<script setup lang="ts">
/**
 * embed 模式(dsh 壳 iframe)的连接上下文头部(方案第 3 章 3.1)。
 *
 * 资产名 + 类型徽标 + 子标题 + 连接状态(未连接/连接中/已连接/错误)+
 * 一键连接/断开 + 资产切换 + 内联新建连接(不再跳设置)。
 * 连接状态经 postMessage 协议与功能页视图同步:视图上报
 * `starhub-embed-conn-state`,资产条展示状态点;资产条发
 * `starhub-embed-conn-action` 请求,视图监听执行。
 */
import { computed, onBeforeUnmount, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import ContextMenu, { type MenuItem } from '@/components/common/ContextMenu.vue'
import NewConnectionDialog from '@/components/common/NewConnectionDialog.vue'
import { useAssetStore } from '@/stores/asset'
import {
  embedSectionForRoute, embedSectionMatchAsset, onConnState,
  postConnAction, postEmbedOpenSection, type EmbedConnState,
} from '@/lib/embed'
import { parseInstanceId, generateInstanceId } from '@/utils/tabId'
import type { Asset, CreateAssetDto } from '@/types/asset'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const assetStore = useAssetStore()

/** 当前路由对应的 embed 段;null = 非功能页或无资产型页面(设置等),整条不渲染 */
const section = computed(() => {
  const s = embedSectionForRoute(route)
  return s?.routeName ? s : null
})

/** 该段的候选资产(最近使用优先) */
const candidates = computed<Asset[]>(() => {
  const s = section.value
  if (!s) return []
  return assetStore.assets
    .filter(a => embedSectionMatchAsset(s, a))
    .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))
})

/** 当前路由 instanceId 对应的资产(段空态页没有 params.id,为 null) */
const currentAsset = computed<Asset | null>(() => {
  const raw = route.params.id
  const assetId = parseInstanceId(typeof raw === 'string' ? raw : '').assetId
  if (!assetId) return null
  return candidates.value.find(a => a.id === assetId) ?? null
})

/** 当前资产副标题(user@host 等,取最常用字段,没有就不显示) */
const currentSubtitle = computed(() => {
  const a = currentAsset.value
  if (!a) return ''
  const c = a.config
  const host = typeof c.host === 'string' ? c.host : ''
  const username = typeof c.username === 'string' ? c.username : ''
  if (host && username) return `${username}@${host}`
  return host || (typeof c.database === 'string' ? c.database : '')
})

/** 类型徽标文案:db 按 dbType 细分(复用 getDbLabel 缩写约定) */
function assetTypeLabel(asset: Asset): string {
  if (asset.type === 'db') return getDbLabel(asset.config.dbType)
  return asset.type.toUpperCase()
}

/** getDbLabel 本地实现(避免依赖视图侧工具时循环引用) */
function getDbLabel(dbType?: string): string {
  switch (dbType) {
    case 'redis': return 'REDIS'
    case 'postgresql': return 'PG'
    case 'sqlite': return 'SQLT'
    case 'elasticsearch': return 'ES'
    case 'clickhouse': return 'CH'
    case 'mssql': return 'MSSQL'
    case 'kafka': return 'KAFKA'
    case 'nsq': return 'NSQ'
    case 'mysql':
    default: return 'MYSQL'
  }
}

// ====== 连接状态(方案 3.1:postMessage 桥)======
/** 当前资产 id(instanceId 反解;段空态页为 '') */
const currentAssetId = computed(() => currentAsset.value?.id ?? '')
const connState = ref<EmbedConnState>('disconnected')
const connReason = ref('')
let offConnState: (() => void) | null = null

onBeforeUnmount(() => { offConnState?.() })

// 监听视图上报状态;切资产后旧上报自然失效(比对 assetId)
if (typeof window !== 'undefined') {
  offConnState = onConnState((msg) => {
    if (msg.assetId !== currentAssetId.value) return
    connState.value = msg.state
    connReason.value = msg.reason ?? ''
  })
}

/** 请求视图连接/断开 */
function requestConn(action: 'connect' | 'disconnect') {
  if (!currentAsset.value) return
  postConnAction(currentAsset.value.id, action)
  connState.value = action === 'connect' ? 'connecting' : 'disconnected'
}

// ====== 资产下拉 ======
const menu = ref<{ x: number; y: number; items: MenuItem[] } | null>(null)

function closeMenu() {
  menu.value = null
}

