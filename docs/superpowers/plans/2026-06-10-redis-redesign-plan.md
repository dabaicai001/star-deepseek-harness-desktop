# Redis Page Complete Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Dismantle 700-line monolithic `RedisView.vue` into a three-column layout with 14 focused components, type-specific visual editors, Redis tools (PubSub/Slowlog/BigKey/Memory), AI integration, and full design system alignment.

**Architecture:** Reuses DbView's `RightPanel` shell for Dashboard/AI, adds Redis-specific tool panels via tab switcher. Left: `KeyBrowser` with DB selector + grouped key tree. Center: multi-tab system + 5 type-specific editors + CLI. Right: RightPanel with Dashboard / AI / RedisTools.

**Tech Stack:** Vue 3 + Pinia + Vuetify 3 + cyber.css, Go 1.22+ with go-redis/v9, Rust + Tauri 2.x

**Spec:** `docs/superpowers/specs/2026-06-10-redis-redesign-design.md`

---

## File Map

| Action | File |
|---|---|
| Modify | `src/types/db.ts` |
| Modify | `src/services/db.ts` |
| Modify | `src/stores/db.ts` |
| Create | `src/components/redis/KeyBrowser.vue` |
| Rewrite | `src/views/RedisView.vue` |
| Create | `src/components/redis/RedisValueEditor.vue` |
| Create | `src/components/redis/RedisCli.vue` |
| Create | `src/components/redis/editors/StringEditor.vue` |
| Create | `src/components/redis/editors/HashEditor.vue` |
| Create | `src/components/redis/editors/ListEditor.vue` |
| Create | `src/components/redis/editors/SetEditor.vue` |
| Create | `src/components/redis/editors/ZSetEditor.vue` |
| Create | `src/components/redis/RedisTools.vue` |
| Create | `src/components/redis/PubSubMonitor.vue` |
| Create | `src/components/redis/SlowlogViewer.vue` |
| Create | `src/components/redis/BigKeyScanner.vue` |
| Create | `src/components/redis/MemoryAnalyzer.vue` |
| Modify | `sidecar/adapters/redis.go` |
| Modify | `sidecar/adapters/handlers.go` |
| Modify | `src-tauri/src/commands/db.rs` |
| Modify | `src-tauri/src/main.rs` |

---

## Phase 1: Types & Service Layer

### Task 1: Add Redis type definitions

- [ ] Append to `src/types/db.ts` (after DbSession):

```typescript
export interface SlowlogEntry {
  id: number
  duration: number
  timestamp: number
  command: string
}

export interface BigKeyEntry {
  key: string
  type: string
  size: number
  length: number
}

export interface MemoryAnalysisEntry {
  prefix: string
  keys: number
  memory: number
  percentage: number
}

export interface PubSubMessage {
  channel: string
  pattern?: string
  payload: string
  time: string
}
```

- [ ] Commit: `git add src/types/db.ts && git commit -m "✨ feat(redis): add SlowlogEntry, BigKeyEntry, MemoryAnalysisEntry, PubSubMessage types"`

### Task 2: Add IPC service functions

- [ ] Update import in `src/services/db.ts` to include `SlowlogEntry, BigKeyEntry, MemoryAnalysisEntry`
- [ ] Append after `redisDBSize` (line 155):

```typescript
export async function redisSlowlogGet(connId: string, count: number): Promise<SlowlogEntry[]> {
  return invoke('db_redis_slowlog_get', { connId, count })
}
export async function redisSlowlogReset(connId: string): Promise<void> {
  return invoke('db_redis_slowlog_reset', { connId })
}
export async function redisScanAll(connId: string, match?: string, count?: number): Promise<RedisScanResult> {
  return invoke('db_redis_scan_all', { connId, match, count })
}
export async function redisBigKeyScan(connId: string, match?: string, stringThreshold?: number, memberThreshold?: number): Promise<BigKeyEntry[]> {
  return invoke('db_redis_bigkey_scan', { connId, match, stringThreshold, memberThreshold })
}
export async function redisMemoryAnalysis(connId: string, match?: string, sampleSize?: number): Promise<MemoryAnalysisEntry[]> {
  return invoke('db_redis_memory_analysis', { connId, match, sampleSize })
}
export async function redisFlushDB(connId: string): Promise<void> {
  return invoke('db_redis_flush_db', { connId })
}
export async function redisSubscribe(connId: string, channels: string[], patterns: string[]): Promise<void> {
  return invoke('db_redis_subscribe', { connId, channels, patterns })
}
export async function redisUnsubscribe(connId: string, channels: string[]): Promise<void> {
  return invoke('db_redis_unsubscribe', { connId, channels })
}
```

