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
import { useDockerStore } from '@/stores/docker'
import * as dbService from '@/services/db'
import * as dockerService from '@/services/docker'
import { openAssetTab, dispatchObjectSelection } from '@/utils/assetRouting'
import { buildDockerConnectParams } from '@/utils/dockerConnect'
import { formatBytes } from '@/utils/sshMetrics'
import { loadBrokerOverview } from '@/services/broker'
import { buildRedisNamespaceTree, type RedisTreeNode } from '@/utils/redisKeys'
import { groupEsIndices } from '@/utils/esIndexGroups'

export type ObjectKind =
  | 'database' | 'table'
  | 'redis-db' | 'redis-ns' | 'redis-key'
  | 'es-group' | 'es-index'
  | 'kafka-topic' | 'nsq-topic' | 'nsq-channel'
  | 'docker-group' | 'docker-container' | 'docker-image'

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
  /** Redis SCAN 续传游标(rdb 节点 key → cursor),点击 '+ 加载更多' 续扫 */
  scanCursor: Record<string, number>
  /** Redis 已收集 key(rdb 节点 key → 列表),续扫后与新增合并重建 trie */
  scanCollected: Record<string, { key: string; type: string; ttl: number }[]>
  /** Redis 连接内过滤:SCAN MATCH 前的 childrenByKey 备份,清空过滤时恢复 */
  searchBackup: Record<string, ObjectNode[]> | null
  /** Redis 过滤搜索代次:防止迟到的搜索结果覆盖已恢复的树 */
  searchSeq: number
}

/** 各 dbType 的系统库/schema 过滤 */
const SYSTEM_DATABASES: Record<string, string[]> = {
  mysql: ['information_schema', 'mysql', 'performance_schema', 'sys'],
  postgresql: ['pg_catalog', 'information_schema', 'pg_toast'],
  clickhouse: ['system', 'INFORMATION_SCHEMA', 'information_schema']
}

/** 表节点截断:全量表都入树(保证连接内过滤命中全部),AssetTreeNode 渲染层默认只显示前 50 张 */
export const TABLE_TRUNCATE = 50

function emptyState(): AssetTreeState {
  return {
    status: 'idle', error: null, connId: null,
    rootChildren: [], childrenByKey: {}, loadingKeys: [], errorByKey: {}, expanded: [],
    scanCursor: {}, scanCollected: {}, searchBackup: null, searchSeq: 0
  }
}