function openMenu(e: MouseEvent) {
  const s = section.value
  if (!s) return
  const target = e.currentTarget as HTMLElement
  const rect = target.getBoundingClientRect()
  const items: MenuItem[] = [
    { type: 'header', icon: s.icon, label: t('embed.assetBar.sectionAssets') },
    ...candidates.value.map(a => ({
      type: 'item' as const,
      icon: s.icon,
      label: a.name,
      checked: a.id === currentAsset.value?.id,
      onClick: () => switchAsset(a),
    })),
    { type: 'divider' },
    {
      type: 'item',
      icon: 'mdi-plus',
      label: t('embed.assetBar.newConnection'),
      onClick: () => { showNewDialog.value = true },
    },
    {
      type: 'item',
      icon: 'mdi-cog-outline',
      label: t('embed.assetBar.goSettings'),
      onClick: () => postEmbedOpenSection('settings'),
    },
  ]
  menu.value = { x: rect.left, y: rect.bottom + 4, items }
}

/** 切换资产:同段路由换一个 instanceId(= 新会话),组件整体重挂;重置状态显示 */
function switchAsset(asset: Asset) {
  const s = section.value
  if (!s?.routeName || asset.id === currentAsset.value?.id) return
  assetStore.updateAsset(asset.id, { lastUsedAt: Date.now() }).catch(() => {})
  connState.value = 'disconnected'
  connReason.value = ''
  router.replace({ name: s.routeName, params: { id: generateInstanceId(asset.id) } }).catch(() => {})
}

// ====== 内联新建连接(方案 3.1:不再跳设置)======
const showNewDialog = ref(false)

async function onCreateAsset(dto: CreateAssetDto) {
  try {
    await assetStore.createAsset(dto)
    showNewDialog.value = false
    // 新建后如果当前段还是空态,直接切到新资产
    const created = assetStore.assets.find(a => a.name === dto.name && a.config === dto.config)
    if (created && !currentAsset.value) {
      const s = section.value
      if (s?.routeName) {
        router.replace({ name: s.routeName, params: { id: generateInstanceId(created.id) } }).catch(() => {})
      }
    }
  } catch (err) {
    // 保持对话框打开让用户修正;错误由对话框侧提示
    void err
  }
}
</script>

<template>
  <div v-if="section" class="cyber-embed-bar">
    <v-icon size="13" class="cyber-embed-bar-icon">{{ section.icon }}</v-icon>
    <button
      class="cyber-embed-bar-current"
      :disabled="candidates.length === 0"
      @click="openMenu"
    >
      <span v-if="currentAsset" class="cyber-embed-badge">{{ assetTypeLabel(currentAsset) }}</span>
      <span class="cyber-embed-bar-name">
        {{ currentAsset?.name ?? t('embed.assetBar.noAsset') }}
      </span>
      <v-icon v-if="candidates.length > 0" size="11">mdi-chevron-down</v-icon>
    </button>
    <span v-if="currentSubtitle" class="cyber-embed-bar-sub">{{ currentSubtitle }}</span>
    <span class="cyber-embed-bar-spacer" />
    <!-- 连接状态点 + 一键连接/断开(方案 3.1) -->
    <template v-if="currentAsset">
      <span
        class="cyber-embed-conn"
        :class="`conn-${connState}`"
        :title="connState === 'error' ? connReason : t(`embed.assetBar.state.${connState}`)"
      >
        <span class="cyber-embed-conn-dot" />
        {{ t(`embed.assetBar.state.${connState}`) }}
      </span>
      <button
        v-if="connState === 'connected'"
        class="cyber-embed-bar-action"
        @click="requestConn('disconnect')"
      >
        <v-icon size="12">mdi-power</v-icon>
        <span>{{ t('embed.assetBar.disconnect') }}</span>
      </button>
      <button
        v-else
        class="cyber-embed-bar-action"
        :disabled="connState === 'connecting'"
        @click="requestConn('connect')"
      >
        <v-icon size="12">mdi-power</v-icon>
        <span>{{ connState === 'connecting' ? t('embed.assetBar.connecting') : t('embed.assetBar.connect') }}</span>
      </button>
    </template>
    <button
      v-if="candidates.length === 0"
      class="cyber-embed-bar-action"
      @click="showNewDialog = true"
    >
      <v-icon size="12">mdi-plus</v-icon>
      <span>{{ t('embed.assetBar.newConnection') }}</span>
    </button>
    <ContextMenu
      v-if="menu"
      :x="menu.x"
      :y="menu.y"
      :items="menu.items"
      @close="closeMenu"
    />
    <!-- 内联新建连接(方案 3.1:不再跳设置) -->
    <NewConnectionDialog
      v-model="showNewDialog"
      :initial-type="section ? sectionToAssetType(section.key) : undefined"
      @submit="onCreateAsset"
    />
  </div>
</template>

<script lang="ts">
/** 段 key → 资产类型(NewConnectionDialog 的 initialType) */
function sectionToAssetType(key: string): 'ssh' | 'db' | 'docker' | undefined {
  if (key === 'terminal') return 'ssh'
  if (key === 'database' || key === 'redis' || key === 'elasticsearch'
    || key === 'clickhouse' || key === 'postgresql') return 'db'
  if (key === 'docker') return 'docker'
  return undefined
}
</script>
