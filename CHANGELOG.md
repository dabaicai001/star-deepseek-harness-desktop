# 更新日志 (Changelog)

本项目的所有重要变更都会记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/),
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/) 规范。

---

## [未发布]

### 新增
- ✨ feat(sftp): SFTP 文件管理器 — 双面板布局、拖拽传输、传输队列
- ✨ feat(sftp): 文件操作 — 列目录、上传、下载、删除、重命名、新建目录
- ✨ feat(sftp): 断点续传支持
- ✨ feat(sftp): 文件搜索（glob 模式）
- ✨ feat(sftp): 权限修改（chmod 对话框）
- ✨ feat(sftp): 文件预览（文本 + 图片）
- ✨ feat(sftp): 右键上下文菜单
- ✨ feat(sftp): 面包屑路径导航
- ✨ feat(ssh): 终端 / SFTP 分栏可拖拽（默认 65:35,记忆到 localStorage,双击重置）
- ✨ feat(layout): 标签页右键菜单 + Ctrl/Cmd+W 关闭 + 鼠标中键关闭

### 修复
- 🐛 fix(ssh): 「测试连接」按钮不可用 —— 后端缺少 `test_ssh_connection` 命令
- 🐛 fix(sftp): 冷启动首次进入 SSH 标签,SFTP 报 "Session not found" —— SftpBrowser 等待 SSH connected=true 后再发 sftpList
- 🐛 fix(sftp): SFTP 缩窄后文件名列被压扁消失 —— name 列改为 `minmax(140px, 1fr)`,并加上 resize handle

### 改进
- 🎨 style(design-system): SSH 表单 host/port 比例收紧(端口固定 90px)
- 🎨 style(layout): 顶部"+"按钮克制化、状态栏增加 SFTP 计数、欢迎页 4 卡 + P0/P1 chip
- 🎨 style(layout): 状态栏时钟改 1s 间隔 HH:MM:SS,标签页关闭按钮默认半透明

### 计划中
- Tauri 2 + Vue 3 + Rust + Go 项目脚手架
- MVP: SSH 终端、MySQL / PostgreSQL / SQLite / Redis 基础支持
- Docker 本地 + SSH 通道管理
- AI 助手基础集成(Claude / GPT)

---

## [0.2.0] - 2026-06-04

### 立项
- 🎉 **项目正式立项**(StarHub)
- 完成产品定位与目标用户分析
- 完整功能列表(280+ 子功能,带 P0/P1/P2/P3 优先级)

### 架构
- ✅ 整体架构定稿:5 层分层 + 三进程模型(Tauri 主进程 / WebView / Go Sidecar)
- ✅ 技术选型定稿:**Tauri 2 + Vue 3 + Rust + Go**
- ✅ 数据库驱动决策:Go Sidecar(从原 Node.js 升级,理由:静态二进制、PG/Redis 生态更强、与 Rust 同编译型语言)
- ✅ 通信协议:stdio JSON-RPC(Rust ↔ Go)
- ✅ 选型对比完成:Tauri vs Electron、Go vs Node、Go DB 驱动生态
- ✅ 数据模型:SQLite + 系统 Keyring
- ✅ 安全设计:三层信任边界、CSP、Keyring、审计日志
- ✅ 跨平台打包:Win/macOS/Linux + 代码签名
- ✅ MVP 周期 3-4 月、3 人团队、成本 40-50 万

### 文档
- 📋 技术方案文档 v0.2(14 章,49012 字节)
- 📐 架构图 HTML v0.2(10 章节,48303 字节)
  - 分层架构图、进程模型图、Mermaid 流程图
  - 三大数据流示例(SQL 查询、SSH 命令、AI 排障)
  - 模块卡片、数据模型 ER 图、路线图时间线
  - 性能指标、团队配置、风险与对策

### 工程
- MIT License 开源
- 仓库地址:https://github.com/dabaicai001/starhub

---

## 历史

- **v0.1 (2026-06-04)** — 初版,Sidecar 选用 Node.js(后改为 Go)
- **v0.0** — 内部调研
