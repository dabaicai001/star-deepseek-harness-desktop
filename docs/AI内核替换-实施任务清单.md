# AI 内核替换实施任务清单(deepseek-harness)

> 配套方案文档:[`AI内核替换方案-deepseek-harness.md`](./AI内核替换方案-deepseek-harness.md)(下称「方案」,章节号引用该文档)。
> 用法:按 Phase 顺序实施,每完成一项打钩(`[x]`)并在条目后注明产出/结论;涉及代码的 commit 遵循 AGENTS.md 6.5.1 版本号规则。
> 创建:2026-08-14

---

## Phase 0:POC(风险验证,目标 1 周出结论)

- [x] P0-1 建立 `vendor/deepseek-harness/` 源码副本(方案 6-Phase0-0 / D6)——✅ 2026-08-14,锁定上游 commit `47f9438`(commit `782b480`);注:实际保留了 `docs/`(裁的是 `.git`/`website/`/`.github`),剔除 `website/` 导致 doc-site 脚本编译错,已用 tsconfig exclude 修复(方案附录 G-2)
- [x] P0-2 裁剪最小子集(方案 D6)——✅ 2026-08-14,`pnpm install`(4m23s)+ `build:lib:host` 全绿;最小保留子集清单已定(方案附录 11.6),物理裁剪随 exe 管线一起做
- [x] P0-3 Windows 单文件 exe 打包验证(方案 D2)——✅ 2026-08-14,`@yao-pkg/pkg --sea` 产出 172MB win-x64 exe 并冒烟通过;一键复跑稳定性有 3 个遗留问题(方案附录 11.5),不阻塞
- [x] P0-4 Rust ↔ dsh stdio JSON-RPC 最小回路(方案 6-Phase0-2)——✅ 2026-08-14,`src-tauri/src/harness/`(spawn + NDJSON 协议)+ `src-tauri/src/commands/harness.rs`(3 个 command)+ `src/services/aiHarness.ts`;端到端测试 `harness::tests::dsh_stdio_roundtrip_with_mock_llm` 连跑 4 轮全绿(mock LLM 实跑 initialize→流式→idle→shutdown),`cargo:test` 81 passed,`vue-tsc` 通过;验证日志 `tmp/dsh-p0-4-rust-roundtrip.log`
- [x] P0-5 cancel 方案验证(方案 D1)——✅ 结论:SDK 协议**无 cancel**(-32603 unknown method,实测流式中取消无效),杀进程兜底已验证;进程内 `Agent.cancel()` 存在(ACP server 在用),给 SDK server 加 `session/cancel` 是小补丁,列入 Phase 1 候选
- [x] P0-6 审批桥技术可行性验证(方案 D3)——✅ 结论:可介入;审批 seam 是 cordis 服务 `ctx.approval.request()`,需自写 answerer 插件桥到 stdio(现成参考 `packages/acp/acp/src/index.ts:215-229`);现 jsonrpc-agent 组合未挂 user-approval,需审批的工具 fail closed

**Go/No-Go 门槛(方案 6):P0-3 / P0-4 / P0-5+P0-6 全部通过才进入 Phase 1;P0-3 失败且无备选 = 整体方案重议。**

- [x] P0-G Go/No-Go 结论——✅ **Go**(2026-08-14):exe 打包 ✅、协议回路全链路 ✅(Node 驱动 + Rust 桥端到端测试均通过)、cancel 有兜底 ✅、审批桥路径明确 ✅;完整 POC 结论见方案附录 11。**Phase 0 全部完成,进入 Phase 1**

## Phase 1:全局 AiView 切换(单宿主试点)

