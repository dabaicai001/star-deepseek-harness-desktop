# Elasticsearch Support — Design Spec

> **Date**: 2026-06-10  
> **Status**: Draft → Awaiting Implementation Plan  
> **Author**: AI Agent + User  
> **Scope**: Add full Elasticsearch support across Go Sidecar, Rust Backend, and Vue Frontend

---

## 1. Overview

StarHub currently supports MySQL and Redis as database types. This spec adds Elasticsearch as a third fully-supported database backend, following the same three-layer architecture pattern:

- **Go Sidecar**: `go-elasticsearch v8` client, exposes 19 JSON-RPC methods
- **Rust Backend**: Thin pass-through Tauri commands (one per RPC method)
- **Vue Frontend**: New `ElasticsearchView.vue` + connection form updates + routing + i18n

### Goals

1. Full ES integration matching RedisView feature depth (cluster health, index browser, DSL search, document CRUD, import/export)
2. Table + JSON dual view for search results (auto-detect _source fields as columns)
3. Follow existing MySQL/Redis patterns precisely (adapter → handlers → commands → service → store → view)
4. All UI uses `cyber.css` design tokens, zero hardcoded colors
5. Separate `ElasticsearchView.vue` (not crammed into DbView.vue)

---

## 2. File Structure

### New files

```
sidecar/
└── adapters/
    └── elasticsearch.go          # ES adapter + types (~800 lines)

src/
├── views/
│   └── ElasticsearchView.vue     # Four-tab view: Overview/Search/Index/ImportExport (~800 lines)
├── components/
│   └── es/
│       ├── EsSearchEditor.vue    # DSL editor (CodeMirror + lang-json) + execute button
│       ├── EsResultTable.vue     # Table view of search hits (auto-column detection)
│       ├── EsResultJson.vue      # JSON tree view of search hits
│       ├── EsIndexDetail.vue     # Index stats + mapping tree + settings + document preview
│       └── EsImportExport.vue    # JSON file import/export with progress
```

### Modified files

```
sidecar/
├── adapters/handlers.go          # Add ES RPC handlers (~250 lines)
├── pool/manager.go               # Add ConnES constant
└── go.mod                        # Add go-elasticsearch v8

src-tauri/src/
├── commands/db.rs                # Add 19 ES Tauri commands (~250 lines)
└── main.rs                       # Register ES commands in invoke_handler

src/
├── types/asset.ts                # Add 'elasticsearch' to DatabaseType
├── types/db.ts                   # Add ES types (EsConnectParams, ClusterHealth, EsSearchResult...)
├── services/db.ts                # Add 19 ES invoke wrappers
├── stores/db.ts                  # Add connectElasticsearch(), disconnect case
├── components/db/DbConnectionForm.vue  # Add ES connection fields
├── components/common/NewConnectionDialog.vue  # Update type description
├── components/asset/AssetTree.vue       # Add ES icon, label, routing, CSS
├── router/index.ts               # Add db/elasticsearch/:id route
├── i18n/zh-CN.ts                 # Add ~25 ES i18n keys
├── i18n/en-US.ts                 # Add ~25 ES i18n keys
└── styles/cyber.css              # Add .db-elasticsearch CSS class (if needed)
```

---

## 3. Go Sidecar — RPC Methods & Data Structures

### 3.1 Dependencies

Add to `go.mod`:
```
github.com/elastic/go-elasticsearch/v8
```

### 3.2 Connection Type

In `pool/manager.go`:
```go
const ConnES ConnType = "elasticsearch"
```

### 3.3 ElasticsearchConnInfo

```go
type ElasticsearchConnInfo struct {
    Host     string `json:"host"`
    Port     int    `json:"port"`
    Username string `json:"username"`
    Password string `json:"password"`
    UseSSL   bool   `json:"useSSL"`
    APIKey   string `json:"apiKey"`   // Mutually exclusive with password
}
```

### 3.4 ElasticsearchAdapter

```go
type ElasticsearchAdapter struct {
    client    *elasticsearch.Client
    connInfo  ElasticsearchConnInfo
    clusterName string
}
```

Implements the `DBAdapter` interface (`Ping()`, `Close()`).

### 3.5 RPC Method Catalog (19 methods)

