<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { useAssetStore } from '@/stores/asset'
import { useDbStore } from '@/stores/db'
import { useAiStore } from '@/stores/ai'
import { useAppStore } from '@/stores/app'
import { parseInstanceId } from '@/utils/tabId'
import * as dbService from '@/services/db'
import { useDialogStore } from '@/stores/dialog'
import { REDIS_SYSTEM_PROMPT, redisTools, makeRedisToolCaller } from '@/utils/aiTools'
import type { LlmToolCall } from '@/services/ai'
import KeyBrowser from '@/components/redis/KeyBrowser.vue'
import RedisValueEditor from '@/components/redis/RedisValueEditor.vue'
import RedisCli from '@/components/redis/RedisCli.vue'
import RedisTools from '@/components/redis/RedisTools.vue'
import RightPanel from '@/components/layout/RightPanel.vue'
import DbDashboard from '@/components/dashboard/DbDashboard.vue'
import AiChat from '@/components/ai/AiChat.vue'
import type { RightPanelTab } from '@/components/layout/RightPanel.vue'

const { t } = useI18n()
const route = useRoute()
const assetStore = useAssetStore()
const dbStore = useDbStore()
const aiStore = useAiStore()
const appStore = useAppStore()
const dlg = useDialogStore()

const instanceId = computed(() => route.params.id as string)
const assetId = computed(() => parseInstanceId(instanceId.value).assetId)
const asset = computed(() => assetStore.assets.find(a => a.id === assetId.value))

const connected = ref(false)
const connecting = ref(false)
const connId = ref<string | null>(null)
const currentDb = ref(0)
const dbsize = ref(0)
const dbSizes = ref<Record<number, number>>({})

const keyBrowserRef = ref<InstanceType<typeof KeyBrowser> | null>(null)
const valueEditorRef = ref<InstanceType<typeof RedisValueEditor> | null>(null)

const rightPanelTabs: RightPanelTab[] = [
  { key: 'dashboard', label: 'Dashboard', icon: 'mdi-view-dashboard' },
  { key: 'ai', label: 'AI', icon: 'mdi-robot' },
  { key: 'tools', label: 'Tools', icon: 'mdi-tools' },
]

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
  aiSession.value.messages.push({ role: 'user', content: text })

  const confirmFn: import('@/utils/aiTools').ToolConfirmFn = async (ctx) => {
    const session = aiSession.value!
    const running = [...session.toolCalls].reverse().find(t => t.status === 'running' || t.status === 'awaiting-confirm')
    const recordId = running?.id || `pending-${Date.now()}`
    if (running) {
      running.status = 'awaiting-confirm'
      running.result = ctx.message
    } else {
      session.toolCalls.push({
        id: recordId, name: ctx.toolName, args: ctx.args,
        status: 'awaiting-confirm', result: ctx.message, startedAt: Date.now()
      })
    }
    return new Promise<boolean>((resolve) => {
      redisPendingConfirms.value.set(recordId, resolve)
    })
  }

  const caller = makeRedisToolCaller(
    executeRedisCmd,
    () => aiStore.settings.commandWhitelist,
    confirmFn
  )
  const toolExec = async (call: LlmToolCall) =>
    await caller({ function: { name: call.function.name, arguments: call.function.arguments } })
  const sysPrompt = REDIS_SYSTEM_PROMPT.replace('db0', `db${currentDb.value}`)
  await aiStore.runAgent(instanceId.value, redisTools, toolExec, sysPrompt)
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

async function connect() {
  if (!asset.value || connected.value) return
  connecting.value = true
  try {
    const config = asset.value.config
    const session = await dbStore.connectRedis(assetId.value, asset.value.name, {
      host: config.host || '',
      port: config.port || 6379,
      password: config.password,
      db: 0,
      ssl: config.ssl
    })
    connId.value = session.connId
    connected.value = true
    await refreshDBSize()
    await refreshAllDBSizes()
  } catch (err) {
    console.error('Redis connect failed:', err)
  } finally {
    connecting.value = false
  }
}

async function refreshDBSize() {
  if (!connId.value) return
  try {
    dbsize.value = (await dbService.redisDBSize(connId.value)).size
  } catch { /* ignore */ }
}

async function refreshAllDBSizes() {
  if (!connId.value) return
  try {
    const raw = await dbService.redisInfo(connId.value, 'keyspace')
    const sizes: Record<number, number> = {}
    for (const line of raw.split('\n')) {
      const m = line.match(/^db(\d+):keys=(\d+)/)
      if (m) {
        sizes[Number(m[1])] = Number(m[2])
      }
    }
    dbSizes.value = sizes
  } catch { /* ignore */ }
}

function getDbSize(db: number): number {
  return dbSizes.value[db] ?? -1
}

async function onSwitchDb(db: number) {
  if (!connId.value) return
  try {
    await dbService.redisSelect(connId.value, db)
    currentDb.value = db
    await refreshDBSize()
    await refreshAllDBSizes()
  } catch (err) {
    console.error('Switch DB failed:', err)
  }
}

async function onDeleteKey(key: string) {
  if (!connId.value) return
  try {
    await dbService.redisDel(connId.value, [key])
    await refreshDBSize()
    await refreshAllDBSizes()
    keyBrowserRef.value?.loadKeys()
  } catch (err) {
    console.error('Delete key failed:', err)
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
    keyBrowserRef.value?.loadKeys()
  } catch (err) {
    console.error('Flush DB failed:', err)
  }
}

onMounted(() => {
  if (asset.value && asset.value.type === 'db' && asset.value.config.dbType === 'redis') {
    connect()
  }
})

watch(() => assetId.value, () => {
  if (asset.value && !connected.value) connect()
})
</script>

<template>
  <div class="redis-view">
    <!-- Left: Key Browser -->
    <KeyBrowser
      v-if="connId"
      ref="keyBrowserRef"
      :conn-id="connId"
      :current-db="currentDb"
      :total-keys="dbsize"
      :db-sizes="dbSizes"
      @select-key="onSelectKey"
      @delete-key="onDeleteKey"
      @switch-db="onSwitchDb"
    />

    <!-- Center -->
    <div class="redis-center">
      <!-- Header bar -->
      <div class="redis-header">
        <div class="connection-card">
          <v-icon size="18" color="cyan">mdi-database</v-icon>
          <span class="conn-name">{{ asset?.name || '...' }}</span>
          <span class="cyber-badge">db{{ currentDb }}</span>
          <span class="key-count">{{ dbsize.toLocaleString() }} keys</span>
        </div>
        <div class="header-actions">
          <button
            class="action-btn"
            title="Flush DB"
            @click="onFlushDb"
          >
            <v-icon size="16">mdi-alert-octagon</v-icon>
          </button>
          <button
            class="action-btn"
            :class="{ active: appStore.rightPanelOpen }"
            title="Toggle Panel"
            @click="appStore.toggleRightPanel()"
          >
            <v-icon size="16">mdi-panel-right</v-icon>
          </button>
        </div>
      </div>

      <!-- Editor area -->
      <RedisValueEditor
        v-if="connId"
        ref="valueEditorRef"
        :conn-id="connId"
        :current-db="currentDb"
      />

      <!-- CLI panel -->
      <RedisCli
        v-if="connId"
        :conn-id="connId"
        :current-db="currentDb"
      />
    </div>

    <!-- Right Panel -->
    <RightPanel
      v-model="appStore.rightPanelOpen"
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
</style>