- [ ] Commit: `git add src/services/db.ts && git commit -m "✨ feat(redis): add 8 IPC service functions"`

### Task 3: Extend Pinia store

- [ ] In `src/stores/db.ts`, add before `return`:

```typescript
const redisCliHistory = ref<string[]>([])
function addCliHistory(cmd: string) {
  redisCliHistory.value.unshift(cmd)
  if (redisCliHistory.value.length > 200) redisCliHistory.value = redisCliHistory.value.slice(0, 200)
}
function getCliHistory() { return redisCliHistory.value }
```

- [ ] Add to return: `redisCliHistory, addCliHistory, getCliHistory,`
- [ ] Commit: `git add src/stores/db.ts && git commit -m "✨ feat(redis): add CLI history to Pinia store"`

---

## Phase 2: Go Sidecar Backend

### Task 4: New Redis adapter methods + handlers

- [ ] In `sidecar/adapters/redis.go`, add `"sort"` to imports. Append these types and methods before EOF:

```go
type SlowlogEntry struct {
	ID        int64  `json:"id"`
	Duration  int64  `json:"duration"`
	Timestamp int64  `json:"timestamp"`
	Command   string `json:"command"`
}

func (a *RedisAdapter) SlowlogGet(count int64) ([]SlowlogEntry, error) {
	result, err := a.client.SlowLogGet(a.ctx, count).Result()
	if err != nil { return nil, fmt.Errorf("slowlog get: %w", err) }
	entries := make([]SlowlogEntry, len(result))
	for i, r := range result {
		entries[i] = SlowlogEntry{ID: r.ID, Duration: r.Duration.Microseconds(), Timestamp: r.Time.Unix(), Command: strings.Join(r.Args, " ")}
	}
	return entries, nil
}

func (a *RedisAdapter) SlowlogReset() error {
	_, err := a.client.SlowLogReset(a.ctx).Result()
	if err != nil { return fmt.Errorf("slowlog reset: %w", err) }
	return nil
}

func (a *RedisAdapter) ScanAll(match string, count int64, typeFilter string) ([]RedisKeyInfo, error) {
	var allKeys []RedisKeyInfo
	var cursor uint64 = 0
	if count <= 0 { count = 200 }
	for {
		keys, nextCursor, err := a.client.Scan(a.ctx, cursor, match, count).Result()
		if err != nil { return nil, fmt.Errorf("scan all: %w", err) }
		for _, key := range keys {
			keyType, err := a.client.Type(a.ctx, key).Result()
			if err != nil { continue }
			if typeFilter != "" && typeFilter != "all" && keyType != typeFilter { continue }
			ttl, _ := a.client.TTL(a.ctx, key).Result()
			allKeys = append(allKeys, RedisKeyInfo{Key: key, Type: keyType, TTL: int64(ttl.Seconds())})
		}
		cursor = nextCursor
		if cursor == 0 { break }
	}
	return allKeys, nil
}

type BigKeyEntry struct {
	Key    string `json:"key"`
	Type   string `json:"type"`
	Size   int64  `json:"size"`
	Length int64  `json:"length"`
}

func (a *RedisAdapter) BigKeyScan(match string, stringThreshold, memberThreshold int64) ([]BigKeyEntry, error) {
	var results []BigKeyEntry
	var cursor uint64 = 0
	for {
		keys, nextCursor, err := a.client.Scan(a.ctx, cursor, match, 200).Result()
		if err != nil { return nil, fmt.Errorf("bigkey scan: %w", err) }
		for _, key := range keys {
			keyType, err := a.client.Type(a.ctx, key).Result()
			if err != nil { continue }
			switch keyType {
			case "string":
				if size, err := a.client.StrLen(a.ctx, key).Result(); err == nil && size >= stringThreshold {
					results = append(results, BigKeyEntry{Key: key, Type: keyType, Size: size})
				}
			case "hash":
				if length, err := a.client.HLen(a.ctx, key).Result(); err == nil && length >= memberThreshold {
					results = append(results, BigKeyEntry{Key: key, Type: keyType, Length: length})
				}
			case "list":
				if length, err := a.client.LLen(a.ctx, key).Result(); err == nil && length >= memberThreshold {
					results = append(results, BigKeyEntry{Key: key, Type: keyType, Length: length})
				}
			case "set":
				if length, err := a.client.SCard(a.ctx, key).Result(); err == nil && length >= memberThreshold {
					results = append(results, BigKeyEntry{Key: key, Type: keyType, Length: length})
				}
			case "zset":
				if length, err := a.client.ZCard(a.ctx, key).Result(); err == nil && length >= memberThreshold {
					results = append(results, BigKeyEntry{Key: key, Type: keyType, Length: length})
				}
			}
		}
		cursor = nextCursor
		if cursor == 0 { break }
	}
	sort.Slice(results, func(i, j int) bool { return results[i].Size+results[i].Length > results[j].Size+results[j].Length })
	return results, nil
}

type MemoryAnalysisEntry struct {
	Prefix     string  `json:"prefix"`
	Keys       int64   `json:"keys"`
	Memory     int64   `json:"memory"`
	Percentage float64 `json:"percentage"`
}

func (a *RedisAdapter) MemoryAnalysis(match string, sampleSize int) ([]MemoryAnalysisEntry, error) {
	type agg struct{ Keys, Memory int64 }
	prefixes := map[string]*agg{}
	var cursor uint64 = 0
	var total int64 = 0
	for {
		keys, nextCursor, err := a.client.Scan(a.ctx, cursor, match, 200).Result()
		if err != nil { return nil, fmt.Errorf("memory scan: %w", err) }
		for _, key := range keys {
			prefix := key
			if idx := strings.Index(key, ":"); idx != -1 { prefix = key[:idx+1] + "*" } else { prefix = "<no prefix>" }
			if _, ok := prefixes[prefix]; !ok { prefixes[prefix] = &agg{} }
			prefixes[prefix].Keys++
			if sampleSize <= 0 || prefixes[prefix].Keys <= int64(sampleSize) {
				if mem, err := a.client.MemoryUsage(a.ctx, key, 0).Result(); err == nil { prefixes[prefix].Memory += mem; total += mem }
			}
		}
		cursor = nextCursor
		if cursor == 0 { break }
	}
	var results []MemoryAnalysisEntry
	for prefix, a := range prefixes {
		pct := float64(0)
		if total > 0 { pct = float64(a.Memory) / float64(total) * 100 }
		results = append(results, MemoryAnalysisEntry{Prefix: prefix, Keys: a.Keys, Memory: a.Memory, Percentage: pct})
	}
	sort.Slice(results, func(i, j int) bool { return results[i].Memory > results[j].Memory })
	return results, nil
}

func (a *RedisAdapter) FlushDB() error {
	_, err := a.client.FlushDB(a.ctx).Result()
	if err != nil { return fmt.Errorf("flushdb: %w", err) }
	return nil
}
```

