//! dsh web GUI 组合的长驻管理器(主壳融合 P1,与 HarnessManager 并列)。
//!
//! 把 `vendor/deepseek-harness/examples/starhub-web/boot.mjs` 的逻辑移植到 Rust:
//! 1. 物化 `$DSH_HOME/profiles/web/`(默认 `<app_data_dir>/dsh-web-home`,
//!    可用 STARHUB_DSH_WEB_HOME 覆盖)——拷 profile package.json,并把
//!    cordis.patch.yml 的 webserver 端口改写为实际选定端口;
//! 2. 为本地包(client-nav / host-static)在 `$DSH_HOME/profiles/node_modules`
//!    下补 junction(healProfilesModuleFallback 不会链接依赖闭包之外的本地包);
//! 3. spawn 便携 Node + `apps/cli/lib/bin.js web`,kill_on_drop 随应用退出回收
//!    (与 HarnessManager / SidecarManager 同一约定)。
//!
//! 端口:默认 3085,占用则递增重试(上限 +10);实际端口写回状态,经
//! `dsh_web_url` command 暴露。就绪探测:轮询 GET / 直到 200(超时 30s)。
//! `STARHUB_DSH_WEB=0` 整体禁用(逃生门,便于旧外壳开发)。

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use thiserror::Error;
use tokio::process::{Child, Command};

use super::plugins;
use super::HarnessPaths;

/// dsh web 默认端口(与 examples/starhub-web/cordis.patch.yml 一致)。
pub const DEFAULT_PORT: u16 = 3085;
/// 端口递增重试上限:3085..=3095。
const MAX_PORT_OFFSET: u16 = 10;
/// 就绪探测总超时。
const READY_TIMEOUT: Duration = Duration::from_secs(30);
/// 就绪探测间隔。
const READY_INTERVAL: Duration = Duration::from_millis(300);
/// starhub-web 组合在 vendor 内的相对路径。
const EXAMPLE_REL: &str = "examples/starhub-web";
/// dsh CLI bin 相对 vendor 根的路径。
const CLI_BIN_REL: &str = "apps/cli/lib/bin.js";
/// 需要补 junction 的本地包(packages/starhub/ 下的目录名)。
const LOCAL_PACKAGES: [&str; 2] = ["client-nav", "host-static"];

#[derive(Debug, Error)]
pub enum DshWebError {
    #[error("dsh web 路径解析失败: {0}")]
    PathResolve(String),
    #[error("dsh web 启动失败: {0}")]
    Spawn(String),
    #[error("dsh web 就绪探测超时({0}s),进程日志见 tracing")]
    ReadyTimeout(u64),
    #[error("3085..=3095 端口全部被占用")]
    NoFreePort,
    #[error("dsh web 未运行")]
    NotRunning,
}

/// 一次成功启动的运行态:URL / 子进程句柄。
struct DshWebHandle {
    url: String,
    child: Child,
}

/// 挂在 tauri State 上的 dsh web 单例管理器。
pub struct DshWebManager {
    handle: tokio::sync::Mutex<Option<DshWebHandle>>,
    /// 串行化 ensure_started,消除并发 spawn 的 TOCTOU
    start_lock: tokio::sync::Mutex<()>,
}

/// 在 base..=base+max_offset 里找第一个可绑定端口(占位进程占着 3085 时递增)。
fn find_free_port(base: u16, max_offset: u16) -> Option<u16> {
    (0..=max_offset).find_map(|offset| {
        let port = base.checked_add(offset)?;
        std::net::TcpListener::bind(("127.0.0.1", port)).ok().map(|_| port)
    })
}

/// 把 cordis.patch.yml 模板里 webserver 行的 `port: N` 改写为实际端口。
/// patch 会整段替换目标行 config,webserver 块在本文件中是唯一的 `port:` 持有者。
fn rewrite_patch_port(template: &str, port: u16) -> Result<String, DshWebError> {
    let mut in_webserver = false;
    let mut replaced = false;
    let mut out: Vec<String> = Vec::new();
    for line in template.lines() {
        if line.trim_start().starts_with("- id:") {
            in_webserver = line.contains("webserver");
        }
        if in_webserver && !replaced && line.trim_start().starts_with("port:") {
            let indent = &line[..line.len() - line.trim_start().len()];
            out.push(format!("{indent}port: {port}"));
            replaced = true;
        } else {
            out.push(line.to_string());
        }
    }
    if !replaced {
        return Err(DshWebError::PathResolve(
            "cordis.patch.yml 模板缺少 webserver 端口行".into(),
        ));
    }
    Ok(out.join("\n"))
}

