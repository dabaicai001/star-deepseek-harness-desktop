# AI 内核替换实施任务清单(deepseek-harness)

> 配套方案文档:[`AI内核替换方案-deepseek-harness.md`](./AI内核替换方案-deepseek-harness.md)(下称「方案」,章节号引用该文档)。
> 用法:按 Phase 顺序实施,每完成一项打钩(`[x]`)并在条目后注明产出/结论;涉及代码的 commit 遵循 AGENTS.md 6.5.1 版本号规则。
> 创建:2026-08-14

---

## Phase 0:POC(风险验证,目标 1 周出结论)

- [ ] P0-1 建立 `vendor/deepseek-harness/` 源码副本(方案 6-Phase0-0 / D6):锁定上游 commit `47f9438`,保留 LICENSE,剔除 `.git`、`website/`、`docs/` 等无关目录
- [ ] P0-2 裁剪最小子集(方案 D6):core 脊柱 + llm + 适配器 + sdk protocol/server + 必需工具包;`pnpm install` 与最小构建跑通
- [ ] P0-3 Windows 单文件 exe 打包验证(方案 D2):dsh runtime 打成 sidecar 可分发产物;失败则验证「内置 Node + lib 闭包」备选
- [ ] P0-4 Rust ↔ dsh stdio JSON-RPC 最小回路(方案 6-Phase0-2):`initialize` → `session/prompt` → 收 `session.event` → 前端渲染一条流式回复(参考 deepseek-harness-tui)
- [ ] P0-5 cancel 方案验证(方案 D1)
- [ ] P0-6 审批桥技术可行性验证(方案 D3)

**Go/No-Go 门槛(方案 6):P0-3 / P0-4 / P0-5+P0-6 全部通过才进入 Phase 1;P0-3 失败且无备选 = 整体方案重议。**

- [ ] P0-G Go/No-Go 结论记录(结论写回本条目)

## Phase 1:全局 AiView 切换(单宿主试点)

- [ ] P1-1 新建 `src/services/aiHarness.ts`(前端 dsh 会话封装)
- [ ] P1-2 新建 `src-tauri/src/harness/`(Rust 侧 runtime 启动 + stdio 桥)
- [ ] P1-3 AiView 切换到 dsh 会话(流式事件渲染,方案 5.4)
- [ ] P1-4 工具集第一批:workspace 工具(starhub_list_capabilities 等)+ session_search + memory(方案 3.2)
- [ ] P1-5 Planner→Executor 切换为 dsh plan mode / subagent(方案 D8)
- [ ] P1-6 旧内核调用路径随切换直接删除:不做 feature flag 并存,不留回退方案(方案 6-Phase1,已拍板)

## Phase 2:本地工作区与资产绑定

- [ ] P2-1 #LOCAL 切换 dsh fs/bash 工具(方案 5.1 方案 A);LocalView 目录 = session cwd
- [ ] P2-2 starhub-ssh-tools 包(SSH/SFTP 工具,含 hostkey 确认桥);SshTerminal 宿主切换
- [ ] P2-3 starhub-db-tools 包(MySQL/PG/SQLite/ClickHouse/MSSQL)+ DbView 宿主切换
- [ ] P2-4 redis / es 工具包 + 对应宿主视图
- [ ] P2-5 docker 工具包 + DockerView 宿主切换
- [ ] P2-6 excel 工具包 + ExcelView 宿主切换
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

- [ ] D0 token 层合并(方案 9.3 映射表落地到 `src/styles/cyber.css`)
- [ ] D1 按钮 / 输入框 / 标签 / 卡片组件类改造(胶囊按钮、hairline 边框等)
- [ ] D2 AiView / 聊天气泡 / 设置页按 dsh 信息架构重做
- [ ] D3 表格 / 终端等重组件仅在受益点轻量对齐
- [ ] D-VERIFY 每个 D 节点执行方案 9.4 的验证清单(视觉走查 + 组件抽检 + 对比截图)

## 支线 B:插件生态与用户自行引入(方案 8.3,P2 级)

- [ ] B-1 vendor 副本保留 Cordis profile patch / `dsh.bundle` manifest 加载机制
- [ ] B-2 应用数据目录 `plugins/` + 前端快捷导入(市场 / URL / 本地三入口)
- [ ] B-3 Rust 安装管线(下载/拷贝 → 校验 manifest → 写入 runtime cordis 配置 → 重启 dsh runtime)
- [ ] B-4 Settings 插件管理 UI(逐项启用,默认关闭,仅限运行时类插件)

## 支线 C:皮肤/风格导入(方案 8.2,非完整适配)

- [ ] C-1 dsh-deep-whale 风格元素评估提取(配色/圆角/质感 → token 候选)
- [ ] C-2 maid-atelier 素材评估(CC BY-NC-SA 素材不入库,仅参考)

---

*完成标准:Phase 3 全部打钩 + 方案第 6 章各 Phase 退出条件满足。*
