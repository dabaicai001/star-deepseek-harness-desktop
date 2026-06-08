<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useAssetStore } from '@/stores/asset'
import { useAppStore } from '@/stores/app'
import { useNotifyStore } from '@/stores/notify'
import ContextMenu, { type MenuItem } from '@/components/common/ContextMenu.vue'
import NewConnectionDialog from '@/components/common/NewConnectionDialog.vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'
import { generateInstanceId } from '@/utils/tabId'
import type { Asset, CreateAssetDto } from '@/types/asset'

const { t } = useI18n()
const router = useRouter()
const assetStore = useAssetStore()
const appStore = useAppStore()
const notifyStore = useNotifyStore()
const isCollapsed = computed(() => !appStore.sidebarOpen)

/**
 * 折叠态拦截:点击图标先展开 sidebar,让用户能"看到名字再确认"。
 * 返回 true 表示"已展开 + 拦截了点击,不要再走原动作",false 表示正常路径。
 */
function expandIfCollapsed(): boolean {
  if (!isCollapsed.value) return false
  appStore.sidebarOpen = true
  return true
}

const emit = defineEmits<{
  'new-connection': []
}>()

const sshAssets = computed(() =>
  assetStore.filteredAssets.filter(a => a.type === 'ssh' && !a.favorite)
)
const dbAssets = computed(() =>
  assetStore.filteredAssets.filter(a => a.type === 'db' && !a.favorite)
)
const dockerAssets = computed(() =>
  assetStore.filteredAssets.filter(a => a.type === 'docker' && !a.favorite)
)

function getIcon(type: string) {
  switch (type) {
    case 'ssh': return 'mdi-console'
    case 'db': return 'mdi-database-outline'
    case 'docker': return 'mdi-docker'
    default: return 'mdi-file-outline'
  }
}

function getStatus(asset: Asset): 'never' | 'recent' | 'stale' {
  // 区分三种状态,比单纯 online/offline 表达更多信息:
  //  - never:  从未连接过(灰,无光晕)
  //  - recent: 最近 30 分钟用过(绿,脉冲)
  //  - stale:  之前用过但超 30 分钟(绿,无脉冲)
  if (!asset.lastUsedAt) return 'never'
  const minutesAgo = (Date.now() - asset.lastUsedAt) / 60000
  return minutesAgo < 30 ? 'recent' : 'stale'
}

