# Agent Note:StarHub git 分支胶囊经 one-shot LLM HTTP 端点生成提交信息草稿

Status: implemented

[English](2026-08-22-starhub-commit-message-ai-draft.md) | 中文

## 问题

会话头部 git 分支胶囊(见[分支胶囊 note](2026-08-21-starhub-session-header-git-branch-pill.md))已支持暂存提交,但提交信息仍需手写。用 AI 起草需要从 web GUI 发起一次 one-shot 模型调用,而客户端没有这样的通道:`IApiClient` 没有辅助 LLM RPC,凭据只在 host 侧;若借道聊天会话则会污染对话,并为一个格式化任务跑完整 agent loop。

## 决策

新增 StarHub 本地 host 包 `packages/starhub/commit-message`,在 `ctx.webServer` 上认领 exact 路由 `POST /starhub/git/commit-message`。客户端(`git-service.ts` 的 `gitDraftCommitMessage`)经既有 Tauri `local_shell_exec` 采集 `git status --porcelain`、`git diff HEAD --stat`(首次提交前回落 `git diff --stat`)与最近 8 条提交主题,按字节预算截断后以 JSON POST 上来。插件从 `agentDefaultModel.currentSelection()` 解析模型路由(cordis.yml 可成对固定 `provider`/`model`,单写即报错),把摘要帧为一条 JSON 用户消息,用 Loader 必填配置里的 `maxOutputTokens`/`timeoutMs` 预算跑一次 `ctx.llm.stream`;系统提示钉死主题 ≤72 字符、对齐近期提交的语言与约定、不得虚构。草稿回填胶囊输入框,用户审阅、编辑后再提交。错误映射:400(体)、405(方法)、413(超预算)、502(生成失败)。

端点刻意不做任何 git 操作:客户端持有工作区与 Tauri 能力,host 持有模型与凭据。输入是预先摘要过的,模型永远不会收到原始巨型 diff。

## 备选方案

**借道当前聊天会话发送草稿请求。** `IApiClient` 上有 `session.prompt`,但会产生可见 turn、跑完整工具循环,还把一个 UI 小调用与会话状态、审批纠缠在一起;答复还得从会话投影里刮出来。

**Typert Remote 服务 + 生成描述符。** 那是受认可的类型化 RPC 路径,但需要描述符生成、api-remotes 白名单条目与客户端 `remote.$mount` 装配——对一次 JSON 进/JSON 出的调用太重。`webServer` 上的 plain exact 路由是 `starhub-host-static` 已在用的形态,客户端除 `fetch` 外不需要任何框架支持。

**给胶囊单独配 provider 设置。** 在客户端复制凭据存储会破坏单一事实来源(GUI 设置 → 模型),还把密钥泄进 webview;经 `agentDefaultModel` 解析保持部署默认的权威性。

## 影响

`LOCAL_PACKAGES`(src-tauri `harness/web.rs`)、`WEB_LOCAL_PACKAGE_DIRS`(package-dsh-runtime.ts)、starhub-web profile 清单与 patch 层、examples 清单、host tsconfig 聚合都登记了这个新包;缺失时 profile 启动 fail-loud。调用不绑定会话:不写入任何会话日志,不占对话上下文。仅摘要的输入意味着全新文件只能按文件名描述,草稿偏泛,留待未来的 `diffPreview` 字段。同一改动顺带修掉了 Windows 控制台闪窗:`local_shell_exec` 与 harness 两处 `cmd` spawn 现在都带 `CREATE_NO_WINDOW`——此前胶囊每次会话切换探测 git 都会从 GUI 进程弹出一个可见控制台窗口。
