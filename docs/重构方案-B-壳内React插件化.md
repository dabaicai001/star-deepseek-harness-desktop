# 重构方案 B:去 iframe,StarHub 工具壳内 React 插件化

> 状态:方案稿(只出方案,先不动代码)
> 关联:`docs/重构方案-交互与信息架构.md`(产品目标)、`docs/dsh主壳融合-任务清单.md`(P0–P6 已落地)、`docs/设计系统.md`
> 目标:把 StarHub 工具从「Vue + iframe」整体重写为「dsh 壳内 React 插件」,最终删除整个 Vue 应用(`src/`),实现真正的单技术栈、同进程、边聊边做。

---

## 0. 为什么是 B

当前形态:

```
dsh 壳(React,apps/web + client 插件)   ←── 语言 React
        │  iframe 边界(postMessage 协议 + Tauri IPC 白嫖)
StarHub 工具(Vue 3 + Vite,独立 app,base /starhub/,dist-embed)  ←── 语言 Vue
```

「把 Vue 改成 React 但保留 iframe」不会带来统一:语言一致了,但仍然是两个应用、两套构建、一个进程边界。**唯一有意义的统一是去 iframe、工具搬进壳内同进程渲染**,这就是 B:

- AI 上下文绑定从「postMessage 往返 + 新扩展点」变成「同进程直接读工具状态」,难度降一个数量级;
- 视觉、组件、store、i18n、构建全部并入 dsh 一套体系;
- 「资产为中心」「连接上下文头部」天然成为壳的一部分,而不是 iframe 里的自绘条。

代价:**这是一次重写,不是翻译**。Vue 侧现有 71 个 `.vue`(约 3.2 万行)+ 72 个 `.ts`(约 1.5 万行),且要遵守 vendored dsh 的包规范(每包 100% 覆盖率 gate、slot/store 纪律、invariant、Agent Note)。因此本方案的核心不是「怎么重写」,而是**怎么增量迁移、每步可回退、直到 iframe 可以整体退役**。

---

## 1. 落地形态

### 1.1 代码归属

工具插件与现有 `client-nav` / `host-static` 同处:

```
vendor/deepseek-harness/packages/starhub/
├── client-nav/          # 已有:侧栏导航 + overlay 层(最终被拆)
├── host-static/         # 已有:托管 Vue dist-embed(最终退役)
└── <tool-domain>/       # 新增:每工具一个 client 插件包(或先合并大包,见 D3)
```

每个新插件包遵循 `packages/client/AGENTS.md` 的清单:三处注册面(`tsconfig.client.json` 聚合 + `packages/bundle/web-app/cordis.patch.yml` 行 + `package.json` 依赖)、`dsh.client` manifest(`platform: 'web'`)、`src/client/` 浏览器半 + 空 node 半 + `invariant.ts`。

### 1.2 渲染席位

工具渲染进壳,不再有 iframe。候选席位见第 3 节决策 D1;当前最贴合「左聊右做」的是改造后的 `details` 右栏(或 ui-layout 新增 workspace 席位)。

### 1.3 数据与 IPC

- **资产/连接数据**:直接调顶层帧 Tauri IPC。P0 spike(2026-08-15)已实测顶层帧 `__TAURI_INTERNALS__.invoke` 存在且可真实往返,无需 `dangerousRemoteDomainIpcAccess`。
- **资产清单**:复用现有 Rust command(`src-tauri/src/commands/asset.rs` 的 `get_assets` 等),React 侧封装为 service + dsh store(`defineStore`,zustand 内核)。
- **工具域命令**:`ssh_*` / `sftp_*` / `db_*` / `docker_*` / `broker_*` 等全部不动,React 插件只是换了调用方。
- **连接状态**:提升到壳级 store,跨会话保活(见 D2)。

### 1.4 视觉与文案

- 全部走 `--dsw-*` token + dsh `ui-primitives`,不再有 `cyber-*` 类与 `cyber.css`(注意:现状 `cyber-*` 在 `.vue` 里有 418 处引用,退役只能随 Vue 应用一起删,不能提前删——见交互方案评审的修正)。
- 用户文案走 dsh locale 体系(`product copy 中文`),不再用 vue-i18n。

### 1.5 不改动的东西

- Rust 主进程与 Go sidecar:**零改动**(React 插件调的是同一批 Tauri command)。
- dsh 核心会话/模型/凭据层:不动(与交互方案一致)。

---

## 2. 迁移路线:iframe 保留到全部迁完

