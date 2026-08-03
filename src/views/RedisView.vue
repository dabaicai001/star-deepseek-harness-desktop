<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { useAssetStore } from '@/stores/asset'
import { useDbStore } from '@/stores/db'
import { useAiStore } from '@/stores/ai'
import { useAppStore } from '@/stores/app'
import { useNotifyStore } from '@/stores/notify'
import { parseInstanceId } from '@/utils/tabId'
import { usePersistentPanelState } from '@/utils/panelState'
import * as dbService from '@/services/db'
import { useDialogStore } from '@/stores/dialog'
import { REDIS_SYSTEM_PROMPT, redisTools, makeRedisToolCaller } from '@/utils/aiTools'
import type { LlmToolCall } from '@/services/ai'
import { createMcpRuntime } from '@/services/mcp'
import { useObjectTreeStore } from '@/stores/objectTree'
import RedisValueEditor from '@/components/redis/RedisValueEditor.vue'
import RedisCli from '@/components/redis/RedisCli.vue'
import RedisTools from '@/components/redis/RedisTools.vue'
import NewKeyDialog from '@/components/redis/NewKeyDialog.vue'
import ContextMenu, { type MenuItem } from '@/components/common/ContextMenu.vue'
import RightPanel from '@/components/layout/RightPanel.vue'
import DbDashboard from '@/components/dashboard/DbDashboard.vue'
import AiChat from '@/components/ai/AiChat.vue'
import type { RightPanelTab } from '@/components/layout/RightPanel.vue'
import ProductIcon from '@/components/common/ProductIcon.vue'

const { t } = useI18n()
const route = useRoute()
const assetStore = useAssetStore()
const dbStore = useDbStore()
const aiStore = useAiStore()
const appStore = useAppStore()
const dlg = useDialogStore()
const rightPanelOpen = usePersistentPanelState('redis', true)
const notify = useNotifyStore()

// 冻结路由参数:keep-alive 缓存的组件实例不应跟踪全局路由变化,
// 否则切换到其他 tab 时 route.params.id 改变会触发 watch 断开本 tab 的连接。
const _frozenInstanceId = route.params.id as string
const instanceId = computed(() => _frozenInstanceId)
const assetId = computed(() => parseInstanceId(_frozenInstanceId).assetId)
const asset = computed(() => assetStore.assets.find(a => a.id === assetId.value))

const connected = ref(false)
const connecting = ref(false)
const connectError = ref<string | null>(null)
const connId = ref<string | null>(null)
const currentDb = ref(0)
const dbsize = ref(0)

const objectTree = useObjectTreeStore()
const valueEditorRef = ref<InstanceType<typeof RedisValueEditor> | null>(null)
let connectAttemptId = 0
// 路由切换或 view 卸载时,把当前正在跑的连接尝试标为 stale,
// 避免 <transition mode="out-in"> leave 动画 (200ms) 期间
// 后端立即返回错误 → catch 里误以为"新 view 还在连" → 弹通知。
let connectStale = false
const ownedConnIds = new Set<string>()

function markStale() {
  if (connectStale) return
  connectStale = true
  connectAttemptId++
  connected.value = false
  connectError.value = null
  void disconnectOwnedSessions()
}

const showNewKey = ref(false)
const newKeyDb = ref(0)
const showRenameKey = ref(false)
const renameKeyOld = ref('')
const renameKeyNew = ref('')

const rightPanelTabs = computed<RightPanelTab[]>(() => [
  { key: 'dashboard', label: t('redis.dashboard'), icon: 'mdi-view-dashboard' },
  { key: 'ai', label: t('redis.aiAssistant'), icon: 'mdi-robot' },
  { key: 'tools', label: t('redis.tools'), icon: 'mdi-tools' },
])

const activeRightTab = ref('dashboard')

const aiSession = computed(() => {
  if (!connId.value) return null
  return aiStore.getOrCreateSession(instanceId.value, assetId.value, 'db')
})

async function executeRedisCmd(command: string): Promise<string> {
  if (!connId.value) throw new Error('Redis 未连接')
  const r = await dbService.redisExecute(connId.value, command)
  if (r.error) return `[Error] ${r.error}`
  return r.result == null ? '(无输出)' : (typeof r.result === 'string' ? r.result : JSON.stringify(r.result, null, 2))
}