- [ ] In `sidecar/adapters/handlers.go`, add 6 handler functions before `// --- Docker Handlers ---` following the existing pattern (full code in spec). Register in `RegisterDBHandlers`:

```go
server.Register("db.redis.slowlogGet", handleRedisSlowlogGet(mgr))
server.Register("db.redis.slowlogReset", handleRedisSlowlogReset(mgr))
server.Register("db.redis.scanAll", handleRedisScanAll(mgr))
server.Register("db.redis.bigkeyScan", handleRedisBigKeyScan(mgr))
server.Register("db.redis.memoryAnalysis", handleRedisMemoryAnalysis(mgr))
server.Register("db.redis.flushDb", handleRedisFlushDB(mgr))
```

Each handler struct follows this pattern (see existing handlers for exact template):
```go
func handleRedisSlowlogGet(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct { ConnID string `json:"connId"`; Count int64 `json:"count"` }
		if err := json.Unmarshal(params, &p); err != nil { return nil, err }
		if p.Count <= 0 { p.Count = 50 }
		adapter, err := getRedisAdapter(mgr, p.ConnID)
		if err != nil { return nil, err }
		return adapter.SlowlogGet(p.Count)
	}
}
```

- [ ] Commit: `git add sidecar/adapters/ && git commit -m "✨ feat(redis/sidecar): add Slowlog, ScanAll, BigKeyScan, MemoryAnalysis, FlushDB"`

---

## Phase 3: Rust Command Layer

### Task 5: New Tauri commands