核心策略:**每一个工具先以 iframe 形态在壳里正常服务(现状),逐个替换为壳内 React 插件;未迁移的工具继续走 host-static + embed 协议,直到最后一个迁完,再一次性退役整个 Vue 面。** 每一步可回退、可独立验证。

| Phase | 内容 | 验收标准 | 主要改动面 |
|---|---|---|---|
| P0 | **地基 spike**:工具工作区席位形态(决策 D1)+ 资产 service/store(React)+ sections 单一事实表落地 + 连接上下文头部(React 版,替代 EmbedAssetBar)+ Tauri IPC 直调验证 | 壳内直渲一个最小工具占位(无 iframe),资产列表可见,切会话状态保活 | `ui-layout` 或 `ui-conversation`(席位)、新增 `starhub/` 基础包、`client-nav` |
| P1 | 首批最小工具:**Broker**(纯元数据展示)+ **Excel**(Univer 框架无关,白捡) | 真连测试服务器/真实文件往返,DOM 级证据,与 iframe 版行为一致 | 各工具插件包 + 壳级资产 store |
| P2 | 中等工具:**Redis → Docker → Elasticsearch** | 同上 | 各工具插件包 |
| P3 | 大件:**SSH/SFTP**(xterm + zmodem)、**DB**(DbView 2500+ 行,最后做) | 真连 test-sftp stub + 真实 DB 往返;连接状态在壳 UI 可见 | 各工具插件包 |
| P4 | **退役**:删除 `src/` Vue 应用、`host-static`、`dist-embed` 构建、`embed.ts` / `CyberLayout` / `EmbedAssetBar` / `EmbedSectionEmpty`、`starhub-embed-*` postMessage 协议、client-nav 的 overlay 注册;版本发布 | 无 iframe、无 Vue 依赖、`npm run build:embed` 脚本删除 | 仓库级清理 + 文档同步 |

每个工具迁移的验收口径:**壳内直渲 + 真连 + 连接状态壳 UI 可见 + 与 iframe 版功能对齐**(对照 `docs/技术方案.md` 的功能矩阵)。

---

## 3. 开工前必须拍板的三个设计决策

### D1 工具席位形态(唯一碰 dsh 核心 UI 的地方)

现状 `ui-layout` 顶层席位(`packages/client/ui-layout/src/client/index.ts`):

- `sidebar`(root 单席,被 SidebarRoot 占用)
- `conversation`(session-maybe 单席,被 ConversationRoot 占用)
- `details`(**session 单席**,被 ui-conversation 的 DetailsPanel 占用,内含 `conversation.details.tool`)
- `shell.overlay`(root 列表席,当前工具所在)

候选:

| 方案 | 形态 | 优点 | 代价 |
|---|---|---|---|
| A. details 改 `session-maybe` + 新增「工具工作区」内席 | 右栏 = DetailsPanel(工具调用详情)与工具工作区 tab 共存 | 原生三栏、无会话也可达、与「边聊边做」最贴合 | 要改 vendored `ui-conversation` 的 `details` 注册与 `DetailsPanel`,并处理与 `conversation.details.tool` 的共处;跨包改动 + 100% 覆盖门槛 |
| B. ui-layout 新增独立 workspace 席位 | 第四个顶层列/面板,专放工具 | 不与 DetailsPanel 冲突,语义干净 | 改 ui-layout 的 AppFrame(列计算/拖宽/折叠),动静最大 |
| C. `conversation.view` 页签 | 工具作为聊天区 tab | 改动最小(P0 验证过) | 仍是「聊天 ↔ 工具」二选一,不满足边聊边做——**与 B 的目标冲突,排除** |

**推荐 A**,但需在 P0 spike 里实测两个硬约束:无会话时右栏可达性(AppFrame 现在 `detailsSession === undefined ? 0 : panels.details` 列宽归零)、以及切会话时工具状态去向(见 D2)。若 A 的 tab 共处代价过大,退回 B。

