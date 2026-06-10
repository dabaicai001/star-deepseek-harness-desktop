# Redis Page Complete Redesign — Design Spec

> **Date**: 2026-06-10  
> **Status**: Draft → Awaiting Implementation Plan  
> **Author**: AI Agent + User  
> **Scope**: Full rewrite of RedisView.vue and all related components

---

## 1. Overview

The current Redis page (`src/views/RedisView.vue`, 700 lines) is a single-file component with basic functionality: key scan, value view (plain `<pre>`), and a basic CLI. Compared to the MySQL page (`DbView.vue`, 1754+ lines with three-column layout, sub-tabs, dashboard, AI, DataGrid), the Redis page lacks:

- **No three-column layout** (no RightPanel with Dashboard / AI)
- **No multi-tab system** (only one key at a time)
- **No data editors** (values are read-only `<pre>` display)
- **No design system alignment** (mostly scoped hardcoded styles, barely uses `cyber.css`)
- **No Redis-specific tools** (Pub/Sub, Slowlog, BigKey scan, Memory analysis)

### Goals

1. **Complete rewrite** — dismantle 700-line monolithic file into ~14 focused components
2. **Three-column layout** matching DbView pattern (sidebar + main + right panel)
3. **Type-specific visual editors** for all 5 Redis data types
4. **Redis-specific tools**: Pub/Sub monitor, Slowlog viewer, BigKey scanner, Memory analyzer
5. **Design system alignment**: all styles use `cyber.css` classes + CSS variables, zero hardcoded colors
6. **Full AI integration**: reuse existing AI chat panel with Redis context

---

## 2. File Structure

### New files

```
src/
├── views/
│   └── RedisView.vue                    # Rewrite: three-column skeleton (~200 lines)
├── components/
│   ├── redis/
│   │   ├── KeyBrowser.vue               # Left panel: DB selector + filters + grouped key tree
│   │   ├── KeyBrowserNode.vue           # Single key node (icon + name + TTL badge + delete)
│   │   ├── RedisValueEditor.vue         # Center: multi-tab container, dispatches by type
│   │   ├── editors/
│   │   │   ├── StringEditor.vue         # Monaco editor (JSON/text/Base64 modes)
│   │   │   ├── HashEditor.vue           # Editable field-value table
│   │   │   ├── ListEditor.vue           # Ordered list + inline edit + reorder
│   │   │   ├── SetEditor.vue            # Member set + add/delete
│   │   │   └── ZSetEditor.vue           # Member + score table
│   │   ├── RedisCli.vue                 # Enhanced CLI (command history, autocomplete, highlight)
│   │   └── RedisTools.vue               # Right panel tool container (tab switcher)
│   │       ├── PubSubMonitor.vue        # Subscribe channels + real-time message stream
│   │       ├── SlowlogViewer.vue        # Slow query list + detail
│   │       ├── BigKeyScanner.vue        # Big key scan + progress + results table
│   │       └── MemoryAnalyzer.vue       # Memory analysis by key prefix
│   └── dashboard/
│       └── DbDashboard.vue              # Existing: extends for Redis-specific metrics
└── types/
    └── db.ts                            # Add: PubSubMessage, SlowlogEntry, BigKeyEntry, MemoryAnalysisEntry
```

### Modified files

| File | Change |
|---|---|
| `src/views/RedisView.vue` | Complete rewrite |
| `src/stores/db.ts` | Add Redis-specific state (subscriptions, slowlog, etc.) |
| `src/services/db.ts` | Add 8 new IPC service functions |
| `src/types/db.ts` | Add Redis-specific type definitions |
| `src/components/dashboard/DbDashboard.vue` | Add Redis metric cards |
| `sidecar/adapters/redis.go` | Add Subscribe, Slowlog, ScanAll, MemoryUsage, BigKeyScan, FlushDB |
| `sidecar/adapters/handlers.go` | Add 8 new JSON-RPC handlers |
| `sidecar/pool/manager.go` | Add PubSub lifecycle to ConnRedis |
| `src-tauri/src/commands/db.rs` | Add 8 new Tauri commands |
| `src-tauri/src/main.rs` | Register new commands |
| `src/styles/cyber.css` | Add any missing token/classes (e.g., `.redis-cli`, `.key-node`) |

---

## 3. Layout Skeleton (RedisView.vue)