| # | Method | Params | Returns | Description |
|---|--------|--------|---------|-------------|
| 1 | `db.es.connect` | `ElasticsearchConnInfo` | `{clusterName, version}` | Connect, return cluster info |
| 2 | `db.es.test` | `ElasticsearchConnInfo` (no sessionId) | `{success}` | Test connectivity |
| 3 | `db.es.disconnect` | `{sessionId}` | `{success}` | Close connection |
| 4 | `db.es.clusterHealth` | `{sessionId}` | `ClusterHealthInfo` | Cluster health report |
| 5 | `db.es.clusterStats` | `{sessionId}` | `ClusterStatsInfo` | Node/shard/storage stats |
| 6 | `db.es.listIndices` | `{sessionId}` | `[]IndexInfo` | List all indices with stats |
| 7 | `db.es.getIndexMapping` | `{sessionId, index}` | `IndexMappingInfo` | Field mappings |
| 8 | `db.es.getIndexSettings` | `{sessionId, index}` | `map[string]any` | Index settings |
| 9 | `db.es.createIndex` | `{sessionId, index, mappings?, settings?}` | `{acknowledged}` | Create index |
| 10 | `db.es.deleteIndex` | `{sessionId, index}` | `{acknowledged}` | Delete index |
| 11 | `db.es.search` | `{sessionId, index, body, from?, size?}` | `EsSearchResult` | DSL search |
| 12 | `db.es.count` | `{sessionId, index, body?}` | `{count}` | Count matching docs |
| 13 | `db.es.getDocument` | `{sessionId, index, id}` | `DocumentResult` | Get doc by ID |
| 14 | `db.es.indexDocument` | `{sessionId, index, id?, body}` | `{id, version, result}` | Create/replace doc |
| 15 | `db.es.updateDocument` | `{sessionId, index, id, body}` | `{version, result}` | Partial update |
| 16 | `db.es.deleteDocument` | `{sessionId, index, id}` | `{result}` | Delete doc |
| 17 | `db.es.bulkIndex` | `{sessionId, index, documents}` | `{took, errors, items}` | Bulk import |
| 18 | `db.es.exportJSON` | `{sessionId, index, body?, size?}` | `{documents}` | Export as JSON array |
| 19 | `db.es.scrollSearch` | `{sessionId, index, body, size?}` | `{scrollId, hits, total}` | Scroll API for large exports |

### 3.6 Key Result Types

```go
type ClusterHealthInfo struct {
    ClusterName             string `json:"clusterName"`
    Status                  string `json:"status"` // green/yellow/red
    NumberOfNodes           int    `json:"numberOfNodes"`
    NumberOfDataNodes       int    `json:"numberOfDataNodes"`
    ActivePrimaryShards     int    `json:"activePrimaryShards"`
    ActiveShards            int    `json:"activeShards"`
    ActiveShardsPercent     float64 `json:"activeShardsPercent"`
    UnassignedShards        int    `json:"unassignedShards"`
}

type IndexInfo struct {
    Name          string `json:"name"`
    DocsCount     int64  `json:"docsCount"`
    StoreSize     string `json:"storeSize"`
    Health        string `json:"health"`
    Status        string `json:"status"` // open/close
    PrimaryShards int    `json:"primaryShards"`
    ReplicaShards int    `json:"replicaShards"`
}

type FieldInfo struct {
    Name     string      `json:"name"`
    Type     string      `json:"type"`
    Children []FieldInfo `json:"children,omitempty"`
}

type IndexMappingInfo struct {
    IndexName string      `json:"indexName"`
    Fields    []FieldInfo `json:"fields"`
}

type EsSearchResult struct {
    Took         int                    `json:"took"`
    TimedOut     bool                   `json:"timedOut"`
    TotalHits    int64                  `json:"totalHits"`
    MaxScore     *float64               `json:"maxScore"`
    Hits         []EsSearchHit          `json:"hits"`
    Aggregations map[string]interface{} `json:"aggregations"`
}

type EsSearchHit struct {
    Index  string                 `json:"index"`
    ID     string                 `json:"id"`
    Score  *float64               `json:"score"`
    Source map[string]interface{} `json:"source"`
}

type DocumentResult struct {
    Index   string                 `json:"index"`
    ID      string                 `json:"id"`
    Version int64                  `json:"version"`
    Found   bool                   `json:"found"`
    Source  map[string]interface{} `json:"source"`
}
```