- [x] P1-1 新建 `src/services/aiHarness.ts`(前端 dsh 会话封装)——✅ 2026-08-14:P0-4 已产出初版,Phase 1 重写为 initialize(模型参数)/prompt/cancel/shutdown/会话级订阅 hub(按 sessionId 路由,prompt 前 await 消除竞态)/promptStream;新增 `src/services/aiHarnessProjection.ts` 事件投影(块模型 user/assistant/tool/todo/notice/subagent/error),`tests/ai-dsh-projection.test.mjs` 11 测试全绿
- [x] P1-2 新建 `src-tauri/src/harness/`(Rust 侧 runtime 启动 + stdio 桥)——✅ 2026-08-14:P0-4 已产出 spawn + NDJSON JSON-RPC 桥;Phase 1 增加 DshModelConfig 模型参数注入(DEEPSEEK_API_KEY/DEEPSEEK_BASE_URL/DSH_SYSTEM_PROMPT/DSH_CWD/DSH_SESSION_ROOT)、spawn 指纹自动重启、cancel(杀进程兜底)/abort、subagent 事件转发;P1-4 升级双向 request 分发;支线 B 接入包装配置生成;e2e 3 个(mock LLM 回路/工具桥/包装配置启动)真跑全绿
- [x] P1-3 AiView 切换到 dsh 会话(流式事件渲染,方案 5.4)——✅ 2026-08-14:AiView 整文件重写,消息区改渲染投影 blocks;send() = resolveModelConfig → dshInitialize(systemPrompt = aiStore.buildAgentPrompt)→ 指纹重启时 adoptFreshSession → dshPrompt;stop() = dshCancel + notice;保留 mention/Agent 侧栏/滚动锚点/AiModelSelector/devMock;vue-tsc 绿
- [x] P1-4 工具集第一批:workspace 工具(starhub_list_capabilities 等)+ session_search + memory(方案 3.2)——✅ 2026-08-14,新增 vendor 本地包 `packages/starhub/tools/`(4 个工具经 SDK 双向 request `starhub/tool.execute` 桥回 Rust)+ sdk/server transport 暴露补丁(`ctx.provide('sdk-transport')`,补丁清单见方案附录 11.9)+ Rust 侧 `src-tauri/src/harness/tools.rs`(含 memoryGuard 安全扫描移植)与 `harness/mod.rs` 双向 request 帧支持;`cargo test harness` 8/8 绿(含新增 e2e `dsh_tool_call_bridges_to_host`:mock LLM tool_call → 桥执行 → 结果回注),vendor `build:lib:host` 绿;memory 的 asset 级与确认闸待 P2-7 / D3 审批桥
- [x] P1-5 Planner→Executor 切换为 dsh plan mode / subagent(方案 D8)——✅ 2026-08-14(部分):cordis.yml 已挂 subagent 系 3 个插件 + tool-todo,投影支持 todo/write 与 subagent.started/finished 渲染;**plan mode 暂缓**——其 exit_plan_mode 依赖 ctx.userQuestions 审批缝,须待 D3 审批桥落地后启用
- [x] P1-6 旧内核调用路径随切换直接删除:不做 feature flag 并存,不留回退方案(方案 6-Phase1,已拍板)——✅ 2026-08-14(AiView 路径):planAndExecute/runPlanStep/executePlan/确认卡/pendingSteers/Planner 面板/workspaceTools/ctx 压缩按钮全部从 AiView 移除,grep 验证无残留;stores/ai.ts 的 runAgent 等仍被 AiChat 宿主(SSH/DB 等内嵌助手)使用,P3-4 才退役

## Phase 2:本地工作区与资产绑定

- [ ] P2-1 #LOCAL 切换 dsh fs/bash 工具(方案 5.1 方案 A);LocalView 目录 = session cwd
- [ ] P2-2 starhub-ssh-tools 包(SSH/SFTP 工具,含 hostkey 确认桥);SshTerminal 宿主切换
- [ ] P2-3 starhub-db-tools 包(MySQL/PG/SQLite/ClickHouse/MSSQL)+ DbView 宿主切换
- [ ] P2-4 redis / es 工具包 + 对应宿主视图
- [ ] P2-5 docker 工具包 + DockerView 宿主切换
- [ ] P2-7 绑定集合的 agent-scoped 插件机制落地(方案 D4)
- [ ] P2-8 确认/安全语义迁移逐项核对(方案 5.2:commandGuard 平移 + 测试)

## Phase 3:收尾与退役

- [ ] P3-1 三级记忆卡系统接入 dsh(方案 5.3 / D5 / D8)
- [ ] P3-2 SettingsView AI tab 改造(模型配置 → dsh route,方案 4.3)
- [ ] P3-3 MCP 归并(方案 D7)
- [ ] P3-4 退役 `src/stores/ai.ts` runAgent/Planner/压缩、`src/services/ai.ts`、`aiWorkspace.ts`、`aiLocal.ts`(方案 3.4)
- [ ] P3-5 退役 Rust 旧 AI 网关
- [ ] P3-6 测试补齐:桥层协议单测、工具 schema 快照测试、事件投影渲染测试;`tests/ai-*.test.mjs` 按新架构重写

## 支线 A:设计语言与前端改造(方案 9,可与主线并行)

