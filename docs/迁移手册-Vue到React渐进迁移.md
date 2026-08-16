# Vue → React 渐进迁移手册(绞杀者模式)

> 状态:执行手册(配套 [`重构方案-B-壳内React插件化.md`](./重构方案-B-壳内React插件化.md))
> 关系:**方案 B 定战略**(为什么迁、分几个 Phase、三个设计决策 D1/D2/D3);**本手册定战术**——每一页具体怎么迁、映射关系是什么、验收看什么。
> 版本:v0.72.2 盘点数据(71 个 `.vue` / 32k 行,73 个 `.ts` / 15k 行)。

---

## 1. 五条铁律(每次迁移开工前读一遍)

1. **iframe 兜底到最后一刻**:未迁移的页继续走 `host-static` + embed 协议,任何一页迁坏了不影响其他页。最后一个页迁完之前,禁止删 `src/`、`embed.ts`、`EmbedAssetBar` 的任何一行。
2. **一次只迁一页**,一页一个 commit 主题、一次版本递增;client-nav 里该页路由从 iframe 切到壳内组件的那一行改动,必须能单独 revert。
3. **验收口径不妥协**(方案 B 第 2 节):壳内直渲 + 真连真实服务器往返 + 连接状态壳 UI 可见 + 与 iframe 版逐项对齐 `docs/技术方案.md` 功能矩阵。四条全过才算迁完。
4. **遵守 dsh 包规范**:vendored dsh 树内的每个包过 100% 覆盖率 gate、`invariant.ts`、slot/store 纪律(four-share props、one-handle-one-scope、root/session scope 分清)。迁移成本的大头在这里,不在「Vue 翻译成 React」。
5. **业务逻辑零重写**:`src-tauri/`(Rust)、`sidecar/`(Go)、`src/services/`(Tauri IPC 封装,仅 3 个文件耦合 Pinia)全部原样复用。React 侧只是换了调用方。

---

## 2. 家底盘点(v0.72.2 实测)

### 2.1 视图层(迁移对象)

| 视图 | 行数 | 复杂度 | 说明 |
|---|---:|---|---|
| BrokerView | 156 | ★ | 纯元数据展示 |
| WebBrowserView | 456 | ★★ | 内嵌浏览器壳 |
| ElasticsearchView | 504 | ★★ | ES 索引/查询 |
| RedisView | 519 | ★★ | 13 个 `components/redis/` 子组件 |
| ExcelView | 1172 | ★★★ | Univer(框架无关,白捡) |
| DockerView | 1222 | ★★★ | 容器/镜像/Compose |
| SettingsView | 3078 | ★★★★ | 8 个 tab;**特例见 §3.2** |
| DbView | 3116 | ★★★★★ | 12 个 `components/db/` 子组件 + objectTree,最后做 |
| SshTerminal(在 components/ssh) | 2459 | ★★★★★ | xterm + ZMODEM + 7 个子组件,最后做 |

组件目录:`ai` 5 / `common` 10 / `dashboard` 4 / `db` 12 / `docker` 1 / `es` 2 / `excel` 2 / `layout` 4 / `redis` 13 / `sftp` 1 / `ssh` 7 / `transfer` 1(共 62 个,随宿主视图一起迁)。

### 2.2 好消息:Vuetify 依赖极浅

实测全仓 Vuetify 组件用量:

| 组件 | 处数 | React 侧替代 |
|---|---:|---|
| `v-icon` | 558 | dsw 图标(`@deepseek-ai/dsw` 的 `Icon*Outline*`)或内联 SVG |
| `v-dialog` | 28 | dsh overlay 席 / ui-primitives 对话框 |
| 其余(v-spacer/v-text-field/v-list-item/v-menu/v-select/v-app) | ≤12 | 布局类直接 CSS,输入类自绘 + token |

真正的视觉面是 **448 处 `cyber-*` 类引用**——样式不是「组件翻译」而是「token 翻译」:`cyber.css` 的 `--cyber-*` → dsh 的 `--dsw-*`(映射表见 §4.4)。

### 2.3 状态层(11 个 Pinia store)