- [ ] Append to `src-tauri/src/commands/db.rs` after `db_redis_db_size`:

```rust
#[tauri::command]
pub async fn db_redis_slowlog_get(sidecar: State<'_, SidecarManager>, conn_id: String, count: i64) -> Result<Value, String> {
    sidecar.call("db.redis.slowlogGet", serde_json::json!({ "connId": conn_id, "count": count })).await
}
#[tauri::command]
pub async fn db_redis_slowlog_reset(sidecar: State<'_, SidecarManager>, conn_id: String) -> Result<Value, String> {
    sidecar.call("db.redis.slowlogReset", serde_json::json!({ "connId": conn_id })).await
}
#[tauri::command]
pub async fn db_redis_scan_all(sidecar: State<'_, SidecarManager>, conn_id: String, match_pattern: Option<String>, count: Option<i64>) -> Result<Value, String> {
    let mut params = serde_json::json!({ "connId": conn_id });
    if let Some(m) = match_pattern { params["match"] = serde_json::json!(m); }
    if let Some(c) = count { params["count"] = serde_json::json!(c); }
    sidecar.call("db.redis.scanAll", params).await
}
#[tauri::command]
pub async fn db_redis_bigkey_scan(sidecar: State<'_, SidecarManager>, conn_id: String, match_pattern: Option<String>, string_threshold: Option<i64>, member_threshold: Option<i64>) -> Result<Value, String> {
    let mut params = serde_json::json!({ "connId": conn_id });
    if let Some(m) = match_pattern { params["match"] = serde_json::json!(m); }
    if let Some(s) = string_threshold { params["stringThreshold"] = serde_json::json!(s); }
    if let Some(c) = member_threshold { params["memberThreshold"] = serde_json::json!(c); }
    sidecar.call("db.redis.bigkeyScan", params).await
}
#[tauri::command]
pub async fn db_redis_memory_analysis(sidecar: State<'_, SidecarManager>, conn_id: String, match_pattern: Option<String>, sample_size: Option<i32>) -> Result<Value, String> {
    let mut params = serde_json::json!({ "connId": conn_id });
    if let Some(m) = match_pattern { params["match"] = serde_json::json!(m); }
    if let Some(s) = sample_size { params["sampleSize"] = serde_json::json!(s); }
    sidecar.call("db.redis.memoryAnalysis", params).await
}
#[tauri::command]
pub async fn db_redis_flush_db(sidecar: State<'_, SidecarManager>, conn_id: String) -> Result<Value, String> {
    sidecar.call("db.redis.flushDb", serde_json::json!({ "connId": conn_id })).await
}
```

- [ ] Register in `src-tauri/src/main.rs` `generate_handler!` macro: add `db_redis_slowlog_get, db_redis_slowlog_reset, db_redis_scan_all, db_redis_bigkey_scan, db_redis_memory_analysis, db_redis_flush_db`
- [ ] Commit: `git add src-tauri/src/ && git commit -m "✨ feat(redis/rust): add 6 Tauri commands for extended Redis ops"`

---

## Phase 4: Frontend — KeyBrowser + Layout

### Task 6: Create KeyBrowser.vue

- [ ] Create `src/components/redis/editors/` directory (recursive)
- [ ] Create `src/components/redis/KeyBrowser.vue` with:
  - Props: `connId`, `currentDb`, `totalKeys`
  - Emits: `select-key`, `delete-key`, `switch-db`
  - States: `keys[]`, `cursor`, `scanMatch`, `typeFilter`, `loading`, `collapsed`
  - `groupedKeys` computed: group by type (string/hash/list/set/zset), sorted by count desc
  - `loadKeys(append)`: calls `redisScan`, append or replace
  - `onSearch()`: reset keys + cursor, SCAN from scratch
  - `onDbChange(db)`: emit switch-db, reset keys
  - `filteredKeys(items)`: client-side type filter
  - Template: `.section-header` (01 Keys + collapse), `.browser-controls` (DB select + key count), `.browser-filters` (pattern input + type select), `.key-tree` (grouped `.tree-section` + `.tree-item` rows with icon/name/TTL/delete)
  - All styles use CSS variables only, `.tree-item` / `.tree-item.active` / `.cyber-input` / `.cyber-badge` / `.action-btn` classes
  - `defineExpose({ loadKeys })`