```
┌──────────────────────────────────────────────────────────────────────┐
│ redis-header (50px)                                                 │
│  connection-card ● online  redis-prod   db0   12345 keys            │
│  [Refresh] [Flush DB] [Disconnect]                                   │
├───────────┬───────────────────────────────────────────┬──────────────┤
│           │                                           │              │
│ KeyBrowser│  Multi-tab Editor                        │ RightPanel   │
│ (260px)   │  (flex:1)                                 │ (320px)      │
│           │                                           │              │
│           │  ┌─ tab bar ───────────────────────────┐ │ Tab switcher │
│           │  │ key:n [type] [×] │ key:m [type] [×] │ │              │
│           │  └──────────────────────────────────────┘ │ Dashboard    │
│           │  ┌─ editor ─────────────────────────────┐ │ AI Chat      │
│           │  │ type-specific editor                 │ │ Pub/Sub      │
│           │  └─────────────────────────────────────── │ Slowlog      │
│           │  ┌─ redis-cli ──────────────────────────┐ │ BigKey       │
│           │  │ > GET mykey                          │ │ Memory       │
│           │  │ "value"                              │ │              │
│           │  └─────────────────────────────────────── │              │
└───────────┴───────────────────────────────────────────┴──────────────┘
```

### Key conventions
- Outer containers: `.cyber-panel` (glass panel + top gradient highlight bar)
- Column dividers: `border-right: 1px solid var(--line)`
- Spacing: 8-rhythm (8/16/24/32)
- Border radius: 12 (panels) / 8 (inputs) / 6 (buttons)
- Fonts: Outfit for headers, JetBrains Mono for keys/numbers/CLI, Orbitron for section numbers
- **Absolutely no scoped hardcoded colors** — all visual values must reference CSS variables

---

## 4. Left Panel: KeyBrowser

### Layout
```
.section-header:  01  Keys  (Orbitron number + gradient divider)
.cyber-input db-selector:  [▼ db0 (938 keys)]
.filter-row:  [🔍 pattern...]  [▼ type: All | String | Hash | List | Set | ZSet]
.key-tree (virtual scroll):
  📁 Strings (42)  ── collapsible group, icon = type color
    ■ session:*     ── .tree-item, left 2px --cyan bar when active
    ■ config:app    ── hover: [×] delete button appears
  📁 Hashes (15)    ── TTL badge (JetBrains Mono, --green / --yellow / --red)
  📁 Lists (8)
  📁 Sets (6)
  📁 ZSets (3)
  ── Load 200 more ──  .cyber-btn-secondary
  938 total
```

### Behavior
- `SCAN` count=200, append mode, cursor-based pagination
- Type filter: **client-side** (SCAN result already has type, no extra request)
- Pattern filter: **server-side**, resets cursor to 0
- DB switch: resets key list, cursor, closes all open tabs
- Group collapse state in `useDbStore` (non-persistent)
- Virtual scroll: `vue-virtual-scroller` (`DynamicScroller` + `DynamicScrollerItem`)
- Right-click context menu: Delete / Rename / Copy Key / Set TTL
- Click key = opens/activates tab in center panel

### Design system classes used
`.section-header` `.section-number` `.cyber-input` `.cyber-badge` `.tree-item` `.tree-item.active` `.action-btn` `.cyber-btn-secondary` `.status-dot`

---

## 5. Center Panel: Multi-Tab Editor

