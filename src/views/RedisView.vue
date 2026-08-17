<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { useAssetStore } from '@/stores/asset'
import { useDbStore } from '@/stores/db'
import { useAppStore } from '@/stores/app'
import { useNotifyStore } from '@/stores/notify'
import { parseInstanceId } from '@/utils/tabId'
import { usePersistentPanelState } from '@/utils/panelState'
import * as dbService from '@/services/db'
import { useDialogStore } from '@/stores/dialog'
import { REDIS_SYSTEM_PROMPT } from '@/utils/aiPrompts'
import { useAiDshHost } from '@/composables/useAiDshHost'
import { useEmbedConnBridgeOnUnmount } from '@/composables/useEmbedConnBridge'
import { useObjectTreeStore, type ObjectAction, type ObjectKind } from '@/stores/objectTree'
import RedisValueEditor from '@/components/redis/RedisValueEditor.vue'
import RedisCli from '@/components/redis/RedisCli.vue'
import RedisTools from '@/components/redis/RedisTools.vue'
import NewKeyDialog from '@/components/redis/NewKeyDialog.vue'
import RightPanel from '@/components/layout/RightPanel.vue'
import DbDashboard from '@/components/dashboard/DbDashboard.vue'
import AiDshChat from '@/components/ai/AiDshChat.vue'
import type { RightPanelTab } from '@/components/layout/RightPanel.vue'
import ProductIcon from '@/components/common/ProductIcon.vue'

const { t } = useI18n()
const route = useRoute()
const assetStore = useAssetStore()
const dbStore = useDbStore()
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
/** 连接上下文头部桥的停止函数(方案 3.1) */
let stopEmbedConnBridge: (() => void) | null = null

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

// ====== AI 助手(dsh 内核;域工具经 dsh://tool-exec 桥回本面板执行,审批走 dsh 审批门) ======
const {
  blocks: aiBlocks,
  sending: aiSending,
  sendError: aiSendError,
  pendingApproval: aiPendingApproval,
  lastUsage: aiLastUsage,
  send: onAiSend,
  stop: onAiStop,
  newChat: onAiNewChat,
  resolveApproval: onAiResolveApproval
} = useAiDshHost({
  assetType: 'redis',
  assetId,
  makeSystemPrompt: () => REDIS_SYSTEM_PROMPT.replace('db0', `db${currentDb.value}`)
})

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

// ====== 树右键动作(菜单在树侧弹出,动作经双通道到达;连接就绪后才执行) ======
// redis-db:refresh / new-key / flushdb;redis-key:open / rename / delete
const queuedAction = ref<ObjectAction | null>(null)

function applyObjectAction(kind: ObjectKind, action: string, payload: Record<string, unknown>) {
  if (kind === 'redis-db') {
    const db = Number(payload.db ?? 0)
    if (action === 'refresh') void onSwitchDb(db).then(refreshObjectTree)
    else if (action === 'new-key') onNewKey(db)
    else if (action === 'flushdb') void onFlushDbFromBrowser(db)
  } else if (kind === 'redis-key') {
    const key = String(payload.key ?? '')
    const type = String(payload.type ?? '')
    if (!key) return
    if (action === 'open') onSelectKey(key, type)
    else if (action === 'rename') onRenameKey(key)
    else if (action === 'delete') void onDeleteKey(key)
  }
}

/** 连接未就绪时先缓存,connId 就绪后补执行(右键 → 自动开 tab → 连接完成 → 动作执行) */
function runObjectAction(act: ObjectAction) {
  if (!connId.value) {
    queuedAction.value = act
    return
  }
  applyObjectAction(act.kind, act.action, act.payload)
}

watch(connId, (v) => {
  if (!v || !queuedAction.value) return
  const act = queuedAction.value
  queuedAction.value = null
  applyObjectAction(act.kind, act.action, act.payload)
})

function onObjectAction(e: Event) {
  const detail = (e as CustomEvent).detail as { assetId?: string; kind?: ObjectKind; action?: string; payload?: Record<string, unknown> } | undefined
  if (!detail || detail.assetId !== assetId.value || !detail.kind || !detail.action || !detail.payload) return
  runObjectAction({ kind: detail.kind, action: detail.action, payload: detail.payload })
}

// 标签右键「断开连接」:断开本视图持有的会话并更新 connected 状态(不走 markStale,视图保持挂载可重连)
function onTabDisconnect(e: Event) {
  const detail = (e as CustomEvent).detail as { assetId?: string } | undefined
  if (!detail || detail.assetId !== assetId.value) return
  connected.value = false
  connId.value = null
  void disconnectOwnedSessions()
}

onMounted(() => {
  connectStale = false
  if (asset.value && asset.value.type === 'db' && asset.value.config.dbType === 'redis') {
    connect()
  }
  window.addEventListener('starhub:object-selected', onObjectSelected)
  window.addEventListener('starhub:object-action', onObjectAction)
  window.addEventListener('starhub:tab-disconnect', onTabDisconnect)
  // 晚挂载兜底:树上先点了对象、视图后挂载时主动拉取一次
  const pendingSel = objectTree.takePendingSelection(assetId.value)
  if (pendingSel) applyObjectSelection(pendingSel.kind, pendingSel.payload)
  const pendingAct = objectTree.takePendingAction(assetId.value)
  if (pendingAct) runObjectAction(pendingAct)

  // 连接上下文头部(方案 3.1):状态上报父帧资产条 + 监听连接/断开动作
  stopEmbedConnBridge = useEmbedConnBridgeOnUnmount({
    assetId: () => assetId.value,
    connecting: () => connecting.value,
    connected: () => connected.value,
    error: () => connectError.value,
    connect: () => connect(),
    disconnect: () => {
      connected.value = false
      connId.value = null
      void disconnectOwnedSessions()
    },
  })
})

onBeforeUnmount(() => {
  stopEmbedConnBridge?.()
  markStale()
  connecting.value = false
  window.removeEventListener('starhub:object-selected', onObjectSelected)
  window.removeEventListener('starhub:object-action', onObjectAction)
  window.removeEventListener('starhub:tab-disconnect', onTabDisconnect)
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
        <AiDshChat
          v-if="connId"
          :blocks="aiBlocks"
          :sending="aiSending"
          :send-error="aiSendError"
          :pending-approval="aiPendingApproval"
          :last-usage="aiLastUsage"
          placeholder="问我关于 Redis 的任何事,例如'列出所有以 user: 开头的 key'"
          @send="onAiSend"
          @resolve-approval="onAiResolveApproval"
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