/** 紧凑时间标签:刚刚 / 5m / 2h / 昨天 / 3d / 12-25 */
function shortTimeAgo(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m`
  if (diff < 86_400_000) return `${Math.floor(diff / 3600_000)}h`
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d`
  const d = new Date(ts)
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function isActive(asset: Asset) {
  const activeTab = appStore.tabs.find(t => t.id === appStore.activeTab)
  return activeTab?.assetId === asset.id
}

function connectToAsset(asset: Asset) {
  // 折叠态:点击图标等同于"展开 sidebar + 连接",让用户立刻看到反馈
  if (isCollapsed.value) appStore.sidebarOpen = true
  if (asset.type === 'docker') {
    // Docker 当前是单视图,走主页的 quick action / 头像菜单入口;侧边栏点击不响应
    return
  }
  // SSH / DB:单击 = 总是新开 tab(不复用)
  const instanceId = generateInstanceId(asset.id)
  appStore.addTab({
    id: instanceId,
    assetId: asset.id,
    title: asset.name,
    type: asset.type
  })
  assetStore.updateAsset(asset.id, { lastUsedAt: Date.now() })
  if (asset.type === 'ssh') {
    router.push({ name: 'ssh-terminal', params: { id: instanceId } })
  } else if (asset.type === 'db') {
    const dbType = asset.config.dbType || 'mysql'
    router.push({ name: dbType === 'redis' ? 'db-redis' : 'db-mysql', params: { id: instanceId } })
  }
}

// "在新标签页中打开"——每次创建新 tab，支持同一资产多实例
// 支持 SSH / DB;Docker 当前是单视图(后端按 host 串流复用同一 session),先 disabled。
function openInNewTab(asset: Asset) {
  if (asset.type === 'docker') return
  const instanceId = generateInstanceId(asset.id)
  appStore.addTab({ id: instanceId, assetId: asset.id, title: asset.name, type: asset.type })
  assetStore.updateAsset(asset.id, { lastUsedAt: Date.now() })
  if (asset.type === 'ssh') {
    router.push({ name: 'ssh-terminal', params: { id: instanceId } })
  } else if (asset.type === 'db') {
    const dbType = asset.config.dbType || 'mysql'
    router.push({ name: dbType === 'redis' ? 'db-redis' : 'db-mysql', params: { id: instanceId } })
  }
}

function reconnectToAsset(asset: Asset) {
  if (asset.type !== 'ssh') return
  // 关闭该资产的所有 tab,重新发起
  const tabsToRemove = appStore.tabs.filter(t => t.assetId === asset.id)
  for (const tab of tabsToRemove) {
    appStore.removeTab(tab.id)
  }
  connectToAsset(asset)
}

// ====== 右键菜单 ======
const ctxMenu = ref<{ x: number; y: number; asset: Asset } | null>(null)
const ctxItems = computed<MenuItem[]>(() => {
  if (!ctxMenu.value) return []
  const asset = ctxMenu.value.asset
  return [
    { type: 'header', icon: getIcon(asset.type), label: asset.name },
    {
      type: 'item',
      icon: 'mdi-connection',
      label: t('asset.connect'),
      shortcut: 'Enter',
      onClick: () => connectToAsset(asset)
    },
    {
      type: 'item',
      icon: 'mdi-tab-plus',
      label: t('asset.openInNewTab') || '在新标签页中打开',
      // 仅 SSH / DB 支持开新标签页(Docker 当前只有一个视图)
      disabled: asset.type === 'docker',
      onClick: () => openInNewTab(asset)
    },
    {
      type: 'item',
      icon: 'mdi-restart',
      label: t('asset.reconnect'),
      disabled: asset.type !== 'ssh',
      onClick: () => reconnectToAsset(asset)
    },
    { type: 'divider' },
    {
      type: 'item',
      icon: 'mdi-pencil-outline',
      label: t('asset.edit'),
      shortcut: 'F2',
      onClick: () => openEditDialog(asset)
    },
    {
      type: 'item',
      icon: 'mdi-content-duplicate',
      label: t('asset.duplicate'),
      onClick: () => duplicateAsset(asset)
    },
    {
      type: 'item',
      icon: asset.favorite ? 'mdi-star-off-outline' : 'mdi-star-outline',
      label: asset.favorite ? t('asset.unfavorite') : t('asset.favorite'),
      onClick: () => assetStore.toggleFavorite(asset.id)
    },
    { type: 'divider' },
    {
      type: 'item',
      icon: 'mdi-delete-outline',
      label: t('asset.delete'),
      shortcut: 'Del',
      danger: true,
      onClick: () => openDeleteConfirm(asset)
    }
  ]
})

function openContextMenu(e: MouseEvent, asset: Asset) {
  e.preventDefault()
  // 折叠态:先展开 sidebar 再弹菜单,让用户看到完整资产名
  if (isCollapsed.value) appStore.sidebarOpen = true
  ctxMenu.value = { x: e.clientX, y: e.clientY, asset }
}

function closeContextMenu() {
  ctxMenu.value = null
}

// ====== 编辑 dialog ======
const editTarget = ref<Asset | null>(null)
const showEditDialog = ref(false)

function openEditDialog(asset: Asset) {
  editTarget.value = asset
  showEditDialog.value = true
}

function handleEdit({ id, dto }: { id: string; dto: CreateAssetDto }) {
  assetStore.updateAsset(id, {
    name: dto.name,
    config: dto.config
  })
  showEditDialog.value = false
  editTarget.value = null
}

// ====== 删除 confirm ======
const showDeleteConfirm = ref(false)
const deleteTarget = ref<Asset | null>(null)
const deleteTyped = ref('')

function openDeleteConfirm(asset: Asset) {
  deleteTarget.value = asset
  deleteTyped.value = ''
  showDeleteConfirm.value = true
}

async function handleDelete() {
  if (!deleteTarget.value) return
  const target = deleteTarget.value
  // 关闭该资产的所有 tab
  const tabsToRemove = appStore.tabs.filter(t => t.assetId === target.id)
  const removingCurrent = tabsToRemove.some(t => t.id === router.currentRoute.value.params.id)
  for (const tab of tabsToRemove) {
    appStore.removeTab(tab.id)
  }
  // 路由回 home(如果当前路由在被关的 tab 上)
  if (removingCurrent) {
    router.push({ name: 'home' })
  }
  try {
    await assetStore.deleteAsset(target.id)
    showDeleteConfirm.value = false
    deleteTarget.value = null
  } catch (error) {
    const msg = String(error)
    if (msg.includes('Asset not found')) {
      // 资产已不存在，从本地列表移除
      assetStore.assets = assetStore.assets.filter(a => a.id !== target.id)
      showDeleteConfirm.value = false
      deleteTarget.value = null
      notifyStore.notify({ message: t('asset.deleted'), color: 'success' })
    } else {
      notifyStore.notify({ message: msg, color: 'error' })
    }
  }
}

// ====== 复制 ======
async function duplicateAsset(asset: Asset) {
  const dto: CreateAssetDto = {
    type: asset.type,
    name: `${asset.name} (copy)`,
    config: { ...asset.config }
  }
  const newAsset = await assetStore.createAsset(dto)
  const instanceId = generateInstanceId(newAsset.id)
  appStore.addTab({
    id: instanceId,
    assetId: newAsset.id,
    title: newAsset.name,
    type: newAsset.type
  })
  if (newAsset.type === 'ssh') {
    router.push({ name: 'ssh-terminal', params: { id: instanceId } })
  } else if (newAsset.type === 'db') {
    const dbType = newAsset.config.dbType || 'mysql'
    router.push({ name: dbType === 'redis' ? 'db-redis' : 'db-mysql', params: { id: instanceId } })
  }
}

// ====== 键盘 ======
function onAssetKeydown(e: KeyboardEvent, asset: Asset) {
  if (e.key === 'Enter') {
    e.preventDefault()
    connectToAsset(asset)
  } else if (e.key === 'F2') {
    e.preventDefault()
    openEditDialog(asset)
  } else if (e.key === 'Delete' || e.key === 'Del') {
    e.preventDefault()
    openDeleteConfirm(asset)
  }
}

// ====== 折叠/展开分组(SSH / DB / DOCKER / 收藏) ======
// 持久化到 localStorage,这样刷新页面 / 重启 app 之后,用户折叠过的
// 分组不会被强制展开。默认全部展开,首次启动会写入 localStorage。
const GROUP_EXPAND_KEY = 'starhub.assetTree.expanded'
const GROUP_DEFAULTS: Record<string, boolean> = {
  favorite: true,
  ssh: true,
  db: true,
  docker: true
}

function loadExpanded(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(GROUP_EXPAND_KEY)
    if (!raw) return { ...GROUP_DEFAULTS }
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return { ...GROUP_DEFAULTS }
    // 用默认填充缺失 key,避免旧版数据/手工改动造成 undefined
    return { ...GROUP_DEFAULTS, ...parsed }
  } catch {
    return { ...GROUP_DEFAULTS }
  }
}