- [ ] Commit: `git add src/components/redis/KeyBrowser.vue && git commit -m "✨ feat(redis): add KeyBrowser with DB selector, filters, grouped key tree"`

### Task 7: Rewrite RedisView.vue

- [ ] Replace `src/views/RedisView.vue` (all 700 lines) with three-column skeleton:
  - Imports: KeyBrowser, RedisValueEditor, RedisCli, RedisTools, RightPanel, DbDashboard, AiChat
  - State: `connected`, `connecting`, `connId`, `currentDb`, `dbsize`, `rightPanelOpen`, `keyBrowserRef`, `valueEditorRef`
  - `connect()`: calls `dbStore.connectRedis()`, then `refreshDBSize()`
  - `onSwitchDb(db)`: calls `redisSelect`, updates `currentDb`, refreshes DBSize
  - `onDeleteKey(key)`: calls `redisDel`, refreshes DBSize, calls `keyBrowserRef.loadKeys()`
  - `onSelectKey(key, type)`: calls `valueEditorRef.openKey(key, type)`
  - `onFlushDb()`: confirm dialog, calls `redisFlushDB`, resets dbsize, reloads keys
  - Template: `<KeyBrowser>` | `<div.redis-center>` (header + `<RedisValueEditor>` + `<RedisCli>`) | `<RightPanel>` (Dashboard/AI/RedisTools tabs)
  - Header shows `.connection-card` with icon, asset name, `cyber-badge` db number, key count, action buttons
  - Minimal scoped styles, all visual values via CSS variables

- [ ] Commit: `git add src/views/RedisView.vue && git commit -m "✨ feat(redis): rewrite RedisView.vue as three-column layout"`

---

## Phase 5: Center Panel — Editors

### Task 8: RedisValueEditor — Tab System Shell

- [ ] Create `src/components/redis/RedisValueEditor.vue`:
  - Props: `connId`, `currentDb`
  - Interface `EditorTab { id, key, type, title, isDirty, isNew, component }`
  - `tabs[]`, `activeTabId` state
  - `editorMap`: Record mapping type to lazily-imported component (`StringEditor`/`HashEditor`/`ListEditor`/`SetEditor`/`ZSetEditor`)
  - `openKey(key, type)`: find existing tab or push new one
  - `closeTab(id)`: confirm if dirty, splice, reassign active
  - `openNewKey()`: prompt for key name + type, push new tab
  - Template: `.editor-tabs` bar (`.cyber-tab` per tab + `[+]` add button) + `.editor-body` (`<component :is>` dynamic) + empty state
  - `defineExpose({ openKey })`

- [ ] Commit: `git add src/components/redis/RedisValueEditor.vue && git commit -m "✨ feat(redis): add RedisValueEditor with multi-tab system"`

### Task 9: StringEditor

- [ ] Create `src/components/redis/editors/StringEditor.vue`:
  - Props: `connId`, `keyName`, `keyType`, `isNew`
  - Emits: `dirty`, `saved`
  - State: `value`, `originalValue`, `loading`, `saving`, `ttl`, `viewMode`, `error`
  - `isDirty` computed: `value !== originalValue`
  - `load()`: calls `redisGetValue`, auto-detects JSON mode
  - `save()`: calls `redisSet`, marks saved
  - `formatJson()`: parse + stringify with indent 2
  - Template: info bar (key + type badge + TTL) | toolbar (Text/JSON mode tabs + Format/Reload buttons) | `<textarea>` editor area | footer (Revert + Save buttons)
  - Textarea styled with JetBrains Mono, `var(--panel-solid-2)` background

- [ ] Commit: `git add src/components/redis/editors/StringEditor.vue && git commit -m "✨ feat(redis): add StringEditor with text/JSON view modes"`

### Task 10: HashEditor

- [ ] Create `src/components/redis/editors/HashEditor.vue`:
  - Props/Emits: same pattern as StringEditor
  - State: `fields[]` (each: field, value, originalValue, deleted?), `newFieldName`, `newFieldValue`
  - `load()`: calls `redisGetValue`, parses object entries into fields array
  - `addField()`: push new field row
  - `removeField(idx)`: splice row
  - `save()`: batch via `redisExecute` — HDEL for removed fields, HSET for changed/added
  - Template: info bar | field-value table (header + rows with inline `<input>` cells + delete button + new row at bottom) | footer with Revert/Save

- [ ] Commit: `git add src/components/redis/editors/HashEditor.vue && git commit -m "✨ feat(redis): add HashEditor with inline field-value table"`

