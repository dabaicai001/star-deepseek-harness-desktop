<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { useAssetStore } from '@/stores/asset'
import { useDbStore } from '@/stores/db'
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

const { t } = useI18n()
const route = useRoute()
const assetStore = useAssetStore()
const dbStore = useDbStore()
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
    dbsize.value = (await dbService.redisDBSize(connId.value)).size
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
  if (!confirm(`FLUSHDB — This will delete ALL keys in db${currentDb.value}. Continue?`)) return
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
      :tabs="rightPanelTabs"
      default-tab="dashboard"
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
          :sending="false"
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