const expandedGroups = ref<Record<string, boolean>>(loadExpanded())

// deep watch:toggleGroup 是直接改子属性,ref 引用没变也能捕获
watch(expandedGroups, (v) => {
  try { localStorage.setItem(GROUP_EXPAND_KEY, JSON.stringify(v)) } catch {}
}, { deep: true })

function toggleGroup(id: string) {
  expandedGroups.value[id] = !expandedGroups.value[id]
}
function isGroupExpanded(id: string) {
  return expandedGroups.value[id] !== false  // 默认 true
}
</script>

<template>
  <div class="asset-tree" :class="{ collapsed: !appStore.sidebarOpen }">
    <!-- 收藏分组 -->
    <div v-if="assetStore.favoriteAssets.length > 0" class="tree-group favorite">
      <div
        class="tree-group-head collapsible"
        :class="{ collapsed: !isGroupExpanded('favorite') }"
        role="button"
        :aria-expanded="isGroupExpanded('favorite')"
        @click="toggleGroup('favorite')"
      >
        <v-icon class="chevron" size="12">mdi-chevron-down</v-icon>
        <v-icon class="type-icon" size="11">mdi-star</v-icon>
        <span class="label">{{ t('asset.favorite') }}</span>
        <span class="count">{{ assetStore.favoriteAssets.length }}</span>
      </div>
      <div v-show="isGroupExpanded('favorite')" class="tree-group-body">
      <div
        v-for="asset in assetStore.favoriteAssets"
        :key="asset.id"
        class="tree-item"
        :class="{ active: isActive(asset) }"
        :data-tooltip="asset.name"
        tabindex="0"
        @click="connectToAsset(asset)"
        @contextmenu="openContextMenu($event, asset)"
        @keydown="onAssetKeydown($event, asset)"
      >
        <v-icon size="13" :class="asset.type">{{ getIcon(asset.type) }}</v-icon>
        <span class="name">{{ asset.name }}</span>
        <span v-if="asset.lastUsedAt" class="last-used">{{ shortTimeAgo(asset.lastUsedAt) }}</span>
        <span class="status-dot" :class="getStatus(asset)" />
        <button
          class="action-btn"
          @click.stop="assetStore.toggleFavorite(asset.id)"
          :data-tooltip="t('asset.unfavorite')"
        >
          <v-icon size="13" color="yellow">mdi-star</v-icon>
        </button>
      </div>
      </div>
    </div>

    <div v-if="assetStore.favoriteAssets.length > 0" class="group-divider" />

    <!-- SSH 分组 -->
    <div class="tree-group ssh">
      <div
        class="tree-group-head collapsible"
        :class="{ collapsed: !isGroupExpanded('ssh') }"
        role="button"
        :aria-expanded="isGroupExpanded('ssh')"
        @click="toggleGroup('ssh')"
      >
        <v-icon class="chevron" size="12">mdi-chevron-down</v-icon>
        <v-icon class="type-icon" size="11">mdi-console</v-icon>
        <span class="label">SSH</span>
        <span class="count">{{ sshAssets.length }}</span>
      </div>
      <div v-show="isGroupExpanded('ssh')" class="tree-group-body">
      <div
        v-for="asset in sshAssets"
        :key="asset.id"
        class="tree-item"
        :class="{ active: isActive(asset) }"
        :data-tooltip="asset.name"
        tabindex="0"
        @click="connectToAsset(asset)"
        @contextmenu="openContextMenu($event, asset)"
        @keydown="onAssetKeydown($event, asset)"
      >
        <v-icon size="13" :class="asset.type">{{ getIcon(asset.type) }}</v-icon>
        <span class="name">{{ asset.name }}</span>
        <span class="status-dot" :class="getStatus(asset)" />
        <button
          class="action-btn"
          @click.stop="assetStore.toggleFavorite(asset.id)"
          :data-tooltip="t('asset.favorite')"
        >
          <v-icon size="13">mdi-star-outline</v-icon>
        </button>
      </div>
      <div v-if="sshAssets.length === 0" class="tree-empty">
        <v-icon size="11">mdi-circle-small</v-icon>
        <span>暂无 SSH 主机</span>
      </div>
      </div>
    </div>

    <!-- DB 分组 -->
    <div class="tree-group db">
      <div
        class="tree-group-head collapsible"
        :class="{ collapsed: !isGroupExpanded('db') }"
        role="button"
        :aria-expanded="isGroupExpanded('db')"
        @click="toggleGroup('db')"
      >
        <v-icon class="chevron" size="12">mdi-chevron-down</v-icon>
        <v-icon class="type-icon" size="11">mdi-database-outline</v-icon>
        <span class="label">{{ t('db.title') }}</span>
        <span class="count">{{ dbAssets.length }}</span>
      </div>
      <div v-show="isGroupExpanded('db')" class="tree-group-body">
      <div
        v-for="asset in dbAssets"
        :key="asset.id"
        class="tree-item"
        :class="{ active: isActive(asset) }"
        :data-tooltip="asset.name"
        tabindex="0"
        @click="connectToAsset(asset)"
        @contextmenu="openContextMenu($event, asset)"
        @keydown="onAssetKeydown($event, asset)"
      >
        <v-icon size="13" :class="asset.type">{{ getIcon(asset.type) }}</v-icon>
        <span class="name">{{ asset.name }}</span>
        <span class="status-dot" :class="getStatus(asset)" />
        <button
          class="action-btn"
          @click.stop="assetStore.toggleFavorite(asset.id)"
          :data-tooltip="t('asset.favorite')"
        >
          <v-icon size="13">mdi-star-outline</v-icon>
        </button>
      </div>
      <div v-if="dbAssets.length === 0" class="tree-empty">
        <v-icon size="11">mdi-circle-small</v-icon>
        <span>暂无数据库</span>
      </div>
      </div>
    </div>

    <!-- Docker 分组 -->
    <div class="tree-group docker">
      <div
        class="tree-group-head collapsible"
        :class="{ collapsed: !isGroupExpanded('docker') }"
        role="button"
        :aria-expanded="isGroupExpanded('docker')"
        @click="toggleGroup('docker')"
      >
        <v-icon class="chevron" size="12">mdi-chevron-down</v-icon>
        <v-icon class="type-icon" size="11">mdi-docker</v-icon>
        <span class="label">Docker</span>
        <span class="count">{{ dockerAssets.length }}</span>
      </div>
      <div v-show="isGroupExpanded('docker')" class="tree-group-body">
      <div
        v-for="asset in dockerAssets"
        :key="asset.id"
        class="tree-item"
        :class="{ active: isActive(asset) }"
        :data-tooltip="asset.name"
        tabindex="0"
        @click="connectToAsset(asset)"
        @contextmenu="openContextMenu($event, asset)"
        @keydown="onAssetKeydown($event, asset)"
      >
        <v-icon size="13" :class="asset.type">{{ getIcon(asset.type) }}</v-icon>
        <span class="name">{{ asset.name }}</span>
        <span class="status-dot" :class="getStatus(asset)" />
        <button
          class="action-btn"
          @click.stop="assetStore.toggleFavorite(asset.id)"
          :data-tooltip="t('asset.favorite')"
        >
          <v-icon size="13">mdi-star-outline</v-icon>
        </button>
      </div>
      <div v-if="dockerAssets.length === 0" class="tree-empty">
        <v-icon size="11">mdi-circle-small</v-icon>
        <span>暂无 Docker 主机</span>
      </div>
      </div>
    </div>

    <!-- 总空状态 -->
    <div
      v-if="assetStore.filteredAssets.length === 0"
      class="empty-state"
      style="padding: 24px 12px;"
    >
      <v-icon class="empty-state-icon" size="32">mdi-server-off</v-icon>
      <div class="empty-state-title">{{ t('asset.noConnection') }}</div>
      <div class="empty-state-desc" style="font-size: 11px;">{{ t('asset.addHint') }}</div>
      <button class="cyber-btn" style="margin-top: 12px;" @click="$emit('new-connection')">
        <v-icon size="14">mdi-plus</v-icon>
        {{ t('asset.create') }}
      </button>
    </div>
  </div>

  <!-- 右键菜单 -->
  <ContextMenu
    v-if="ctxMenu"
    :x="ctxMenu.x"
    :y="ctxMenu.y"
    :items="ctxItems"
    @close="closeContextMenu"
  />

  <!-- 编辑 dialog -->
  <NewConnectionDialog
    v-model="showEditDialog"
    :asset="editTarget"
    @update="handleEdit"
  />

  <!-- 删除确认 -->
  <ConfirmDialog
    v-model="showDeleteConfirm"
    :title="t('asset.delete')"
    :message="t('asset.confirmDelete', { name: deleteTarget?.name })"
    :confirm-text="t('asset.delete')"
    :cancel-text="t('common.cancel')"
    :require-typing="deleteTarget?.name || ''"
    v-model:typed="deleteTyped"
    danger
    @confirm="handleDelete"
  />