### Task 11: ListEditor

- [ ] Create `src/components/redis/editors/ListEditor.vue`:
  - State: `items[]` (each: value, originalValue, index), `newItem`
  - `load()`: `redisGetValue`, parse array as ordered list
  - `addItem()`: push new item row
  - `removeItem(idx)`: splice
  - `save()`: DEL key then RPUSH all items (simplest full-rewrite approach)
  - Template: info bar | ordered list (index + value input + delete + up/down buttons) | new item row | LPUSH/RPUSH/LPOP/RPOP action buttons row | footer

- [ ] Commit: `git add src/components/redis/editors/ListEditor.vue && git commit -m "✨ feat(redis): add ListEditor with ordered list and inline editing"`

### Task 12: SetEditor

- [ ] Create `src/components/redis/editors/SetEditor.vue`:
  - State: `members[]` (each: value, originalValue), `newMember`, `searchFilter`
  - `load()`: `redisGetValue`, parse array as members
  - `addMember()`: push new member
  - `removeMember(idx)`: splice
  - `save()`: DEL key then SADD all members
  - Template: info bar | search filter input | member list (value + delete button) | new member row | footer

- [ ] Commit: `git add src/components/redis/editors/SetEditor.vue && git commit -m "✨ feat(redis): add SetEditor with member add/delete"`

### Task 13: ZSetEditor

- [ ] Create `src/components/redis/editors/ZSetEditor.vue`:
  - State: `entries[]` (each: member, score, originalScore), `newMember`, `newScore`, `sortAsc`
  - `load()`: `redisGetValue`, parse array of {member, score}
  - `addEntry()`: push new entry
  - `removeEntry(idx)`: splice
  - `save()`: DEL key then ZADD all entries
  - Template: info bar | sort toggle | member-score table (member + score input cells + delete) | new entry row | footer

- [ ] Commit: `git add src/components/redis/editors/ZSetEditor.vue && git commit -m "✨ feat(redis): add ZSetEditor with member-score table"`

---

## Phase 6: CLI Panel

### Task 14: RedisCli.vue

- [ ] Create `src/components/redis/RedisCli.vue`:
  - Props: `connId`, `currentDb`
  - State: `cliCommand`, `cliResult[]`, `cliLoading`, `historyIndex`
  - `executeCli()`: calls `redisExecute`, pushes result to array, saves to Pinia `addCliHistory`
  - Up/Down arrow: cycle through `dbStore.getCliHistory()` via `historyIndex`
  - `clearCli()`: clear result array
  - Template: `.terminal-container` wrapper | `.terminal-header` with `.terminal-dots` (red/yellow/green) + `redis-cli db:N` label | `.terminal-body` (scrollable output, `>` cyan, error red, result white) | `.terminal-input` (prompt `redis:N>` + `<input>`)
  - Styles: JetBrains Mono font, `var(--panel-solid-2)` background, all colors via CSS variables

- [ ] Commit: `git add src/components/redis/RedisCli.vue && git commit -m "✨ feat(redis): add enhanced RedisCli with command history"`

---

## Phase 7: Right Panel — Redis Tools

### Task 15: RedisTools container

- [ ] Create `src/components/redis/RedisTools.vue`:
  - Props: `connId`, `currentDb`
  - Tab switcher: PubSub | Slowlog | BigKey | Memory
  - Each sub-panel via `v-if` lazy rendering
  - Template: `.cyber-tab` row + panel body with `<component :is>` dispatch
  - All four tool panels are children of this container

- [ ] Commit: `git add src/components/redis/RedisTools.vue && git commit -m "✨ feat(redis): add RedisTools container with tab switcher"`

### Task 16: PubSubMonitor

- [ ] Create `src/components/redis/PubSubMonitor.vue`:
  - Props: `connId`
  - State: `subscribedChannels[]`, `messages[]`, `paused`, `channelInput`, `patternInput`
  - `subscribe()`: call `redisSubscribe`, then start polling/listening for messages
  - `unsubscribe(channel)`: call `redisUnsubscribe`, remove from list
  - Messages auto-scroll, max 500 buffer, FIFO eviction
  - Template: subscribe bar (channel input + Subscribe/PSUBSCRIBE buttons) | subscribed channels list (each with Unsubscribe) | message stream (timestamp + channel + payload, JSON auto-format) | footer (Pause/Clear/Export)

