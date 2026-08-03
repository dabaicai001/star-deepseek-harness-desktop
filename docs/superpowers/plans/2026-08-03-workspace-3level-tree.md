# v0.39 工作区 3 层对象树重构 · 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把六域(MySQL/PG/ClickHouse/Redis/ES/Kafka/NSQ)对象树并入全局资产树(实例→分组→对象),视图去内部侧栏,Dashboard tab 分组,顶栏搜索改 ⌘K,状态栏 24px。

**Architecture:** 新增 `src/stores/objectTree.ts` 按 assetId 管理三级懒加载元数据(连接复用全局 `dbStore.sessions`);`AssetTreeNode.vue` 递归渲染;选中经 `starhub:object-selected` 事件 + pendingSelection 兜底路由到视图实例;NSQ channel 明细扩 Go sidecar。

**Tech Stack:** Vue 3 `<script setup>` + Pinia + Vuetify 3 + TypeScript strict;Go 1.25 sidecar;node --test(纯函数单测);vue-tsc + vite build。

**Spec:** `docs/superpowers/specs/2026-08-03-workspace-3level-tree-design.md`

## Global Constraints

- 视觉只用 `src/styles/cyber.css` token(`var(--cyan)` / `var(--line)` / `var(--muted)` 等),禁止引入 mockup 的 Material 色板(#1e88e5 等),禁止组件内写死颜色。
- 面向用户文案走 i18n(`src/i18n/zh-CN.ts` / `en-US.ts` 同步加 key),禁止硬编码中文。
- TypeScript strict,禁用 `any`(用 `unknown` + 收窄)。
- commit 信息:Conventional Commits + emoji 前缀(✨ feat / 🐛 fix / 🔧 refactor / 📝 docs / ✅ test)。
- **版本号策略(用户已知情)**:Task 1 一次性把七处版本号提到 **0.39.0** 并在 `CHANGELOG.md` `[未发布]` 开 `### 新增` 段落;Task 2-6 只往 `[未发布]` 追加条目,不再动版本号;Task 7 收口。不执行 6.5.1 的「每 commit 一 bump」——本计划是一个 feature 的拆分提交,以 Task 1 的首 bump 为准。
- 每个 Task 结尾必须 `npm run build`(含 vue-tsc)通过再 commit;Go 改动须 `cd sidecar && go build ./... && go test ./...` 通过。
- 工作区有用户未提交改动(docs/BUG.md 等删除、docs/workspace-mockups.html 未跟踪),**禁止 stage 这些文件**;每次 `git add` 只加本任务明确列出的文件。

## 通用事件契约(后续 Task 都依赖)

```ts
// 选中事件:AssetTree 派发,各域视图监听
window.dispatchEvent(new CustomEvent('starhub:object-selected', {
  detail: { assetId: string, kind: ObjectKind, payload: Record<string, unknown> }
}))
// kind ∈ 'table' | 'database' | 'redis-db' | 'redis-key' | 'es-index' | 'nsq-topic' | 'kafka-topic'
// payload:
//   table    → { db: string, table: string }
//   database → { db: string }
//   redis-db → { db: number }
//   redis-key→ { db: number, key: string, type: string }
//   es-index → { index: string }
```

---

### Task 1: assetRouting 收敛 + ⌘K 命令面板 + 删顶栏搜索 + 状态栏 24px + 版本 0.39.0

**Files:**
- Create: `src/utils/assetRouting.ts`
- Modify: `src/components/asset/AssetTree.vue`(删本地 routeNameForAsset/openAssetTab/getDbLabel;加树顶过滤输入)
- Modify: `src/components/layout/CyberLayout.vue`(删顶栏搜索;⌘K handler 删除;routeNameForAsset 改用 util)
- Modify: `src/components/layout/CommandPalette.vue`(加 Ctrl/⌘+K 触发;routeNameForAsset 改用 util)
- Modify: `src/styles/cyber.css:147`(statusbar 32→24)
- Modify: `src/components/layout/CyberLayout.vue:2849`(statusbar font-size 11→10)
- Modify: 版本七处 + `CHANGELOG.md` + `README.md` + `AGENTS.md`

**Interfaces:**
- Produces(后续 Task 依赖):
  - `routeNameForAsset(asset: Asset): string`
  - `getDbLabel(dbType?: string): string`
  - `openAssetTab(asset: Asset, reuseExisting: boolean, router: Router): string`(返回 instanceId)
  - `dispatchObjectSelection(assetId: string, kind: string, payload: Record<string, unknown>): void`

- [ ] **Step 1: 创建 `src/utils/assetRouting.ts`**

```ts
/**
 * 资产 → 路由/tab 的单一入口。
 * 历史:routeNameForAsset / openAssetTab / getDbLabel 曾在 AssetTree.vue、
 * CyberLayout.vue、CommandPalette.vue 重复三份,此处收敛。
 */
import type { Router } from 'vue-router'
import type { Asset } from '@/types/asset'
import { generateInstanceId } from '@/utils/tabId'
import { useAppStore } from '@/stores/app'
import { useAssetStore } from '@/stores/asset'

/** 资产 → 路由名(kafka/nsq 共用 db-broker;未知 dbType 回退 db-mysql) */
export function routeNameForAsset(asset: Asset): string {
  if (asset.type === 'ssh') return 'ssh-terminal'
  if (asset.type === 'docker') return 'docker'
  if (asset.type === 'excel') return 'excel'
  const dbType = asset.config.dbType || 'mysql'
  if (dbType === 'redis') return 'db-redis'
  if (dbType === 'elasticsearch') return 'db-elasticsearch'
  if (dbType === 'clickhouse') return 'db-clickhouse'
  if (dbType === 'postgresql') return 'db-postgresql'
  if (dbType === 'kafka' || dbType === 'nsq') return 'db-broker'
  return 'db-mysql'
}

/** dbType → 侧栏等宽小徽章文案 */
export function getDbLabel(dbType?: string): string {
  switch (dbType) {
    case 'redis': return 'REDIS'
    case 'postgresql': return 'PG'
    case 'sqlite': return 'SQLITE'
    case 'elasticsearch': return 'ES'
    case 'clickhouse': return 'CLICKHOUSE'
    case 'kafka': return 'KAFKA'
    case 'nsq': return 'NSQ'
    case 'mysql':
    default: return 'MYSQL'
  }
}

/**
 * 打开资产 tab。reuseExisting=true 时复用该资产已有 tab 并激活;
 * 返回 tab 的 instanceId。sidebar 折叠时先展开。
 */
export function openAssetTab(asset: Asset, reuseExisting: boolean, router: Router): string {
  const appStore = useAppStore()
  const assetStore = useAssetStore()
  if (!appStore.sidebarOpen) appStore.sidebarOpen = true
  if (reuseExisting) {
    const existing = appStore.tabs.find(t => t.assetId === asset.id)
    if (existing) {
      appStore.setActiveTab(existing.id)
      router.push({ name: routeNameForAsset(asset), params: { id: existing.id } })
      assetStore.updateAsset(asset.id, { lastUsedAt: Date.now() })
      return existing.id
    }
  }
  const instanceId = generateInstanceId(asset.id)
  appStore.addTab({ id: instanceId, assetId: asset.id, title: asset.name, type: asset.type })
  assetStore.updateAsset(asset.id, { lastUsedAt: Date.now() })
  router.push({ name: routeNameForAsset(asset), params: { id: instanceId } })
  return instanceId
}

/** 派发对象选中事件(通用事件契约见计划头) */
export function dispatchObjectSelection(assetId: string, kind: string, payload: Record<string, unknown>): void {
  window.dispatchEvent(new CustomEvent('starhub:object-selected', { detail: { assetId, kind, payload } }))
}
```

- [ ] **Step 2: AssetTree.vue 改用 util**

- 删除本地 `routeNameForAsset`(L147-158)、`getDbLabel`(L95-107)、`openAssetTab`(L160-177)函数体,改为:

```ts
import { routeNameForAsset, getDbLabel, openAssetTab as openAssetTabRouting } from '@/utils/assetRouting'
// 本地保留薄封装,模板/调用点不动:
function openAssetTab(asset: Asset, reuseExisting: boolean) {
  openAssetTabRouting(asset, reuseExisting, router)
}
```

- `getDbLabel` / `routeNameForAsset` 的模板引用不变(同名 import 即可)。
- 在 sidebar 分组列表**顶部**(收藏组之前)加过滤输入,承接原顶栏搜索对 `assetStore.searchQuery` 的写入:

```html
<div class="tree-filter" v-if="!isCollapsed">
  <v-icon size="12">mdi-magnify</v-icon>
  <input v-model="filterQuery" type="text" :placeholder="t('common.search') + '...'" />
</div>
```

```ts
const filterQuery = computed({
  get: () => assetStore.searchQuery,
  set: (v: string) => assetStore.setSearchQuery(v)
})
```

```css
.tree-filter { display: flex; align-items: center; gap: 6px; margin: 6px 8px; padding: 0 8px; height: 26px; border: 1px solid var(--line); border-radius: 5px; color: var(--muted); }
.tree-filter input { flex: 1; min-width: 0; border: none; outline: none; background: transparent; color: var(--text); font-size: 11px; font-family: inherit; }
```

- [ ] **Step 3: CyberLayout.vue 删顶栏搜索 + 删 ⌘K handler**

- 删除模板 `.top-search` 整块(L1548-1582,含搜索下拉 L1563-1581)。
- 删除 script 中:`searchQuery` computed(L60-63)、`searchInputRef`(L64)、`onSearchShortcut`(L66-74)及其 `window.addEventListener('keydown', onSearchShortcut)` 注册/注销、`searchOpen` / `searchResults` / `searchSelectedIdx` / `searchShortcut` / `onSearchInput` / `onSearchFocus` / `onSearchBlur` / `onSearchKeydown`(L934-979 一带);`openAsset` 若仅被搜索下拉使用一并删(被别处引用则保留)。
- `closeFloatingSurfaces` 保留,但删掉其中关搜索下拉的一行。
- 删除样式:`.top-search`、`.search-input`、`.search-dropdown`、`.search-result`、`.search-result-info`、`.search-result-name`、`.search-result-host`、`.search-result-kbd`(L2166 一带「顶栏搜索下拉」注释段)。
- `routeNameForAsset`(L1022-1034)本地副本删除,改 `import { routeNameForAsset } from '@/utils/assetRouting'`;`routeNameForTab`(L1036-1046)保留,内部如是按 asset 映射则委托 `routeNameForAsset`。
- ⌘K 新入口由 CommandPalette 自监听(Step 4),CyberLayout 不再处理 ctrl/cmd+K。

- [ ] **Step 4: CommandPalette.vue 加 Ctrl/⌘+K**

在 `onKeydown`(L267)的 Ctrl+P 分支**之前**插入:

```ts
  // Ctrl/Cmd + K 同样唤起(与 Ctrl+P 双入口)
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault()
    if (open.value) hide()
    else show()
    return
  }
```

同时把本地 `routeNameForAsset`(L48-52 一带)删了,改 `import { routeNameForAsset } from '@/utils/assetRouting'`。

- [ ] **Step 5: 状态栏紧凑**

- `src/styles/cyber.css:147`:`--layout-statusbar-h: 32px;` → `--layout-statusbar-h: 24px;`
- `src/components/layout/CyberLayout.vue:2849` `.statusbar` 的 `font-size: 11px;` → `font-size: 10px;`

- [ ] **Step 6: 构建验证**

Run: `npm run build`
Expected: vue-tsc + vite build 全过;若有残留引用报错,按报错逐个清理(都是 Step 2-4 的删除遗留)。

- [ ] **Step 7: 版本号 0.39.0 七处 + CHANGELOG**

- `package.json` / `src-tauri/Cargo.toml` / `src-tauri/Cargo.lock`(name = "starhub" 段)/ `src-tauri/tauri.conf.json`:`0.38.2` → `0.39.0`
- `CHANGELOG.md` `[未发布]` 下新增:

```markdown
### 新增
- 工作区 3 层对象树重构(v0.39):顶栏常驻搜索框移除,⌘K / Ctrl+K 唤起命令面板(与 Ctrl+P 双入口);资产树顶部新增紧凑过滤输入;状态栏行高 32px→24px、字号 11→10px;routeNameForAsset/openAssetTab 三处重复收敛为 src/utils/assetRouting.ts
```

- `AGENTS.md` 第 2 节「当前版本」→ `v0.39.0(工作区 3 层对象树重构)`,末尾「最后更新」→ `2026-08-03 (v0.39.0)`
- `README.md` badge `v0.38.2` → `v0.39.0`;「当前版本」区顶部插入:

```markdown
### v0.39.0 (2026-08-03)
- ✨ 工作区 3 层对象树重构:对象树并入全局资产树、视图去内部侧栏、Dashboard tab 分组、⌘K 命令面板、状态栏紧凑
```

- [ ] **Step 8: Commit**

```bash
git add src/utils/assetRouting.ts src/components/asset/AssetTree.vue src/components/layout/CyberLayout.vue src/components/layout/CommandPalette.vue src/styles/cyber.css package.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json CHANGELOG.md AGENTS.md README.md
git commit -m "🔧 refactor(layout): 顶栏搜索改 ⌘K 命令面板 + assetRouting 收敛 + 状态栏 24px

- routeNameForAsset/openAssetTab/getDbLabel 三处重复收敛到 src/utils/assetRouting.ts
- 删顶栏常驻搜索框与下拉;⌘K/Ctrl+K 唤起 CommandPalette(与 Ctrl+P 双入口)
- 资产树顶部新增紧凑过滤输入(承接 assetStore.searchQuery)
- --layout-statusbar-h 32px→24px,状态栏字号 11→10px
- 版本号 0.39.0(七处同步)"
```

---

### Task 2: objectTree store + AssetTreeNode 递归组件 + DB 系(MySQL/PG/ClickHouse)3 层 + DbView 去侧栏

**Files:**
- Create: `src/stores/objectTree.ts`
- Create: `src/components/asset/AssetTreeNode.vue`
- Modify: `src/components/asset/AssetTree.vue`(DB 组资产节点可展开,L805-829)
- Modify: `src/views/DbView.vue`(删 .db-sidebar L2272-2425;工具栏去重;接选中事件)

**Interfaces:**
- Consumes: Task 1 的 `openAssetTab` / `dispatchObjectSelection`
- Produces:
  - `useObjectTreeStore()`:
    - `ensureAsset(asset: Asset): Promise<void>` — 连接 + 加载 L2 分组
    - `toggleNode(asset: Asset, node: ObjectNode): Promise<void>` — 展开/折叠,懒加载子级
    - `selectObject(asset: Asset, node: ObjectNode, router: Router): void` — pending + 开 tab + 派事件
    - `takePendingSelection(assetId: string): ObjectSelection | null`
    - `refreshAsset(assetId: string): Promise<void>`(Task 3/4 的视图删除/清空后调用)
    - `stateOf(assetId: string): AssetTreeState | undefined`
    - `isExpanded(assetId: string, key: string): boolean`
    - `childrenOf(assetId: string, key: string): ObjectNode[]`
  - `ObjectNode = { key, kind, label, count?, meta?, hasChildren, payload? }`
  - `ObjectKind = 'database' | 'table' | 'redis-db' | 'redis-ns' | 'redis-key' | 'es-group' | 'es-index' | 'kafka-topic' | 'nsq-topic' | 'nsq-channel'`(本 Task 只实现 database/table,后续 Task 扩展同文件)

- [ ] **Step 1: 创建 `src/stores/objectTree.ts`**

```ts
/**
 * 全局对象树 store:资产实例 → 分组 → 对象 三级懒加载元数据。
 *
 * - 连接复用 dbStore.sessions(按 assetId + dbType 匹配),没有则由本 store
 *   建立(会话归全局 sessions 管理,视图卸载不影响);
 * - 选中对象:先存 pendingSelection(晚挂载的视图 onMounted 主动拉),
 *   再派 starhub:object-selected(已挂载的视图即时响应),双通道不丢;
 * - 展开状态持久化 localStorage `starhub.objectTree.{assetId}`。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { Router } from 'vue-router'
import type { Asset } from '@/types/asset'
import { useDbStore } from '@/stores/db'
import * as dbService from '@/services/db'
import { openAssetTab, dispatchObjectSelection } from '@/utils/assetRouting'

export type ObjectKind =
  | 'database' | 'table'
  | 'redis-db' | 'redis-ns' | 'redis-key'
  | 'es-group' | 'es-index'
  | 'kafka-topic' | 'nsq-topic' | 'nsq-channel'

export interface ObjectNode {
  /** 资产内唯一,如 'db:zhht_wx' / 'table:zhht_wx.orders' */
  key: string
  kind: ObjectKind
  label: string
  /** 子对象数(表数/keyCount/docs) */
  count?: number
  /** 次级文本(行数/大小) */
  meta?: string
  hasChildren: boolean
  payload?: Record<string, unknown>
}

export interface ObjectSelection {
  kind: ObjectKind
  payload: Record<string, unknown>
}

export interface AssetTreeState {
  status: 'idle' | 'connecting' | 'ready' | 'error'
  error: string | null
  connId: string | null
  rootChildren: ObjectNode[]
  childrenByKey: Record<string, ObjectNode[]>
  loadingKeys: string[]
  errorByKey: Record<string, string>
  expanded: string[]
}

/** 各 dbType 的系统库/schema 过滤(与 DbView SYSTEM_DATABASES 对齐) */
const SYSTEM_DATABASES: Record<string, string[]> = {
  mysql: ['information_schema', 'mysql', 'performance_schema', 'sys'],
  postgresql: ['pg_catalog', 'information_schema', 'pg_toast'],
  clickhouse: ['system', 'INFORMATION_SCHEMA', 'information_schema']
}

/** 表节点截断:每库默认显示前 50 张,追加 '+ N more' 节点 */
const TABLE_TRUNCATE = 50

function emptyState(): AssetTreeState {
  return {
    status: 'idle', error: null, connId: null,
    rootChildren: [], childrenByKey: {}, loadingKeys: [], errorByKey: {}, expanded: []
  }
}

export const useObjectTreeStore = defineStore('objectTree', () => {
  const states = ref<Record<string, AssetTreeState>>({})
  const pending = ref<Record<string, ObjectSelection | null>>({})

  function stateOf(assetId: string): AssetTreeState | undefined {
    return states.value[assetId]
  }
  function ensureState(assetId: string): AssetTreeState {
    if (!states.value[assetId]) states.value[assetId] = emptyState()
    return states.value[assetId]
  }

  // ─── 展开状态持久化 ───
  function persistExpanded(assetId: string) {
    try {
      localStorage.setItem(`starhub.objectTree.${assetId}`, JSON.stringify(states.value[assetId]?.expanded ?? []))
    } catch { /* quota 等忽略 */ }
  }
  function restoreExpanded(assetId: string) {
    try {
      const raw = localStorage.getItem(`starhub.objectTree.${assetId}`)
      if (raw) ensureState(assetId).expanded = JSON.parse(raw) as string[]
    } catch { /* 脏数据忽略 */ }
  }
  function isExpanded(assetId: string, key: string): boolean {
    return states.value[assetId]?.expanded.includes(key) ?? false
  }
  function childrenOf(assetId: string, key: string): ObjectNode[] {
    return states.value[assetId]?.childrenByKey[key] ?? []
  }

  // ─── 连接(复用 dbStore.sessions) ───
  async function ensureConnection(asset: Asset): Promise<string> {
    const dbStore = useDbStore()
    const dbType = asset.config.dbType || 'mysql'
    const existing = [...dbStore.sessions.values()].find(
      s => s.assetId === asset.id && s.dbType === dbType && s.connected
    )
    if (existing) return existing.connId
    const cfg = asset.config as Record<string, unknown>
    const base = {
      host: String(cfg.host ?? ''),
      port: Number(cfg.port ?? 0),
      username: String(cfg.username ?? ''),
      password: String(cfg.password ?? ''),
      database: cfg.database ? String(cfg.database) : undefined,
      ssl: Boolean(cfg.ssl)
    }
    let session
    if (dbType === 'postgresql') session = await dbStore.connectPostgres(asset.id, asset.name, base)
    else if (dbType === 'clickhouse') session = await dbStore.connectClickHouse(asset.id, asset.name, base)
    else if (dbType === 'redis') {
      session = await dbStore.connectRedis(asset.id, asset.name, {
        host: base.host, port: base.port, password: base.password || undefined,
        db: Number(cfg.db ?? 0), ssl: base.ssl
      })
    } else if (dbType === 'elasticsearch') {
      session = await dbStore.connectElasticsearch(asset.id, asset.name, {
        address: cfg.address ? String(cfg.address) : undefined,
        host: base.host, port: base.port,
        username: base.username || undefined, password: base.password || undefined,
        useSSL: base.ssl, apiKey: cfg.apiKey ? String(cfg.apiKey) : undefined
      })
    } else {
      session = await dbStore.connectMySQL(asset.id, asset.name, base)
    }
    return session.connId
  }

  // ─── L2 分组加载(DB 系:库/schema 列表) ───
  async function loadRoot(asset: Asset, state: AssetTreeState): Promise<void> {
    const dbType = asset.config.dbType || 'mysql'
    if (dbType === 'mysql' || dbType === 'postgresql' || dbType === 'clickhouse') {
      const connId = state.connId!
      const dbs = dbType === 'clickhouse'
        ? await dbService.clickhouseListDatabases(connId)
        : await dbService.mysqlListDatabases(connId)
      const filtered = dbs.filter(db => !(SYSTEM_DATABASES[dbType] ?? []).includes(db))
      state.rootChildren = filtered.map(db => ({
        key: `db:${db}`, kind: 'database', label: db,
        hasChildren: true, payload: { db }
      }))
      return
    }
    // redis / es / broker 在 Task 3/4/5 扩展
    state.rootChildren = []
  }

  /** 展开资产节点:连接 + 拉 L2;幂等(已 ready 直接返回) */
  async function ensureAsset(asset: Asset): Promise<void> {
    const state = ensureState(asset.id)
    if (state.status === 'ready' || state.status === 'connecting') return
    restoreExpanded(asset.id)
    state.status = 'connecting'
    state.error = null
    try {
      state.connId = await ensureConnection(asset)
      await loadRoot(asset, state)
      state.status = 'ready'
    } catch (err) {
      state.status = 'error'
      state.error = err instanceof Error ? err.message : String(err)
    }
  }

  // ─── L3 子级加载 ───
  async function loadChildren(asset: Asset, state: AssetTreeState, node: ObjectNode): Promise<void> {
    const dbType = asset.config.dbType || 'mysql'
    if (node.kind === 'database') {
      const db = String(node.payload?.db ?? '')
      const connId = state.connId!
      const tables = dbType === 'clickhouse'
        ? await dbService.clickhouseListTables(connId, db)
        : await dbService.mysqlListTables(connId, db)
      const shown = tables.slice(0, TABLE_TRUNCATE)
      const nodes: ObjectNode[] = shown.map(t => ({
        key: `table:${db}.${t.name}`, kind: 'table', label: t.name,
        meta: t.rows != null ? String(t.rows) : undefined,
        hasChildren: false, payload: { db, table: t.name }
      }))
      if (tables.length > TABLE_TRUNCATE) {
        nodes.push({
          key: `table:${db}.__more`, kind: 'table',
          label: `+ ${tables.length - TABLE_TRUNCATE} more`,
          hasChildren: false, payload: { db, table: '', more: true }
        })
      }
      state.childrenByKey[node.key] = nodes
    }
  }

  async function toggleNode(asset: Asset, node: ObjectNode): Promise<void> {
    const state = ensureState(asset.id)
    // '+ N more' 伪节点:展开成全量
    if (node.payload?.more) {
      const db = String(node.payload.db)
      const connId = state.connId
      if (!connId) return
      const dbType = asset.config.dbType || 'mysql'
      const tables = dbType === 'clickhouse'
        ? await dbService.clickhouseListTables(connId, db)
        : await dbService.mysqlListTables(connId, db)
      state.childrenByKey[`db:${db}`] = tables.map(t => ({
        key: `table:${db}.${t.name}`, kind: 'table' as const, label: t.name,
        meta: t.rows != null ? String(t.rows) : undefined,
        hasChildren: false, payload: { db, table: t.name }
      }))
      return
    }
    const idx = state.expanded.indexOf(node.key)
    if (idx >= 0) {
      state.expanded.splice(idx, 1)
      persistExpanded(asset.id)
      return
    }
    state.expanded.push(node.key)
    persistExpanded(asset.id)
    if (node.hasChildren && !state.childrenByKey[node.key] && !state.loadingKeys.includes(node.key)) {
      state.loadingKeys.push(node.key)
      delete state.errorByKey[node.key]
      try {
        await loadChildren(asset, state, node)
      } catch (err) {
        state.errorByKey[node.key] = err instanceof Error ? err.message : String(err)
      } finally {
        state.loadingKeys = state.loadingKeys.filter(k => k !== node.key)
      }
    }
  }

  // ─── 选中:pending + 开 tab + 事件 双通道 ───
  function selectObject(asset: Asset, node: ObjectNode, router: Router): void {
    if (node.payload?.more) return
    const selection: ObjectSelection = { kind: node.kind, payload: node.payload ?? {} }
    pending.value[asset.id] = selection
    openAssetTab(asset, true, router)
    dispatchObjectSelection(asset.id, selection.kind, selection.payload)
  }

  /** 视图 onMounted 主动拉取并清除(晚挂载兜底) */
  function takePendingSelection(assetId: string): ObjectSelection | null {
    const sel = pending.value[assetId] ?? null
    pending.value[assetId] = null
    return sel
  }

  /** 数据变更后(删 key / flushdb / 删索引 / 刷新)重拉 */
  async function refreshAsset(assetId: string): Promise<void> {
    const state = states.value[assetId]
    if (!state || state.status !== 'ready') return
    state.childrenByKey = {}
    // 由 AssetTree 里缓存的 asset 对象重新 loadRoot;调用方保证 asset 仍存在
    const assetStore = (await import('@/stores/asset')).useAssetStore()
    const asset = assetStore.assets.find(a => a.id === assetId)
    if (!asset) return
    await loadRoot(asset, state)
    // 已展开的组逐个重拉子级
    for (const key of [...state.expanded]) {
      const node = state.rootChildren.find(n => n.key === key)
      if (node) {
        try { await loadChildren(asset, state, node) } catch { /* 保持旧错误行 */ }
      }
    }
  }

  return {
    states, stateOf, ensureAsset, toggleNode, selectObject,
    takePendingSelection, refreshAsset, isExpanded, childrenOf
  }
})
```

- [ ] **Step 2: 创建 `src/components/asset/AssetTreeNode.vue`(递归)**

```vue
<script setup lang="ts">
/**
 * 资产树对象节点(递归):实例 → 分组 → 对象 的第 2/3 层。
 * 数据全部来自 objectTree store,本组件只负责渲染与事件上抛。
 */
import { computed } from 'vue'
import { useObjectTreeStore, type ObjectNode } from '@/stores/objectTree'

const props = defineProps<{
  assetId: string
  node: ObjectNode
  depth: number
}>()
const emit = defineEmits<{
  toggle: [node: ObjectNode]
  select: [node: ObjectNode]
}>()

const tree = useObjectTreeStore()
const expanded = computed(() => tree.isExpanded(props.assetId, props.node.key))
const loading = computed(() => tree.stateOf(props.assetId)?.loadingKeys.includes(props.node.key) ?? false)
const error = computed(() => tree.stateOf(props.assetId)?.errorByKey[props.node.key] ?? null)
const children = computed(() => tree.childrenOf(props.assetId, props.node.key))
const pad = computed(() => `${10 + props.depth * 14}px`)
const childPad = computed(() => `${10 + (props.depth + 1) * 14}px`)
const isMore = computed(() => Boolean(props.node.payload?.more))

function icon(n: ObjectNode): string {
  switch (n.kind) {
    case 'database': return 'mdi-database-outline'
    case 'table': return 'mdi-table'
    case 'redis-db': return 'mdi-database'
    case 'redis-ns': return 'mdi-folder-outline'
    case 'redis-key': return 'mdi-key-variant'
    case 'es-group': return 'mdi-folder-multiple-outline'
    case 'es-index': return 'mdi-text-search'
    case 'kafka-topic': return 'mdi-view-list-outline'
    case 'nsq-topic': return 'mdi-view-list-outline'
    case 'nsq-channel': return 'mdi-arrow-right-bold-outline'
    default: return 'mdi-circle-small'
  }
}

function onLabelClick() {
  if (isMore.value) { emit('toggle', props.node); return }
  if (props.node.hasChildren) emit('toggle', props.node)
  emit('select', props.node)
}
</script>

<template>
  <div class="obj-node" :class="{ more: isMore }" :style="{ paddingLeft: pad }">
    <v-icon
      v-if="node.hasChildren"
      class="obj-chevron" :class="{ open: expanded }"
      size="10"
      @click.stop="emit('toggle', node)"
    >mdi-chevron-right</v-icon>
    <span v-else class="obj-chevron-spacer" />
    <v-icon size="12" class="obj-icon">{{ icon(node) }}</v-icon>
    <span class="obj-label" @click="onLabelClick">{{ node.label }}</span>
    <span v-if="node.count !== undefined" class="obj-count">{{ node.count }}</span>
    <span v-else-if="node.meta" class="obj-meta">{{ node.meta }}</span>
  </div>
  <div v-if="loading" class="obj-hint" :style="{ paddingLeft: childPad }">加载中…</div>
  <div v-else-if="error" class="obj-hint obj-error" :style="{ paddingLeft: childPad }">
    加载失败 · <a href="javascript:void 0" @click="emit('toggle', node)">重试</a>
  </div>
  <template v-if="expanded && !loading">
    <AssetTreeNode
      v-for="child in children" :key="child.key"
      :asset-id="assetId" :node="child" :depth="depth + 1"
      @toggle="emit('toggle', $event)" @select="emit('select', $event)"
    />
  </template>
</template>

<style scoped>
.obj-node { display: flex; align-items: center; gap: 5px; padding-top: 3px; padding-bottom: 3px; padding-right: 10px; font-size: 11px; color: var(--text-2); cursor: pointer; user-select: none; }
.obj-node:hover { background: var(--hover, rgba(127, 127, 127, 0.08)); color: var(--text); }
.obj-node.more { color: var(--muted); font-style: italic; }
.obj-chevron { color: var(--muted); transition: transform 0.15s; flex-shrink: 0; }
.obj-chevron.open { transform: rotate(90deg); }
.obj-chevron-spacer { width: 10px; flex-shrink: 0; }
.obj-icon { color: var(--muted); flex-shrink: 0; }
.obj-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: 'JetBrains Mono', monospace; }
.obj-count, .obj-meta { font-size: 9px; color: var(--muted); font-family: 'JetBrains Mono', monospace; }
.obj-hint { padding-top: 2px; padding-bottom: 2px; font-size: 10px; color: var(--muted); }
.obj-error a { color: var(--cyan); }
</style>
```

- [ ] **Step 3: AssetTree.vue DB 组接入 3 层**

在 DB 组的资产 `.tree-item`(L805-829)上:

1. 最左侧加展开 chevron(仅 db 类资产;`ssh/docker/excel` 不变):

```html
<v-icon
  class="chevron asset-chevron" :class="{ open: treeExpandedIds.includes(asset.id) }"
  size="12"
  @click.stop="toggleAssetTree(asset)"
>mdi-chevron-right</v-icon>
```

2. script 增加:

```ts
import AssetTreeNode from '@/components/asset/AssetTreeNode.vue'
import { useObjectTreeStore, type ObjectNode } from '@/stores/objectTree'
import { dispatchObjectSelection } from '@/utils/assetRouting' // selectObject 内部已派发,这里不需要

const objectTree = useObjectTreeStore()
const treeExpandedIds = ref<string[]>([])

async function toggleAssetTree(asset: Asset) {
  const idx = treeExpandedIds.value.indexOf(asset.id)
  if (idx >= 0) { treeExpandedIds.value.splice(idx, 1); return }
  treeExpandedIds.value.push(asset.id)
  await objectTree.ensureAsset(asset)
}

function onNodeToggle(asset: Asset, node: ObjectNode) {
  void objectTree.toggleNode(asset, node)
}
function onNodeSelect(asset: Asset, node: ObjectNode) {
  objectTree.selectObject(asset, node, router)
}
```

3. 资产 item 之后、`</TransitionGroup>` 之前渲染子树(每个展开的资产):

```html
<div v-if="treeExpandedIds.includes(asset.id)" class="asset-children">
  <div v-if="objectTree.stateOf(asset.id)?.status === 'connecting'" class="tree-empty">连接中…</div>
  <div v-else-if="objectTree.stateOf(asset.id)?.status === 'error'" class="tree-empty">
    连接失败 · <a href="javascript:void 0" @click="objectTree.ensureAsset(asset)">重试</a>
  </div>
  <AssetTreeNode
    v-for="node in objectTree.stateOf(asset.id)?.rootChildren ?? []"
    :key="node.key" :asset-id="asset.id" :node="node" :depth="1"
    @toggle="onNodeToggle(asset, $event)" @select="onNodeSelect(asset, $event)"
  />
</div>
```

注意 TransitionGroup 直接子元素需要稳定 key——把资产 item 和 asset-children 包一层 `<div :key="asset.id" class="asset-block">`(TransitionGroup 下每项一个根)。

4. 连接失败重试:`ensureAsset` 在 error 状态下应允许重入——把 store 里 `if (state.status === 'ready' || state.status === 'connecting') return` 保持不变即可(error 不在拦截列表,自然重试)。

5. 样式:

```css
.asset-block { display: block; }
.asset-chevron { transition: transform 0.15s; }
.asset-chevron.open { transform: rotate(90deg); }
.asset-children { overflow: hidden; }
```

- [ ] **Step 4: DbView.vue 去侧栏 + 接事件**

1. **删模板**:`.db-sidebar` 整块(L2272-2425,含 sidebar-header、conn-status、搜索框、tables-tree、ResizableSidebarHandle 用法 L2413-2424)。
2. **删 script**:`sidebarCollapsed`(L74)、`sidebarWidth`(L75)、`sidebarDragging`(L76)、`ResizableSidebarHandle` import(L12)、`expandedDatabases`(L323,仅侧栏用)、`toggleDatabase`(L613-625,仅侧栏用);持久化 watch(L326-372)里去掉 `expanded[]` 的存取,保留 `selectedDb`。
3. **工具栏去重**(L2430-2463):在最左插入连接身份(原侧栏 conn-status L2306-2310 的内容):

```html
<span class="conn-status">
  <ProductIcon :product="asset?.config.dbType || 'mysql'" :size="14" />
  <span class="conn-name">{{ asset?.name }}</span>
  <span class="conn-dot" :class="{ online: connected }" />
</span>
```

保留:新建查询、新建表(mysql/pg/ch 限定)、spacer、库选择器、RightPanel 开关。工具栏不再有其它标题。
4. **接选中事件**(script setup 顶层,`assetId` 用现有冻结值 L56):

```ts
import { useObjectTreeStore } from '@/stores/objectTree'
const objectTree = useObjectTreeStore()

function applyObjectSelection(kind: string, payload: Record<string, unknown>) {
  if (kind === 'table') {
    void selectTable(String(payload.db ?? ''), String(payload.table ?? ''))
  } else if (kind === 'database') {
    selectedDb.value = String(payload.db ?? '')
    void loadTablesForDb(selectedDb.value)
  }
}
function onObjectSelected(e: Event) {
  const detail = (e as CustomEvent).detail as { assetId?: string; kind?: string; payload?: Record<string, unknown> } | undefined
  if (!detail || detail.assetId !== assetId || !detail.kind || !detail.payload) return
  applyObjectSelection(detail.kind, detail.payload)
}
```

在现有 `onMounted`(L2070-2083)内追加:

```ts
  window.addEventListener('starhub:object-selected', onObjectSelected)
  const pendingSel = objectTree.takePendingSelection(assetId)
  if (pendingSel) applyObjectSelection(pendingSel.kind, pendingSel.payload)
```

卸载处(`markStale`/onBeforeUnmount 一带)追加 `window.removeEventListener('starhub:object-selected', onObjectSelected)`。
5. **删样式**:`.db-sidebar`、`.sidebar-header`、`.sidebar-title`、`.sidebar-header-actions`、`.tables-tree` 及其子选择器(L2836-2933 一带);新增:

```css
.conn-status { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--text-2); }
.conn-name { font-weight: 600; color: var(--text); }
.conn-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--muted); }
.conn-dot.online { background: var(--green); }
```

6. 布局容器:原 `.db-view` 若为 flex 且第一子是 sidebar,删 sidebar 后确认主区 `flex: 1` 正常铺满;有 `grid-template-columns` 含侧栏轨道的同步删轨道。

- [ ] **Step 5: 构建验证**

Run: `npm run build`
Expected: 通过。常见残留:`expandedDatabases` / `sidebarCollapsed` 未删净、`tables-tree` 相关函数(retryLoadTablesForDb 若仅侧栏用则删)。

- [ ] **Step 6: 手动冒烟(dev 服务器)**

Run: `npm run dev -- --host 127.0.0.1`(后台),浏览器开 `http://127.0.0.1:1420/` 1280×800:
- 展开一个 MySQL 资产 → 出现库列表;展开库 → 表列表(>50 张的库有 "+ N more",点开变全量)
- 点表 → 打开/复用资产 tab,DbView 自动开该表 sub-tab
- 纯浏览器无 Tauri IPC,连接会失败 → 树上应显示「连接失败 · 重试」而不是全局报错(降级验证)

- [ ] **Step 7: CHANGELOG + Commit**

`CHANGELOG.md` `[未发布] ### 新增` 追加:

```markdown
- 全局资产树升级 3 层(实例 → 库 → 表):新增 objectTree store(连接复用 + 懒加载 + 展开持久化)与 AssetTreeNode 递归组件;MySQL/PostgreSQL/ClickHouse 库表树并入,系统库默认过滤,表超过 50 张折叠为 "+ N more";DbView 删除内部库表侧栏,工具栏只留连接身份 + 操作 + 库选择器
```

```bash
git add src/stores/objectTree.ts src/components/asset/AssetTreeNode.vue src/components/asset/AssetTree.vue src/views/DbView.vue CHANGELOG.md
git commit -m "✨ feat(asset-tree): 对象树并入全局资产树(DB 系)+ DbView 去内部侧栏

- 新增 src/stores/objectTree.ts:按 assetId 三级懒加载,连接复用 dbStore.sessions,
  展开状态持久化 starhub.objectTree.{assetId},选中双通道(事件 + pendingSelection)
- 新增递归组件 AssetTreeNode.vue;AssetTree DB 组资产可展开
- DbView 删 .db-sidebar,工具栏去重,接 starhub:object-selected"
```

---

### Task 3: Redis 接入(db0-15 → namespace → key)+ RedisView 去侧栏

**Files:**
- Create: `src/utils/redisKeys.ts`
- Test: `tests/redis-keys.test.mjs`
- Modify: `src/stores/objectTree.ts`(loadRoot/loadChildren 增 redis 分支)
- Modify: `src/views/RedisView.vue`(删 KeyBrowser 侧栏;接事件)
- Delete: `src/components/redis/KeyBrowser.vue`(确认无其它引用后)

**Interfaces:**
- Consumes: Task 2 的 store 扩展点(`loadRoot` / `loadChildren` 内 switch)
- Produces:
  - `buildRedisNamespaceTree(keys: RedisKeyLike[]): RedisTreeNode[]`
  - `RedisKeyLike = { key: string; type: string; ttl: number }`
  - `RedisTreeNode = { name, fullKey, keyType, ttl, isLeaf, keyCount, children: RedisTreeNode[] }`
  - 事件 kind:`'redis-db'` payload `{db: number}`;`'redis-key'` payload `{db, key, type}`

- [ ] **Step 1: 先写失败测试 `tests/redis-keys.test.mjs`**

测试模式照抄 `tests/ai-steering.test.mjs`(typescript transpile + data: URL import):

```js
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const source = await readFile(path.join(__dirname, '../src/utils/redisKeys.ts'), 'utf8')
const transpiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 }
}).outputText
const { buildRedisNamespaceTree } = await import(`data:text/javascript;base64,${Buffer.from(transpiled).toString('base64')}`)

const keys = [
  { key: 'user:1:name', type: 'string', ttl: -1 },
  { key: 'user:2:name', type: 'string', ttl: 100 },
  { key: 'user:2:age', type: 'string', ttl: -1 },
  { key: 'cart:9', type: 'hash', ttl: -1 },
  { key: 'standalone', type: 'string', ttl: -1 }
]

test('buildRedisNamespaceTree: 按 : 前缀建 trie,目录在前(keyCount 降序),叶子字母序', () => {
  const tree = buildRedisNamespaceTree(keys)
  // user(3) 和 cart(1) 是目录,standalone 是叶子;目录在前
  assert.equal(tree[0].name, 'user')
  assert.equal(tree[0].isLeaf, false)
  assert.equal(tree[0].keyCount, 3)
  assert.equal(tree[1].name, 'cart')
  assert.equal(tree[1].keyCount, 1)
  assert.equal(tree[2].name, 'standalone')
  assert.equal(tree[2].isLeaf, true)
})

test('buildRedisNamespaceTree: 嵌套层级与 keyCount 递归累加', () => {
  const tree = buildRedisNamespaceTree(keys)
  const user = tree[0]
  assert.equal(user.children.length, 2) // user:1, user:2
  const u2 = user.children.find(n => n.name === '2')
  assert.equal(u2.keyCount, 2)
  assert.equal(u2.children.length, 2) // name, age
  assert.equal(u2.children[0].isLeaf, true)
  assert.equal(u2.children[0].keyType, 'string')
  assert.equal(u2.children.find(n => n.name === 'age').ttl, -1)
})

test('buildRedisNamespaceTree: 空输入返回空数组', () => {
  assert.deepEqual(buildRedisNamespaceTree([]), [])
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/redis-keys.test.mjs`
Expected: FAIL(`Cannot find module '../src/utils/redisKeys.ts'` ENOENT)

- [ ] **Step 3: 实现 `src/utils/redisKeys.ts`**(逻辑抽自 KeyBrowser.vue L70-188,改为返回嵌套树、去掉 expanded/typeFilter 依赖)

```ts
/**
 * Redis key 命名空间树:按 ':' 前缀把扁平 key 列表组织成 trie。
 * 排序:目录在前(keyCount 降序,平级再按名),叶子在后(按名)。
 * 纯函数,node --test 可测。
 */
export interface RedisKeyLike {
  key: string
  type: string
  ttl: number
}

export interface RedisTreeNode {
  name: string
  fullKey: string
  keyType: string
  ttl: number
  isLeaf: boolean
  keyCount: number
  children: RedisTreeNode[]
}

interface MutableTrieNode extends RedisTreeNode {
  childrenMap: Map<string, MutableTrieNode>
}

export function buildRedisNamespaceTree(keys: RedisKeyLike[]): RedisTreeNode[] {
  if (keys.length === 0) return []
  const root = new Map<string, MutableTrieNode>()

  for (const k of keys) {
    const parts = k.key.split(':')
    let level = root
    let path = ''
    for (let i = 0; i < parts.length; i++) {
      const seg = parts[i]
      path = path ? `${path}:${seg}` : seg
      const isLast = i === parts.length - 1
      let node = level.get(seg)
      if (!node) {
        node = {
          name: seg,
          fullKey: isLast ? k.key : path,
          keyType: isLast ? k.type : '',
          ttl: isLast ? k.ttl : 0,
          isLeaf: isLast,
          keyCount: 0,
          children: [],
          childrenMap: new Map()
        }
        level.set(seg, node)
      }
      if (isLast) {
        node.isLeaf = true
        node.keyType = k.type
        node.ttl = k.ttl
        node.fullKey = k.key
      }
      level = node.childrenMap
    }
  }

  function finalize(node: MutableTrieNode): number {
    node.children = [...node.childrenMap.values()].sort((a, b) => {
      if (a.isLeaf !== b.isLeaf) return a.isLeaf ? 1 : -1
      if (!a.isLeaf) return b.keyCount - a.keyCount || a.name.localeCompare(b.name)
      return a.name.localeCompare(b.name)
    })
    let sum = node.isLeaf ? 1 : 0
    for (const child of node.children) sum += finalize(child as MutableTrieNode)
    node.keyCount = sum
    return sum
  }

  const roots = [...root.values()].map(node => {
    finalize(node)
    return node as RedisTreeNode
  })
  return roots.sort((a, b) => {
    if (a.isLeaf !== b.isLeaf) return a.isLeaf ? 1 : -1
    if (!a.isLeaf) return b.keyCount - a.keyCount || a.name.localeCompare(b.name)
    return a.name.localeCompare(b.name)
  })
}
```

注意:finalize 里目录的 keyCount 需要先算子级再排序——把排序移到 finalize 之后(上面代码 finalize 内先排了 children 再算 sum,顺序不影响正确性,因为 sort 比较用的是上一轮的 keyCount;**修正**:先递归算 count 再排序,把 `node.children = [...].sort(...)` 挪到 `for` 循环之后)。实现时按「先递归算 count、再排序」写,测试会兜住。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/redis-keys.test.mjs`
Expected: pass 3/3

- [ ] **Step 5: objectTree.ts 加 redis 分支**

`loadRoot` 的 redis 分支(替换 `// redis / es / broker 在 Task 3/4/5 扩展` 注释处):

```ts
    if (dbType === 'redis') {
      const connId = state.connId!
      const raw = await dbService.redisInfo(connId, 'keyspace')
      const sizes: Record<number, number> = {}
      for (const line of raw.split('\n')) {
        const m = line.match(/^db(\d+):keys=(\d+)/)
        if (m) sizes[Number(m[1])] = Number(m[2])
      }
      state.rootChildren = Array.from({ length: 16 }, (_, db) => ({
        key: `rdb:${db}`, kind: 'redis-db' as const, label: `db${db}`,
        count: sizes[db] ?? 0,
        hasChildren: (sizes[db] ?? 0) > 0,
        payload: { db }
      }))
      return
    }
```

`loadChildren` 加(redis-db → scan → trie;redis-ns → 其子节点):

```ts
    if (node.kind === 'redis-db') {
      const db = Number(node.payload?.db ?? 0)
      const connId = state.connId!
      await dbService.redisSelect(connId, db)
      const collected: { key: string; type: string; ttl: number }[] = []
      let cursor = 0
      let rounds = 0
      do {
        const result = await dbService.redisScan(connId, cursor, '*', 200)
        collected.push(...result.keys)
        cursor = result.cursor
        rounds++
      } while (cursor !== 0 && rounds < 3 && collected.length < 500)
      const trie = buildRedisNamespaceTree(collected)
      const nodes = trie.map(t => redisTrieToNode(db, t))
      if (cursor !== 0) {
        nodes.push({
          key: `rdb:${db}.__more`, kind: 'redis-key', label: '(仅前 500 个 key,用 Redis CLI SCAN 查看更多)',
          hasChildren: false, payload: { db, key: '', type: '', more: true }
        })
      }
      state.childrenByKey[node.key] = nodes
      // ns 子级预填(trie 已在内存,无需再请求)
      for (const n of nodes) fillNsChildren(db, n, state)
    }
```

辅助函数(放 store 文件内):

```ts
function redisTrieToNode(db: number, t: RedisTreeNode): ObjectNode {
  const key = t.isLeaf ? `rkey:${db}:${t.fullKey}` : `rns:${db}:${t.fullKey}`
  return {
    key,
    kind: t.isLeaf ? 'redis-key' : 'redis-ns',
    label: t.name,
    count: t.isLeaf ? undefined : t.keyCount,
    hasChildren: !t.isLeaf && t.children.length > 0,
    payload: t.isLeaf ? { db, key: t.fullKey, type: t.keyType } : { db, ns: t.fullKey }
  }
}
function fillNsChildren(db: number, node: ObjectNode, state: AssetTreeState) {
  // 由 payload.ns 找不到原 trie,因此 redisTrieToNode 时把 children 暂存;
  // 简化:redisTrieToNode 递归版直接返回 { node, descendants: Record<key, ObjectNode[]> }
}
```

**实现简化(推荐)**:把 `redisTrieToNode` 改成递归收集:

```ts
function redisTrieToNodes(db: number, t: RedisTreeNode, byKey: Record<string, ObjectNode[]>): ObjectNode {
  const node: ObjectNode = {
    key: t.isLeaf ? `rkey:${db}:${t.fullKey}` : `rns:${db}:${t.fullKey}`,
    kind: t.isLeaf ? 'redis-key' : 'redis-ns',
    label: t.name,
    count: t.isLeaf ? undefined : t.keyCount,
    hasChildren: !t.isLeaf && t.children.length > 0,
    payload: t.isLeaf ? { db, key: t.fullKey, type: t.keyType } : { db, ns: t.fullKey }
  }
  if (!t.isLeaf) byKey[node.key] = t.children.map(c => redisTrieToNodes(db, c, byKey))
  return node
}
// loadChildren 里:
const byKey: Record<string, ObjectNode[]> = {}
const nodes = trie.map(t => redisTrieToNodes(db, t, byKey))
state.childrenByKey[node.key] = nodes
Object.assign(state.childrenByKey, byKey)
```

`toggleNode` 里 `state.childrenByKey[node.key]` 已存在(ns 子级预填),不会重复请求——天然满足懒加载。同时 store import 加 `import { buildRedisNamespaceTree, type RedisTreeNode } from '@/utils/redisKeys'`。

- [ ] **Step 6: RedisView.vue 去侧栏 + 接事件**

1. 删模板 KeyBrowser 侧栏块(L394-408)及 `ResizableSidebarHandle` 包层;删 `keyBrowserRef`、`KeyBrowser` import;`dbSizes` / `refreshAllDBSizes` / `getDbSize` 若仅喂 KeyBrowser 则删(header 有 key 数显示则保留 `dbsize` + `refreshDBSize`)。
2. `onDeleteKey` / `onFlushDb` 里 `keyBrowserRef.value?.loadKeys()` 改为 `void objectTree.refreshAsset(assetId)`(import store;`assetId` 用现有冻结值 L40-43)。
3. 接事件(onMounted 追加 + 卸载移除,模式同 DbView):

```ts
function applyObjectSelection(kind: string, payload: Record<string, unknown>) {
  if (kind === 'redis-db') {
    void onSwitchDb(Number(payload.db ?? 0))
  } else if (kind === 'redis-key') {
    const db = Number(payload.db ?? 0)
    const open = () => onSelectKey(String(payload.key ?? ''), String(payload.type ?? ''))
    if (db !== currentDb.value) void onSwitchDb(db).then(open)
    else open()
  }
}
```

pending 兜底同 DbView(`takePendingSelection`)。
4. KeyBrowser.vue 删除前确认引用:

Run: `Grep "KeyBrowser" src/` → 只剩 RedisView 与自身 → `git rm src/components/redis/KeyBrowser.vue`

- [ ] **Step 7: 构建 + 单测**

Run: `npm run build && node --test tests/redis-keys.test.mjs`
Expected: 全过

- [ ] **Step 8: CHANGELOG + Commit**

`[未发布] ### 新增` 追加:

```markdown
- Redis 对象树并入资产树:db0-15(带 keyCount,空库无子级)→ 命名空间 trie(: 前缀,目录按 keyCount 降序)→ key;单次展开最多扫 500 key,超出给提示节点;RedisView 删除内部 KeyBrowser 侧栏(逻辑抽为 src/utils/redisKeys.ts 纯函数并配单测),删 key/FLUSHDB 后自动刷新树
```

```bash
git add src/utils/redisKeys.ts tests/redis-keys.test.mjs src/stores/objectTree.ts src/views/RedisView.vue CHANGELOG.md
git rm src/components/redis/KeyBrowser.vue
git commit -m "✨ feat(asset-tree): Redis db/key 3 层树接入 + RedisView 去 KeyBrowser 侧栏

- redisKeys.ts 纯函数(namespace trie)+ node --test 3 例
- objectTree redis 分支:keyspace 尺寸 + SCAN(上限 500)+ ns 子级预填
- RedisView 接 redis-db/redis-key 选中事件,删 KeyBrowser.vue"
```

---

### Task 4: ES 接入(分组 + 系统索引默认隐藏)+ ElasticsearchView 去侧栏 + EsOverview tab 化

**Files:**
- Create: `src/utils/esIndexGroups.ts`
- Test: `tests/es-index-groups.test.mjs`
- Modify: `src/stores/objectTree.ts`(es 分支)
- Modify: `src/views/ElasticsearchView.vue`(删 .es-sidebar;接事件)
- Modify: `src/components/es/EsOverview.vue`(概览/索引 两 tab)

**Interfaces:**
- Produces:
  - `groupEsIndices<T extends EsIndexLike>(indices: T[]): EsIndexGroup<T>[]`
  - `EsGroupKey = 'business' | 'metricbeat' | 'system'`(**决策修正**:mockup 的「其他」组无判定规则且恒为空,不做——三组:业务 / metricbeat-* / 系统)
  - 事件 kind:`'es-index'` payload `{index: string}`

- [ ] **Step 1: 失败测试 `tests/es-index-groups.test.mjs`**(transpile 模式同 Task 3)

```js
test('groupEsIndices: 点开头进系统组(默认隐藏),metricbeat 前缀单列,其余业务', () => {
  const groups = groupEsIndices([
    { name: 'log-oardsapi-2026.08.01' },
    { name: 'metricbeat-7.17.8-2026.03' },
    { name: '.monitoring-kibana-7-08.03' },
    { name: '.kibana_1' },
    { name: 'nginx-access' }
  ])
  assert.deepEqual(groups.map(g => g.key), ['business', 'metricbeat', 'system'])
  assert.deepEqual(groups[0].indices.map(i => i.name), ['log-oardsapi-2026.08.01', 'nginx-access'])
  assert.equal(groups[1].indices.length, 1)
  assert.equal(groups[2].indices.length, 2)
  assert.equal(groups[2].hidden, true)
  assert.equal(groups[0].hidden, false)
})

test('groupEsIndices: 空组被过滤;全系统索引时只剩 system 组', () => {
  const groups = groupEsIndices([{ name: '.a' }, { name: '.b' }])
  assert.deepEqual(groups.map(g => g.key), ['system'])
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/es-index-groups.test.mjs`
Expected: FAIL(ENOENT redisKeys 同款)

- [ ] **Step 3: 实现 `src/utils/esIndexGroups.ts`**

```ts
/**
 * ES 索引分组:业务 / metricbeat-* / 系统(默认隐藏)。
 * 纯函数,objectTree store 与 EsOverview 共用。
 */
export interface EsIndexLike {
  name: string
  docsCount?: number
}

export type EsGroupKey = 'business' | 'metricbeat' | 'system'

export interface EsIndexGroup<T extends EsIndexLike> {
  key: EsGroupKey
  label: string
  indices: T[]
  /** 默认隐藏(系统索引),树上展示为 "N (隐藏)" 且默认折叠 */
  hidden: boolean
}

export function groupEsIndices<T extends EsIndexLike>(indices: T[]): EsIndexGroup<T>[] {
  const business: T[] = []
  const metricbeat: T[] = []
  const system: T[] = []
  for (const idx of indices) {
    if (idx.name.startsWith('.')) system.push(idx)
    else if (idx.name.startsWith('metricbeat')) metricbeat.push(idx)
    else business.push(idx)
  }
  return [
    { key: 'business' as const, label: '业务索引', indices: business, hidden: false },
    { key: 'metricbeat' as const, label: 'metricbeat-*', indices: metricbeat, hidden: false },
    { key: 'system' as const, label: '系统索引', indices: system, hidden: true }
  ].filter(g => g.indices.length > 0)
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/es-index-groups.test.mjs`
Expected: pass 2/2

- [ ] **Step 5: objectTree.ts 加 es 分支**

`loadRoot`:

```ts
    if (dbType === 'elasticsearch') {
      const connId = state.connId!
      const indices = await dbService.esListIndices(connId)
      const groups = groupEsIndices(indices)
      state.rootChildren = groups.map(g => ({
        key: `esg:${g.key}`, kind: 'es-group' as const,
        label: g.hidden ? `${g.label}(${g.indices.length} 隐藏)` : g.label,
        count: g.indices.length,
        hasChildren: true,
        payload: { group: g.key }
      }))
      state.childrenByKey = {}
      for (const g of groups) {
        state.childrenByKey[`esg:${g.key}`] = g.indices.map(idx => ({
          key: `esi:${idx.name}`, kind: 'es-index' as const, label: idx.name,
          meta: idx.docsCount != null ? compactDocs(idx.docsCount) : undefined,
          hasChildren: false, payload: { index: idx.name }
        }))
      }
      return
    }
```

辅助(store 文件内):

```ts
function compactDocs(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}
```

import 加 `groupEsIndices`。系统组默认折叠不靠特殊逻辑——`expanded` 不预置它即可(用户点开才展示)。
`esListIndices` 返回类型 `EsIndexInfo` 满足 `EsIndexLike`(name 必需、docsCount number)。

- [ ] **Step 6: ElasticsearchView.vue 去侧栏 + 接事件**

1. 删模板 `.es-sidebar`(L445-480)及 `ResizableSidebarHandle` import/用法;删 `indexSearch` / `filteredIndices`(仅侧栏用);`onSidebarContextMenu`(L391-397)的「新建索引/刷新」挪成 header 右侧两个小按钮(mdi-database-plus / mdi-refresh),复用 `showNewIndex` / `loadIndices`。
2. `.es-body` 的 grid/flex 去掉侧栏轨道。
3. 接事件(onMounted + 卸载,模式同前):

```ts
function applyObjectSelection(kind: string, payload: Record<string, unknown>) {
  if (kind === 'es-index') selectIndex(String(payload.index ?? ''))
}
```

pending 兜底同前。删除索引成功后(`doDeleteIndex`)追加 `void objectTree.refreshAsset(assetId)`。

- [ ] **Step 7: EsOverview.vue tab 化**

1. script 加:

```ts
import { ref } from 'vue'
const ovTab = ref<'overview' | 'indices'>('overview')
```

2. 模板:`.es-overview` 顶部加 tab 条;`.overview-grid` 加 `v-show="ovTab === 'overview'"`;`.indices-table-wrap` 加 `v-show="ovTab === 'indices'"`:

```html
<div class="ov-tabs">
  <button class="ov-tab" :class="{ active: ovTab === 'overview' }" @click="ovTab = 'overview'">{{ t('db.overview', '概览') }}</button>
  <button class="ov-tab" :class="{ active: ovTab === 'indices' }" @click="ovTab = 'indices'">{{ t('db.indices') }} <span class="ov-count">{{ indices.length }}</span></button>
</div>
```

```css
.ov-tabs { display: flex; gap: 2px; margin-bottom: 12px; border-bottom: 1px solid var(--line); }
.ov-tab { padding: 6px 12px; font-size: 11px; color: var(--text-2); background: none; border: none; border-bottom: 2px solid transparent; cursor: pointer; font-family: inherit; }
.ov-tab.active { color: var(--cyan); border-bottom-color: var(--cyan); }
.ov-count { font-size: 9px; color: var(--muted); font-family: 'JetBrains Mono', monospace; }
```

i18n 检查:`db.overview` 若不存在,zh-CN/en-US 同步补(zh: 概览 / en: Overview)。

- [ ] **Step 8: 构建 + 单测**

Run: `npm run build && node --test tests/es-index-groups.test.mjs`
Expected: 全过

- [ ] **Step 9: CHANGELOG + Commit**

`[未发布] ### 新增` 追加:

```markdown
- ES 索引树并入资产树:按 业务 / metricbeat-* / 系统 三组组织,系统索引(.monitoring-*、.kibana_* 等 . 开头)默认折叠隐藏并标注数量;ElasticsearchView 删除内部索引侧栏(新建/刷新挪到 header),ES 概览面板改 概览/索引 两 tab,索引大表不再挤概览首屏
```

```bash
git add src/utils/esIndexGroups.ts tests/es-index-groups.test.mjs src/stores/objectTree.ts src/views/ElasticsearchView.vue src/components/es/EsOverview.vue src/i18n/zh-CN.ts src/i18n/en-US.ts CHANGELOG.md
git commit -m "✨ feat(asset-tree): ES 索引分组树接入 + ElasticsearchView 去侧栏 + EsOverview tab 化

- esIndexGroups.ts 纯函数(业务/metricbeat/系统,系统默认隐藏)+ node --test 2 例
- objectTree es 分支;视图接 es-index 事件;删索引后刷新树"
```

---

### Task 5: Kafka/NSQ 接入 + Go 扩 NSQ channel 明细

**Files:**
- Modify: `sidecar/adapters/broker.go`(NSQ channel 明细 + parseNsqStats 抽取)
- Test: `sidecar/adapters/broker_test.go`(没有则新建)
- Modify: `src/services/broker.ts`(类型加 channelList)
- Modify: `src/stores/objectTree.ts`(broker 分支,无会话直连)
- Modify: `src/views/BrokerView.vue`(topic 点击高亮选中态即可)

**Interfaces:**
- Produces:
  - Go:`BrokerResource.ChannelList []NSQChannel`;`NSQChannel = { Name, Depth, Backlog, Messages }`
  - TS:`BrokerResource.channelList?: { name: string; depth?: number; backlog?: number; messages?: number }[]`
  - 事件 kind:`'kafka-topic'` payload `{topic}`;`'nsq-topic'` payload `{topic}`;`'nsq-channel'` payload `{topic, channel}`(BrokerView 本轮只高亮,不消费)

- [ ] **Step 1: 先写 Go 失败测试 `sidecar/adapters/broker_test.go`**

若文件已存在,追加;不存在则新建:

```go
package adapters

import (
	"strings"
	"testing"
)

func TestParseNsqStatsWithChannels(t *testing.T) {
	body := `{
		"topics": [
			{
				"topic_name": "orders",
				"depth": 12,
				"message_count": 1000,
				"channels": [
					{"channel_name": "worker", "depth": 5, "backlog_count": 5, "message_count": 900},
					{"channel_name": "audit", "depth": 0, "backlog_count": 0, "message_count": 100}
				]
			},
			{"topic_name": "events", "depth": 0, "message_count": 3, "channels": []}
		]
	}`
	resources, err := parseNsqStats(strings.NewReader(body))
	if err != nil {
		t.Fatalf("parseNsqStats: %v", err)
	}
	if len(resources) != 2 {
		t.Fatalf("expected 2 topics, got %d", len(resources))
	}
	orders := resources[1] // 按 name 排序: events, orders
	if orders.Name != "orders" || orders.Channels != 2 || orders.Depth != 12 || orders.Messages != 1000 {
		t.Fatalf("unexpected orders resource: %+v", orders)
	}
	if len(orders.ChannelList) != 2 {
		t.Fatalf("expected 2 channels, got %d", len(orders.ChannelList))
	}
	if orders.ChannelList[0].Name != "worker" || orders.ChannelList[0].Backlog != 5 || orders.ChannelList[0].Messages != 900 {
		t.Fatalf("unexpected channel: %+v", orders.ChannelList[0])
	}
	events := resources[0]
	if events.Channels != 0 || len(events.ChannelList) != 0 {
		t.Fatalf("unexpected events resource: %+v", events)
	}
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd sidecar && go test ./adapters/ -run TestParseNsqStatsWithChannels -v`
Expected: FAIL(`undefined: parseNsqStats`)

- [ ] **Step 3: 改 `sidecar/adapters/broker.go`**

1. 结构体加:

```go
type NSQChannel struct {
	Name     string `json:"name"`
	Depth    int64  `json:"depth,omitempty"`
	Backlog  int64  `json:"backlog,omitempty"`
	Messages int64  `json:"messages,omitempty"`
}

// BrokerResource 加字段:
	ChannelList []NSQChannel `json:"channelList,omitempty"`
```

2. `NSQOverview` 的 stats 解析抽成可测函数,channels 从 `[]any` 改结构化解码:

```go
// parseNsqStats 解析 nsqd /stats?format=json 响应,返回按 name 排序的 topic 列表(含 channel 明细)。
func parseNsqStats(body io.Reader) ([]BrokerResource, error) {
	var payload struct {
		Topics []struct {
			Name         string `json:"topic_name"`
			Depth        int64  `json:"depth"`
			MessageCount int64  `json:"message_count"`
			Channels     []struct {
				Name         string `json:"channel_name"`
				Depth        int64  `json:"depth"`
				Backlog      int64  `json:"backlog_count"`
				MessageCount int64  `json:"message_count"`
			} `json:"channels"`
		} `json:"topics"`
	}
	if err := json.NewDecoder(body).Decode(&payload); err != nil {
		return nil, fmt.Errorf("decode nsqd stats: %w", err)
	}
	resources := make([]BrokerResource, 0, len(payload.Topics))
	for _, topic := range payload.Topics {
		channels := make([]NSQChannel, 0, len(topic.Channels))
		for _, ch := range topic.Channels {
			channels = append(channels, NSQChannel{
				Name:     ch.Name,
				Depth:    ch.Depth,
				Backlog:  ch.Backlog,
				Messages: ch.MessageCount,
			})
		}
		resources = append(resources, BrokerResource{
			Name:        topic.Name,
			Channels:    len(topic.Channels),
			Depth:       topic.Depth,
			Messages:    topic.MessageCount,
			ChannelList: channels,
		})
	}
	sort.Slice(resources, func(i, j int) bool { return resources[i].Name < resources[j].Name })
	return resources, nil
}
```

3. `NSQOverview` 里原 `var payload struct{...}` + decode + resources 组装段(L159-179)替换为:

```go
	resources, err := parseNsqStats(response.Body)
	if err != nil {
		return nil, err
	}
```

import 加 `"io"`。

- [ ] **Step 4: Go 构建 + 测试**

Run: `cd sidecar && go build ./... && go test ./adapters/ -run TestParseNsqStats -v && npm run --prefix .. sidecar:build`
Expected: 测试 PASS,sidecar 二进制重出(`sidecar/bin/starhub-sidecar.exe`)

- [ ] **Step 5: `src/services/broker.ts` 类型同步**

```ts
export interface BrokerChannel {
  name: string
  depth?: number
  backlog?: number
  messages?: number
}

export interface BrokerResource {
  name: string
  partitions?: number
  channels?: number
  depth?: number
  messages?: number
  leader?: string
  channelList?: BrokerChannel[]
}
```

- [ ] **Step 6: objectTree.ts broker 分支(无会话,直连 overview)**

`ensureConnection` 对 kafka/nsq 返回空串不建会话——在 `ensureAsset` 里特殊化:broker 类跳过 `ensureConnection`,直接 `loadRoot`;`loadRoot` 加:

```ts
  async function loadRoot(asset: Asset, state: AssetTreeState): Promise<void> {
    const dbType = asset.config.dbType || 'mysql'
    if (dbType === 'kafka' || dbType === 'nsq') {
      const cfg = asset.config as Record<string, unknown>
      const overview = await loadBrokerOverview(dbType, {
        host: String(cfg.host ?? ''),
        port: Number(cfg.port ?? 0),
        username: cfg.username ? String(cfg.username) : undefined,
        password: cfg.password ? String(cfg.password) : undefined,
        ssl: Boolean(cfg.ssl)
      })
      if (dbType === 'kafka') {
        state.rootChildren = overview.resources.map(r => ({
          key: `kt:${r.name}`, kind: 'kafka-topic' as const, label: r.name,
          count: r.partitions, hasChildren: false, payload: { topic: r.name }
        }))
      } else {
        state.rootChildren = overview.resources.map(r => ({
          key: `nt:${r.name}`, kind: 'nsq-topic' as const, label: r.name,
          count: r.channels,
          meta: r.depth != null && r.depth > 0 ? `积压 ${r.depth}` : undefined,
          hasChildren: (r.channelList?.length ?? 0) > 0,
          payload: { topic: r.name }
        }))
        for (const r of overview.resources) {
          if (r.channelList?.length) {
            state.childrenByKey[`nt:${r.name}`] = r.channelList.map(ch => ({
              key: `nc:${r.name}/${ch.name}`, kind: 'nsq-channel' as const, label: ch.name,
              meta: ch.backlog != null && ch.backlog > 0 ? `积压 ${ch.backlog}` : undefined,
              hasChildren: false, payload: { topic: r.name, channel: ch.name }
            }))
          }
        }
      }
      return
    }
    // ... 原有 mysql/pg/ch/redis/es 分支
```

`ensureAsset` 调整:

```ts
      if (dbType === 'kafka' || dbType === 'nsq') {
        state.connId = null
      } else {
        state.connId = await ensureConnection(asset)
      }
      await loadRoot(asset, state)
```

(dbType 在 ensureAsset 顶部取 `const dbType = asset.config.dbType || 'mysql'`。)

- [ ] **Step 7: BrokerView 选中高亮(轻量)**

BrokerView 不消费对象页;在 DashboardCard 的 topic 明细表行上监听事件高亮即可——**简化决策**:本轮 BrokerView 不改(树点击仍会复用/打开 Broker tab,overview 30s 轮询自洽)。此步只验证树侧行为。

- [ ] **Step 8: 前端构建**

Run: `npm run build`
Expected: 通过

- [ ] **Step 9: CHANGELOG + Commit**

`[未发布] ### 新增` 追加:

```markdown
- Kafka/NSQ topic 树并入资产树:Kafka topic(分区数)直挂实例;NSQ topic → channel 二级(sidecar NSQOverview 扩展返回 channel 明细:名称/深度/积压/累计消息,parseNsqStats 抽取并配 Go 单测)
```

```bash
git add sidecar/adapters/broker.go sidecar/adapters/broker_test.go sidecar/bin/ src/services/broker.ts src/stores/objectTree.ts CHANGELOG.md
git commit -m "✨ feat(asset-tree): Kafka/NSQ topic 树接入 + NSQ channel 明细(Go)

- broker.go: parseNsqStats 抽取 + NSQChannel 明细 + 单测
- objectTree broker 分支(无会话直连 overview)"
```

---

### Task 6: DbDashboard tab 分组(概览/性能/网络)

**Files:**
- Modify: `src/components/dashboard/DbDashboard.vue`

**Interfaces:**
- Consumes: 无新依赖;不改 props(`{ connId, dbType, connected, database? }`)、不改 load 逻辑。

- [ ] **Step 1: 加分组 tab 状态与映射**

script 加:

```ts
type DashTab = 'overview' | 'performance' | 'network'
const dashTab = ref<DashTab>('overview')
const dashTabs = computed<DashTab[]>(() => {
  if (props.dbType === 'mysql') return ['overview', 'performance', 'network']
  if (props.dbType === 'postgresql' || props.dbType === 'redis') return ['overview', 'performance']
  return ['overview']
})
const dashTabLabel: Record<DashTab, string> = {
  overview: t('db.dashOverview', '概览'),
  performance: t('db.dashPerformance', '性能'),
  network: t('db.dashNetwork', '网络')
}
```

卡片 → tab 映射(按现有模板卡序给每个 `DashboardCard` 包 `v-show="dashTab === 'xxx'"`):

| dbType | overview | performance | network |
|---|---|---|---|
| mysql | 运行时间 / 连接数(含明细) / 数据大小 / 表数量 | 累计查询 / 慢查询(含明细) / 缓冲池命中率 / 活跃线程 | 网络接收 / 网络发送 |
| postgresql | 运行时间 / 连接数(含明细) / 数据库大小 / 当前 Schema 表数 | 活跃会话 / 慢语句(含明细) / 缓存命中率 / 累计事务 | — |
| redis | 运行时间 / 已用内存 / 总键数 / 客户端连接 | 命中率 / 峰值内存 / 累计命令数 / 每秒操作数 | — |

- [ ] **Step 2: 模板加 tab 条**

在三个 dbType 分支(redis L440-531 / mysql L534-658 / pg L662-745)各自卡片网格**上方**插入(三分支各一份,或抽成分支外公共一段——推荐抽公共:`v-if="dbType === 'mysql' || dbType === 'postgresql' || dbType === 'redis'"`):

```html
<div class="dash-tabs">
  <button
    v-for="tab in dashTabs" :key="tab"
    class="dash-tab" :class="{ active: dashTab === tab }"
    @click="dashTab = tab"
  >{{ dashTabLabel[tab] }}</button>
</div>
```

```css
.dash-tabs { display: flex; gap: 2px; margin-bottom: 12px; border-bottom: 1px solid var(--line); }
.dash-tab { padding: 6px 12px; font-size: 11px; color: var(--text-2); background: none; border: none; border-bottom: 2px solid transparent; cursor: pointer; font-family: inherit; }
.dash-tab.active { color: var(--cyan); border-bottom-color: var(--cyan); }
```

unsupported 分支(clickhouse/mssql/sqlite 占位,L749-754)不加 tab。

- [ ] **Step 3: i18n 补 key**

zh-CN:`db.dashOverview: '概览'`、`db.dashPerformance: '性能'`、`db.dashNetwork: '网络'`;en-US 对应 `Overview / Performance / Network`。(`db.overview` 若 Task 4 已加则复用,key 冲突时统一用 `db.dashOverview`。)

- [ ] **Step 4: 构建验证**

Run: `npm run build`
Expected: 通过

- [ ] **Step 5: CHANGELOG + Commit**

`[未发布] ### 新增` 追加:

```markdown
- DbDashboard 指标卡改 tab 分组:MySQL 概览(4)/性能(4)/网络(2),PostgreSQL 概览(4)/性能(4),Redis 概览(4)/性能(4),单屏不再堆 8-9 张卡;数据加载逻辑不变
```

```bash
git add src/components/dashboard/DbDashboard.vue src/i18n/zh-CN.ts src/i18n/en-US.ts CHANGELOG.md
git commit -m "✨ feat(dashboard): DbDashboard 指标卡按 概览/性能/网络 tab 分组"
```

---

### Task 7: 真实布局浏览器回归 + 版本收口

**Files:**
- Modify: `CHANGELOG.md`(`[未发布]` → `[0.39.0] - 2026-08-03`)
- Modify: `AGENTS.md` / `README.md`(若 Task 1 已改版本行,本步只校对)

- [ ] **Step 1: 全量构建 + 全部单测**

Run: `npm run build && npm run test:utils && node --test tests/redis-keys.test.mjs tests/es-index-groups.test.mjs tests/ai-steering.test.mjs && cd sidecar && go build ./... && go test ./... && cd ..`
Expected: 全过

- [ ] **Step 2: 浏览器回归(AGENTS.md 7.3 强制)**

`npm run dev -- --host 127.0.0.1` 后台起;浏览器 1280×800 开 `http://127.0.0.1:1420/`,覆盖:

- 资产树:过滤输入可用;DB 资产展开(纯浏览器无 IPC → 显示「连接失败 · 重试」内联,不触发全局 ErrorBoundary);分组折叠状态刷新后保留
- ⌘K 与 Ctrl+P 都能唤起命令面板,Esc 关闭;顶栏无搜索框残留
- 状态栏 24px、内容不溢出;900px 窄视口断点正常
- DbView(有 mock/历史 tab 时):无左侧栏,工具栏连接身份 + 按钮齐全;右面板 Dashboard tab 条出现且切换正常
- 深浅双主题截图对比(token 生效,无硬编码颜色残留)
- console 无新增 error

发现问题修复后从 reload 重走一遍。

- [ ] **Step 3: CHANGELOG 收口**

`CHANGELOG.md`:把 `[未发布] ### 新增` 下本 feature 全部条目移到新段落 `## [0.39.0] - 2026-08-03` 的 `### 新增` 下;`[未发布]` 保留 `### 计划中` 原有内容。校对七处版本号一致(0.39.0):`grep -n '"version"' package.json src-tauri/tauri.conf.json; grep -n '^version' src-tauri/Cargo.toml; grep -n -A1 'name = "starhub"' src-tauri/Cargo.lock; grep -n '当前版本' AGENTS.md; grep -n 'badge' README.md | head -2`。

- [ ] **Step 4: Commit + push**

```bash
git add CHANGELOG.md AGENTS.md README.md
git commit -m "📝 docs: v0.39.0 收口(CHANGELOG 发布段 + 版本校对)"
git push
```

---

## Self-Review 记录

- Spec 3.1-3.6 → Task 2(3.1/3.2/3.3 DbView)、3(Redis)、4(ES + EsOverview)、5(3.6 + broker)、6(3.4 DbDashboard)、1(3.5)。spec 实施顺序 1-7 全覆盖。
- 「其他」ES 分组:无判定规则,spec 与 mockup 不一致处已在 Task 4 修正为三组。
- mockup Dashboard 第 4 tab「AI」:RightPanel 已有 AI tab,按 spec 3.4 偏差不放。
- 版本号 6.5.1 每 commit bump 规则:按 Global Constraints 的折中(Task 1 首 bump 0.39.0)执行,用户已知情。
