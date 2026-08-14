<script setup lang="ts">
/**
 * embed 模式(dsh 壳 iframe)专用的顶部资产条(P3 主壳融合)。
 *
 * 仅在当前路由是「有资产类型的功能页」(或对应段空态页)时渲染:
 * 段图标 + 当前资产名下拉(切换 = router.replace 同段不同 instanceId,
 * 即新会话);无资产时给「去设置添加」入口(postMessage 让 dsh 壳切到设置页)。
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import ContextMenu, { type MenuItem } from '@/components/common/ContextMenu.vue'
import { useAssetStore } from '@/stores/asset'
import { embedSectionForRoute, embedSectionMatchAsset, postEmbedOpenSection } from '@/lib/embed'
import { parseInstanceId, generateInstanceId } from '@/utils/tabId'
import type { Asset } from '@/types/asset'

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
      label: t('embed.assetBar.goSettings'),
      onClick: () => postEmbedOpenSection('settings'),
    },
  ]
  menu.value = { x: rect.left, y: rect.bottom + 4, items }
}

/** 切换资产:同段路由换一个 instanceId(= 新会话),组件整体重挂 */
function switchAsset(asset: Asset) {
  const s = section.value
  if (!s?.routeName || asset.id === currentAsset.value?.id) return
  assetStore.updateAsset(asset.id, { lastUsedAt: Date.now() }).catch(() => {})
  router.replace({ name: s.routeName, params: { id: generateInstanceId(asset.id) } }).catch(() => {})
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
      <span class="cyber-embed-bar-name">
        {{ currentAsset?.name ?? t('embed.assetBar.noAsset') }}
      </span>
      <v-icon v-if="candidates.length > 0" size="11">mdi-chevron-down</v-icon>
    </button>
    <span v-if="currentSubtitle" class="cyber-embed-bar-sub">{{ currentSubtitle }}</span>
    <span class="cyber-embed-bar-spacer" />
    <button
      v-if="candidates.length === 0"
      class="cyber-embed-bar-action"
      @click="postEmbedOpenSection('settings')"
    >
      <v-icon size="12">mdi-plus</v-icon>
      <span>{{ t('embed.assetBar.goSettings') }}</span>
    </button>
    <ContextMenu
      v-if="menu"
      :x="menu.x"
      :y="menu.y"
      :items="menu.items"
      @close="closeMenu"
    />
  </div>
</template>