### Tab System
- Implemented as a standalone sub-tab bar inside `RedisValueEditor.vue` (NOT reusing DbView's `SubTabNav` component — Redis tabs have different data model and lifecycle)
- Each tab = one key + its type-specific editor
- `[+ new]` button: input key name → choose type → create + open tab
- `[×]` closes tab; if dirty, show confirmation dialog (`.cyber-panel` dialog)
- Tab title: key name + type badge (colored by type semantics)
- Right-click tab: Close / Close Others / Close All
- Tabs tracked by `multiTabs: { key, type, isDirty, isNew }[]` in component state
- Tab bar uses `.cyber-tab` / `.cyber-tab.active` classes for visual consistency

### Editor Contract
Every editor component must expose (via `defineExpose`):
```typescript
{
  isDirty: Ref<boolean>
  save(): Promise<void>     // incremental save via type-specific command
  reload(): Promise<void>   // re-fetch from server
}
```

### 5.1 String Editor (`editors/StringEditor.vue`)

```
┌────────────────────────────────┐
│ key info bar: key name | type  │
│ string | TTL: 3600s | 2.4 KB  │
├────────────────────────────────┤
│ mode tabs: [JSON] [Text] [Hex] │
├────────────────────────────────┤
│ Monaco Editor (flex:1)         │
│ auto-detect JSON → highlight   │
│ Shift+Alt+F → format           │
├────────────────────────────────┤
│ [Format] [Save] [Delete]       │  .cyber-btn / .cyber-btn-secondary
└────────────────────────────────┘
```

- Requires: `monaco-editor` (already in project)
- JSON mode: tree/table view toggle via split pane

### 5.2 Hash Editor (`editors/HashEditor.vue`)

```
┌────────────────────────────────┐
│ key info bar                   │
├────────────────────────────────┤
│ ┌─ field ───┬─ value ───┬──┐  │
│ │ name      │ Alice     │[×]│  │  double-click → edit
│ │ email     │ a@b.com   │[×]│  │  enter → confirm
│ ├───────────┼───────────┼───┤  │  virtual scroll (>1000 fields)
│ │ [+ field] │ [+ value] │   │  │
│ └───────────┴───────────┴───┘  │
├────────────────────────────────┤
│ [Add Field] [Save All] [Del]   │
└────────────────────────────────┘
```

- Backend: `HSET` / `HDEL` per field
- Batch save: `HSET key field1 val1 field2 val2 ...`

### 5.3 List Editor (`editors/ListEditor.vue`)

```
┌────────────────────────────────┐
│ key info bar                   │
├────────────────────────────────┤
│ #1  "task1" [Edit] [×] [↑][↓] │  reorder via move buttons
│ #2  "task2" [Edit] [×] [↑][↓] │  virtual scroll
│ ...                            │
│ [+ new item]                   │
├────────────────────────────────┤
│ [LPUSH] [RPUSH] [LPOP] [RPOP]  │
│ [Save]                         │
└────────────────────────────────┘
```

- `↑ ↓` sends `LMOVE` backend commands for reorder

### 5.4 Set Editor (`editors/SetEditor.vue`)

```
┌────────────────────────────────┐
│ ■ python    [×]                │
│ ■ typescript [×]               │  search filter bar at top
│ ■ rust      [×]                │  virtual scroll
│ [+ Add member]                 │
├────────────────────────────────┤
│ [Add Member] [Delete Selected] │
└────────────────────────────────┘
```

- Add = `SADD`, delete = `SREM`

### 5.5 ZSet Editor (`editors/ZSetEditor.vue`)

```
┌──────────────┬──────────────┐
│ member       │ score        │
│ player_42    │ 9987.5  [×]  │  click score → inline edit
│ player_17    │ 8721.0  [×]  │  sort by score ↑↓ toggle
│ player_99    │ 7654.2  [×]  │  virtual scroll
│ [+ new]      │              │
├──────────────┴──────────────┤
│ [Add] [Batch Set] [Delete]  │
└──────────────────────────────┘
```

- Backend: `ZADD` / `ZREM` / `ZINCRBY`

### TTL Editing
- All editors show TTL in info bar
- Click TTL → inline input (`.cyber-input`) → Set TTL (seconds) or Persist (remove TTL)

---

## 6. CLI Panel (RedisCli.vue)

```
┌─ terminal-container ────────────────────────────────────┐
│ terminal-header:  ● ● ●  redis-cli  db:0               │
│ terminal-dots (red/yellow/green)                        │
├─────────────────────────────────────────────────────────┤
│ > GET mykey                                            │
│ "value"                                                │
│ > HGETALL user:1                                       │
│ ...                                                    │
│ >                                                      │
└─────────────────────────────────────────────────────────┘
```

### Features
- **Command history**: ↑ ↓ arrow keys cycle through history (stored in Pinia, 200 max)
- **Autocomplete**: Tab for Redis command autocomplete (static list of ~200 commands)
- **Syntax highlighting**: commands = cyan, keys = white, args = magenta (using ANSI/xterm colors)
- **Multi-line**: Shift+Enter for multi-line commands
- **Output formatting**: auto-detect JSON → pretty print
- **Clear**: Ctrl+L or `CLEAR` command

### Implementation
- Uses `xterm.js` (already in project for SSH terminal)
- `.terminal-container` + `.terminal-header` + `.terminal-dots` from `cyber.css`
- Backend: reuses existing `redisExecute()` service

---

## 7. Right Panel: RedisTools + RightPanel

Reuses DbView's `RightPanel` outer shell (320px), adds Redis-specific sub-panels via `.cyber-tab` switcher.

### 7.1 Dashboard (extends DbDashboard)

8 metric cards, auto-refresh every 5s:

| Card | Data Source | Token |
|---|---|---|
| Keys | `DBSIZE` | `--cyan` |
| Memory | `INFO memory` → `used_memory_human` | `--purple` |
| Hit Rate | `INFO stats` → `keyspace_hits / (hits+misses)` | `--green` |
| CPU | `INFO cpu` → `used_cpu_sys` | `--yellow` |
| Ops/sec | `INFO stats` → `instantaneous_ops_per_sec` | `--cyan` |
| Evicted | `INFO stats` → `evicted_keys` | `--red` |
| Frag Ratio | `INFO memory` → `mem_fragmentation_ratio` | `--yellow` |
| Connections | `INFO clients` → `connected_clients` | `--green` |

- Numbers: JetBrains Mono, labels: text-xs
- Cards: `.cyber-card` with hover lift 2px + `--glow-soft`
- Refresh indicator: subtle pulse on `.status-dot.connecting` while loading

### 7.2 PubSub Monitor (`PubSubMonitor.vue`)

```
subscribe bar:
  [channel:________] [Subscribe] [PSUBSCRIBE pattern:________]

subscribed channels:
  ● channel:orders      [Unsubscribe]
  ● channel:notify      [Unsubscribe]

message stream (scrollable, newest at top):
  14:32:01 [orders] "new_order" {"id":123}
  14:32:03 [orders] "update"   {"id":123}
  14:32:05 [notify] "alert"    "disk 90%"

footer:
  [Pause] [Clear] [Export]
```

- Backend: Go goroutine subscribes via `*redis.PubSub.Channel()`, pushes messages via Tauri event system (`app_handle.emit()`)
- Frontend: `listen()` from `@tauri-apps/api/event`
- JSON payload auto-formatting
- Auto-scroll unless user has scrolled up (pause mode)
- Max 500 messages buffer, FIFO eviction

### 7.3 Slowlog Viewer (`SlowlogViewer.vue`)

```
filter: [Top N: 50▼] [Refresh]

table:
  # | Duration | Time     | Command
  1 | 152ms    | 14:32:01 | KEYS *
  2 | 89ms     | 14:31:55 | HGETALL user:1001
  3 | 45ms     | 14:31:30 | ZRANGE lb 0 -1

footer:
  [Reset Slowlog]
```

- Duration coloring: >100ms = yellow, >500ms = red, ≤100ms = muted
- Field widths: `.text-sm` for ID/duration, `.text-base` for command
- Backend: `SLOWLOG GET <count>` via existing Execute gateway

### 7.4 BigKey Scanner (`BigKeyScanner.vue`)

```
threshold config:
  String > [10___] KB | Collection > [1000___] members
  [Start Scan]

scan progress:
  ████████░░ 78%  scanned: 7,812 / 9,381

results table (sorted by size desc):
  key           | type   | size     | length
  user:sessions | string | 15.2 MB  | -
  queue:tasks   | list   | 8.7 MB   | 52,000
  cache:html    | string | 6.1 MB   | -

footer:
  Found 12 big keys | Total scanned: 9,381
```

- Size coloring: >10MB or >100K members = red, >1MB or >10K = yellow
- Backend: full SCAN loop → TYPE + STRLEN/LLEN/HLEN/SCARD/ZCARD per key
- Progress bar: `.cyber-badge` style progress, updates per SCAN batch
- Export CSV available

### 7.5 Memory Analyzer (`MemoryAnalyzer.vue`)

```
[Analyze]  based on: [▼ Top prefixes]

prefix      | keys  | memory   | %
user:*      │ 3821  │ 42.3 MB  │ 38.2% │ ████████
cache:*     │ 2104  │ 28.1 MB  │ 25.4% │ █████
session:*   │ 891   │ 15.7 MB  │ 14.2% │ ███
queue:*     │ 520   │ 12.4 MB  │ 8.2%  │ ██
config:*    │ 312   │ 5.2 MB   │ 4.7%  │ █
<no prefix> │ 143   │ 3.9 MB   │ 3.5%  │ █

Total: 7,791 keys | 110.6 MB
```

- Prefix extraction: split key by `:` and group by first prefix
- Memory columns: inline bar (cyan gradient proportional to value)
- Backend: SCAN → batch MEMORY USAGE → aggregate by prefix
- "Top prefixes" dropdown: 10 / 25 / 50 / All

---

## 8. Backend Changes

### 8.1 Go Sidecar (`sidecar/adapters/redis.go`)

New methods (existing 622 lines → ~1100 lines):

```go
// Pub/Sub
Subscribe(ctx, connId, channels, patterns) (*redis.PubSub, <-chan PubSubMessage, error)
Unsubscribe(ctx, connId, channels) error

// Slowlog
SlowlogGet(ctx, connId, count int) ([]SlowlogEntry, error)

// Full scan
ScanAll(ctx, connId, match, count int, typeFilter string) ([]RedisKeyInfo, error)

// Memory
MemoryUsage(ctx, connId, key string) (int64, error)
MemoryAnalysis(ctx, connId, match string, sampleSize int) ([]MemoryAnalysisEntry, error)

// BigKey scan
BigKeyScan(ctx, connId, match string, strThresholdMB int, memberThreshold int) ([]BigKeyEntry, error)

// Flush
FlushDB(ctx, connId) error
```

### 8.2 JSON-RPC Handlers (`sidecar/adapters/handlers.go`)

8 new handlers: `redis_subscribe`, `redis_unsubscribe`, `redis_slowlog_get`, `redis_scan_all`, `redis_memory_usage`, `redis_memory_analysis`, `redis_bigkey_scan`, `redis_flushdb`

### 8.3 Connection Pool (`sidecar/pool/manager.go`)

Add `pubsub *redis.PubSub` field to `ConnRedis`. Lifecycle: disconnect auto-unsubscribes.

### 8.4 Rust Commands (`src-tauri/src/commands/db.rs`)

8 new `#[tauri::command]` functions mirroring the Go handlers, with proper error mapping.

### 8.5 IPC Service (`src/services/db.ts`)

8 new functions wrapping Tauri `invoke()` calls.

### 8.6 Types (`src/types/db.ts`)

```typescript
interface PubSubMessage { channel: string; pattern?: string; payload: string; time: string }
interface SlowlogEntry { id: number; duration: number; timestamp: number; command: string }
interface BigKeyEntry { key: string; type: string; size: number; length: number }
interface MemoryAnalysisEntry { prefix: string; keys: number; memory: number; percentage: number }
```

---

## 9. Design System Alignment Checklist

| Requirement | Status |
|---|---|
| Zero hardcoded colors in `<style scoped>` | All visual values → CSS variables |
| All panels use `.cyber-panel` | Glass + blur + gradient top bar |
| Key nodes use `.tree-item` / `.tree-item.active` | Left 2px active bar + text-glow |
| CLI uses `.terminal-container` + `.terminal-header` + `.terminal-dots` | Red/yellow/green dots shell |
| Empty states use `.empty-state` | Icon + title + description + CTA |
| Buttons use `.cyber-btn` / `.cyber-btn-secondary` / `.action-btn` | Gradient primary, outline secondary |
| Inputs/selects use `.cyber-input` | Dark background + cyan focus glow |
| Tabs use `.cyber-tab` / `.cyber-tab.active` | Bottom 2px active bar |
| Badges use `.cyber-badge` | Cyan background + monospace |
| Section headers use `.section-header` / `.section-number` | Orbitron number + gradient divider |
| Connection card uses `.connection-card` | Type-colored icon + status dot |
| Status dots use `.status-dot.online/.connecting/.offline` | Pulsing colors |
| Sidebar width: 260px | Matches DbView standard |
| Spacing: 8-rhythm (8/16/24/32) | No arbitrary spacing |
| Border radius: 12/8/6 | Panel/input/button |
| Fonts: Outfit / JetBrains Mono / Orbitron | Per role |
| Animations: pulse / shimmer / glow / float | From cyber.css keyframes |

---

## 10. Non-Goals (YAGNI)

- Cluster/Sentinel support (P2, separate project)
- Redis Graph / TimeSeries / Search modules (P3)
- Stream viewer (P3, visual complexity disproportionate to MVP value)
- Geolocation (GEO) editor (P3)
- Lua script editor (P2, handled by AI + Execute fallback)
- Drag-and-drop keys between DBs (P2)

---

## 11. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Monaco Editor bundle size | Lazy-load via `defineAsyncComponent` |
| xterm.js + Redis CLI conflict with existing SSH terminal | Separate terminal instance, no shared state |
| Pub/Sub SSE complexity | Start with simple poll-based fallback, upgrade to push |
| BigKey scan on large DBs | Show progress, allow cancel, set timeout |
| Memory analysis on 1M+ keys | Sampling mode (analyze first N keys per prefix) |
| Design system classes missing for new patterns | Add `.redis-cli`, `.key-node`, `.tool-panel` to cyber.css |
