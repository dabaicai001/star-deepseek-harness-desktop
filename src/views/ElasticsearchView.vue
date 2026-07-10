<script setup lang="ts">
import { ref, computed, onMounted, watch, nextTick } from 'vue'
import { useRoute } from 'vue-router'
import { useDbStore } from '@/stores/db'
import { useAppStore } from '@/stores/app'
import { useAssetStore } from '@/stores/asset'
import { useAiStore } from '@/stores/ai'
import { useI18n } from 'vue-i18n'
import * as esService from '@/services/db'
import { ES_SYSTEM_PROMPT, esTools, makeEsToolCaller } from '@/utils/aiTools'
import type { LlmToolCall } from '@/services/ai'
import AiChat from '@/components/ai/AiChat.vue'
import NewIndexDialog from '@/components/es/NewIndexDialog.vue'
import ContextMenu from '@/components/common/ContextMenu.vue'
import ResizableSidebarHandle from '@/components/layout/ResizableSidebarHandle.vue'
import type { MenuItem } from '@/components/common/ContextMenu.vue'
import type { EsIndexInfo, EsSearchResult } from '@/types/db'
import ProductIcon from '@/components/common/ProductIcon.vue'

const { t } = useI18n()
const route = useRoute()
const dbStore = useDbStore()
const appStore = useAppStore()
const assetStore = useAssetStore()
const aiStore = useAiStore()

const instanceId = computed(() => route.params.id as string)
const tab = computed(() => appStore.tabs.find(t => t.id === instanceId.value))

const session = computed(() => {
  for (const [, s] of dbStore.sessions) {
    if (s.assetId === tab.value?.assetId && s.dbType === 'elasticsearch') return s
  }
  return null
})

const connId = ref<string | null>(session.value?.connId || null)
const isLoading = ref(false)
const error = ref<string | null>(null)

const activeTab = ref<'overview' | 'search' | 'index' | 'importexport' | 'ai'>('overview')

const indices = ref<EsIndexInfo[]>([])
const selectedIndex = ref<string | null>(null)
const indexSearch = ref('')
const sidebarOpen = ref(true)
const sidebarWidth = ref(240)
const sidebarDragging = ref(false)

const clusterHealth = ref<{ status: string; numberOfNodes: number; activeShardsPercent: number } | null>(null)

const dslQuery = ref('{\n  "query": {\n    "match_all": {}\n  },\n  "size": 20\n}')
const searchResult = ref<EsSearchResult | null>(null)
const searchLoading = ref(false)
const resultViewMode = ref<'table' | 'json'>('table')
const searchFrom = ref(0)
const searchSize = ref(20)
const searchIndex = ref('')

const mapping = ref<{ indexName: string; fields: { name: string; type: string; children?: { name: string; type: string }[] }[] } | null>(null)
const settings = ref<Record<string, unknown> | null>(null)

const showNewIndex = ref(false)
const ctxMenu = ref<{ x: number; y: number; items: MenuItem[] } | null>(null)

const filteredIndices = computed(() => {
  if (!indexSearch.value) return indices.value
  const q = indexSearch.value.toLowerCase()
  return indices.value.filter(i => i.name.toLowerCase().includes(q))
})

const searchColumns = computed(() => {
  if (!searchResult.value?.hits?.length) return []
  const cols = new Set<string>()
  cols.add('_id')
  for (const hit of searchResult.value.hits) {
    for (const key of Object.keys(hit.source)) {
      cols.add(key)
    }
  }
  return Array.from(cols)
})

function getFieldValue(source: Record<string, unknown>, field: string): string {
  if (field === '_id') return ''
  const val = source[field]
  if (val === null || val === undefined) return ''
  if (typeof val === 'object') return JSON.stringify(val)
  return String(val)
}

// ====== AI 助手 ======
const aiSession = computed(() => {
  if (!connId.value) return null
  return aiStore.getOrCreateSession(instanceId.value, tab.value?.assetId || '', 'db')
})