const redisPendingConfirms = ref<Map<string, (approved: boolean) => void>>(new Map())

async function onAiSend(text: string) {
  if (!aiSession.value) return
  // 防并发 send:loading 在 runAgent 之前立刻设,挡住重复点击,
  // 否则两个 runAgent 并发跑会污染 messages(LLM 报 400 tool call 错位)
  if (aiSession.value.loading) {
    // 运行中:作为 steering 引导注入历史,runAgent 下一步边界生效
    aiStore.steer(instanceId.value, text)
    return
  }
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
      redisPendingConfirms.value.set(recordId, resolve)
    })
  }

  const caller = makeRedisToolCaller(
    executeRedisCmd,
    () => aiStore.settings.commandWhitelist,
    confirmFn
  )
  const mcpRuntime = await createMcpRuntime(await aiStore.getMcpServers(), confirmFn)
  if (mcpRuntime.warnings.length) console.warn('[redis-ai] MCP discovery warnings:', mcpRuntime.warnings)
  const toolExec = async (call: LlmToolCall) =>
    call.function.name.startsWith('mcp__')
      ? mcpRuntime.execute(call)
      : caller({ function: { name: call.function.name, arguments: call.function.arguments } })
  const basePrompt = REDIS_SYSTEM_PROMPT.replace('db0', `db${currentDb.value}`)
  const sysPrompt = aiStore.buildSystemPrompt(basePrompt, 'db')
  await aiStore.runAgent(instanceId.value, [...redisTools, ...mcpRuntime.tools], toolExec, sysPrompt)
}

async function onAiRetry() {
  if (!aiSession.value) return
  const msgs = aiSession.value.messages
  while (msgs.length && msgs[msgs.length - 1].role !== 'user') msgs.pop()
  const lastUserText = msgs.pop()?.content
  if (lastUserText) await onAiSend(lastUserText)
}

function onAiNewChat() {
  resolveRedisPendingConfirms()
  aiStore.resetSession(instanceId.value)
}

function onAiStop() {
  resolveRedisPendingConfirms()
  aiStore.stopAgent(instanceId.value)
}

function resolveRedisPendingConfirms() {
  for (const resolve of redisPendingConfirms.value.values()) resolve(false)
  redisPendingConfirms.value.clear()
}