</template>

<style scoped>
.asset-tree {
  padding: 8px 0 16px;
  font-family: inherit;
}

/* 折叠状态 */
.asset-tree.collapsed .tree-group-head .label,
.asset-tree.collapsed .tree-group-head .count,
.asset-tree.collapsed .tree-group-head .chevron,
.asset-tree.collapsed .tree-item .name,
.asset-tree.collapsed .tree-item .status-dot,
.asset-tree.collapsed .tree-item .action-btn,
.asset-tree.collapsed .tree-empty span,
.asset-tree.collapsed .empty-state {
  display: none;
}

.asset-tree.collapsed .tree-group-head {
  justify-content: center;
  padding: 8px 0;
}

.asset-tree.collapsed .tree-item {
  justify-content: center;
  padding: 8px 0;
  border-left: none;
}

.asset-tree.collapsed .tree-item .v-icon {
  margin: 0;
}

.asset-tree.collapsed .tree-empty {
  display: none;
}

.tree-group { margin-bottom: 4px; }

.tree-group-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  font-size: 10px;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.1em;
  font-weight: 700;
}

.tree-group-head.collapsible {
  cursor: pointer;
  user-select: none;
  transition: background 0.15s;
  border-radius: 4px;
  margin: 0 6px;
  padding: 6px 8px;
}