---

## 4. Rust Backend — Tauri Commands

### 4.1 `src-tauri/src/commands/db.rs` — New Commands

All 19 commands follow the same pass-through pattern. Example:

```rust
#[tauri::command]
pub async fn db_es_connect(
    sidecar: State<'_, SidecarManager>,
    params: Value,
) -> Result<Value, String> {
    sidecar.call("db.es.connect", params).await
}

#[tauri::command]
pub async fn db_es_search(
    sidecar: State<'_, SidecarManager>,
    session_id: String,
    index: String,
    body: Value,
    from: Option<usize>,
    size: Option<usize>,
) -> Result<Value, String> {
    let params = json!({
        "sessionId": session_id,
        "index": index,
        "body": body,
        "from": from.unwrap_or(0),
        "size": size.unwrap_or(20),
    });
    sidecar.call("db.es.search", params).await
}
```

### 4.2 `src-tauri/src/main.rs` — Registration

Add all 19 commands to the `invoke_handler` macro:
```rust
.invoke_handler(tauri::generate_handler![
    // ... existing commands ...
    commands::db::db_es_connect,
    commands::db::db_es_test,
    commands::db::db_es_disconnect,
    commands::db::db_es_cluster_health,
    // ... all 19 ...
])
```

---

## 5. Frontend — Types & Service & Store

### 5.1 `src/types/asset.ts`

```ts
export type DatabaseType = 'mysql' | 'postgresql' | 'sqlite' | 'redis' | 'elasticsearch'
```

### 5.2 `src/types/db.ts`

Add `'elasticsearch'` to `DatabaseType` union. Add all ES-specific types matching the Go structs (EsConnectParams, ClusterHealth, IndexInfo, FieldInfo, IndexMappingInfo, EsSearchResult, EsSearchHit, DocumentResult, BulkResult, ScrollResult).

### 5.3 `src/services/db.ts`

Add 19 `invoke()` wrapper functions, one per Tauri command:
```ts
export async function esConnect(params: EsConnectParams): Promise<ClusterInfo>
export async function esTest(params: Omit<EsConnectParams, 'sessionId'>): Promise<{success: boolean}>
export async function esSearch(sessionId: string, index: string, body: object, from?: number, size?: number): Promise<EsSearchResult>
// ...
```

### 5.4 `src/stores/db.ts`

- New `connectElasticsearch()` method in the store
- `disconnect()` adds `case 'elasticsearch': await esDisconnect(sessionId); break;`
- ES session state: `selectedIndex: string | null`, `lastDsl: string`

---

## 6. Frontend — Connection Form

### `src/components/db/DbConnectionForm.vue`

Add a third DB type button in `.db-type-switcher`:
```html
<button :class="['cyber-btn', dbType === 'elasticsearch' ? 'primary' : 'secondary']"
        @click="switchDbType('elasticsearch')">
  <v-icon size="18">mdi-database-search</v-icon>
  Elasticsearch
</button>
```

ES-specific fields (shown when `dbType === 'elasticsearch'`):
- **Host**: text input, default `localhost`
- **Port**: number input, default `9200`
- **Auth Mode**: toggle between `Basic Auth` (username + password) and `API Key` (single text field)
- **SSL**: checkbox, default off
- **Default Port**: `watch(dbType)` sets port to `9200` when switching to ES

---

## 7. Frontend — ElasticsearchView.vue

### 7.1 Layout

```
┌──────────────────────────────────────────────────────────────────┐
│ header: connection info + status dot + disconnect button          │ 48px
├───────────────┬──────────────────────────────────────────────────┤
│ sidebar (260) │ tab-bar: [Overview] [Search] [Index] [Import/Export]│
│               ├──────────────────────────────────────────────────┤
│ index list    │ tab content area (fills remaining space)           │
│ + search      │                                                   │
│ + new index   │                                                   │
│               │                                                   │
├───────────────┴──────────────────────────────────────────────────┤
│ statusbar: cluster health dot + stats summary                     │ 30px
└──────────────────────────────────────────────────────────────────┘
```