/// StarHub embed dist:优先 dist-embed(build:embed 产物,base /starhub/),
/// 回退 dist。host-static 自己也做同样解析,这里经 STARHUB_DIST 显式钉死。
fn resolve_starhub_dist(repo_root: &Path) -> Result<PathBuf, DshWebError> {
    for dir in [repo_root.join("dist-embed"), repo_root.join("dist")] {
        if dir.join("index.html").exists() {
            return Ok(dir);
        }
    }
    Err(DshWebError::PathResolve(format!(
        "未找到 StarHub 前端 dist(先跑 npm run build:embed): {}",
        repo_root.display()
    )))
}

impl DshWebManager {
    pub fn new() -> Self {
        Self {
            handle: tokio::sync::Mutex::new(None),
            start_lock: tokio::sync::Mutex::new(()),
        }
    }

    /// 当前运行中的 dsh web URL(未运行返回错误)。
    pub async fn url(&self) -> Result<String, DshWebError> {
        let guard = self.handle.lock().await;
        match guard.as_ref() {
            Some(handle) => Ok(handle.url.clone()),
            None => Err(DshWebError::NotRunning),
        }
    }

    /// 启动(如未运行)并等待就绪,返回 `http://127.0.0.1:<port>`。
    /// 幂等:已在运行直接返回现有 URL。
    pub async fn ensure_started(&self, app: &tauri::AppHandle) -> Result<String, DshWebError> {
        let _start_guard = self.start_lock.lock().await;
        if let Some(handle) = self.handle.lock().await.as_ref() {
            return Ok(handle.url.clone());
        }
        let handle = self.spawn(app).await?;
        let url = handle.url.clone();
        *self.handle.lock().await = Some(handle);
        Ok(url)
    }