> **P0 spike 实测记录(Step 1,2026-08-15)**:壳内直渲已验证可行——
> 1. **`conversation.view` 页签 + Tauri IPC 直调成立**:`client-nav` 新增 `starhub-tools` 页签(`StarHubToolWorkspace.tsx`),壳内 React 直渲(无 iframe),挂载时经顶层帧 `__TAURI_INTERNALS__.invoke('get_assets')` 拉资产列表写入共享 asset store(`asset-store.ts`,defineStore);`pnpm exec tsc -b` + tsdown 构建通过,4 个组件测试(空态/加载/错误/列表)全绿。
> 2. **独立测试实例验证**:为不干扰线上 3085(当前 GUI),在 **3086** 起独立 DSH_HOME 测试实例(port 3085→3086 改写 + client-nav junction 指向仓库 vendor 新 bundle):`/plugins/.../client-nav/client.js` 返回 14944B 新 bundle(含 `starhub-tools`)、boot rev 更新、注入含 `dsh-client-ui-conversation`;3085 保持 9255B 旧 bundle 不受影响。
> 3. **关键发现(反直觉)**:本地开发改 `vendor/deepseek-harness/packages/starhub/client-nav` **不会**即时影响运行的 dsh web——线上实例经 `web.rs` 的 junction 指向 `runtime_dir`(本机为 `E:\StarHub1\dsh-runtime`,部署副本,非 git 仓库),需要把构建产物同步过去或用独立 DSH_HOME 起测试实例。验证完已把 3085 的 dsh-runtime 回滚到旧 bundle。
> 4. **D2 数据佐证**:`conversation.view` 是 session scope,store 按 handle × scopeKey(sessionId)缓存实例——资产这类全局数据放 per-session 实例会随会话切换重建,验证了「长生命周期状态必须提升到 root-scope 承载」的必要性。
> 5. **D1 修正**:Step 1 用 `conversation.view` 仅作载体验证「壳内直渲 + IPC + store」链路;`details` 右栏席位改造(方案 A)在 Step 2 完成(见下)。
>
> **P0 spike 实测记录(Step 2,2026-08-15,修订版)**:`details` 右栏停靠工具工作区——
> 1. **改动落点(修订版)**:`details` 席位**保持 `session` scope**(不可改 session-maybe,见下);`ui-conversation` 的 `DetailsPanel` 新增 `details.workspace` 内席,无选中工具调用时右栏渲染 StarHub 工具工作区(fallback 保留原 guidance,vanilla dsh 不受影响),选中工具调用时显示调用详情;`client-nav` 工具工作区从 `conversation.view` 迁到 `details.workspace`,侧栏新增「工具工作区」入口(经 `ctx.layout.openDetails()` 打开右栏);StarHubToolWorkspace 挂载时直调 Tauri IPC `get_assets`。
> 2. **架构障碍(实测发现,推翻方案 A)**:dsh 有硬约束 **`one handle, one scope`**(`SlotCore.register`)—同一 store handle 不能跨 scope 挂载。`DetailsPanel` 与 `conversation.session` 等共享 `chatStore`(session pin),若 `details` 改 `session-maybe` 则同一 handle 跨 scope → 注册抛错。**结论:`details` 不能改 session-maybe;「无会话时右栏可达」需要独立的 workspace 顶层席位(方案 B 的独立列),即几何改动(AppFrame 加列 + columns/stores),留待后续。**
> 3. **硬约束 2(切会话保活)部分成立**:DetailsPanel 有会话时渲染,无选中时显示工具工作区——「有会话时边聊右做」成立;「无会话可达」受方案 B 待办限制。
> 4. **回归**:`tsc -b tsconfig.client.json` 全量通过;703 个测试全绿(含 DetailsPanel workspace fallback、ui-tool 空态适配);`package:dsh-runtime` 本地复现通过——**修复了 GitHub CI `build:lib:client` 的类型错误**(改 details scope 引发的连锁测试声明冲突已全部对齐)。
> 5. **部署约束(新发现,重要)**:浏览器级验证受 dsh 启动机制限制——`apps/cli` 每次启动经 `healProfilesModuleFallback` 从安装锚点(apps/cli 的依赖闭包)**强制重置** `profiles/node_modules` 里核心包(ui-layout/ui-conversation 等)的 junction 指向 dsh-runtime 实体,测试 DSH_HOME 无法让这些包指向仓库 vendor;而 dsh-runtime 实体文件被 3085(当前 GUI)共用,不能覆盖。**结论:修改 dsh 核心 UI 包后,浏览器级验证需要「重启应用让 Rust 重新物化」或「独立 runtime 副本」**;本 spike 的 Step 2 验证以单元测试为准。
> 6. **D1 结论(更新)**:方案 A(details 改 session-maybe)**被 one-handle-one-scope 否决**;采用修订版(DetailsPanel 内席,有会话时边聊右做);「无会话可达」需方案 B 独立列(AppFrame 几何改动),标记为 P1 前置项。
>
> **P0 spike 实测记录(Step 3,2026-08-15,交互升级)**:右侧列改造成「工具大类 → 子类 → 资产列表」——
> 1. **交互形态(用户确认)**:侧栏「工具工作区」升级为**大类**(可展开,对齐 dsh WorkspaceBrowser 分组),下挂**子类**:终端、数据库、Docker;点子类 → 右侧 workspace 列显示该类型的**资产列表**;点资产行 → **弹出该实例的操作页**(复用现有 embed iframe 功能页,功能与之前完全一致);右侧列交互(展示/切换/新建连接)与现状一致。
> 2. **落地要点**:`sections.ts` 扩展为「大类 → 子类 → 资产路由」三层事实表;子类定义资产类型匹配(复用 `routeNameForAsset` 映射:终端=ssh、数据库=db 各子类型、Docker=docker);`StarHubToolWorkspace` 从「全部资产列表」改为「按所选子类过滤」;实例操作页复用 `sectionEmbedUrl(route + instanceId)` 的 embed iframe,后续随 P2 逐个壳内 React 化。
> 3. **与既有实现的关系**:workspace 席位(session-maybe,无会话渲染)与 details 内席(有会话)已就位,本次只改右侧列的**内容逻辑**(子类过滤 + 资产行点击)与**侧栏结构**(大类/子类);操作页先用 iframe,不阻塞 B 路径的渐进迁移。

