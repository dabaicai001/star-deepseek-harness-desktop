use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Instant, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::process::Command;

const MAX_SHELL_OUTPUT_BYTES: usize = 512 * 1024;
const MAX_TEXT_READ_BYTES: usize = 1024 * 1024;
const MAX_TEXT_WRITE_BYTES: usize = 2 * 1024 * 1024;
const MAX_DIRECTORY_ENTRIES: usize = 500;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSystemInfo {
    os: String,
    family: String,
    arch: String,
    current_dir: String,
    home_dir: Option<String>,
    shell: String,
    path_separator: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalShellResult {
    stdout: String,
    stderr: String,
    exit_code: Option<i32>,
    elapsed_ms: u128,
    truncated: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalFileEntry {
    name: String,
    path: String,
    kind: String,
    size: u64,
    modified_at: Option<u64>,
    readonly: bool,
    hidden: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalPathInfo {
    path: String,
    name: String,
    kind: String,
    size: u64,
    modified_at: Option<u64>,
    readonly: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalTextRead {
    path: String,
    content: String,
    offset: u64,
    bytes_read: usize,
    total_bytes: u64,
    truncated: bool,
}

fn home_dir() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("USERPROFILE").map(PathBuf::from)
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::env::var_os("HOME").map(PathBuf::from)
    }
}

#[cfg(target_os = "windows")]
fn shell_command(command: &str) -> Command {
    let mut process = Command::new("powershell.exe");
    process.args([
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        command,
    ]);
    process
}

#[cfg(not(target_os = "windows"))]
fn shell_command(command: &str) -> Command {
    let mut process = Command::new("/bin/sh");
    process.args(["-lc", command]);
    process
}

fn shell_name() -> String {
    #[cfg(target_os = "windows")]
    {
        "PowerShell".to_string()
    }
    #[cfg(not(target_os = "windows"))]
    {
        "/bin/sh".to_string()
    }
}

fn modified_at(metadata: &std::fs::Metadata) -> Option<u64> {
    metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_secs())
}

fn path_kind(metadata: &std::fs::Metadata) -> String {
    if metadata.is_dir() {
        "directory"
    } else if metadata.is_file() {
        "file"
    } else if metadata.file_type().is_symlink() {
        "symlink"
    } else {
        "other"
    }
    .to_string()
}

fn display_path(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

async fn read_limited_output<R>(mut reader: R) -> Result<(String, bool), String>
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut captured = Vec::with_capacity(MAX_SHELL_OUTPUT_BYTES.min(64 * 1024));
    let mut buffer = [0_u8; 8192];
    let mut truncated = false;
    loop {
        let count = reader
            .read(&mut buffer)
            .await
            .map_err(|error| format!("read shell output failed: {error}"))?;
        if count == 0 {
            break;
        }
        let remaining = MAX_SHELL_OUTPUT_BYTES.saturating_sub(captured.len());
        if remaining > 0 {
            captured.extend_from_slice(&buffer[..count.min(remaining)]);
        }
        if count > remaining {
            truncated = true;
        }
    }
    Ok((String::from_utf8_lossy(&captured).to_string(), truncated))
}

/// 返回当前应用进程看到的本机操作系统、架构、目录和 Shell 信息。
#[tauri::command]
pub fn local_system_info() -> Result<LocalSystemInfo, String> {
    let current_dir =
        std::env::current_dir().map_err(|error| format!("current dir failed: {error}"))?;
    Ok(LocalSystemInfo {
        os: std::env::consts::OS.to_string(),
        family: std::env::consts::FAMILY.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        current_dir: display_path(&current_dir),
        home_dir: home_dir().as_deref().map(display_path),
        shell: shell_name(),
        path_separator: std::path::MAIN_SEPARATOR.to_string(),
    })
}

/// 使用平台默认非交互 Shell 执行命令：Windows PowerShell，macOS/Linux /bin/sh。
#[tauri::command]
pub async fn local_shell_exec(
    command: String,
    working_dir: Option<String>,
    timeout_sec: Option<u64>,
) -> Result<LocalShellResult, String> {
    if command.trim().is_empty() {
        return Err("command must not be empty".to_string());
    }
    let timeout = timeout_sec.unwrap_or(30).clamp(1, 120);
    let mut process = shell_command(&command);
    process
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(directory) = working_dir.filter(|value| !value.trim().is_empty()) {
        let path = PathBuf::from(directory);
        if !path.is_dir() {
            return Err(format!(
                "working directory does not exist: {}",
                display_path(&path)
            ));
        }
        process.current_dir(path);
    }

    let started = Instant::now();
    let mut child = process
        .spawn()
        .map_err(|error| format!("local shell failed: {error}"))?;
    let stdout_pipe = child
        .stdout
        .take()
        .ok_or_else(|| "local shell stdout pipe unavailable".to_string())?;
    let stderr_pipe = child
        .stderr
        .take()
        .ok_or_else(|| "local shell stderr pipe unavailable".to_string())?;
    let execution = async {
        let (status, stdout, stderr) = tokio::join!(
            child.wait(),
            read_limited_output(stdout_pipe),
            read_limited_output(stderr_pipe)
        );
        (status, stdout, stderr)
    };
    let (status, stdout, stderr) =
        match tokio::time::timeout(std::time::Duration::from_secs(timeout), execution).await {
            Ok(result) => result,
            Err(_) => {
                let _ = child.kill().await;
                let _ = child.wait().await;
                return Err(format!("local shell timed out after {timeout}s"));
            }
        };
    let status = status.map_err(|error| format!("wait for local shell failed: {error}"))?;
    let (stdout, stdout_truncated) = stdout?;
    let (stderr, stderr_truncated) = stderr?;
    Ok(LocalShellResult {
        stdout,
        stderr,
        exit_code: status.code(),
        elapsed_ms: started.elapsed().as_millis(),
        truncated: stdout_truncated || stderr_truncated,
    })
}

/// 列出本机目录，单次最多返回 500 项。
#[tauri::command]
pub async fn local_list_directory(
    path: String,
    max_entries: Option<usize>,
) -> Result<Vec<LocalFileEntry>, String> {
    let root = PathBuf::from(path);
    if !root.is_dir() {
        return Err(format!("directory does not exist: {}", display_path(&root)));
    }
    let limit = max_entries.unwrap_or(200).clamp(1, MAX_DIRECTORY_ENTRIES);
    let mut reader = tokio::fs::read_dir(&root)
        .await
        .map_err(|error| format!("read directory failed: {error}"))?;
    let mut entries = Vec::new();
    while entries.len() < limit {
        let Some(entry) = reader
            .next_entry()
            .await
            .map_err(|error| format!("read directory entry failed: {error}"))?
        else {
            break;
        };
        let metadata = entry
            .metadata()
            .await
            .map_err(|error| format!("read metadata failed: {error}"))?;
        let name = entry.file_name().to_string_lossy().to_string();
        entries.push(LocalFileEntry {
            hidden: name.starts_with('.'),
            name,
            path: display_path(&entry.path()),
            kind: path_kind(&metadata),
            size: metadata.len(),
            modified_at: modified_at(&metadata),
            readonly: metadata.permissions().readonly(),
        });
    }
    entries.sort_by_key(|entry| entry.name.to_lowercase());
    Ok(entries)
}

/// 获取本机路径元数据，不读取文件正文。
#[tauri::command]
pub async fn local_stat_path(path: String) -> Result<LocalPathInfo, String> {
    let target = PathBuf::from(path);
    let metadata = tokio::fs::metadata(&target)
        .await
        .map_err(|error| format!("stat failed: {error}"))?;
    Ok(LocalPathInfo {
        name: target
            .file_name()
            .map(|value| value.to_string_lossy().to_string())
            .unwrap_or_else(|| display_path(&target)),
        path: display_path(&target),
        kind: path_kind(&metadata),
        size: metadata.len(),
        modified_at: modified_at(&metadata),
        readonly: metadata.permissions().readonly(),
    })
}

/// 分段读取 UTF-8/文本文件；二进制内容以 UTF-8 replacement 字符安全返回。
#[tauri::command]
pub async fn local_read_text_file(
    path: String,
    offset: Option<u64>,
    max_bytes: Option<usize>,
) -> Result<LocalTextRead, String> {
    let target = PathBuf::from(path);
    let metadata = tokio::fs::metadata(&target)
        .await
        .map_err(|error| format!("read metadata failed: {error}"))?;
    if !metadata.is_file() {
        return Err("path is not a file".to_string());
    }
    let start = offset.unwrap_or(0).min(metadata.len());
    let limit = max_bytes
        .unwrap_or(256 * 1024)
        .clamp(1, MAX_TEXT_READ_BYTES);
    let mut file = tokio::fs::File::open(&target)
        .await
        .map_err(|error| format!("open file failed: {error}"))?;
    file.seek(std::io::SeekFrom::Start(start))
        .await
        .map_err(|error| format!("seek file failed: {error}"))?;
    let mut buffer = Vec::with_capacity(limit);
    file.take(limit as u64)
        .read_to_end(&mut buffer)
        .await
        .map_err(|error| format!("read file failed: {error}"))?;
    Ok(LocalTextRead {
        path: display_path(&target),
        content: String::from_utf8_lossy(&buffer).to_string(),
        offset: start,
        bytes_read: buffer.len(),
        total_bytes: metadata.len(),
        truncated: start + (buffer.len() as u64) < metadata.len(),
    })
}

/// 覆盖或追加写入本机文本文件，可选创建父目录。
#[tauri::command]
pub async fn local_write_text_file(
    path: String,
    content: String,
    append: Option<bool>,
    create_parents: Option<bool>,
) -> Result<u64, String> {
    if content.len() > MAX_TEXT_WRITE_BYTES {
        return Err(format!("content exceeds {} bytes", MAX_TEXT_WRITE_BYTES));
    }
    let target = PathBuf::from(path);
    if create_parents.unwrap_or(false) {
        if let Some(parent) = target.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|error| format!("create parent directory failed: {error}"))?;
        }
    }
    let mut options = tokio::fs::OpenOptions::new();
    options.create(true).write(true);
    if append.unwrap_or(false) {
        options.append(true);
    } else {
        options.truncate(true);
    }
    let mut file = options
        .open(&target)
        .await
        .map_err(|error| format!("open file for write failed: {error}"))?;
    file.write_all(content.as_bytes())
        .await
        .map_err(|error| format!("write file failed: {error}"))?;
    file.flush()
        .await
        .map_err(|error| format!("flush file failed: {error}"))?;
    Ok(content.len() as u64)
}