.tree-group-head.collapsible:hover {
  background: rgba(0, 240, 255, 0.05);
  color: var(--text-2);
}

.tree-group-head .chevron {
  flex-shrink: 0;
  color: var(--muted);
  transition: transform 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  margin-right: -2px;
}

.tree-group-head.collapsed .chevron {
  transform: rotate(-90deg);
}

.tree-group-body {
  /* body 容器,无额外样式,只作为 v-show 的折叠单位 */
}

.tree-group-head .type-icon { flex-shrink: 0; }

.tree-group.ssh .tree-group-head .type-icon { color: var(--cyan); }
.tree-group.db .tree-group-head .type-icon { color: var(--purple); }
.tree-group.docker .tree-group-head .type-icon { color: var(--green); }
.tree-group.favorite .tree-group-head .type-icon { color: var(--yellow); }

.tree-group-head .count {
  margin-left: auto;
  color: var(--cyan);
  font-weight: 500;
  font-family: 'JetBrains Mono', monospace;
}

.tree-item {
  padding: 6px 14px 6px 28px;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  color: var(--text-2);
  cursor: pointer;
  position: relative;
  transition: all 0.2s;
  border-left: 2px solid transparent;
  outline: none;
}

.tree-item:focus-visible {
  background: rgba(0, 240, 255, 0.05);
  box-shadow: inset 2px 0 0 var(--cyan);
}

