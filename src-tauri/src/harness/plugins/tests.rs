//! plugins.rs 单测:manifest 校验 / cordis.yml 生成 / 市场 README 解析 /
//! Zip Slip 防护 / install→list→set_enabled→uninstall 链路。
//! 全部在临时目录内运行,不依赖 Tauri AppHandle。

use super::*;

/// 造一个唯一临时根目录,返回 (app_data, vendor_root)。
fn test_roots(tag: &str) -> (PathBuf, PathBuf) {
    let root = std::env::temp_dir().join(format!(
        "starhub-plugin-test-{tag}-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let app_data = root.join("app-data");
    let vendor_root = root.join("vendor/deepseek-harness");
    // 假 vendor 布局:peer 包各带一个声明包名的 package.json
    for pkg in PEER_PACKAGE_DIRS {
        let dir = vendor_root.join("vendor").join(pkg);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("package.json"),
            format!("{{\"name\": \"@deepseek-ai/{pkg}\"}}"),
        )
        .unwrap();
    }
    (app_data, vendor_root)
}

/// 在指定目录写一个最小零依赖插件包。
fn write_minimal_plugin(dir: &Path, name: &str) {
    fs::create_dir_all(dir.join("lib")).unwrap();
    fs::write(
        dir.join("package.json"),
        format!(
            r#"{{"name": "{name}", "version": "1.2.3", "description": "测试插件",
                "license": "MIT", "main": "lib/index.js",
                "dsh": {{"bundle": {{"patch": "./cordis.patch.yml"}}}}}}"#
        ),
    )
    .unwrap();
    fs::write(dir.join("lib/index.js"), "export default {}\n").unwrap();
}

#[test]
fn sanitize_id_cases() {
    assert_eq!(
        sanitize_id("@deepseek-ai/dsh-tool-foo").as_deref(),
        Some("dsh-tool-foo")
    );
    assert_eq!(sanitize_id("My Plugin!").as_deref(), Some("my-plugin"));
    assert_eq!(sanitize_id("dsh_thing").as_deref(), Some("dsh_thing"));
    assert_eq!(sanitize_id("---").as_deref(), None);
    assert_eq!(sanitize_id("").as_deref(), None);
}

