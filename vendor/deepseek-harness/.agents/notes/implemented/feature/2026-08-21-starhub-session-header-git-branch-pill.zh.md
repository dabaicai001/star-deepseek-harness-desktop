# Agent Note: StarHub session header hosts a git branch pill with search, checkout, commit, and push

Status: implemented

[English](2026-08-21-starhub-session-header-git-branch-pill.md) | 中文

## Problem

dsh 会话顶栏暴露两个 list 槽位——`conversation.session.header.actions`(标题旁)与 `conversation.session.header.utilities`(右对齐)——而 StarHub 桌面产品面向 git 工作区,顶栏却不显示任何当前仓库状态。用户要离开 AI 对话才能查看或切换分支、暂存提交改动、推送。仓库里也没有「浏览器渲染组件执行 git」的先例:`IApiClient` 没有命令执行面,面向模型的 `starhub/tool.execute` 桥也不是 UI 通道。

## Decision

`packages/starhub/client-nav` 在 `conversation.session.header.actions` 注册 `GitBranchPill`,id `starhub-git-branch`、`order: 30`,落在 subagent 目录(10)与任务列表(20)之后、右对齐的 Session log 按钮之前。组件取 `PropsRuntime<'conversation.session.header.actions'>`,经 `useSessions(list => list.byId[sessionId]?.cwd)` 得到工作目录。cwd 缺席(宿主帧未达的 blank 会话)、目录不是 git 工作树(`git rev-parse --is-inside-work-tree` 探测)、或 Tauri IPC 不可用(浏览器预览)时一律不渲染,与其他 Tauri 支撑的 StarHub 部件同样降级。

git 执行走已授权的 Tauri `local_shell_exec` 命令(`git-service.ts` 包装 `tauriInvoke`):`git branch --show-current` 出胶囊标签(detached HEAD 显示为 `(detached <sha>)`),`git branch --format=%(refname:short)` 出可搜索列表,`git checkout <branch>` 切换,`git add -A` + `git commit -m <message>` 提交,`git push` 用 120 秒超时。未提交改动圆点来自 `git status --porcelain`。PowerShell 单引号转义(`psQuote`)保护分支名与提交信息,首行输出或 stderr 内联展示在面板里。

## Alternatives considered

**注册到 `conversation.session.header.utilities`。** utilities 簇右对齐、紧邻 Session log;分支身份属于会话上下文,actions 簇与既有的任务列表/subagent 放置一致,分支名紧贴会话标题更醒目。

**新增 dsh host git 端点(前缀路由或 apiproxy RPC)以获得浏览器可移植执行。** 那要动上游 `api/rpc-map.ts` 与 IApiClient 契约,而桌面产品已有一条特权 Tauri shell——`local_shell_exec` 对 127.0.0.1 dsh shell 源已 ACL。复用它零 Rust/ACL 改动;浏览器预览缺失可接受,因为 StarHub 的 git 流程本就是桌面端能力。

**checkout/commit/push 前弹 `RiskConfirmation`。** dsh 的 `RiskConfirmation` 先例守卫高风险开关(full-access 权限)。切分支、提交、推送是用户在自己工作区发起的常规操作,结果内联可见;确认弹窗会打断紧凑面板,收益却很小。

## Consequences

钉在 git 工作区的会话一眼可见当前分支、未提交状态,并能在不离开对话的情况下搜索切换分支、全部提交、推送。非 git 会话与浏览器预览不渲染。代价是 web GUI 里 `local_shell_exec` 的第二个消费方(第一个是文件查看窗)、一个必须对任意分支名与提交信息保持正确的 PowerShell 转义助手,以及大仓库 push 的 120 秒上限。