| store | 持久化 | React 侧去向 |
|---|---|---|
| `asset` | ✓ | **壳级 root store**(`defineStore` + persist key),方案 B 已 spike |
| `app` / `theme` | ✓ | 壳已自带(主题走 dsh 设置);`app` 的 tab 体系随壳内席位重设计 |
| `db` / `objectTree` | ✓/✓ | 随 DbView 最后迁,root-scope 承载(连接句柄跨会话保活,D2) |
| `docker` / `excel` / `transfer` / `dialog` / `notify` | 部分 | 各域 React 插件内 store;`notify` 用壳通知体系替代 |
| `ai` | ✓ | **不迁**——AI 内核已替换为 dsh(见 `AI内核替换方案-deepseek-harness.md`),`ai.ts` 随 P4 整体删除 |

### 2.4 服务层(基本白拿)

`src/services/` 19 个文件,仅 `aiCompaction` / `aiMemoryReview` / `mcp` 各 1 处引用 Pinia store,其余全是纯 Tauri IPC 封装——**逐文件复制到 React 包,删掉 store 耦合(改为参数注入)即可**。

### 2.5 需要拍板的两个迁移面

- **i18n:866 处 `t()`**。dsh 产品文案直接中文,不走运行时多语言。建议:迁移时**直接内联中文文案**(与 dsh 规范一致),英文版在迁移完成前由 iframe 版继续提供。若要坚持双语,需接入 dsh locale 体系(成本另估)——**默认按内联中文执行,有异议在开工时提出**。
- **vue-router 11 条路由**:全部映射为壳内状态(子类选择 + 资产 id),不再有 URL 路由;client-nav 的 `routeNameForAsset` / sections 事实表(§3.3)就是替代物,已在用。

---

## 3. 迁移顺序与每页去向

### 3.1 排序逻辑与排期

按「复杂度 ↑ × 独立性 ↑」排序(独立性 = 少共享组件、少跨页状态),对齐方案 B 的 Phase:

| 序 | 页 | Phase | 理由 |
|---|---|---|---|
| 1 | Broker | P1 | 156 行纯展示,验证全链路的最小样本 |
| 2 | Excel | P1 | Univer 框架无关,只换壳 |
| 3 | Redis | P2 | 中等,13 个子组件但自包含 |
| 4 | Docker | P2 | 中等,连接经 SSH 通道(复用 services) |
| 5 | Elasticsearch | P2 | 中等,与 DbView 有少量相似模式(为 DB 探路) |
| 6 | WebBrowser | P3 | 低频,简单但可放后 |
| 7 | Settings | 特例 | 见 §3.2 |
| 8 | SSH 终端 + SFTP | P3 | xterm/ZMODEM 重资产;连接保活(D2)硬指标 |
| 9 | DbView | P3 | 3116 行 + 12 子组件 + objectTree,压轴 |

每迁完一页:client-nav 对应路由切壳内组件 → 真连验收 → iframe 版该页进入「只读冻结」(不再改,等 P4 删)。

### 3.2 Settings 特例(已半迁)

v0.72.0 起 Settings 已以两种 embed 形态进壳(dsh 设置面板的 StarHub 分区 + 连接管理 overlay)。**React 化时按 tab 逐个迁,而不是整页迁**:AI / 通用 / 插件 / 审计 / 告警 / 关于 6 个 tab 各自成为 dsh 设置面板的独立 section(就是现在的 `settings.section` 注册,只是内容从 iframe 换 React);资产 tab 变为工具区的连接管理面板(React)。`visibleTabs` / `chrome=inline` 参数机制保留到全部 tab 迁完。

v0.76.0 起设置面板为**两列**:左侧 dsh 设置导航中 StarHub 为可展开分组(`settings.section` 注册带 `group: 'starhub'` + `groupLabel`,由 vendored `ui-settings-general` 的 SettingsRoot 渲染为折叠分组头,点击展开/收起,默认展开),5 个子项(AI 助手 / 插件 / 审计日志 / 告警规则 / 关于)各自直渲右侧内容,无面板内部嵌套列;旧版 SettingsPanel(面板内 rail + 内容区)已删除。

### 3.3 事实表更新规则

`vendor/deepseek-harness/packages/starhub/client-nav/src/client/sections.ts` 是「大类 → 子类 → 资产路由」唯一事实表。每迁一页,在该页的路由条目上加「壳内组件」分支(建议:`renderMode: 'iframe' | 'native'`),切换 = 改这一行,回退 = 改回来。禁止在别处硬编码「这页已迁移」。

---

## 4. 技术映射表(翻译词典)

### 4.1 框架层

