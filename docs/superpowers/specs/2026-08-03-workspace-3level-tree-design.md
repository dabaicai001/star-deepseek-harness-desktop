# v0.39 工作区 3 层对象树重构 · 设计 spec

> 日期:2026-08-03 · 依据:`docs/workspace-mockups.html`(浅色 Material 重构预览)
> 决策(用户已拍板):全部域对象树并入全局资产树 / Dashboard 分组 + 顶栏 + 状态栏全做 / 视觉跟随 cyber.css token / NSQ 扩 Go 返回 channel 明细 / 一次性全做、按域分 commit

## 1. 目标

把各域视图私有的对象树(MySQL/PG/ClickHouse 库表、Redis db/key、ES 索引、Kafka/NSQ topic)并入 CyberLayout 全局资产树,统一为 3 层结构「实例 → 分组 → 对象」;各视图删除内部侧栏;Dashboard 指标卡改 tab 分组;顶栏搜索改 ⌘K 命令面板;状态栏压到 24px。

## 2. 现状要点(探索结论)

- 对象树数据私有在视图内:DbView(`databases`/`databaseTables`,L66-74)、Redis `KeyBrowser.vue`(871 行,db0-15 + namespace trie L70-188)、ES `.es-sidebar`(ElasticsearchView L445-480,无系统索引过滤)、Broker 无树(topic 只在 DashboardCard 明细里)。
- connId 由视图实例持有(DbView `ownedConnIds` L83);`src/stores/db.ts` 的 `sessions` 是全局共享 Map,ES/Redis 已会复用匹配 assetId+dbType 的会话。
- `openAssetTab`/`routeNameForAsset` 重复三份:AssetTree.vue:147-177、CyberLayout.vue:1022-1117、CommandPalette.vue:42-78。
- 顶栏搜索框与侧栏过滤共享 `assetStore.searchQuery`(持久化);CommandPalette 已存在(Ctrl+P 自监听 + `starhub:open-command-palette` 事件)。
- 状态栏行高 token:`src/styles/cyber.css:145-149`(`--layout-statusbar-h: 32px`)。
- RightPanel 显隐各视图自治(`usePersistentPanelState`),`appStore.rightPanelOpen` 无人消费(本轮不顺手改,避免扩 scope)。
- NSQ `sidecar/adapters/broker.go` 的 `NSQOverview` 只返回 channel 数量(L160-178),无名单。

## 3. 架构设计

### 3.1 新增 `src/stores/objectTree.ts`(Pinia)

按 assetId 管理三级懒加载元数据,与视图解耦:

```
state: Record<assetId, {
  status: 'idle' | 'connecting' | 'ready' | 'error'
  connId: string | null        // tree-owned 会话(复用 dbStore.sessions 匹配项,否则新建并标记)
  groups: ObjectGroup[]        // 二级:库 / db0-15 / 索引分组 / topic 列表
  children: Map<groupKey, ObjectNode[]>  // 三级,懒加载
  error: string | null
}>
actions: ensureConnected(asset), toggleGroup(asset, key), loadChildren(asset, key),
         refresh(asset), dispose(assetId)
```

- 连接复用:先查 `dbStore.sessions` 有无该 assetId+dbType 的存活会话,有则借用(不拥有);无则自建,标记 tree-owned,视图卸载不关。
- 展开/选中持久化:沿用 `starhub.db.{assetId}` 模式,统一为 `starhub.objectTree.{assetId}`(DbView 旧 key 迁移读取一次)。

### 3.2 AssetTree 3 层渲染

- 抽递归节点组件 `src/components/asset/AssetTreeNode.vue`(现有 AssetTree 1386 行扁平模板,DB 组 L805-829 改为实例可展开节点)。
- 缩进按深度变量化(现 `.tree-item` padding 写死 L1249)。
- 各域层级定义:
  | 域 | L2 分组 | L3 对象 | 特殊 |
  |---|---|---|---|
  | MySQL | databases(过滤系统库,沿用 SYSTEM_DATABASES) | tables("+ N more" 截断,默认 50) | 表带行数 |
  | PostgreSQL | schemas(默认展开 public) | tables | 系统 schema 过滤(pg_catalog/information_schema) |
  | ClickHouse | databases(过滤 system) | tables | |
  | Redis | db0-15(带 keyCount,空库置灰) | namespace(`:` 前缀 trie,逻辑抽自 KeyBrowser L70-188)→ key | key 分页 120,"加载更多"节点 |
  | Elasticsearch | 业务 / metricbeat-* / 系统(默认折叠隐藏,显示"N (隐藏)")/ 其他 | indices | 前端分组+过滤,Go 侧 ListIndices 不改 |
  | Kafka | —(topic 直挂实例) | topics(分区数) | |
  | NSQ | —(topic 直挂实例) | topics → channels | 需扩 Go(见 3.6) |
- 点击对象:`openAssetTab`(实例级 tab,复用已有)+ `window.dispatchEvent('starhub:object-selected', { assetId, instanceId, kind, payload })`。
- 树顶保留紧凑过滤输入(承接 `assetStore.searchQuery`)。

### 3.3 视图改造(删内部侧栏,监听选中事件)

各视图 onMounted 注册 `starhub:object-selected`,assetId 匹配后执行现有 select 逻辑:

- **DbView**(3805 行):删 `.db-sidebar`(L2272-2425)及 ResizableSidebarHandle;`databases`/`databaseTables` 本地缓存保留(sub-tab、工具栏库选择器、Dashboard prop 都依赖它),树与视图各自加载同一 IPC,选中经事件驱动 `selectTable`;工具栏(L2430-2463)去重——只留:新建查询 / 新建表 / 库选择器 / RightPanel 开关;连接身份(现侧栏 conn-status L2306-2310)挪到工具栏左侧。
- **RedisView**:删 KeyBrowser 侧栏位(L394-408),KeyBrowser 的 namespace trie 构建逻辑抽成 `src/utils/redisKeys.ts`(纯函数,可单测);保留 header、`RedisValueEditor`、`RedisCli`、RightPanel。事件 `kind: 'redis-key'` → `valueEditorRef.openKey()`;`kind: 'redis-db'` → `onSwitchDb`。
- **ElasticsearchView**:删 `.es-sidebar`(L445-480);事件 `kind: 'es-index'` → `selectIndex`(置 searchIndex + 切 index tab + loadMapping)。分组/系统索引隐藏逻辑放 objectTree store(前端纯函数,可单测)。
- **BrokerView**:本来无侧栏,主区保留 DashboardCard 网格;topic/channel 点击暂只高亮(无主区对象页,后续再扩)。

### 3.4 Dashboard 分组

- `DbDashboard.vue` mysql(9 卡)/pg(8 卡)/redis(8 卡)分支各加内部 tab 条:
  - 概览:运行时间 / 连接数 / 数据大小(内存) / 表数量(总键数)
  - 性能:累计查询 / 慢查询 / 缓冲池命中率 / 活跃线程(命中率、累计命令、OPS;PG:活跃会话、慢语句、缓存命中率、累计事务)
  - 网络:接收 / 发送(MySQL;PG/Redis 无网络卡则该 tab 不显示)
- `EsOverview.vue` 改 tab:概览(集群健康 + 索引统计)/ 索引(原全量索引表)。
- **偏差**:mockup 第 4 tab「AI」不放进 dashboard——RightPanel 已有独立 AI tab(AiChat),避免重复。
- Broker 卡片轻量分组(连接/资源),不强行套 tab。

### 3.5 顶栏 / 状态栏

- 删顶栏 `.top-search`(CyberLayout L1548-1582 + 搜索下拉 L1564-1581 + searchResults L935-979);`onSearchShortcut`(L67-74)⌘K/Ctrl+K 改为 `openCommandPalette()`;CommandPalette 自监听的 Ctrl+P 保留,双入口并存。
- `routeNameForAsset`/`openAssetTab`/`getDbLabel` 三处收敛到 `src/utils/assetRouting.ts`,AssetTree/CyberLayout/CommandPalette 统一引用。
- `src/styles/cyber.css:147`:`--layout-statusbar-h: 32px → 24px`;statusbar 字号 11px→10px(CyberLayout L2841-2883)。

### 3.6 Go sidecar:NSQ channel 明细

- `sidecar/adapters/broker.go` `NSQOverview`:解析 nsqd `/stats?format=json` 的 topics[].channels[](name/depth/backlog/messages),`NSQTopic` 结构加 `ChannelList []NSQChannel`。
- `src/services/broker.ts` 类型同步;objectTree store 消费。
- `npm run sidecar:build` 重新出二进制。

## 4. 数据流(选中一张表)

```
AssetTree 点表 → objectTree.ensureConnected(复用/建会话)
  → openAssetTab(复用实例 tab,appStore.addTab + router.push)
  → dispatchEvent('starhub:object-selected', { assetId, kind:'table', payload:{db, table} })
  → DbView(该 assetId 实例)收到 → 等价 selectTable(db, table):开 sub-tab + loadTableDataFor
```

## 5. 错误处理

- 连接失败:树节点 inline 「连接失败 · 重试」(沿用 DbView loadErrors 模式 L2376-2384)。
- 子级加载失败:组节点下 inline 错误行 + 重试,不弹全局错误。
- 视图未打开时点对象:先开 tab 再发事件;时序兜底不用定时器——视图 onMounted 主动拉一次 objectTree 的 pendingSelection。

## 6. 测试

- `src/utils/redisKeys.ts`(namespace trie)与 ES 索引分组纯函数:node --test 单测(tests/ 下新增)。
- NSQ channel 解析:`sidecar/adapters/broker_test.go`(若已有测试文件则补 case)。
- UI 回归(AGENTS.md 7.3 强制):`npm run dev` 真实 1280×800 视口,覆盖:资产树 3 层展开/折叠/过滤、点表开 sub-tab、Redis 点 key 开编辑器、ES 系统索引隐藏/展开、⌘K 唤起面板、状态栏紧凑、深浅双主题截图。

## 7. 实施顺序(每个一段 commit)

1. `src/utils/assetRouting.ts` 收敛三处重复 + CommandPalette 接入 ⌘K + 删顶栏搜索框 + 状态栏 24px(CyberLayout/cyber.css)
2. `objectTree.ts` store + `AssetTreeNode.vue` 递归组件 + DB 系(MySQL/PG/CH)3 层 + DbView 去侧栏
3. Redis:utils 抽取 + 树接入 + RedisView 去侧栏
4. ES:分组/隐藏 + 树接入 + ElasticsearchView 去侧栏 + EsOverview tab 化
5. Kafka/NSQ:Go broker.go 扩 channel + 树接入 + BrokerView 联动
6. DbDashboard 4 域 tab 分组
7. 版本号 0.39.0(次版本,新功能)+ CHANGELOG + AGENTS.md/README 同步

## 8. 不做(YAGNI)

- ⌘K 面板扩展到 SQL 历史/表搜索(mockup 有,但依赖对象树全局索引,下轮)
- `appStore.rightPanelOpen` 与视图 panel 状态统一(现存不一致,独立议题)
- Broker 的 topic 主区对象页(消息浏览,下轮)
- 顶栏头像/用户菜单重构