/** docs 数紧凑格式化:1234 → 1.2K,5678901 → 5.7M */
function compactDocs(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

/** Redis trie → ObjectNode,递归把 ns 子级预填进 byKey(无需再请求) */
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

  // ─── 连接(复用 dbStore/dockerStore.sessions) ───
  async function ensureConnection(asset: Asset): Promise<string> {
    // Docker 资产:复用 dockerStore 会话,没有则按资产配置建连(socket/tcp/ssh)
    if (asset.type === 'docker') {
      const dockerStore = useDockerStore()
      const existingDocker = [...dockerStore.sessions.values()].find(
        s => s.assetId === asset.id && s.connected
      )
      if (existingDocker) return existingDocker.connId
      const assetStore = (await import('@/stores/asset')).useAssetStore()
      const sshAssetId = asset.config.dockerSshAssetId
      const sshAsset = sshAssetId
        ? assetStore.assets.find(a => a.id === sshAssetId && a.type === 'ssh') ?? null
        : null
      const params = await buildDockerConnectParams(asset, sshAsset)
      const session = await dockerStore.connect(asset.id, asset.name, params)
      return session.connId
    }
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

  // ─── L2 分组加载(DB 系:库/schema 列表;Docker:容器/镜像) ───
  async function loadRoot(asset: Asset, state: AssetTreeState): Promise<void> {
    // Docker 资产:容器 / 镜像 两个固定分组,子级一次性预填
    if (asset.type === 'docker') {
      const connId = state.connId!
      const [containers, images] = await Promise.all([
        dockerService.listContainers(connId, true),
        dockerService.listImages(connId, false)
      ])
      state.rootChildren = [
        {
          key: 'dkg:containers', kind: 'docker-group' as const, label: '容器',
          count: containers.length, hasChildren: containers.length > 0,
          payload: { group: 'containers' }
        },
        {
          key: 'dkg:images', kind: 'docker-group' as const, label: '镜像',
          count: images.length, hasChildren: images.length > 0,
          payload: { group: 'images' }
        }
      ]
      state.childrenByKey['dkg:containers'] = containers.map(c => ({
        key: `dkc:${c.id}`, kind: 'docker-container' as const, label: c.name,
        meta: c.state === 'running' ? '运行中' : (c.status || c.state),
        hasChildren: false, payload: { containerId: c.id, name: c.name, state: c.state }
      }))
      state.childrenByKey['dkg:images'] = images.map(img => ({
        key: `dki:${img.id}`, kind: 'docker-image' as const,
        label: img.tags[0] ?? img.id.replace(/^sha256:/, '').slice(0, 12),
        meta: formatBytes(img.size),
        hasChildren: false, payload: { imageId: img.id }
      }))
      return
    }
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
      // 各组子级预填(索引列表已在内存,无需再请求);系统组默认不展开
      for (const g of groups) {
        state.childrenByKey[`esg:${g.key}`] = g.indices.map(idx => ({
          key: `esi:${idx.name}`, kind: 'es-index' as const, label: idx.name,
          meta: compactDocs(idx.docsCount),
          hasChildren: false, payload: { index: idx.name }
        }))
      }
      return
    }
    // broker 分支在后续迭代扩展
    state.rootChildren = []
  }

  /** 展开资产节点:连接 + 拉 L2;幂等(已 ready/connecting 直接返回) */
  async function ensureAsset(asset: Asset): Promise<void> {
    const state = ensureState(asset.id)
    if (state.status === 'ready' || state.status === 'connecting') return
    restoreExpanded(asset.id)
    state.status = 'connecting'
    state.error = null
    try {
      const dbType = asset.config.dbType || 'mysql'
      if (dbType === 'kafka' || dbType === 'nsq') {
        // broker 无会话,loadRoot 直连 overview
        state.connId = null
      } else {
        state.connId = await ensureConnection(asset)
      }
      await loadRoot(asset, state)
      // 重启恢复:expanded 从 localStorage 还原后,补齐各展开节点的子级(否则会显示已展开但无数据)
      for (const key of [...state.expanded]) {
        const node = state.rootChildren.find(n => n.key === key)
        if (!node?.hasChildren || state.childrenByKey[key]) continue
        state.loadingKeys.push(key)
        delete state.errorByKey[key]
        try {
          await loadChildren(asset, state, node)
        } catch (err) {
          state.errorByKey[key] = err instanceof Error ? err.message : String(err)
        } finally {
          state.loadingKeys = state.loadingKeys.filter(k => k !== key)
        }
      }
      state.status = 'ready'
    } catch (err) {
      state.status = 'error'
      state.error = err instanceof Error ? err.message : String(err)
    }
  }

  /** 由已收集 key 重建某 redis-db 的 trie 子树;游标未耗尽时追加可点击的 '+ 加载更多' 节点 */
  function renderRedisDb(state: AssetTreeState, rdbKey: string, db: number): void {
    const collected = state.scanCollected[rdbKey] ?? []
    const trie = buildRedisNamespaceTree(collected)
    const byKey: Record<string, ObjectNode[]> = {}
    const nodes = trie.map(t => redisTrieToNodes(db, t, byKey))
    if ((state.scanCursor[rdbKey] ?? 0) !== 0) {
      nodes.push({
        key: `${rdbKey}.__more`, kind: 'redis-key',
        label: `+ 加载更多(已显示 ${collected.length} 个 key)`,
        hasChildren: false, payload: { db, rdb: rdbKey, more: true }
      })
    }
    state.childrenByKey[rdbKey] = nodes
    // ns 子级预填(trie 已在内存,无需再请求)
    Object.assign(state.childrenByKey, byKey)
  }

  /** SCAN 一批 key(初扫/续扫共用):最多 3 轮或 500 个 */
  async function scanRedisBatch(
    connId: string, cursor: number, collected: { key: string; type: string; ttl: number }[]
  ): Promise<number> {
    let rounds = 0
    let added = 0
    do {
      const result = await dbService.redisScan(connId, cursor, '*', 200)
      collected.push(...result.keys)
      added += result.keys.length
      cursor = result.cursor
      rounds++
    } while (cursor !== 0 && rounds < 3 && added < 500)
    return cursor
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
      // 全量入树(连接内过滤需命中全部表);截断展示由 AssetTreeNode 渲染层负责
      const nodes: ObjectNode[] = tables.map(t => ({
        key: `table:${db}.${t.name}`, kind: 'table', label: t.name,
        meta: t.rows != null ? String(t.rows) : undefined,
        hasChildren: false, payload: { db, table: t.name }
      }))
      state.childrenByKey[node.key] = nodes
    }
    if (node.kind === 'redis-db') {
      const db = Number(node.payload?.db ?? 0)
      const connId = state.connId!
      await dbService.redisSelect(connId, db)
      const collected: { key: string; type: string; ttl: number }[] = []
      const cursor = await scanRedisBatch(connId, 0, collected)
      state.scanCollected[node.key] = collected
      state.scanCursor[node.key] = cursor
      renderRedisDb(state, node.key, db)
    }
  }

  async function toggleNode(asset: Asset, node: ObjectNode): Promise<void> {
    const state = ensureState(asset.id)
    // '+ 加载更多' 伪节点:Redis 从上次游标续扫下一批(表截断是渲染层行为,见 AssetTreeNode)
    if (node.payload?.more) {
      if (node.payload.hint) return
      const rdbKey = String(node.payload.rdb ?? '')
      const db = Number(node.payload.db ?? 0)
      if (!rdbKey || !state.connId) return
      state.loadingKeys.push(node.key)
      delete state.errorByKey[node.key]
      try {
        await dbService.redisSelect(state.connId, db)
        const collected = state.scanCollected[rdbKey] ?? []
        const cursor = await scanRedisBatch(state.connId, state.scanCursor[rdbKey] ?? 0, collected)
        state.scanCollected[rdbKey] = collected
        state.scanCursor[rdbKey] = cursor
        renderRedisDb(state, rdbKey, db)
      } catch (err) {
        state.errorByKey[node.key] = err instanceof Error ? err.message : String(err)
      } finally {
        state.loadingKeys = state.loadingKeys.filter(k => k !== node.key)
      }
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

  // ─── 表截断展示(渲染层;全量已入树,连接内过滤始终命中全部表) ───
  const fullTableLists = ref<Record<string, true>>({})
  function isTableListFull(assetId: string, key: string): boolean {
    return Boolean(fullTableLists.value[`${assetId}|${key}`])
  }
  function showAllTables(assetId: string, key: string): void {
    fullTableLists.value[`${assetId}|${key}`] = true
  }

  // ─── Redis 连接内过滤:SCAN MATCH 服务端过滤 ───
  // 注意:SCAN glob 大小写敏感,与 UI 过滤的大小写不敏感略有差异;glob 元字符需转义
  async function searchRedis(asset: Asset, q: string): Promise<void> {
    const state = states.value[asset.id]
    if (!state || state.status !== 'ready' || !state.connId) return
    if (!state.searchBackup) state.searchBackup = state.childrenByKey
    const seq = ++state.searchSeq
    const connId = state.connId
    const pattern = `*${q.replace(/[\\*?[\]]/g, m => `\\${m}`)}*`
    for (const rdb of state.rootChildren) {
      if (rdb.kind !== 'redis-db' || (rdb.count ?? 0) <= 0) continue
      if (state.searchSeq !== seq) return
      const db = Number(rdb.payload?.db ?? 0)
      try {
        await dbService.redisSelect(connId, db)
        const collected: { key: string; type: string; ttl: number }[] = []
        let cursor = 0
        let rounds = 0
        do {
          const result = await dbService.redisScan(connId, cursor, pattern, 200)
          collected.push(...result.keys)
          cursor = result.cursor
          rounds++
        } while (cursor !== 0 && rounds < 25 && collected.length < 1000)
        if (state.searchSeq !== seq) return
        const trie = buildRedisNamespaceTree(collected)
        const byKey: Record<string, ObjectNode[]> = {}
        const nodes = trie.map(t => redisTrieToNodes(db, t, byKey))
        if (cursor !== 0) {
          nodes.push({
            key: `${rdb.key}.__search_hint`, kind: 'redis-key',
            label: `(仅显示前 ${collected.length} 个匹配)`,
            hasChildren: false, payload: { db, more: true, hint: true }
          })
        }
        state.childrenByKey = { ...state.childrenByKey, [rdb.key]: nodes, ...byKey }
      } catch { /* 单库搜索失败不影响其他库 */ }
    }
  }

  /** 清空 Redis 过滤:恢复搜索前备份的子树 */
  function clearRedisSearch(assetId: string): void {
    const state = states.value[assetId]
    if (!state) return
    state.searchSeq++
    if (state.searchBackup) {
      state.childrenByKey = state.searchBackup
      state.searchBackup = null
    }
  }

  /** 数据变更后(删 key / flushdb / 删索引 / 刷新)重拉 */
  async function refreshAsset(assetId: string): Promise<void> {
    const state = states.value[assetId]
    if (!state || state.status !== 'ready') return
    state.childrenByKey = {}
    state.searchBackup = null
    state.searchSeq++
    state.scanCursor = {}
    state.scanCollected = {}
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
    takePendingSelection, refreshAsset, isExpanded, childrenOf,
    isTableListFull, showAllTables, searchRedis, clearRedisSearch
  }
})