async function executeEsTool(name: string, args: Record<string, unknown>): Promise<string> {
  if (!connId.value) throw new Error('ES 未连接')
  try {
    switch (name) {
      case 'es_list_indices': {
        const idxs = await esService.esListIndices(connId.value)
        return JSON.stringify(idxs.map(i => ({ name: i.name, docs: i.docsCount, size: i.storeSize, health: i.health, status: i.status })), null, 2)
      }
      case 'es_cluster_health': {
        const h = await esService.esClusterHealth(connId.value)
        return JSON.stringify(h, null, 2)
      }
      case 'es_get_mapping': {
        const m = await esService.esGetMapping(connId.value, String(args.index))
        if (m && m.fields) {
          return JSON.stringify(m.fields.map(f => ({ name: f.name, type: f.type, children: f.children })), null, 2)
        }
        return JSON.stringify(m, null, 2)
      }
      case 'es_search': {
        let body: Record<string, unknown>
        try { body = JSON.parse(String(args.query)) } catch { return '[Error] Invalid JSON in query DSL' }
        const size = args.size ? Number(args.size) : 20
        const from = args.from ? Number(args.from) : 0
        const r = await esService.esSearch(connId.value, String(args.index), body, from, size)
        const hits = r.hits?.map(h => ({ _id: h.id, _index: h.index, _score: h.score, ...h.source })) || []
        return `总计: ${r.totalHits} 条, 耗时: ${r.took}ms\n${JSON.stringify(hits.slice(0, 20), null, 2)}${r.totalHits > 20 ? `\n... (还有 ${r.totalHits - 20} 条)` : ''}`
      }
      case 'es_get_document': {
        const doc = await esService.esGetDocument(connId.value, String(args.index), String(args.id))
        return JSON.stringify(doc, null, 2)
      }
      case 'es_count': {
        let body: Record<string, unknown> | undefined
        if (args.query) {
          try { body = JSON.parse(String(args.query)) } catch { return '[Error] Invalid JSON in query' }
        }
        const r = await esService.esCount(connId.value, String(args.index), body)
        return `count: ${r.count}`
      }
      case 'es_index_document_confirmed': {
        let body: Record<string, unknown>
        try { body = JSON.parse(String(args.body)) } catch { return '[Error] Invalid JSON in body' }
        const id = args.id ? String(args.id) : undefined
        const r = await esService.esIndexDocument(connId.value, String(args.index), body, id)
        return JSON.stringify(r, null, 2)
      }
      case 'es_delete_document_confirmed': {
        const r = await esService.esDeleteDocument(connId.value, String(args.index), String(args.id))
        return JSON.stringify(r, null, 2)
      }
      case 'es_delete_index_confirmed': {
        const r = await esService.esDeleteIndex(connId.value, String(args.index))
        return JSON.stringify(r, null, 2)
      }
      default:
        return `[Unknown tool] ${name}`
    }
  } catch (e: any) {
    return `[Error] ${e?.message || String(e)}`
  }
}

const esPendingConfirms = ref<Map<string, (approved: boolean) => void>>(new Map())

async function onAiSend(text: string) {
  if (!aiSession.value) return
  // 防并发 send:loading 在 runAgent 之前立刻设,挡住重复点击,
  // 否则两个 runAgent 并发跑会污染 messages(LLM 报 400 tool call 错位)
  if (aiSession.value.loading) return
  aiSession.value.loading = true
  aiSession.value.messages.push({ role: 'user', content: text })

  const confirmFn: import('@/utils/aiTools').ToolConfirmFn = async (ctx) => {
    const session = aiSession.value!
    const running = [...session.toolCalls].reverse().find(t => t.status === 'running' || t.status === 'awaiting-confirm')
    const recordId = running?.id || `pending-${Date.now()}`
    if (running) {
      running.status = 'awaiting-confirm'
      running.result = ctx.message
      running.confirmReason = ctx.reason
    } else {
      session.toolCalls.push({
        id: recordId, name: ctx.toolName, args: ctx.args,
        status: 'awaiting-confirm', result: ctx.message, confirmReason: ctx.reason, startedAt: Date.now()
      })
    }
    // 强制触发 Vue 响应式:替换 toolCalls 数组引用 + 等 nextTick 刷新 DOM
    session.toolCalls = [...session.toolCalls]
    await nextTick()
    return new Promise<boolean>((resolve) => {
      esPendingConfirms.value.set(recordId, resolve)
    })
  }

  const caller = makeEsToolCaller(
    executeEsTool,
    () => aiStore.settings.commandWhitelist,
    confirmFn
  )
  const toolExec = async (call: LlmToolCall) =>
    await caller({ function: { name: call.function.name, arguments: call.function.arguments } })
  const basePrompt = selectedIndex.value
    ? ES_SYSTEM_PROMPT.replace('Elasticsearch 集群', `Elasticsearch 集群,当前选中的索引是 "${selectedIndex.value}"`)
    : ES_SYSTEM_PROMPT
  const sysPrompt = aiStore.buildSystemPrompt(basePrompt, 'db')
  await aiStore.runAgent(instanceId.value, esTools, toolExec, sysPrompt)
}

async function onAiRetry() {
  if (!aiSession.value) return
  const msgs = aiSession.value.messages
  while (msgs.length && msgs[msgs.length - 1].role !== 'user') msgs.pop()
  if (msgs.length) await onAiSend('')
}

