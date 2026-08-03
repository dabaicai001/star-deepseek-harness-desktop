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
import { loadBrokerOverview } from '@/services/broker'
import { buildRedisNamespaceTree, type RedisTreeNode } from '@/utils/redisKeys'
import { groupEsIndices } from '@/utils/esIndexGroups'

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

/** 各 dbType 的系统库/schema 过滤 */
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
      const byKey: Record<string, ObjectNode[]> = {}
      const nodes = trie.map(t => redisTrieToNodes(db, t, byKey))
      if (cursor !== 0) {
        nodes.push({
          key: `rdb:${db}.__more`, kind: 'redis-key',
          label: '(仅前 500 个 key,用 Redis CLI SCAN 查看更多)',
          hasChildren: false, payload: { db, key: '', type: '', more: true }
        })
      }
      state.childrenByKey[node.key] = nodes
      // ns 子级预填(trie 已在内存,无需再请求)
      Object.assign(state.childrenByKey, byKey)
    }
  }

  async function toggleNode(asset: Asset, node: ObjectNode): Promise<void> {
    const state = ensureState(asset.id)
    // '+ N more' 伪节点:展开成全量(仅 DB 系表;redis 的提示节点不可展开)
    if (node.payload?.more) {
      if (node.kind !== 'table') return
      const db = String(node.payload.db ?? node.payload.database ?? '')
      const connId = state.connId
      if (!connId || !db) return
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