- [ ] Commit: `git add src/components/redis/PubSubMonitor.vue && git commit -m "✨ feat(redis): add PubSubMonitor with subscribe and real-time messages"`

### Task 17: SlowlogViewer

- [ ] Create `src/components/redis/SlowlogViewer.vue`:
  - Props: `connId`
  - State: `entries[]`, `count`, `loading`
  - `load()`: call `redisSlowlogGet(connId, count)`
  - `reset()`: call `redisSlowlogReset`, then reload
  - Duration coloring: greater than 100ms = yellow, greater than 500ms = red, else muted
  - Template: filter bar (Top N select + Refresh) | table (ID + Duration + Time + Command) | footer (Reset Slowlog button)

- [ ] Commit: `git add src/components/redis/SlowlogViewer.vue && git commit -m "✨ feat(redis): add SlowlogViewer with duration coloring"`

### Task 18: BigKeyScanner

- [ ] Create `src/components/redis/BigKeyScanner.vue`:
  - Props: `connId`
  - State: `results[]`, `scanning`, `progress` (scanned/total), `strThreshold`, `memThreshold`
  - `startScan()`: call `redisBigKeyScan`, update progress per batch (backend handles full scan internally, progress is approximated by counting dbsize before scan)
  - `cancelScan()`: abort flag
  - Results sorted by size desc, color coded (greater than 10MB red, greater than 1MB yellow)
  - Template: threshold config inputs + Start Scan button | progress bar | results table (Key + Type + Size + Length) | summary footer

- [ ] Commit: `git add src/components/redis/BigKeyScanner.vue && git commit -m "✨ feat(redis): add BigKeyScanner with configurable thresholds"`

### Task 19: MemoryAnalyzer

- [ ] Create `src/components/redis/MemoryAnalyzer.vue`:
  - Props: `connId`
  - State: `entries[]`, `loading`, `sampleSize`
  - `analyze()`: call `redisMemoryAnalysis`, populate entries
  - Each prefix row shows: prefix name, key count, memory (human-readable), percentage bar
  - Percentage bar is an inline `<div>` with width proportional to percentage, colored with `var(--cyan)` gradient
  - Template: Analyze button + sample size | results table (Prefix + Keys + Memory + % bar + Summary row) | total stats footer

- [ ] Commit: `git add src/components/redis/MemoryAnalyzer.vue && git commit -m "✨ feat(redis): add MemoryAnalyzer with prefix aggregation"`

---

## Phase 8: Integration & Polish

### Task 20: Verify and fix

- [ ] Run `npm run dev` (or `npm run build`) to verify all components compile
- [ ] Check all imports resolve correctly
- [ ] Verify cyber.css classes are used (not hardcoded colors in scoped styles)
- [ ] Ensure sidebar is 260px (not 280px)
- [ ] Verify tab system dirty state tracking works
- [ ] Test CLI command history persistence via Pinia
- [ ] Ensure RightPanel slot names match (`#dashboard`, `#ai`, `#tools`)

- [ ] Commit any fixes: `git add . && git commit -m "🔧 fix(redis): integration fixes and design system alignment"`

---

## Design System Checklist (verify across all components)

| Requirement | Check |
|---|---|
| Zero hardcoded colors in `<style scoped>` | All values via `var(--xxx)` |
| Panels use `.cyber-panel` | Glass + blur effect |
| Key nodes use `.tree-item` / `.tree-item.active` | Left 2px active bar |
| CLI uses `.terminal-container` + `.terminal-dots` | Red/yellow/green dots |
| Empty states use `.empty-state` | Icon + title + desc |
| Buttons: `.cyber-btn` / `.cyber-btn-secondary` / `.action-btn` | Gradient / outline / icon |
| Inputs: `.cyber-input` | Dark bg + cyan focus |
| Tabs: `.cyber-tab` / `.cyber-tab.active` | Bottom 2px bar |
| Badges: `.cyber-badge` | Cyan bg + monospace |
| Section headers: `.section-header` / `.section-number` | Orbitron + gradient |
| Connection: `.connection-card` / `.status-dot` | Type color + pulse |
| Sidebar width: 260px | Matches DbView |
| Spacing: 8/16/24/32 | 8-rhythm |
| Border radius: 12/8/6 | Panel/input/button |
| Fonts: Outfit / JetBrains Mono / Orbitron | Per role |