#[test]
fn validate_manifest_accepts_zero_dep_plugin() {
    let root = std::env::temp_dir().join(format!("starhub-pv-{}", uuid::Uuid::new_v4()));
    let dir = root.join("ok");
    write_minimal_plugin(&dir, "dsh-tool-demo");
    let manifest = validate_plugin_dir(&dir).expect("零依赖插件应通过校验");
    assert_eq!(manifest.id, "dsh-tool-demo");
    assert_eq!(manifest.version, "1.2.3");
    assert_eq!(manifest.entry, "lib/index.js");
    assert_eq!(manifest.license.as_deref(), Some("MIT"));
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn validate_manifest_rejects_dependencies() {
    let root = std::env::temp_dir().join(format!("starhub-pv-{}", uuid::Uuid::new_v4()));
    let dir = root.join("with-deps");
    write_minimal_plugin(&dir, "dsh-tool-deps");
    // 覆写 package.json:带 dependencies
    fs::write(
        dir.join("package.json"),
        r#"{"name": "dsh-tool-deps", "main": "lib/index.js",
            "dependencies": {"lodash": "^4.0.0"},
            "dsh": {"bundle": {"patch": "./cordis.patch.yml"}}}"#,
    )
    .unwrap();
    let error = validate_plugin_dir(&dir).expect_err("带依赖的插件应被拒绝");
    assert!(
        error.to_string().contains("暂不支持带依赖的插件"),
        "错误信息应说明原因: {error}"
    );
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn validate_manifest_rejects_client_and_skin() {
    let root = std::env::temp_dir().join(format!("starhub-pv-{}", uuid::Uuid::new_v4()));
    // dsh.client 字段
    let dir = root.join("client-field");
    write_minimal_plugin(&dir, "dsh-something");
    fs::write(
        dir.join("package.json"),
        r#"{"name": "dsh-something", "main": "lib/index.js",
            "dsh": {"bundle": {"patch": "./p.yml"}, "client": {"entry": "./ui.js"}}}"#,
    )
    .unwrap();
    let error = validate_plugin_dir(&dir).expect_err("dsh.client 应被拒绝");
    assert!(error.to_string().contains("dsh.client"), "{error}");
    // 包名启发式
    let dir2 = root.join("skin-name");
    write_minimal_plugin(&dir2, "dsh-skin-maid");
    let error = validate_plugin_dir(&dir2).expect_err("skin 包名应被拒绝");
    assert!(error.to_string().contains("skin"), "{error}");
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn validate_manifest_requires_bundle_field_and_entry() {
    let root = std::env::temp_dir().join(format!("starhub-pv-{}", uuid::Uuid::new_v4()));
    // 缺 dsh.bundle
    let dir = root.join("no-bundle");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("package.json"), r#"{"name": "plain-lib"}"#).unwrap();
    let error = validate_plugin_dir(&dir).expect_err("缺 dsh.bundle 应被拒绝");
    assert!(error.to_string().contains("dsh.bundle"), "{error}");
    // 入口文件不存在
    let dir2 = root.join("no-entry");
    fs::create_dir_all(&dir2).unwrap();
    fs::write(
        dir2.join("package.json"),
        r#"{"name": "dsh-no-entry", "main": "lib/missing.js",
            "dsh": {"bundle": {"patch": "./p.yml"}}}"#,
    )
    .unwrap();
    let error = validate_plugin_dir(&dir2).expect_err("入口缺失应被拒绝");
    assert!(error.to_string().contains("入口文件不存在"), "{error}");
    // 入口路径穿越
    let dir3 = root.join("evil-entry");
    fs::create_dir_all(&dir3).unwrap();
    fs::write(
        dir3.join("package.json"),
        r#"{"name": "dsh-evil", "main": "../outside.js",
            "dsh": {"bundle": {"patch": "./p.yml"}}}"#,
    )
    .unwrap();
    let error = validate_plugin_dir(&dir3).expect_err("路径穿越入口应被拒绝");
    assert!(error.to_string().contains("入口文件路径非法"), "{error}");
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn render_entries_yml_quotes_and_empty() {
    assert!(render_entries_yml(&[]).contains("[]"));
    let record = PluginRecord {
        id: "dsh-tool-demo".into(),
        name: "dsh-tool-demo".into(),
        version: "1.0.0".into(),
        description: None,
        license: None,
        source: PluginSource {
            kind: "local-dir".into(),
            location: None,
        },
        entry: "lib/index.js".into(),
        enabled: true,
        installed_at: "2026-08-14T00:00:00Z".into(),
    };
    let yml = render_entries_yml(std::slice::from_ref(&record));
    assert!(
        yml.contains(
            "- id: 'dsh-tool-demo'\n  name: './dsh-tool-demo/lib/index.js'\n  disabled: false\n"
        ),
        "生成的 yml 不符预期:\n{yml}"
    );
    // 禁用态
    let disabled_yml = render_entries_yml(&[PluginRecord {
        enabled: false,
        ..record.clone()
    }]);
    assert!(disabled_yml.contains("disabled: true"));
    // 转义:单引号双写,且任何值都不会以 !!js 标签形态出现
    assert_eq!(yaml_single_quoted("it's"), "'it''s'");
    assert!(!render_entries_yml(&[]).contains("!!js"));
}