#[tauri::command]
pub async fn local_create_directory(path: String, recursive: Option<bool>) -> Result<(), String> {
    let target = PathBuf::from(path);
    if recursive.unwrap_or(true) {
        tokio::fs::create_dir_all(target).await
    } else {
        tokio::fs::create_dir(target).await
    }
    .map_err(|error| format!("create directory failed: {error}"))
}

#[tauri::command]
pub async fn local_copy_file(source: String, destination: String) -> Result<u64, String> {
    let source = PathBuf::from(source);
    let destination = PathBuf::from(destination);
    if !source.is_file() {
        return Err("copy source must be a file".to_string());
    }
    tokio::fs::copy(source, destination)
        .await
        .map_err(|error| format!("copy file failed: {error}"))
}

#[tauri::command]
pub async fn local_move_path(source: String, destination: String) -> Result<(), String> {
    tokio::fs::rename(PathBuf::from(source), PathBuf::from(destination))
        .await
        .map_err(|error| format!("move path failed: {error}"))
}

#[tauri::command]
pub async fn local_remove_path(path: String, recursive: Option<bool>) -> Result<(), String> {
    let target = PathBuf::from(path);
    let metadata = tokio::fs::symlink_metadata(&target)
        .await
        .map_err(|error| format!("read path metadata failed: {error}"))?;
    if metadata.is_dir() {
        if recursive.unwrap_or(false) {
            tokio::fs::remove_dir_all(target).await
        } else {
            tokio::fs::remove_dir(target).await
        }
    } else {
        tokio::fs::remove_file(target).await
    }
    .map_err(|error| format!("remove path failed: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::SystemTime;

    #[test]
    fn reports_cross_platform_system_info() {
        let info = local_system_info().expect("system info");
        assert!(!info.os.is_empty());
        assert!(!info.arch.is_empty());
        assert!(!info.current_dir.is_empty());
        assert!(!info.shell.is_empty());
    }

    #[tokio::test]
    async fn executes_non_interactive_shell() {
        let result = local_shell_exec("echo starhub-local-test".to_string(), None, Some(5))
            .await
            .expect("shell output");
        assert_eq!(result.exit_code, Some(0));
        assert!(result.stdout.to_lowercase().contains("starhub-local-test"));
    }

    #[tokio::test]
    async fn writes_reads_and_removes_text_file() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("starhub-local-{unique}"));
        let file = root.join("sample.txt");
        local_write_text_file(
            display_path(&file),
            "cross-platform".to_string(),
            Some(false),
            Some(true),
        )
        .await
        .expect("write");
        let read = local_read_text_file(display_path(&file), None, None)
            .await
            .expect("read");
        assert_eq!(read.content, "cross-platform");
        local_remove_path(display_path(&root), Some(true))
            .await
            .expect("cleanup");
    }
}