function onAiNewChat() {
  aiStore.resetSession(instanceId.value)
}

function onAiStop() {
  aiStore.stopAgent(instanceId.value)
}

function onAiConfirmTool(recordId: string, decision: 'approve' | 'reject' | 'whitelist') {
  if (!aiSession.value) return
  const rec = aiSession.value.toolCalls.find(t => t.id === recordId)
  if (rec) {
    if (decision === 'whitelist') {
      const cmd = String(rec.args.query ?? rec.args.body ?? '')
      const prefix = rec.name
      if (prefix) {
        aiStore.addToWhitelist(prefix)
      }
      rec.status = 'success'
      rec.result = `✓ 已加入白名单 (${prefix}),正在执行…`
    } else if (decision === 'approve') {
      rec.status = 'success'
      rec.result = '✓ 已批准,正在执行…'
    } else {
      rec.status = 'rejected'
      rec.result = '✗ 已拒绝'
    }
  }
  const resolve = esPendingConfirms.value.get(recordId)
  if (resolve) {
    resolve(decision === 'approve' || decision === 'whitelist')
    esPendingConfirms.value.delete(recordId)
  }
}

async function initConnection() {
  if (!tab.value?.assetId) {
    error.value = 'No asset found'
    return
  }
  for (const [cid, s] of dbStore.sessions) {
    if (s.assetId === tab.value.assetId && s.dbType === 'elasticsearch') {
      connId.value = cid
      break
    }
  }
  if (!connId.value) {
    try {
      const asset = assetStore.assets.find(a => a.id === tab.value!.assetId)
      if (!asset) throw new Error('Asset not found')
      const config = asset.config
      const params = {
        address: config.address,
        host: config.host || 'localhost',
        port: config.port || 9200,
        username: config.username,
        password: config.password,
        useSSL: config.ssl || false,
      }
      await dbStore.connectElasticsearch(tab.value.assetId, asset.name, params as any)
      for (const [cid, s] of dbStore.sessions) {
        if (s.assetId === tab.value.assetId) { connId.value = cid; break }
      }
    } catch (e: any) {
      error.value = e?.message || String(e)
      return
    }
  }
  await loadIndices()
  await loadClusterHealth()
}

async function loadClusterHealth() {
  if (!connId.value) return
  try { clusterHealth.value = await esService.esClusterHealth(connId.value) } catch { /* */ }
}

async function loadIndices() {
  if (!connId.value) return
  isLoading.value = true
  try { indices.value = await esService.esListIndices(connId.value) } catch (e: any) { error.value = e?.message || String(e) } finally { isLoading.value = false }
}

function selectIndex(name: string) { selectedIndex.value = name; searchIndex.value = name; activeTab.value = 'index'; loadMapping(name) }

async function loadMapping(index: string) {
  if (!connId.value) return
  try {
    mapping.value = await esService.esGetMapping(connId.value, index)
    settings.value = await esService.esGetSettings(connId.value, index)
  } catch { /* */ }
}

async function executeSearch() {
  if (!connId.value) return
  searchLoading.value = true
  try {
    let body: Record<string, unknown>
    try { body = JSON.parse(dslQuery.value) } catch { error.value = 'Invalid JSON in DSL query'; searchLoading.value = false; return }
    const idx = searchIndex.value || '_all'
    searchResult.value = await esService.esSearch(connId.value, idx, body, searchFrom.value, searchSize.value)
    error.value = null
  } catch (e: any) { error.value = e?.message || String(e) } finally { searchLoading.value = false }
}

function prevPage() { if (searchFrom.value >= searchSize.value) { searchFrom.value -= searchSize.value; executeSearch() } }
function nextPage() { if (searchResult.value && searchFrom.value + searchSize.value < searchResult.value.totalHits) { searchFrom.value += searchSize.value; executeSearch() } }
function formatDsl() { try { dslQuery.value = JSON.stringify(JSON.parse(dslQuery.value), null, 2) } catch { /* */ } }
function showDslTemplate() { dslQuery.value = JSON.stringify({ query: { match_all: {} }, size: 20, sort: [{ _score: { order: 'desc' } }] }, null, 2) }

function getHealthColor(status: string): string { if (status === 'green') return 'var(--green)'; if (status === 'yellow') return 'var(--yellow)'; return 'var(--red)' }
function getFieldTypeColor(type: string): string { if (type === 'text') return 'var(--cyan)'; if (type === 'keyword') return 'var(--green)'; if (type === 'long' || type === 'integer' || type === 'short' || type === 'byte' || type === 'double' || type === 'float') return 'var(--yellow)'; if (type === 'date') return 'var(--purple)'; if (type === 'boolean') return 'var(--muted)'; if (type === 'nested' || type === 'object') return 'var(--pink)'; return 'var(--text-2)' }