### 7.2 Sidebar — Index List

- Search filter input (filters index names by substring)
- Index list using `.tree-item` / `.tree-item.active` classes
- Each item: icon + index name + doc count badge + health dot (green/yellow/red)
- "New Index" button at bottom
- Clicking an index: selects it, navigates to Search/Index tab

### 7.3 Tab 1: Overview

- **Cluster Health Card**: Big status dot (green/yellow/red) + cluster name + version
  - Sub-stats: nodes, data nodes, active shards, active shards %, unassigned shards
- **Index Summary Table**:
  - Columns: Name | Docs | Primary Shards | Replicas | Size | Health | Status | Actions
  - Sortable columns
  - Click index name → select index + switch to Index tab
  - Actions: open index, close index

### 7.4 Tab 2: Search

- **Left (40%)**: DSL Editor
  - CodeMirror 6 with `lang-json`
  - Template placeholder showing basic `{"query": {"match_all": {}}, "size": 20}`
  - Execute button (blue glow) + keyboard shortcut `Ctrl+Enter`
  - Optional: index dropdown to search across a specific index
  - Optional: size (10/20/50/100) and from (pagination)

- **Right (60%)**: Results Panel
  - **Toolbar**: "1,234 hits · 12ms" + [Table] [JSON] view toggle + page navigation
  - **Table View** (`EsResultTable.vue`):
    - Auto-detect columns from `_source` fields across all hits in current page
    - Columns: `_id` | `_score` | dynamic _source fields...
    - Click row → slide-in drawer showing full document JSON
    - Missing fields show empty cells
  - **JSON View** (`EsResultJson.vue`):
    - Syntax-highlighted JSON tree (collapsible)
    - Show `hits.hits[]` array as primary view
    - Above the hits: `took`, `totalHits`, `maxScore` summary
  - **Pagination**: Previous/Next buttons using ES `from`/`size`

### 7.5 Tab 3: Index Detail

Shown when an index is selected in sidebar. Three sub-sections:

1. **Index Stats Cards**: Doc count, store size, primary/replica shards, health status
2. **Mapping Tree** (`EsIndexDetail.vue`):
   - Recursive tree view of field names + types
   - Nested fields shown as expandable children
   - Field type badges: `text` (cyan), `keyword` (green), `long`/`integer` (yellow), `date` (purple), `boolean` (muted), `nested`/`object` (pink), `geo_point` (orange)
3. **Settings Panel**: Collapsible, read-only JSON view of index settings
4. **Document Preview**: Last 20 documents from the index in a mini table (columns same as Search table)
5. **Danger Zone Actions** (with confirmation dialogs): Delete index, Clear index data, Refresh/Flush

### 7.6 Tab 4: Import / Export

- **Import Section**:
  - Drag-and-drop zone (or file picker) for `.json` / `.ndjson` files
  - File preview: shows first 5 lines/objects
  - Target index: dropdown of existing indices OR text input for new index
  - Import button → `db.es.bulkIndex` → progress bar
  - Result summary: `{ took: '2s', errors: false, items: 15000 }`

- **Export Section**:
  - Index selector dropdown
  - Optional: DSL filter query (to export subset)
  - Max documents limit input
  - Export button → streams via scroll API → saves to file
  - Progress: shows docs exported / total

---

## 8. Frontend — Router & AssetTree & i18n

### 8.1 Router (`src/router/index.ts`)

```ts
{
  path: 'db/elasticsearch/:id',
  name: 'db-elasticsearch',
  component: () => import('@/views/ElasticsearchView.vue'),
  props: true,
}
```

### 8.2 AssetTree (`src/components/asset/AssetTree.vue`)

- `getDbLabel()`: add `case 'elasticsearch': return 'ES'`
- `getIcon()`: add `case 'elasticsearch': return 'mdi-database-search'`
- `connectToAsset()`: route to `{ name: 'db-elasticsearch', params: { id } }`
- CSS: add `.db-elasticsearch` with a distinctive connection-line color (use `--purple` token or a new `--es-gold` token)

### 8.3 NewConnectionDialog (`src/components/common/NewConnectionDialog.vue`)

