<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { useAssetStore } from '@/stores/asset'
import { useDbStore } from '@/stores/db'
import { useAppStore } from '@/stores/app'
import { useAiStore } from '@/stores/ai'
import { parseInstanceId } from '@/utils/tabId'
import * as dbService from '@/services/db'
import KeyBrowser from '@/components/redis/KeyBrowser.vue'
import RedisValueEditor from '@/components/redis/RedisValueEditor.vue'
import RedisCli from '@/components/redis/RedisCli.vue'
import RedisTools from '@/components/redis/RedisTools.vue'
import RightPanel from '@/components/layout/RightPanel.vue'
import DbDashboard from '@/components/dashboard/DbDashboard.vue'
import AiChat from '@/components/ai/AiChat.vue'
import type { RightPanelTab } from '@/components/layout/RightPanel.vue'
import { redisTools, makeRedisToolCaller } from '@/utils/aiTools'
import type { LlmToolCall } from '@/services/ai'

const { t } = useI18n()
const route = useRoute()
const assetStore = useAssetStore()
const dbStore = useDbStore()
const appStore = useAppStore()
const aiStore = useAiStore()

const instanceId = computed(() => route.params.id as string)
const assetId = computed(() => parseInstanceId(instanceId.value).assetId)
const asset = computed(() => assetStore.assets.find(a => a.id === assetId.value))

const connected = ref(false)
const connecting = ref(false)
const connId = ref<string | null>(null)
const currentDb = ref(0)
const dbsize = ref(0)
const rightPanelOpen = ref(false)

const keyBrowserRef = ref<InstanceType<typeof KeyBrowser> | null>(null)
const valueEditorRef = ref<InstanceType<typeof RedisValueEditor> | null>(null)

const rightPanelTabs = computed<RightPanelTab[]>(() => [
  { key: 'dashboard', label: t('redis.dashboard', '仪表盘'), icon: 'mdi-view-dashboard-outline' },
  { key: 'ai', label: t('redis.ai', 'AI 助手'), icon: 'mdi-robot-outline' },
  { key: 'tools', label: t('redis.tools', '工具'), icon: 'mdi-tools' }
])

const activeRightTab = ref('dashboard')

const aiSession = computed(() => {
  if (!asset.value) return null
  return aiStore.getOrCreateSession(instanceId.value, asset.value.id, 'db')
})

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
  } catch (err) {
    console.error('Redis connect failed:', err)
  } finally {
    connecting.value = false
  }
}

async function refreshDBSize() {
  if (!connId.value) return
  try {
    const result = await dbService.redisDBSize(connId.value)
    dbsize.value = result.size
  } catch { /* ignore */ }
}

async function onSwitchDb(db: number) {
  if (!connId.value) return
  try {
    await dbService.redisSelect(connId.value, db)
    currentDb.value = db
    await refreshDBSize()
  } catch (err) {
    console.error('Switch DB failed:', err)
  }
}

async function onDeleteKey(key: string) {
  if (!connId.value) return
  try {
    await dbService.redisDel(connId.value, [key])
    await refreshDBSize()
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
  if (!confirm(t('redis.flushConfirm', '确定要清空当前数据库 db{0} 吗?此操作不可撤销。', [currentDb.value]))) return
  try {
    await dbService.redisFlushDB(connId.value)
    dbsize.value = 0
    keyBrowserRef.value?.loadKeys()
  } catch (err) {
    console.error('Flush DB failed:', err)
  }
}

// AI event handlers
async function onAiSend(text: string) {
  if (!aiSession.value || !connId.value) return
  aiSession.value.messages.push({ role: 'user', content: text })
  try {
    const session = aiSession.value!
    session.loading = true
    session.error = null
    const systemPrompt = '你是一个 Redis 数据库助手。当前连接: ' + asset.value?.name
    const runner = makeRedisToolCaller(connId.value)
    await aiStore.runAgent(session.instanceId, systemPrompt, redisTools, runner)
  } catch (err) {
    if (aiSession.value) aiSession.value.error = String(err ?? '')
  } finally {
    if (aiSession.value) aiSession.value.loading = false
  }
}

function onAiRetry() {
  if (!aiSession.value) return
  const msgs = aiSession.value.messages
  const lastUser = [...msgs].reverse().find(m => m.role === 'user')
  if (lastUser) {
    msgs.splice(msgs.indexOf(lastUser) + 1)
    aiSession.value.error = null
    onAiSend(lastUser.content)
  }
}

function onAiConfirmTool(recordId: string, decision: 'approve' | 'reject' | 'whitelist') {
  if (!aiSession.value) return
  aiStore.resolveConfirm(aiSession.value.instanceId, recordId, decision)
}

function onAiNewChat() {
  if (!instanceId.value) return
  aiStore.clearSession(instanceId.value)
}

function onAiStop() {
  if (!instanceId.value) return
  aiStore.stopAgent(instanceId.value)
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
            :class="{ active: rightPanelOpen }"
            title="Toggle Panel"
            @click="rightPanelOpen = !rightPanelOpen"
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
      v-model="rightPanelOpen"
      v-model:active-tab="activeRightTab"
      :tabs="rightPanelTabs"
      default-tab="dashboard"
    >
      <template #tab-dashboard>
        <DbDashboard
          :conn-id="connId || ''"
          :db-type="'redis'"
          :connected="connected"
        />
      </template>
      <template #tab-ai>
        <AiChat
          v-if="aiSession"
          :session="aiSession"
          :sending="aiSession.loading"
          :placeholder="t('redis.aiPlaceholder', '问我关于这个 Redis 的任何事…')"
          @send="onAiSend"
          @retry="onAiRetry"
          @confirm-tool="onAiConfirmTool"
          @new-chat="onAiNewChat"
          @stop="onAiStop"
        />
      </template>
      <template #tab-tools>
        <RedisTools
          :conn-id="connId || ''"
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

.action-btn {
  width: 28px;
  height: 28px;
  border-radius: 6px;
  border: 1px solid var(--line-2);
  background: transparent;
  color: var(--text-2);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s;
}

.action-btn:hover {
  border-color: var(--cyan);
  color: var(--cyan);
}

.action-btn.active {
  border-color: var(--cyan);
  color: var(--cyan);
  background: rgba(0, 240, 255, 0.08);
}
</style>