// ─── Context Menus ───
function closeCtxMenu() { ctxMenu.value = null }

function onIndexContextMenu(e: MouseEvent, index: EsIndexInfo) {
  const items: MenuItem[] = [
    { type: 'header', label: index.name },
    { type: 'divider' },
    { type: 'item', label: '📋 复制名称', icon: 'mdi-content-copy', onClick: () => { navigator.clipboard.writeText(index.name).catch(() => {}) } },
    { type: 'divider' },
    { type: 'item', label: '📝 查看映射', icon: 'mdi-file-tree', onClick: () => { selectIndex(index.name) } },
    { type: 'item', label: '⚙️ 查看设置', icon: 'mdi-cog', onClick: () => { selectIndex(index.name) } },
    { type: 'divider' },
    { type: 'item', label: '🗑️ 删除索引', icon: 'mdi-delete-outline', danger: true, onClick: () => { doDeleteIndex(index.name) } },
  ]
  ctxMenu.value = { x: e.clientX, y: e.clientY, items }
}

function onSidebarContextMenu(e: MouseEvent) {
  const items: MenuItem[] = [
    { type: 'item', label: '➕ 新建索引...', icon: 'mdi-database-plus', onClick: () => { showNewIndex.value = true } },
    { type: 'item', label: '🔄 刷新索引列表', icon: 'mdi-refresh', onClick: () => { loadIndices() } },
  ]
  ctxMenu.value = { x: e.clientX, y: e.clientY, items }
}