### D2 会话切换时工具状态保活

- 现状:iframe 挂 `shell.overlay`(root scope),切会话不受影响;若搬进 `details`(session scope),**切会话会卸载整个右栏 → SSH/SFTP 连接状态全丢**。
- 方案:连接/传输等长生命周期状态**提升到壳级 store**(与 session 解耦),工具组件只做投影;切会话时组件重挂,但 store 里的连接句柄不销毁。
- 验收:P0 spike 里「切会话 → 终端不断线」作为硬指标。
- **P0 spike 实测(Step 1)**:确证 store 实例按 `handle × scopeKey` 缓存,`conversation.view`(session scope)下资产 store 每会话重建——全局数据必须由 root-scope 承载(或 apply 闭包持有、经 inject 注入组件),这是后续 `details` 席位改造必须遵守的约束。

### D3 包粒度

- dsh 规范倾向一域一包(每包独立过 100% 覆盖率 gate、独立 `invariant.ts`)。
- StarHub 有 8+ 工具域,若直接拆 8 个包,初期规范成本高。
- 建议:**先一个 `starhub-tools` 大包快速跑通 P1–P2,验证「壳内直渲 + 保活 + AI 上下文」全链路后,再按域拆分**(拆分是纯搬移,风险低)。

---

## 4. 风险与缓解

| 风险 | 说明 | 缓解 |
|---|---|---|
| dsh 包规范成本 | 每包 100% 覆盖率 gate、invariant、Agent Note,比「翻译成 React」贵 | P1 先建一个最小包摸清门槛;D3 先大包后拆 |
| 巨型组件重写回归 | `DbView.vue`(2500+ 行)、`SettingsView.vue`(3000+ 行)重写行为极易漂移 | DB 放 P3 最后;对照功能矩阵逐项验收;每工具迁移期间 iframe 版保留可对照 |
| 同进程隔离/性能 | 工具崩溃不再是「iframe 白屏」而是壳内组件崩溃;全部工具常驻同一 React 树 | 席位组件包 SlotErrorBoundary(壳已有);懒加载/按需挂载工具 |
| vendor 同步 | 工具插件加在 vendored dsh 树内,上游同步时需保留本地包 | 延续 `client-nav` 先例,记录本地修改清单 |
| 退役时机过早 | 若 in-flight 迁移中删 iframe,未迁移工具直接不可用 | 铁律:最后一个工具迁完才动 P4 |

---

## 5. 与既有方案的关系

- **产品目标不变**:`docs/重构方案-交互与信息架构.md` 的「资产为中心 / 对话优先 / 一步到位」全部继承。
- **该方案的 P1(导航分组 + 连接头部 + 打开即用 + 单一事实表)照做**,与 B 无冲突,是 B 的前置产品价值。
- **该方案的 P2(overlay → details 停靠 iframe)被 B 吸收替代**:P2 是「iframe 换个席位」,B 是「iframe 变插件」;跳过 P2,直接在 B 的 P0 做席位改造。
- **资源中心、AI 上下文绑定**是 B 的自然产物:资产 store 壳内化后,「资源中心」就是侧栏一个读壳级 store 的列表;AI 上下文同进程直读,不再需要 postMessage 扩展点。

---

## 6. 版本与文档

- 本方案为纯文档,按 `AGENTS.md` 6.5.1 走修订版(z)+1,同步七处版本号。
- 实施启动后,每个 Phase 结束更新 `CHANGELOG.md`、`docs/技术方案.md`、`docs/架构图.html`、`AGENTS.md`(架构级变更四件套)。