Update description text: `MySQL · Redis · Elasticsearch`

### 8.4 i18n

Add ~25 keys to both `zh-CN.ts` and `en-US.ts`:

```
db.elasticsearch: 'Elasticsearch' / 'Elasticsearch'
db.index: '索引' / 'Index'
db.indices: '索引列表' / 'Indices'
db.search: '搜索' / 'Search'
db.dslQuery: 'DSL 查询' / 'DSL Query'
db.mapping: '映射' / 'Mapping'
db.settings: '设置' / 'Settings'
db.importJSON: '导入 JSON' / 'Import JSON'
db.exportJSON: '导出 JSON' / 'Export JSON'
db.clusterHealth: '集群健康' / 'Cluster Health'
db.documents: '文档' / 'Documents'
db.newIndex: '新建索引' / 'New Index'
db.deleteIndex: '删除索引' / 'Delete Index'
db.clearIndex: '清空索引' / 'Clear Index'
db.documentPreview: '文档预览' / 'Document Preview'
db.totalHits: '共 {n} 条结果' / '{n} results'
db.dragOrClick: '拖拽文件到此处或点击上传' / 'Drag file here or click to upload'
db.importSuccess: '导入成功: {n} 条文档' / 'Import success: {n} docs'
db.exporting: '导出中...' / 'Exporting...'
db.fieldType: '字段类型' / 'Field Type'
db.emptyDsl: '请输入 DSL 查询语句' / 'Please enter a DSL query'
db.table: '表格' / 'Table'
db.json: 'JSON'
db.bulkImport: '批量导入' / 'Bulk Import'
db.authMode: '认证方式' / 'Auth Mode'
db.apiKey: 'API Key'
```

---

## 9. Design System Compliance

All new components must:
- Use CSS variables from `src/styles/cyber.css` only (no hardcoded colors)
- Use `.cyber-panel`, `.cyber-card`, `.cyber-btn`, `.tree-item`, `.status-dot`, `.cyber-input`, `.cyber-tab` classes
- Status dots: `--green` (online/healthy), `--yellow` (warning), `--red` (error/unhealthy), `--cyan` (active)
- Fonts: Outfit for UI text, JetBrains Mono for JSON/DSL editor, monospace numbers
- Animations: 0.2s fast (button hover), 0.3s medium (card hover), `ease-out` curve

New CSS class if needed:
```css
.db-elasticsearch { --conn-color: var(--purple); }
```

---

## 10. Implementation Order

| Step | Layer | Files | Effort |
|------|-------|-------|--------|
| 1 | Go Sidecar | `elasticsearch.go` (new), `handlers.go`, `pool/manager.go`, `go.mod` | ~800 lines |
| 2 | Rust | `commands/db.rs`, `main.rs` | ~150 lines |
| 3 | Frontend Types/Svc/Store | `types/asset.ts`, `types/db.ts`, `services/db.ts`, `stores/db.ts` | ~200 lines |
| 4 | Connection Form | `DbConnectionForm.vue` | ~80 lines |
| 5 | ElasticsearchView | `ElasticsearchView.vue` + 5 sub-components | ~800 lines |
| 6 | Integration | `router/index.ts`, `AssetTree.vue`, `NewConnectionDialog.vue`, i18n files | ~100 lines |
| 7 | Documentation | `AGENTS.md`, `CHANGELOG.md`, `docs/技术方案.md` | ~30 lines |

**Total estimate**: ~2,160 lines across 19 files.

---

## 11. Risks & Notes

1. **go-elasticsearch v8 API**: The official client is low-level (you construct JSON bodies directly). This is fine for our pass-through architecture since the frontend constructs the DSL JSON and we just forward it.
2. **Table auto-column detection**: Since ES documents in the same index can have different fields, we union all field names from the current page's `_source` objects. This may show empty cells for documents missing specific fields — intentional and acceptable.
3. **Scroll API for exports**: Large exports (>10k docs) use the scroll API to avoid deep pagination limits. The `scrollSearch` RPC method handles this.
4. **ES version compatibility**: go-elasticsearch v8 works with ES 8.x and has backward compatibility with 7.x. The `version` field from the root `/` endpoint is returned on connect and displayed in the header.