- [x] D0 token 层合并(方案 9.3 映射表落地到 `src/styles/cyber.css`)——✅ 2026-08-14:`--shadow-1/2/3` 克制档(`--shadow`/`--shadow-soft` 改别名)、`--line`/`--line-2` 改 hairline(暗 0.06/0.12、亮 0.04/0.10)、新增 `--hover-neutral`/`--active-neutral`、`--radius-chip/control/menu/card/modal/pill`、`--font-sans/mono/display`(等宽去裸 monospace)、`--text-2xs~xl` 字号梯度、`--scrollbar-thumb*`;`--glow-*` 标注仪式场景专用;亮主题同步重做;支线 C 三候选评审并入:`--radius-bubble`、`--ease-emphasize`+`--dur-emphasize`、`@keyframes cyber-chase`(均只入定义层,D2 引用)
- [x] D1 按钮 / 输入框 / 标签 / 卡片组件类改造(胶囊按钮、hairline 边框等)——✅ 2026-08-14:`.cyber-btn*` 胶囊化 + 阴影 lv1/lv2、`.cyber-panel`/`.cyber-card`/`.connection-card` 圆角 16、`.context-menu` 圆角 12 + 修复无效 box-shadow、`.cyber-input`/`.cyber-select`/`.cyber-search` 圆角 token 化、核心类 hover 全面中性化(tree-item / action-btn / context-menu / cyber-tab / auth-chip / segment / win-btn / input-suffix-btn),交互过渡统一 `var(--dur-fast) var(--ease-standard)`(0.2s standard)
- [ ] D2 AiView / 聊天气泡 / 设置页按 dsh 信息架构重做
- [x] D3 表格 / 终端等重组件仅在受益点轻量对齐——✅ 2026-08-14:全局滚动条契约落地(8px / thumb 圆角 4px / track 透明,色走 `--scrollbar-thumb*`);hairline 随 token 级联生效;transfer-dock pill / zmodem 条 / alert-rule-card / db-grid-loading-pill / tab-detach-hint / docker-transport-switch / terminal-quick-btn 的光晕阴影收敛为 `--shadow-*` 档;未动任何 `.ai-workspace-*` 结构
- [x] D-VERIFY 每个 D 节点执行方案 9.4 的验证清单(视觉走查 + 组件抽检 + 对比截图)——✅ 2026-08-14(代码级替代:环境无浏览器自动化):`npm run build`(vue-tsc + vite)绿;`git diff` 抽检新增颜色字面量仅出现在 `:root` token 定义,组件类零新增硬编码色/阴影;裸 `monospace` 全量清除(73 处 → `var(--font-mono)`);视觉走查与对比截图待真实浏览器回归(AGENTS.md 7.3)补做

## 支线 B:插件生态与用户自行引入(方案 8.3,P2 级)

- [x] B-1 vendor 副本保留 Cordis profile patch / `dsh.bundle` manifest 加载机制——✅ 2026-08-14:机制本就在 vendored Cordis Loader / Include / app-boot 中,零代码改动;调研修正:**Include 是 tree carrier(`EntryGroup.key`),config 保持 literal,`path` 不支持 `!!js` env 注入**,落地点改为 Rust 生成包装配置(见 B-3);`cordis:include` 是 app-boot 注册的内建插件,任何位置的配置可直接引用
- [x] B-2 应用数据目录 `plugins/` + 前端快捷导入(市场 / URL / 本地三入口)——✅ 2026-08-14:布局 `<app_data_dir>/plugins/{cordis.yml,registry.json,market-cache.json,<id>/,node_modules/@deepseek-ai/*}`;市场数据源 awesome-dsh-plugin(README.zh.md + data/*.json,抓取失败降级空目录/缓存不报错);URL 入口走 codeload zip(非 git clone,无需依赖用户机器装 git);本地目录/zip 经 plugin-dialog 文件选择器导入
- [x] B-3 Rust 安装管线(下载/拷贝 → 校验 manifest → 写入 runtime cordis 配置 → 重启 dsh runtime)——✅ 2026-08-14:`src-tauri/src/harness/plugins.rs` + `commands/dsh_plugins.rs`(6 个 command);决策:**zip crate 2.x(default-features 关,只开 deflate)**;**首版只支持零依赖插件**(dependencies 非空拒装);UI/皮肤类双保险拒装(dsh.client 字段 + 包名分段启发式);Zip Slip 用 `enclosed_name()` + 剥顶层目录后二次组件校验;peer 依赖用 junction(Windows `mklink /J`,回退整目录复制);启停落 `plugins/cordis.yml` 的 `disabled` 字段(独占生成、单引号转义、禁 `!!js`);**重启生效由前端 shutdown 触发**;spawn 前由 `plugins::prepare_runtime_config` 生成 `<app_data_dir>/dsh-cordis.generated.yml` 包装配置(主组合 + 用户插件两条 cordis:include entry),vendor cordis.yml 零改动
- [x] B-4 Settings 插件管理 UI(逐项启用,默认关闭,仅限运行时类插件)——✅ 2026-08-14:SettingsView 新增 `plugins` tab(已装列表 + 启停/卸载 + URL/本地安装 + 市场浏览搜索),首次启用弹 ConfirmDialog 风险提示(本机代码权限,按插件 id 记一次确认),每项操作后 `aiHarness.shutdown()`;`src/services/aiDshPlugins.ts` 薄 invoke 封装;i18n 中英文案;**坏插件自救首版降级为手动引导**(initialize 失败提示去插件页禁用),自动禁用留 TODO(plugins.rs 模块注释)

## 支线 C:皮肤/风格导入(方案 8.2,非完整适配)

- [x] C-1 dsh-deep-whale 风格元素评估提取(配色/圆角/质感 → token 候选)—— 2026-08-14 完成,产出 `docs/皮肤风格评估-dsh-deep-whale.md`(token 候选表)
- [x] C-2 maid-atelier 素材评估(CC BY-NC-SA 素材不入库,仅参考)—— 2026-08-14 完成,产出 `docs/皮肤风格评估-dsh-deep-whale.md`(素材清单 + 许可链评估)

---

*完成标准:Phase 3 全部打钩 + 方案第 6 章各 Phase 退出条件满足。*