| Vue 3 | React(dsh 壳内) |
|---|---|
| `<script setup>` + 模板 | 函数组件 + hooks;**组件只读 props 四份份额**(runtime/store/inject/渲染槽),不 import 全局单例 |
| `props` / `emits` | props / 回调 props(`onXxx`) |
| `v-model` | controlled props(`value` + `onChange`) |
| `watch` / `watchEffect` | store 选择器订阅(`useStore(sel)`)+ `useEffect`;**禁止用 effect 模拟派生状态**,派生用 `useMemo` 或选择器 |
| `onMounted` / `onBeforeUnmount` | `useEffect` 往返;长生命周期资源(连接句柄)放 root-scope store,组件只做投影(D2) |
| `provide` / `inject` | 插件 `dsh.client.inject` face / React context(限包内) |
| `ref` / `reactive` | `useState` / store draft mutator |
| Pinia `defineStore` + `persistedstate` | dsh `defineStore({ init, persist, actions })`(zustand 内核,persist key 同名迁移用户数据) |

### 4.2 状态读写纪律(vendored dsh 硬约束)

- store 按 `handle × scope` 缓存:**全局数据(资产/连接)root scope 或 apply 持有裸 source 经 inject `hooks` 舱位下发**(v0.71.1 范式);session 数据 session scope。one-handle-one-scope,违反直接抛错。
- 组件写入只走 `actions`(draft mutator),读只走 `useStore(selector)`。
- 跨包只许 `import type`,运行值走 inject face。

### 4.3 UI 组件

| 来源 | 去向 |
|---|---|
| Vuetify 9 个组件(§2.2) | `v-icon`→dsw 图标;`v-dialog`→overlay 席或 ui-primitives;布局/输入类→CSS + token 自绘 |
| `cyber-*` 组件类 | 不翻译类名,**直接引用 dsh ui-primitives / 各 ui-* 包组件**;无对应物时按 §4.4 token 自绘 |
| 自绘业务组件(62 个) | 逐组件随宿主页迁移,DOM 结构可保留,class 全换 |

### 4.4 视觉 token(cyber → dsw)

| cyber.css | dsh |
|---|---|
| `--cyber-bg-*` / `--cyber-panel*` | `--dsw-alias-bg-*` / `--dsw-layer-*` |
| `--cyber-accent` / 青色高亮 | `--dsw-alias-interactive-*` / `--dsw-specific-*-active` |
| `--cyber-text-*` | `--dsw-alias-label-primary/secondary/tertiary` |
| `--cyber-border*` | `--dsw-alias-border-*` |
| 阴影/圆角/间距常量 | dsh spacing/radius token;**禁止字面量颜色** |

迁移时以 `packages/client/ui-*/**/*.module.css` 的既有用法为准,对照 [`docs/设计系统.md`](./设计系统.md) 逐页校对视觉。

### 4.5 第三方库(框架无关,换皮复用)

| 库 | 用法变化 |
|---|---|
| xterm.js | `useEffect` 里 new Terminal,ref 挂 DOM;实例句柄放 root-scope store(切会话保活) |
| Monaco / CodeMirror 6 | 已有 React 社区用法,直接 ref 挂载 |
| Univer | `src/lib/univer.ts` 集成层原样搬,挂在 React ref 容器 |
| ECharts | ref 容器 + resize observer |
| ZMODEM / 虚拟列表 | 原样;vue-virtual-scroller → react 虚拟列表(选型开工时定) |

### 4.6 embed 协议退役映射(迁完一页删一行的对照表)

| Vue/embed 机制 | React 壳内替代 |
|---|---|
| `useEmbedConnBridge`(postMessage 上报连接状态) | 壳级连接 store 直写(D2),EmbedAssetBar 的 React 版(方案 B P0)直读 |
| `starhub-embed-escape` / `-open-section` 消息 | 壳内回调 props(关 overlay、开连接管理 = 同进程函数调用) |
| `embedRoute()` + `?embed=1&route=` URL | client-nav sections 事实表的 native 分支 |
| `EmbedAssetBar` / `EmbedSectionEmpty` | 壳内连接头部组件(P0 spike 已验证形态) |
| `EmbedConnState` 类型 | 壳级连接 store 的 state 字段 |

---

## 5. 单页迁移标准流程(playbook)

每一页都走这 10 步,顺序不可跳:

1. **登记台账**:§6 表格加一行,状态「进行中」。
2. **列功能清单**:从 `docs/技术方案.md` 功能矩阵抄出该页全部子功能,逐项标注「保留/调整」;这就是验收清单的底稿。
3. **搬服务层**:该页用到的 `services/*.ts` 复制进目标包,去 Pinia 耦合(参数注入)。
4. **建 store**:按 §4.2 纪律建 root/session store;需要持久化的沿用原 persist key(用户数据无缝)。
5. **搭骨架**:页面组件 + 空态/加载/错误三态(参考 `StarHubToolWorkspace` 的既有模式),先跑通「壳内直渲 + Tauri IPC 真连」。
6. **逐功能区迁移**:按功能清单一块块搬,每块「DOM 结构保留、class 换 token、逻辑零改动」。
7. **写测试**:组件行为 + store 行为;目标包过 100% 覆盖率 gate(规范要求,接受这个成本)。
8. **切流量**:`sections.ts` 该页 `renderMode` 改 `native`;3086 测试实例实测四条验收口径(§1.3)。
9. **冻结 iframe 版**:该页 `.vue` 标冻结注释,不再改;changelog 记录。
10. **收尾**:台账勾掉,升版本(次版本 y,这是新功能级),commit + push。

**验收清单模板**(每页复制一份):

```
- [ ] 壳内直渲,无 iframe
- [ ] 真连测试服务器,真实数据往返(附 DOM 级证据/截图)
- [ ] 连接状态在壳 UI 可见(徽标/状态点)
- [ ] 功能矩阵逐项对齐(附对照表)
- [ ] 切会话连接不断线(D2,涉及连接态的页)
- [ ] 测试全绿 + 覆盖率 gate 过
- [ ] sections.ts 可一行回退验证过
```

---

## 6. 迁移台账

| 页 | renderMode | 状态 | 完成版本 | 备注 |
|---|---|---|---|---|
| Broker | native | **已迁移** | 0.73.0 | P1 首个,最小样本;壳内直渲 + 30s 自动刷新 + 卡片详情,client-nav 100% 覆盖率 |
| Excel | iframe | 未开始 | — | Univer 白捡 |
| Redis | iframe | 未开始 | — | |
| Docker | iframe | 未开始 | — | |
| Elasticsearch | iframe | 未开始 | — | |
| WebBrowser | iframe | 未开始 | — | 低频 |
| Settings(按 tab 拆) | native | **已迁移**(5 个 React tab) | 0.74.0 | AI(白名单/记忆)/插件/审计/告警/关于 壳内直渲;通用/外观由 dsh 设置接管;资产 tab 暂留 iframe(连接管理 overlay);0.76.0 起设置面板两列,StarHub 为左侧可展开分组(见 §3.2) |
| SSH/SFTP | iframe | 未开始 | — | D2 硬指标 |
| DbView | iframe | 未开始 | — | 压轴 |

---

## 7. 待拍板决策(开工前过一遍)

| # | 决策 | 默认建议 | 状态 |
|---|---|---|---|
| M1 | i18n:866 处 `t()` 怎么办 | 内联中文(§2.5),英文版由 iframe 版兜底到 P4 | 待确认 |
| M2 | 包粒度 | 方案 B D3:先一个 `starhub-tools` 大包,跑通后按域拆 | 沿用 |
| M3 | 无会话时工具区可达性 | 方案 B Step 2 结论:`details` 不可改 session-maybe,需 AppFrame 独立列(P1 前置) | 沿用 |
| M4 | 虚拟列表替代(vue-virtual-scroller) | 开工时选型( react-virtuoso / @tanstack/virtual) | 待定 |
| M5 | 用户数据迁移 | persist key 同名,自动承接;不迁主题/布局(壳已接管) | 默认 |

## 8. 风险(方案 B §4 之外的迁移特有风险)

| 风险 | 缓解 |
|---|---|
| 「翻译漂移」:逐行翻译把 Vue 的隐式依赖(reactive 深度响应、watch flush 时机)带成 React bug | 铁律 3 的四条验收 + 功能矩阵逐项对照;禁止「先翻完再测」 |
| 866 处文案内联时漏翻/错翻 | 从 `.vue` 里用脚本抽 `t('key')` 对照表,迁移 PR 里附抽样核对 |
| 两版并存期间改需求要改两处 | 铁律 1:iframe 版冻结,新需求只落 React 版;迁移期不接受该页新需求 |
| 覆盖率 gate 拖慢节奏 | P1 第一页(Broker)先把规范成本摸清,后续页复用模板 |

---

## 9. 文档维护

- 本手册随每页迁移更新台账(§6);映射表(§4)发现新条目随时补。
- 每页迁移完成:CHANGELOG + 版本递增(次版本);P4 退役时同步 `docs/技术方案.md`、`docs/架构图.html`、AGENTS.md 四件套。