    async fn spawn(&self, app: &tauri::AppHandle) -> Result<DshWebHandle, DshWebError> {
        use tauri::Manager;
        let paths = HarnessPaths::resolve().map_err(|e| DshWebError::PathResolve(e.to_string()))?;
        let runtime_dir = paths.runtime_dir;
        let repo_root = runtime_dir
            .join("..")
            .join("..")
            .canonicalize()
            .map_err(|e| DshWebError::PathResolve(format!("仓库根解析失败: {e}")))?;
        let example_dir = runtime_dir.join(EXAMPLE_REL);
        let cli_bin = runtime_dir.join(CLI_BIN_REL);
        if !cli_bin.exists() {
            return Err(DshWebError::PathResolve(format!(
                "{} 缺失(先在 vendor 内跑 build:lib:host)",
                cli_bin.display()
            )));
        }

        // 1. DSH_HOME 与 profile 物化
        let dsh_home = match std::env::var("STARHUB_DSH_WEB_HOME") {
            Ok(dir) => PathBuf::from(dir),
            Err(_) => app
                .path()
                .app_data_dir()
                .map_err(|e| DshWebError::PathResolve(format!("app_data_dir 失败: {e}")))?
                .join("dsh-web-home"),
        };
        let profile_dir = dsh_home.join("profiles").join("web");
        std::fs::create_dir_all(&profile_dir)
            .map_err(|e| DshWebError::PathResolve(format!("创建 profile 目录失败: {e}")))?;
        std::fs::copy(
            example_dir.join("package.json"),
            profile_dir.join("package.json"),
        )
        .map_err(|e| DshWebError::PathResolve(format!("物化 profile package.json 失败: {e}")))?;

        // 2. 选端口并改写 patch
        let port = find_free_port(DEFAULT_PORT, MAX_PORT_OFFSET).ok_or(DshWebError::NoFreePort)?;
        let patch_template = std::fs::read_to_string(example_dir.join("cordis.patch.yml"))
            .map_err(|e| DshWebError::PathResolve(format!("读取 cordis.patch.yml 模板失败: {e}")))?;
        std::fs::write(
            profile_dir.join("cordis.patch.yml"),
            rewrite_patch_port(&patch_template, port)?,
        )
        .map_err(|e| DshWebError::PathResolve(format!("物化 cordis.patch.yml 失败: {e}")))?;

        // 3. 本地包 junction(已存在则复用,目标本就固定指向 vendor)
        let link_base = dsh_home.join("profiles").join("node_modules").join("@deepseek-ai");
        std::fs::create_dir_all(&link_base)
            .map_err(|e| DshWebError::PathResolve(format!("创建 profiles/node_modules 失败: {e}")))?;
        for dir_name in LOCAL_PACKAGES {
            let link = link_base.join(format!("dsh-starhub-{dir_name}"));
            if link.exists() {
                continue;
            }
            let target = runtime_dir.join("packages").join("starhub").join(dir_name);
            plugins::create_dir_link(&link, &target).map_err(|e| {
                DshWebError::PathResolve(format!(
                    "junction 创建失败({} → {}): {e}",
                    link.display(),
                    target.display()
                ))
            })?;
        }

        // 4. spawn dsh web 组合
        let starhub_dist = resolve_starhub_dist(&repo_root)?;
        let mut cmd = Command::new(&paths.node_path);
        cmd.arg(&cli_bin)
            .arg("web")
            .current_dir(&runtime_dir)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .env("DSH_HOME", &dsh_home)
            .env("DSH_TELEMETRY_DISABLED", "1")
            .env("STARHUB_DIST", &starhub_dist)
            // 不起会话,占位 key 即可(与 boot.mjs 相同)
            .env(
                "DEEPSEEK_API_KEY",
                std::env::var("DEEPSEEK_API_KEY")
                    .unwrap_or_else(|_| "starhub-p0-placeholder".into()),
            );
        #[cfg(target_os = "windows")]
        {
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = cmd.spawn().map_err(|e| {
            DshWebError::Spawn(format!("{} {}: {e}", paths.node_path.display(), cli_bin.display()))
        })?;
        if let Some(stdout) = child.stdout.take() {
            tokio::spawn(drain_lines("stdout", stdout));
        }
        if let Some(stderr) = child.stderr.take() {
            tokio::spawn(drain_lines("stderr", stderr));
        }

        // 5. 就绪探测:轮询 GET / 直到 200
        let url = format!("http://127.0.0.1:{port}");
        let deadline = tokio::time::Instant::now() + READY_TIMEOUT;
        let client = reqwest::Client::new();
        loop {
            match client.get(&url).send().await {
                Ok(resp) if resp.status().is_success() => break,
                _ => {
                    if tokio::time::Instant::now() >= deadline {
                        let _ = child.start_kill();
                        return Err(DshWebError::ReadyTimeout(READY_TIMEOUT.as_secs()));
                    }
                    tokio::time::sleep(READY_INTERVAL).await;
                }
            }
        }

        tracing::info!("dsh web 就绪: {url}(DSH_HOME={},dist={})", dsh_home.display(), starhub_dist.display());
        Ok(DshWebHandle { url, child })
    }

    /// 关停并清空单例(应用退出路径;kill_on_drop 已覆盖崩溃路径)。
    pub async fn shutdown(&self) {
        if let Some(mut handle) = self.handle.lock().await.take() {
            let _ = handle.child.start_kill();
        }
    }
}

/// 子进程 stdout/stderr 排空到 tracing(dsh 日志量较大,一律 info 级)。
async fn drain_lines(tag: &'static str, io: impl tokio::io::AsyncRead + Unpin) {
    use tokio::io::AsyncBufReadExt;
    let mut lines = tokio::io::BufReader::new(io).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        tracing::info!("dsh web {tag}: {}", line.trim());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rewrite_patch_port_only_touches_webserver_block() {
        let template = "# comment with port: 9999\n\
                        - id: webserver\n  config:\n    host: 127.0.0.1\n    port: 3085\n\n\
                        - insert:\n    - id: client-nav\n      name: '@x'\n";
        let out = rewrite_patch_port(template, 3087).unwrap();
        assert!(out.contains("    port: 3087"), "改写结果: {out}");
        assert!(out.contains("port: 9999"), "注释里的 port 不应被动: {out}");
        assert!(!out.contains("port: 3085"), "旧端口应被替换: {out}");
    }

    #[test]
    fn rewrite_patch_port_missing_webserver_fails() {
        let template = "- id: other\n  config:\n    port: 1\n";
        assert!(rewrite_patch_port(template, 3085).is_err());
    }

    /// 动态基准端口:让 OS 分一个空闲端口后立刻释放,作为测试的 base。
    fn ephemeral_base() -> u16 {
        std::net::TcpListener::bind(("127.0.0.1", 0))
            .unwrap()
            .local_addr()
            .unwrap()
            .port()
    }

    #[test]
    fn find_free_port_skips_occupied() {
        let base = ephemeral_base();
        let blocker =
            std::net::TcpListener::bind(("127.0.0.1", base)).expect("测试前提:基准端口可占用");
        let port = find_free_port(base, MAX_PORT_OFFSET).expect("应有可用端口");
        assert!(port > base, "基准端口被占时应递增,得到 {port}");
        assert!(port <= base + MAX_PORT_OFFSET);
        drop(blocker);
    }

    #[test]
    fn find_free_port_base_first_when_free() {
        let base = ephemeral_base();
        // base 刚释放,正常应直接命中;被别的进程瞬时抢走则递增,两种结果都合法
        let port = find_free_port(base, MAX_PORT_OFFSET).expect("应有可用端口");
        assert!((base..=base + MAX_PORT_OFFSET).contains(&port));
    }
}