.tree-item:hover {
  background: rgba(0, 240, 255, 0.05);
  color: var(--text);
}

.tree-item:hover .action-btn { opacity: 1; }

.tree-item .name {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tree-item .status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}

.tree-item .status-dot.online {
  background: var(--green);
  box-shadow: 0 0 6px var(--green);
  animation: pulse 2s infinite;
}

/* 三档状态:never/recent/stale */
.tree-item .status-dot.never {
  background: transparent;
  border: 1px solid var(--muted);
  opacity: 0.5;
}
.tree-item .status-dot.recent {
  background: var(--green);
  box-shadow: 0 0 6px var(--green);
  animation: pulse 2s infinite;
}
.tree-item .status-dot.stale {
  background: var(--green);
  opacity: 0.6;
  box-shadow: 0 0 3px var(--green);
}
/* 旧名兼容 */
.tree-item .status-dot.offline {
  background: var(--muted);
  opacity: 0.5;
}

.tree-item .last-used {
  font-size: 10px;
  font-family: 'JetBrains Mono', monospace;
  color: var(--muted);
  letter-spacing: 0.02em;
  margin-left: auto;
  padding: 0 4px;
  flex-shrink: 0;
}

.tree-item .action-btn {
  width: 22px;
  height: 22px;
  border-radius: 5px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--muted);
  background: transparent;
  border: 1px solid transparent;
  cursor: pointer;
  opacity: 0;
  transition: all 0.2s;
}

.tree-item .action-btn:hover {
  background: rgba(0, 240, 255, 0.08);
  color: var(--cyan);
  border-color: var(--line-2);
}

.tree-item .v-icon.ssh { color: var(--cyan); }
.tree-item .v-icon.db { color: var(--purple); }
.tree-item .v-icon.docker { color: var(--green); }

.tree-empty {
  padding: 4px 28px;
  display: flex;
  align-items: center;
  gap: 2px;
  font-size: 11px;
  color: var(--muted);
  opacity: 0.6;
}

.group-divider {
  height: 1px;
  background: var(--line);
  margin: 8px 14px;
}

@keyframes pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.4; transform: scale(0.7); }
}
</style>