function onAiConfirmTool(recordId: string, decision: 'approve' | 'reject' | 'whitelist') {
  if (!aiSession.value) return
  const rec = aiSession.value.toolCalls.find(t => t.id === recordId)
  if (rec) {
    if (decision === 'whitelist') {
      const cmd = String(rec.args.command ?? '')
      const prefix = cmd.trim().split(/\s+/)[0]?.toUpperCase() || ''
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
  const resolve = redisPendingConfirms.value.get(recordId)
  if (resolve) {
    resolve(decision === 'approve' || decision === 'whitelist')
    redisPendingConfirms.value.delete(recordId)
  }
}

function isStaleConnect(attemptId: number): boolean {
  return connectStale || attemptId !== connectAttemptId
}

async function disconnectOwnedSessions() {
  for (const id of [...ownedConnIds]) {
    await dbStore.disconnect(id)
    ownedConnIds.delete(id)
  }
}

async function connect() {
  if (!asset.value || connected.value) return
  // 重新开始一轮连接,清除上一次 markStale 的状态
  connectStale = false
  const attemptId = ++connectAttemptId
  connecting.value = true
  connectError.value = null
  try {
    const config = asset.value.config
    const session = await dbStore.connectRedis(assetId.value, asset.value.name, {
      host: config.host || '',
      port: config.port || 6379,
      password: config.password,
      db: 0,
      ssl: config.ssl
    })
    if (isStaleConnect(attemptId)) {
      await dbStore.disconnect(session.connId)
      return
    }
    ownedConnIds.add(session.connId)
    connId.value = session.connId
    connected.value = true
    await refreshDBSize()
  } catch (err) {
    if (isStaleConnect(attemptId)) return
    const msg = err instanceof Error ? err.message : String(err)
    connectError.value = msg
    notify.notify({ title: 'Redis 连接失败', message: msg, color: 'error', timeout: 5000 })
  } finally {
    if (!isStaleConnect(attemptId)) {
      connecting.value = false
    }
  }
}

async function refreshDBSize() {
  if (!connId.value) return
  try {
    dbsize.value = (await dbService.redisDBSize(connId.value)).size
  } catch { /* ignore */ }
}

/** 数据变更后刷新全局对象树(库 keyCount / key 列表) */
function refreshObjectTree() {
  void objectTree.refreshAsset(assetId.value)
}

async function onSwitchDb(db: number) {
  if (!connId.value) return
  try {
    await dbService.redisSelect(connId.value, db)
    currentDb.value = db
    await refreshDBSize()
  } catch (err) {
    notify.notify({ title: 'Redis 切换 DB 失败', message: err instanceof Error ? err.message : String(err), color: 'error' })
  }
}

async function onDeleteKey(key: string) {
  if (!connId.value) return
  try {
    await dbService.redisDel(connId.value, [key])
    await refreshDBSize()
    refreshObjectTree()
  } catch (err) {
    notify.notify({ title: '删除 Key 失败', message: err instanceof Error ? err.message : String(err), color: 'error' })
  }
}

function onSelectKey(key: string, type: string) {
  valueEditorRef.value?.openKey(key, type)
}

async function onFlushDb() {
  if (!connId.value) return
  if (!(await dlg.confirm({
    message: `FLUSHDB — This will delete ALL keys in db${currentDb.value}. Continue?`,
    confirmText: 'FLUSHDB',
    danger: true,
    requireTyping: 'FLUSHDB',
  }))) return
  try {
    await dbService.redisFlushDB(connId.value)
    dbsize.value = 0
    refreshObjectTree()
    notify.notify({ title: 'Redis', message: `db${currentDb.value} 已清空`, color: 'success' })
  } catch (err) {
    notify.notify({ title: '清空 DB 失败', message: err instanceof Error ? err.message : String(err), color: 'error' })
  }
}

function onNewKey(db: number) {
  newKeyDb.value = db
  showNewKey.value = true
}

function onKeyCreated(_key: string, _type: string) {
  refreshDBSize()
  refreshObjectTree()
}

async function onFlushDbFromBrowser(db: number) {
  if (!connId.value) return
  if (!(await dlg.confirm({
    message: `FLUSHDB — This will delete ALL keys in db${db}. Continue?`,
    confirmText: 'FLUSHDB',
    danger: true,
    requireTyping: 'FLUSHDB',
  }))) return
  try {
    await dbService.redisSelect(connId.value, db)
    await dbService.redisFlushDB(connId.value)
    currentDb.value = db
    dbsize.value = 0
    refreshObjectTree()
    notify.notify({ title: 'Redis', message: `db${db} 已清空`, color: 'success' })
  } catch (err) {
    notify.notify({ title: '清空 DB 失败', message: err instanceof Error ? err.message : String(err), color: 'error' })
  }
}

function onRenameKey(oldKey: string) {
  renameKeyOld.value = oldKey
  renameKeyNew.value = oldKey
  showRenameKey.value = true
}

async function doRenameKey() {
  if (!connId.value || !renameKeyNew.value.trim() || renameKeyNew.value === renameKeyOld.value) return
  try {
    await dbService.redisRename(connId.value, renameKeyOld.value, renameKeyNew.value)
    showRenameKey.value = false
    await refreshDBSize()
    refreshObjectTree()
    notify.notify({ title: 'Redis', message: 'Key 已重命名', color: 'success' })
  } catch (err) {
    notify.notify({ title: '重命名 Key 失败', message: err instanceof Error ? err.message : String(err), color: 'error' })
  }
}

// ====== 全局对象树联动(db → namespace → key,选中/右键经 window 事件到达) ======
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

function onObjectSelected(e: Event) {
  const detail = (e as CustomEvent).detail as { assetId?: string; kind?: string; payload?: Record<string, unknown> } | undefined
  if (!detail || detail.assetId !== assetId.value || !detail.kind || !detail.payload) return
  applyObjectSelection(detail.kind, detail.payload)
}

// 树节点右键:redis-db(刷新/新建 Key/FLUSHDB)、redis-key(重命名/删除)
const ctxMenu = ref<{ x: number; y: number; items: MenuItem[] } | null>(null)

function onObjectContextMenu(e: Event) {
  const detail = (e as CustomEvent).detail as { assetId?: string; kind?: string; payload?: Record<string, unknown>; x?: number; y?: number } | undefined
  if (!detail || detail.assetId !== assetId.value || !detail.kind || !detail.payload) return
  const x = detail.x ?? 0
  const y = detail.y ?? 0
  if (detail.kind === 'redis-db') {
    const db = Number(detail.payload.db ?? 0)
    ctxMenu.value = {
      x, y,
      items: [
        { type: 'header', label: `db${db}` },
        { type: 'divider' },
        { type: 'item', label: t('common.refresh'), icon: 'mdi-refresh', onClick: () => { void onSwitchDb(db).then(refreshObjectTree) } },
        { type: 'item', label: t('redis.newKey', '新建 Key'), icon: 'mdi-plus', onClick: () => onNewKey(db) },
        { type: 'divider' },
        { type: 'item', label: 'FLUSHDB', icon: 'mdi-alert-octagon', danger: true, onClick: () => { void onFlushDbFromBrowser(db) } }
      ]
    }
  } else if (detail.kind === 'redis-key') {
    const key = String(detail.payload.key ?? '')
    const type = String(detail.payload.type ?? '')
    if (!key) return
    ctxMenu.value = {
      x, y,
      items: [
        { type: 'header', label: key },
        { type: 'divider' },
        { type: 'item', label: t('common.open', '打开'), icon: 'mdi-open-in-new', onClick: () => onSelectKey(key, type) },
        { type: 'item', label: t('redis.rename', '重命名'), icon: 'mdi-rename-outline', onClick: () => onRenameKey(key) },
        { type: 'divider' },
        { type: 'item', label: t('common.delete'), icon: 'mdi-delete-outline', danger: true, onClick: () => { void onDeleteKey(key) } }
      ]
    }
  }
}

onMounted(() => {
  connectStale = false
  if (asset.value && asset.value.type === 'db' && asset.value.config.dbType === 'redis') {
    connect()
  }
  window.addEventListener('starhub:object-selected', onObjectSelected)
  window.addEventListener('starhub:object-contextmenu', onObjectContextMenu)
  // 晚挂载兜底:树上先点了对象、视图后挂载时主动拉取一次
  const pendingSel = objectTree.takePendingSelection(assetId.value)
  if (pendingSel) applyObjectSelection(pendingSel.kind, pendingSel.payload)
})

onBeforeUnmount(() => {
  markStale()
  connecting.value = false
  window.removeEventListener('starhub:object-selected', onObjectSelected)
  window.removeEventListener('starhub:object-contextmenu', onObjectContextMenu)
})
</script>

<template>
  <div class="redis-view">
    <!-- Center -->
    <div class="redis-center">
      <!-- Header bar -->
      <div class="redis-header">
        <div class="connection-card">
          <ProductIcon product="redis" :size="18" />
          <span class="conn-name">{{ asset?.name || '...' }}</span>
          <span class="cyber-badge">db{{ currentDb }}</span>
          <span class="key-count">{{ dbsize.toLocaleString() }} keys</span>
        </div>
        <div class="header-actions">
          <button
            class="action-btn"
            :title="t('redis.newKey')"
            @click="onNewKey(currentDb)"
          >
            <v-icon size="16">mdi-plus</v-icon>
          </button>
          <button
            class="action-btn"
            title="Flush DB"
            @click="onFlushDb"
          >
            <v-icon size="16">mdi-alert-octagon</v-icon>
          </button>
          <button
            class="action-btn"
            :class="{ active: rightPanelOpen }"
            title="Toggle Panel"
            @click="rightPanelOpen = !rightPanelOpen"
          >
            <v-icon size="16">mdi-panel-right</v-icon>
          </button>
        </div>
      </div>

      <div v-if="connectError" class="connection-error-card">
        <v-icon size="18">mdi-alert-circle-outline</v-icon>
        <div class="error-copy">
          <strong>Redis 连接失败</strong>
          <span>{{ connectError }}</span>
        </div>
        <button class="cyber-btn-secondary" :disabled="connecting" @click="connect">
          <v-icon size="14">mdi-refresh</v-icon>
          重试
        </button>
      </div>

      <!-- Editor area -->
      <RedisValueEditor
        v-if="connId && !connectError"
        ref="valueEditorRef"
        :conn-id="connId"
        :current-db="currentDb"
      />

      <!-- CLI panel -->
      <RedisCli
        v-if="connId && !connectError"
        :conn-id="connId"
        :current-db="currentDb"
      />
    </div>

    <!-- Right Panel -->
    <RightPanel
      v-model="rightPanelOpen"
      v-model:active-tab="activeRightTab"
      :tabs="rightPanelTabs"
    >
      <template #tab-dashboard>
        <DbDashboard
          v-if="connId"
          :conn-id="connId"
          :db-type="'redis'"
          :connected="connected"
        />
      </template>
      <template #tab-ai>
        <AiChat
          v-if="aiSession"
          :session="aiSession"
          :sending="aiSession.loading"
          placeholder="问我关于 Redis 的任何事,例如'列出所有以 user: 开头的 key'"
          @send="onAiSend"
          @retry="onAiRetry"
          @confirm-tool="onAiConfirmTool"
          @new-chat="onAiNewChat"
          @stop="onAiStop"
        />
      </template>
      <template #tab-tools>
        <RedisTools
          v-if="connId"
          :conn-id="connId"
          :current-db="currentDb"
        />
      </template>
    </RightPanel>

    <!-- 树节点右键菜单(redis-db / redis-key) -->
    <ContextMenu
      v-if="ctxMenu"
      :x="ctxMenu.x"
      :y="ctxMenu.y"
      :items="ctxMenu.items"
      @close="ctxMenu = null"
    />

    <!-- New Key Dialog -->
    <NewKeyDialog
      v-if="connId"
      v-model="showNewKey"
      :conn-id="connId"
      :current-db="newKeyDb"
      @created="onKeyCreated"
    />

    <!-- Rename Key Dialog -->
    <v-dialog v-model="showRenameKey" max-width="420">
      <div class="cyber-panel" style="padding: 0;">
        <div class="dialog-header">
          <v-icon size="16" color="var(--cyan)">mdi-rename-outline</v-icon>
          <span class="dialog-title">重命名 Key</span>
          <v-spacer />
          <button class="action-btn" @click="showRenameKey = false">
            <v-icon size="16">mdi-close</v-icon>
          </button>
        </div>
        <div style="padding: 16px;">
          <div style="font-size: 12px; color: var(--muted); margin-bottom: 8px;">
            {{ renameKeyOld }} → {{ renameKeyNew || '...' }}
          </div>
          <input v-model="renameKeyNew" class="cyber-input" placeholder="新 Key 名" autofocus @keydown.enter="doRenameKey()" />
        </div>
        <div class="dialog-footer">
          <button class="cyber-btn-secondary" @click="showRenameKey = false">取消</button>
          <button class="cyber-btn" :disabled="!renameKeyNew.trim() || renameKeyNew === renameKeyOld" @click="doRenameKey()">
            <v-icon size="14">mdi-check</v-icon> 确认
          </button>
        </div>
      </div>
    </v-dialog>
  </div>
</template>

<style scoped>
.redis-view {
  display: flex;
  height: 100%;
  overflow: hidden;
}

.redis-center {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
}

.redis-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 16px;
  border-bottom: 1px solid var(--line);
  flex-shrink: 0;
}

.conn-name {
  font-weight: 600;
}

.key-count {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  color: var(--muted);
}

.connection-card {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

/* 对话框样式 */
.dialog-header {
  display: flex; align-items: center; gap: 8px;
  padding: 12px 16px; border-bottom: 1px solid var(--line); flex-shrink: 0;
}
.dialog-title { font-weight: 600; font-size: 14px; color: var(--text); }
.dialog-footer {
  display: flex; justify-content: flex-end; gap: 8px;
  padding: 10px 16px; border-top: 1px solid var(--line); flex-shrink: 0;
}
</style>