#[test]
fn parse_market_readme_categories_and_filter() {
    let sample = r#"# awesome-dsh-plugin

## 分类

### 工具与能力

- [foo/dsh-tool-alpha](https://github.com/foo/dsh-tool-alpha) — Alpha 工具
- [bar/dsh-tool-beta](https://github.com/bar/dsh-tool-beta) - Beta 工具
- [not-a-repo](https://example.com/elsewhere) — 非 GitHub 链接,丢弃

### UI 增强 / 主题

- [someone/dsh-skin-x](https://github.com/someone/dsh-skin-x) — 皮肤,整类不收录

### 模型与 Provider

- [baz/dsh-polyglot](https://github.com/baz/dsh-polyglot) — 多 provider
"#;
    let mut categories = parse_market_readme(sample);
    assert_eq!(categories.len(), 2, "UI 分类应被过滤: {categories:?}");
    assert_eq!(categories[0].name, "工具与能力");
    assert_eq!(categories[0].plugins.len(), 2, "非 GitHub 链接应被丢弃");
    assert_eq!(categories[0].plugins[0].name, "foo/dsh-tool-alpha");
    assert_eq!(categories[0].plugins[0].description, "Alpha 工具");
    assert_eq!(categories[1].plugins[0].name, "baz/dsh-polyglot");

    // join npm-map / stars(以 GitHub URL 为 key)
    let npm_map = serde_json::json!({"https://github.com/foo/dsh-tool-alpha": "dsh-tool-alpha"});
    let stars = serde_json::json!({"https://github.com/foo/dsh-tool-alpha": 42});
    join_market_data(&mut categories, &[npm_map, stars]);
    assert_eq!(
        categories[0].plugins[0].npm.as_deref(),
        Some("dsh-tool-alpha")
    );
    assert_eq!(categories[0].plugins[0].stars, Some(42));
    assert_eq!(categories[0].plugins[1].stars, None);
}

/// 构造一个内存 zip:entries 为 (路径, 内容)。
fn build_zip(entries: &[(&str, &str)]) -> Vec<u8> {
    let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default();
    for (name, content) in entries {
        writer.start_file(name, options).unwrap();
        use std::io::Write;
        writer.write_all(content.as_bytes()).unwrap();
    }
    writer.finish().unwrap().into_inner()
}

const ZIP_MANIFEST: &str = r#"{"name": "dsh-tool-zip", "version": "0.1.0", "main": "lib/index.js",
    "dsh": {"bundle": {"patch": "./cordis.patch.yml"}}}"#;

#[test]
fn zip_install_strips_top_level_dir() {
    let (app_data, vendor_root) = test_roots("zip");
    let paths = PluginPaths::at(app_data.clone());
    paths.ensure_layout().unwrap();
    let bytes = build_zip(&[
        ("dsh-tool-zip-main/package.json", ZIP_MANIFEST),
        ("dsh-tool-zip-main/lib/index.js", "export default {}\n"),
    ]);
    let record = install_zip_bytes(
        &paths,
        &bytes,
        PluginSource {
            kind: "url".into(),
            location: Some("https://github.com/x/dsh-tool-zip".into()),
        },
        &vendor_root,
    )
    .expect("正常 zip 应安装成功");
    assert_eq!(record.id, "dsh-tool-zip");
    // 顶层 <repo>-<branch>/ 已剥掉
    assert!(paths
        .plugin_dir("dsh-tool-zip")
        .join("package.json")
        .exists());
    assert!(paths
        .plugin_dir("dsh-tool-zip")
        .join("lib/index.js")
        .exists());
    // peer junction 已建立
    assert!(
        paths
            .plugins_dir()
            .join("node_modules/@deepseek-ai/cordis")
            .exists(),
        "peer junction 应存在"
    );
    // 新装默认关闭
    let yml = fs::read_to_string(paths.entries_path()).unwrap();
    assert!(yml.contains("disabled: true"), "{yml}");
    let _ = fs::remove_dir_all(app_data.parent().unwrap());
}

#[test]
fn zip_install_rejects_zip_slip() {
    let (app_data, vendor_root) = test_roots("slip");
    let paths = PluginPaths::at(app_data.clone());
    paths.ensure_layout().unwrap();
    let bytes = build_zip(&[
        ("pkg/package.json", ZIP_MANIFEST),
        ("pkg/../evil.txt", "pwned"),
    ]);
    let error = install_zip_bytes(
        &paths,
        &bytes,
        PluginSource {
            kind: "local-zip".into(),
            location: None,
        },
        &vendor_root,
    )
    .expect_err("Zip Slip 应被拒绝");
    assert!(error.to_string().contains("Zip Slip"), "{error}");
    let _ = fs::remove_dir_all(app_data.parent().unwrap());
}

#[test]
fn install_list_enable_uninstall_chain() {
    let (app_data, vendor_root) = test_roots("chain");
    let paths = PluginPaths::at(app_data.clone());
    paths.ensure_layout().unwrap();

    // 本地目录导入
    let src = app_data.parent().unwrap().join("src-plugin");
    write_minimal_plugin(&src, "dsh-tool-chain");
    let record = install_local_dir(&paths, &src, &vendor_root).expect("安装本地目录");
    assert!(!record.enabled, "新装默认关闭");

    // list
    let listed = list_plugins(&paths).unwrap();
    let array = listed.as_array().unwrap();
    assert_eq!(array.len(), 1);
    assert_eq!(array[0]["id"], "dsh-tool-chain");
    assert_eq!(array[0]["missing"], false);

    // 重复安装拒绝
    let error = install_local_dir(&paths, &src, &vendor_root).expect_err("重复安装应拒绝");
    assert!(matches!(error, PluginError::AlreadyInstalled(_)));

    // 启停 → yml 内容联动
    set_enabled(&paths, "dsh-tool-chain", true).unwrap();
    let yml = fs::read_to_string(paths.entries_path()).unwrap();
    assert!(yml.contains("disabled: false"), "{yml}");
    set_enabled(&paths, "dsh-tool-chain", false).unwrap();
    let yml = fs::read_to_string(paths.entries_path()).unwrap();
    assert!(yml.contains("disabled: true"), "{yml}");
    // registry 持久化
    let registry = load_registry(&paths).unwrap();
    assert_eq!(registry.plugins.len(), 1);
    assert_eq!(registry.plugins[0].source.kind, "local-dir");

    // 卸载:目录与记录都消失,entries 回到空数组
    uninstall(&paths, "dsh-tool-chain").unwrap();
    assert!(!paths.plugin_dir("dsh-tool-chain").exists());
    let yml = fs::read_to_string(paths.entries_path()).unwrap();
    assert!(yml.contains("[]"), "{yml}");
    let error = uninstall(&paths, "dsh-tool-chain").expect_err("重复卸载应报不存在");
    assert!(matches!(error, PluginError::NotFound(_)));
    let _ = fs::remove_dir_all(app_data.parent().unwrap());
}

#[test]
fn github_url_parsing() {
    assert_eq!(
        parse_github_repo_url("https://github.com/foo/bar"),
        Some(("foo".into(), "bar".into(), None))
    );
    assert_eq!(
        parse_github_repo_url("https://github.com/foo/bar/tree/dev"),
        Some(("foo".into(), "bar".into(), Some("dev".into())))
    );
    assert_eq!(
        parse_github_repo_url("https://github.com/foo/bar.git/"),
        Some(("foo".into(), "bar".into(), None))
    );
    assert_eq!(parse_github_repo_url("https://example.com/x.zip"), None);
}

#[test]
fn file_url_and_wrapper_rendering() {
    // Windows 盘符 + 空格 + 非 ASCII:反斜杠转正斜杠、空格与汉字 percent-encode
    let url = path_to_file_url(Path::new(r"C:\Users\测试 User\AppData\plugins\cordis.yml"));
    assert_eq!(
        url,
        "file:///C:/Users/%E6%B5%8B%E8%AF%95%20User/AppData/plugins/cordis.yml"
    );
    let url = path_to_file_url(Path::new("/home/u/plugins/cordis.yml"));
    assert_eq!(url, "file:///home/u/plugins/cordis.yml");

    let wrapper = render_wrapper_yml(
        Path::new(r"E:\repo\vendor\deepseek-harness\examples\starhub-agent\cordis.yml"),
        Path::new(r"C:\App Data\plugins\cordis.yml"),
    );
    assert!(wrapper.contains("name: cordis:include"), "{wrapper}");
    assert!(
        wrapper.contains(
            "path: 'file:///E:/repo/vendor/deepseek-harness/examples/starhub-agent/cordis.yml'"
        ),
        "{wrapper}"
    );
    assert!(
        wrapper.contains("path: 'file:///C:/App%20Data/plugins/cordis.yml'"),
        "{wrapper}"
    );
    assert!(wrapper.contains("initial: []"), "{wrapper}");
}