async function doDeleteIndex(name: string) {
  if (!connId.value) return
  try {
    await esService.esDeleteIndex(connId.value, name)
    if (selectedIndex.value === name) { selectedIndex.value = null; mapping.value = null; settings.value = null }
    await loadIndices()
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

function onIndexCreated(name: string) {
  loadIndices()
}

watch(() => route.params.id, () => { connId.value = null; indices.value = []; selectedIndex.value = null; searchResult.value = null; mapping.value = null; error.value = null; initConnection() })
onMounted(() => initConnection())
</script>

<template>
  <div class="es-view">
    <div class="es-header">
      <div class="header-left">
        <span class="status-dot" :class="session?.connected ? 'online' : 'offline'" />
        <ProductIcon product="elasticsearch" :size="16" />
        <span class="header-label">Elasticsearch</span>
        <template v-if="session">
          <span class="header-sep">·</span>
          <span class="header-host">{{ session.database }}</span>
          <span class="header-sep">·</span>
          <span class="header-host">{{ session.host }}:{{ session.port }}</span>
        </template>
      </div>
      <div class="header-right">
        <button class="cyber-btn-secondary" @click="loadIndices"><v-icon size="14">mdi-refresh</v-icon></button>
      </div>
    </div>

    <div class="es-body">
      <div
        class="es-sidebar"
        :class="{ collapsed: !sidebarOpen, dragging: sidebarDragging }"
        :style="{
          width: sidebarOpen ? `${sidebarWidth}px` : '40px',
          minWidth: sidebarOpen ? `${sidebarWidth}px` : '40px'
        }"
        @contextmenu.prevent="onSidebarContextMenu"
      >
        <template v-if="sidebarOpen">
          <div class="sidebar-search">
            <input v-model="indexSearch" type="text" class="cyber-input" :placeholder="t('common.search') + ' ' + t('db.index') + '...'" />
            <button class="action-btn" title="Collapse" @click="sidebarOpen = false"><v-icon size="14">mdi-chevron-left</v-icon></button>
          </div>
          <div class="index-list">
            <div v-for="idx in filteredIndices" :key="idx.name" class="tree-item" :class="{ active: selectedIndex === idx.name }" @click="selectIndex(idx.name)" @contextmenu.prevent="onIndexContextMenu($event, idx)">
              <div class="tree-item-icon"><span class="status-dot" :style="{ backgroundColor: getHealthColor(idx.health) }" /></div>
              <div class="tree-item-content"><span class="tree-item-label">{{ idx.name }}</span><span class="tree-item-meta">{{ idx.docsCount?.toLocaleString() }} docs</span></div>
            </div>
            <div v-if="filteredIndices.length === 0 && !isLoading" class="empty-state"><v-icon size="32">mdi-database-off</v-icon><span>{{ t('common.noData') }}</span></div>
          </div>
        </template>
        <button v-else class="action-btn es-expand-btn" title="Expand" @click="sidebarOpen = true"><v-icon size="14">mdi-chevron-right</v-icon></button>
        <ResizableSidebarHandle
          :open="sidebarOpen"
          :width="sidebarWidth"
          :min="190"
          :max="380"
          :default-width="240"
          :collapse-threshold="150"
          aria-label="Resize Elasticsearch sidebar"
          @update:open="sidebarOpen = $event"
          @update:width="sidebarWidth = $event"
          @dragging="sidebarDragging = $event"
        />
      </div>

      <div class="es-main">
        <div class="es-tabs">
          <button v-for="tb in [{ key: 'overview' as const, label: t('home.welcome'), icon: 'mdi-view-dashboard' }, { key: 'search' as const, label: t('db.query'), icon: 'mdi-magnify' }, { key: 'index' as const, label: t('db.index'), icon: 'mdi-file-document' }, { key: 'importexport' as const, label: t('db.export'), icon: 'mdi-import' }, { key: 'ai' as const, label: 'AI', icon: 'mdi-robot' }]" :key="tb.key" :class="['cyber-tab', { active: activeTab === tb.key }]" @click="activeTab = tb.key"><v-icon size="14">{{ tb.icon }}</v-icon>{{ tb.label }}</button>
        </div>

        <div v-if="activeTab === 'overview'" class="es-tab-content">
          <div class="overview-grid">
            <div class="cyber-card cluster-health-card">
              <div class="card-title"><span class="status-dot" :style="{ backgroundColor: getHealthColor(clusterHealth?.status || 'red') }" />{{ t('db.clusterHealth') }}</div>
              <div class="health-stats" v-if="clusterHealth">
                <div class="health-stat"><span class="stat-value" :style="{ color: getHealthColor(clusterHealth.status) }">{{ clusterHealth.status }}</span><span class="stat-label">Status</span></div>
                <div class="health-stat"><span class="stat-value">{{ clusterHealth.numberOfNodes }}</span><span class="stat-label">Nodes</span></div>
                <div class="health-stat"><span class="stat-value">{{ clusterHealth.activeShardsPercent.toFixed(1) }}%</span><span class="stat-label">Active Shards</span></div>
              </div>
            </div>
            <div class="cyber-card"><div class="card-title">{{ t('db.indices') }}</div><div class="index-stats-summary"><div class="health-stat"><span class="stat-value">{{ indices.length }}</span><span class="stat-label">Total Indices</span></div><div class="health-stat"><span class="stat-value">{{ indices.reduce((s, i) => s + (i.docsCount || 0), 0).toLocaleString() }}</span><span class="stat-label">Total Docs</span></div></div></div>
          </div>
          <div class="indices-table-wrap">
            <table class="data-table"><thead><tr><th>{{ t('asset.name') }}</th><th>{{ t('db.rows') }}</th><th>Shards</th><th>{{ t('sftp.size') }}</th><th>Health</th><th>Status</th></tr></thead><tbody><tr v-for="idx in indices" :key="idx.name" @click="selectIndex(idx.name)" class="clickable-row"><td class="mono">{{ idx.name }}</td><td class="mono">{{ idx.docsCount?.toLocaleString() }}</td><td class="mono">{{ idx.primaryShards }}P / {{ idx.replicaShards }}R</td><td class="mono">{{ idx.storeSize }}</td><td><span class="status-dot" :style="{ backgroundColor: getHealthColor(idx.health) }" /> {{ idx.health }}</td><td>{{ idx.status }}</td></tr></tbody></table>
          </div>
        </div>

        <div v-if="activeTab === 'search'" class="es-tab-content search-layout">
          <div class="dsl-editor-panel">
            <div class="panel-header"><span>{{ t('db.dslQuery') }}</span><div class="panel-actions"><select v-model="searchIndex" class="cyber-input index-select"><option value="">{{ t('db.initialDbHint') }}</option><option v-for="idx in indices" :key="idx.name" :value="idx.name">{{ idx.name }}</option></select><button class="cyber-btn-secondary action-btn" @click="formatDsl" title="Format"><v-icon size="12">mdi-code-braces</v-icon></button><button class="cyber-btn-secondary action-btn" @click="showDslTemplate" title="Template"><v-icon size="12">mdi-file-document-outline</v-icon></button></div></div>
            <textarea v-model="dslQuery" class="dsl-editor" spellcheck="false" @keydown.ctrl.enter.prevent="executeSearch" />
            <div class="dsl-footer"><div class="shortcut-hint"><kbd>Ctrl</kbd>+<kbd>Enter</kbd> {{ t('db.execute') }}</div><button class="cyber-btn" @click="executeSearch" :disabled="searchLoading"><v-icon size="14">{{ searchLoading ? 'mdi-loading mdi-spin' : 'mdi-magnify' }}</v-icon>{{ searchLoading ? t('common.loading') : t('db.query') }}</button></div>
          </div>
          <div class="result-panel">
            <div v-if="error" class="test-status fail"><v-icon size="14">mdi-alert-circle</v-icon>{{ error }}</div>
            <template v-if="searchResult">
              <div class="result-toolbar"><span class="result-info">{{ searchResult.totalHits.toLocaleString() }} hits · {{ searchResult.took }}ms</span><div class="result-actions"><button :class="['view-toggle-btn', { active: resultViewMode === 'table' }]" @click="resultViewMode = 'table'">{{ t('db.table') }}</button><button :class="['view-toggle-btn', { active: resultViewMode === 'json' }]" @click="resultViewMode = 'json'">{{ t('db.json') }}</button></div></div>
              <div v-if="resultViewMode === 'table'" class="result-table-wrap"><table class="data-table"><thead><tr><th v-for="col in searchColumns" :key="col" class="mono">{{ col }}</th></tr></thead><tbody><tr v-for="(hit, hi) in searchResult.hits" :key="hi"><td v-for="col in searchColumns" :key="col" class="mono">{{ col === '_id' ? hit.id : getFieldValue(hit.source, col) }}</td></tr></tbody></table></div>
              <div v-else class="json-view-wrap"><pre class="json-view"><code>{{ JSON.stringify(searchResult.hits.map(h => ({ _id: h.id, _index: h.index, _score: h.score, _source: h.source })), null, 2) }}</code></pre></div>
              <div class="result-pagination"><button class="cyber-btn-secondary" :disabled="searchFrom === 0" @click="prevPage"><v-icon size="12">mdi-chevron-left</v-icon></button><span class="mono">{{ searchFrom + 1 }}-{{ Math.min(searchFrom + searchSize, searchResult.totalHits) }} / {{ searchResult.totalHits.toLocaleString() }}</span><button class="cyber-btn-secondary" :disabled="searchFrom + searchSize >= searchResult.totalHits" @click="nextPage"><v-icon size="12">mdi-chevron-right</v-icon></button></div>
            </template>
            <div v-else-if="!searchLoading && !error" class="empty-state"><v-icon size="32">mdi-magnify</v-icon><span>{{ t('db.emptyDsl') }}</span></div>
          </div>
        </div>

        <div v-if="activeTab === 'index'" class="es-tab-content">
          <div v-if="selectedIndex" class="index-detail">
            <div class="detail-header"><h3 class="section-header"><span class="section-number">#</span>{{ selectedIndex }}</h3></div>
            <div v-if="mapping" class="mapping-section"><h4 class="sub-title"><v-icon size="14">mdi-sitemap</v-icon>{{ t('db.mapping') }}</h4><div class="mapping-tree"><div v-for="field in mapping.fields" :key="field.name" class="mapping-field"><div class="field-row"><span class="field-name mono">{{ field.name }}</span><span class="field-type-badge" :style="{ color: getFieldTypeColor(field.type), borderColor: getFieldTypeColor(field.type) }">{{ field.type }}</span></div><div v-if="field.children?.length" class="field-children"><div v-for="child in field.children" :key="child.name" class="field-row child-row"><span class="field-name mono">&#8627; {{ child.name }}</span><span class="field-type-badge" :style="{ color: getFieldTypeColor(child.type), borderColor: getFieldTypeColor(child.type) }">{{ child.type }}</span></div></div></div></div></div>
            <div v-if="settings" class="settings-section"><h4 class="sub-title"><v-icon size="14">mdi-cog</v-icon>{{ t('db.settings') }}</h4><pre class="json-view settings-json"><code>{{ JSON.stringify(settings, null, 2) }}</code></pre></div>
          </div>
          <div v-else class="empty-state"><v-icon size="32">mdi-file-document-outline</v-icon><span>Select an index from the sidebar</span></div>
        </div>

        <div v-if="activeTab === 'importexport'" class="es-tab-content">
          <div class="importexport-layout">
            <div class="cyber-card"><div class="card-title">{{ t('db.importJSON') }}</div><p class="card-desc">JSON file (array of objects or NDJSON)</p><div class="import-placeholder"><v-icon size="40">mdi-cloud-upload-outline</v-icon><span>{{ t('db.dragOrClick') }}</span></div></div>
            <div class="cyber-card"><div class="card-title">{{ t('db.exportJSON') }}</div><div class="export-controls"><select v-model="searchIndex" class="cyber-input"><option value="">Select index...</option><option v-for="idx in indices" :key="idx.name" :value="idx.name">{{ idx.name }}</option></select><button class="cyber-btn" :disabled="!searchIndex">Export</button></div></div>
          </div>
        </div>

        <div v-if="activeTab === 'ai'" class="es-tab-content">
          <AiChat
            v-if="aiSession"
            :session="aiSession"
            :sending="aiSession.loading"
            placeholder="问我关于 ES 的任何事,例如'列出所有索引'或'在 logs-* 中搜索最近1小时的错误日志'"
            @send="onAiSend"
            @retry="onAiRetry"
            @confirm-tool="onAiConfirmTool"
            @new-chat="onAiNewChat"
            @stop="onAiStop"
          />
          <div v-else class="empty-state"><v-icon size="32">mdi-robot-dead</v-icon><span>连接后可使用 AI 助手</span></div>
        </div>
      </div>
    </div>

    <div class="es-statusbar"><span class="status-dot" :style="{ backgroundColor: getHealthColor(clusterHealth?.status || 'red') }" /><span class="mono">{{ clusterHealth?.status || 'unknown' }}</span><span class="sep">·</span><span class="mono">{{ clusterHealth?.numberOfNodes || 0 }} nodes</span><span class="sep">·</span><span class="mono">{{ indices.length }} indices</span></div>

    <!-- New Index Dialog -->
    <NewIndexDialog
      v-if="connId"
      v-model="showNewIndex"
      :conn-id="connId"
      @created="onIndexCreated"
    />

    <!-- Context Menu -->
    <ContextMenu
      v-if="ctxMenu"
      :x="ctxMenu.x"
      :y="ctxMenu.y"
      :items="ctxMenu.items"
      @close="closeCtxMenu"
    />
  </div>
</template>

<style scoped>
.es-view { display: flex; flex-direction: column; height: 100%; background: var(--bg); color: var(--text); font-size: 13px; }
.es-header { display: flex; align-items: center; justify-content: space-between; padding: 8px 16px; border-bottom: 1px solid var(--line); background: var(--panel-solid); min-height: 48px; }
.header-left { display: flex; align-items: center; gap: 8px; }
.header-label { font-weight: 600; color: var(--cyan); }
.header-sep { color: var(--muted); }
.header-host { font-family: 'JetBrains Mono', monospace; font-size: 12px; color: var(--text-2); }
.header-right { display: flex; gap: 8px; }
.es-body { display: flex; flex: 1; overflow: hidden; }
.es-sidebar { position: relative; border-right: 1px solid var(--line); background: var(--panel-solid); display: flex; flex-direction: column; overflow: hidden; transition: width 0.25s, min-width 0.25s; }
.es-sidebar.dragging { transition: none; }
.es-sidebar.collapsed { align-items: center; }
.sidebar-search { display: flex; align-items: center; gap: 8px; padding: 10px; border-bottom: 1px solid var(--line); }
.sidebar-search .cyber-input { height: 28px; font-size: 12px; }
.es-expand-btn { margin-top: 10px; }
.index-list { flex: 1; overflow-y: auto; padding: 6px 0; }
.es-main { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
.es-tabs { display: flex; gap: 0; padding: 0 16px; border-bottom: 1px solid var(--line); background: var(--panel-solid); }
.es-tab-content { flex: 1; overflow-y: auto; padding: 16px; }
.es-statusbar { display: flex; align-items: center; gap: 8px; padding: 4px 16px; border-top: 1px solid var(--line); background: var(--panel-solid); font-size: 11px; color: var(--text-2); }
.overview-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 16px; }
.health-stats, .index-stats-summary { display: flex; gap: 24px; margin-top: 12px; }
.health-stat { display: flex; flex-direction: column; gap: 4px; }
.stat-value { font-size: 20px; font-weight: 700; font-family: 'JetBrains Mono', monospace; }
.stat-label { font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.08em; }
.indices-table-wrap, .result-table-wrap { overflow-x: auto; margin-top: 8px; }
.data-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.data-table th { text-align: left; padding: 6px 10px; color: var(--muted); font-weight: 600; font-size: 10px; text-transform: uppercase; border-bottom: 1px solid var(--line); }
.data-table td { padding: 5px 10px; border-bottom: 1px solid var(--line); font-size: 12px; }
.clickable-row { cursor: pointer; }
.clickable-row:hover { background: rgba(0, 240, 255, 0.04); }
.search-layout { display: flex; gap: 12px; padding: 12px; }
.dsl-editor-panel { width: 45%; display: flex; flex-direction: column; background: var(--panel-solid); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
.panel-header { display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; border-bottom: 1px solid var(--line); font-size: 12px; font-weight: 600; color: var(--text-2); }
.panel-actions { display: flex; gap: 6px; align-items: center; }
.index-select { width: 140px; height: 24px; font-size: 11px; padding: 0 6px; }
.dsl-editor { flex: 1; background: var(--bg); color: var(--text); border: none; padding: 12px; font-family: 'JetBrains Mono', monospace; font-size: 12px; line-height: 1.5; resize: none; outline: none; tab-size: 2; }
.dsl-footer { display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; border-top: 1px solid var(--line); }
.result-panel { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
.result-toolbar { display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; border: 1px solid var(--line); border-radius: 8px 8px 0 0; background: var(--panel-solid); }
.result-info { font-size: 12px; color: var(--text-2); }
.result-actions { display: flex; gap: 4px; }
.view-toggle-btn { padding: 3px 10px; border: 1px solid var(--line-2); background: transparent; color: var(--text-2); border-radius: 4px; cursor: pointer; font-size: 11px; font-family: inherit; transition: all 0.2s; }
.view-toggle-btn.active { background: rgba(0, 240, 255, 0.1); border-color: var(--cyan); color: var(--cyan); }
.json-view-wrap { flex: 1; overflow: auto; padding: 12px; background: var(--bg); border: 1px solid var(--line); border-top: none; border-radius: 0 0 8px 8px; }
.json-view { margin: 0; font-family: 'JetBrains Mono', monospace; font-size: 11px; line-height: 1.5; white-space: pre-wrap; }
.result-pagination { display: flex; align-items: center; justify-content: center; gap: 12px; padding: 10px; font-size: 12px; color: var(--text-2); }
.index-detail { display: flex; flex-direction: column; gap: 16px; }
.detail-header { display: flex; align-items: center; justify-content: space-between; }
.section-header { font-size: 16px; font-weight: 600; margin: 0; display: flex; align-items: center; gap: 8px; }
.section-number { color: var(--cyan); font-family: 'Orbitron', sans-serif; font-size: 14px; }
.sub-title { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; margin: 0 0 10px; }
.mapping-field { margin-bottom: 4px; }
.field-row { display: flex; align-items: center; gap: 10px; padding: 4px 0; }
.field-name { font-size: 12px; }
.child-row { padding-left: 20px; }
.field-type-badge { font-size: 10px; padding: 1px 6px; border: 1px solid; border-radius: 3px; font-family: 'JetBrains Mono', monospace; }
.mapping-tree { padding: 8px 0; }
.settings-json { max-height: 300px; overflow: auto; background: var(--bg); padding: 12px; border-radius: 8px; border: 1px solid var(--line); }
.importexport-layout { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.import-placeholder { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 40px; border: 2px dashed var(--line-2); border-radius: 12px; color: var(--muted); cursor: pointer; transition: all 0.2s; margin-top: 12px; }
.import-placeholder:hover { border-color: var(--cyan); color: var(--cyan); }
.export-controls { display: flex; gap: 10px; margin-top: 12px; align-items: center; }
.export-controls .cyber-input { flex: 1; }
.card-title { font-size: 13px; font-weight: 600; display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.card-desc { font-size: 11px; color: var(--muted); margin: 0 0 8px; }
.sep { color: var(--line-2); }
.mono { font-family: 'JetBrains Mono', monospace; }
.empty-state { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; padding: 40px; color: var(--muted); font-size: 13px; }
.shortcut-hint { font-size: 10px; color: var(--muted); }
.shortcut-hint kbd { font-family: 'JetBrains Mono', monospace; font-size: 10px; padding: 1px 5px; background: rgba(0, 240, 255, 0.06); border: 1px solid var(--line-2); border-radius: 3px; color: var(--cyan); }
.test-status.fail { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-radius: 8px; font-size: 12px; background: rgba(255, 77, 109, 0.08); border: 1px solid rgba(255, 77, 109, 0.2); color: var(--red); }
.cyber-tab { display: flex; align-items: center; gap: 6px; padding: 8px 14px; border: none; background: none; color: var(--text-2); cursor: pointer; font-size: 12px; font-family: inherit; border-bottom: 2px solid transparent; transition: all 0.2s; }
.cyber-tab:hover { color: var(--text); }
.cyber-tab.active { color: var(--cyan); border-bottom-color: var(--cyan); }
.tree-item { display: flex; align-items: center; gap: 8px; padding: 6px 12px; cursor: pointer; transition: all 0.15s; border-left: 2px solid transparent; }
.tree-item:hover { background: rgba(0, 240, 255, 0.04); }
.tree-item.active { border-left-color: var(--cyan); background: rgba(0, 240, 255, 0.06); }
.tree-item-icon { flex-shrink: 0; }
.tree-item-content { flex: 1; min-width: 0; }
.tree-item-label { font-size: 12px; font-family: 'JetBrains Mono', monospace; display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tree-item-meta { font-size: 10px; color: var(--muted); }
</style>
