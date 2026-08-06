<script setup lang="ts">
import { ref, computed, onMounted, watch, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '@/stores/app'
import { useAssetStore } from '@/stores/asset'
import { useLocalViewStore, type LocalFileEntry } from '@/stores/localView'
import { useDialogStore } from '@/stores/dialog'
import { useNotifyStore } from '@/stores/notify'
import { generateInstanceId } from '@/utils/tabId'
import { invoke } from '@tauri-apps/api/core'
import DirTree from '@/components/local/DirTree.vue'
import ContextMenu, { type MenuItem } from '@/components/common/ContextMenu.vue'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const appStore = useAppStore()
const assetStore = useAssetStore()
const localStore = useLocalViewStore()
const dlg = useDialogStore()
const notify = useNotifyStore()

const props = defineProps<{ id: string }>()

// Tab 信息
const tabId = computed(() => props.id)
const tab = computed(() => appStore.tabs.find(t => t.id === tabId.value))
const asset = computed(() => {
  if (!tab.value) return undefined
  return assetStore.assets.find(a => a.id === tab.value!.assetId)
})

// 加载状态
const loading = ref(false)
const error = ref('')

// 面包屑路径段
const pathSegments = computed(() => {
  if (!localStore.currentPath) return []
  const parts = localStore.currentPath.replace(/\\/g, '/').split('/').filter(Boolean)
  if (localStore.currentPath.match(/^[A-Z]:\\/i)) {
    return [localStore.currentPath.substring(0, 3), ...parts.slice(1)]
  }
  if (localStore.currentPath.startsWith('/')) {
    return ['/', ...parts]
  }
  return parts
})

// 路径面包屑点击
function navigateToSegment(idx: number) {
  const parts = localStore.currentPath.replace(/\\/g, '/').split('/').filter(Boolean)
  const root = localStore.currentPath.match(/^[A-Z]:\\/i)
    ? localStore.currentPath.substring(0, 3)
    : localStore.currentPath.startsWith('/') ? '' : ''
  if (root && idx === 0) {
    localStore.setCurrentPath(root)
    loadDirectory(root)
    return
  }
  const segs = root ? parts.slice(0, root === '/' ? idx : idx) : parts.slice(0, idx + 1)
  const target = root ? root + '/' + segs.join('/') : '/' + segs.join('/')
  localStore.setCurrentPath(target)
  loadDirectory(target)
}

/** dirTree 当前对应的目录(面包屑/树可能把 currentPath 改成文件路径,这里单独记录) */
const listedPath = ref('')

// ====== 路径工具 ======
function normPath(p: string): string {
  const n = p.replace(/\\/g, '/')
  return n.length > 3 ? n.replace(/\/+$/, '') : n
}

/** Windows 路径大小写不敏感,其余平台保持原样比较 */
function samePath(a: string, b: string): boolean {
  const na = normPath(a)
  const nb = normPath(b)
  if (/^[A-Za-z]:\//.test(na) || /^[A-Za-z]:\//.test(nb)) {
    return na.toLowerCase() === nb.toLowerCase()
  }
  return na === nb
}

function sepOf(p: string): string {
  return p.includes('\\') && !p.includes('/') ? '\\' : '/'
}

function parentOf(p: string): string {
  const n = normPath(p)
  const idx = n.lastIndexOf('/')
  if (idx <= 0) return n
  // Windows 盘符根("C:/")不能再往上
  if (idx === 2 && /^[A-Za-z]:\//.test(n)) return n.substring(0, 3)
  return n.substring(0, idx)
}

function joinLocalPath(parent: string, name: string): string {
  const sep = sepOf(parent)
  return parent.replace(/[/\\]+$/, '') + sep + name
}

// ====== 目录读取与树维护 ======
async function listDir(dirPath: string): Promise<LocalFileEntry[]> {
  const result = await invoke<any[]>('local_list_directory', { path: dirPath, maxEntries: 200 })
  const entries: LocalFileEntry[] = result.map((e) => ({
    name: e.name,
    path: e.path,
    isDir: e.kind === 'directory' || e.is_dir || e.isDir || false,
    size: e.size || 0,
    modifiedAt: e.modified_at || e.modifiedAt || 0,
  }))
  entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return entries
}

/** 在树中按路径查找节点 */
function findEntry(entries: LocalFileEntry[], path: string): LocalFileEntry | null {
  for (const e of entries) {
    if (samePath(e.path, path)) return e
    if (e.children) {
      const hit = findEntry(e.children, path)
      if (hit) return hit
    }
  }
  return null
}

/** 查找包含指定路径节点的父列表(根列表或某个节点的 children) */
function findParentList(entries: LocalFileEntry[], path: string): LocalFileEntry[] | null {
  for (const e of entries) {
    if (samePath(e.path, path)) return entries
    if (e.children) {
      const hit = findParentList(e.children, path)
      if (hit) return hit
    }
  }
  return null
}

/** 刷新后保留已展开目录的 children 缓存(按路径匹配) */
function carryChildCache(oldEntries: LocalFileEntry[], newEntries: LocalFileEntry[]) {
  const oldMap = new Map(oldEntries.map(e => [normPath(e.path).toLowerCase(), e]))
  for (const e of newEntries) {
    const old = oldMap.get(normPath(e.path).toLowerCase())
    if (old?.children?.length) e.children = old.children
  }
}

/** 重新读取某个目录并就地更新树(根列表或子节点),不折叠已展开目录 */
async function refreshChildren(dirPath: string) {
  const children = await listDir(dirPath)
  if (samePath(dirPath, listedPath.value)) {
    carryChildCache(localStore.dirTree, children)
    localStore.setDirTree(children)
    return
  }
  const entry = findEntry(localStore.dirTree, dirPath)
  if (entry) {
    carryChildCache(entry.children ?? [], children)
    entry.children = children
  }
}

// 加载目录
async function loadDirectory(dirPath: string) {
  loading.value = true
  error.value = ''
  try {
    const entries = await listDir(dirPath)
    listedPath.value = dirPath
    localStore.setDirTree(entries)
  } catch (err: any) {
    error.value = String(err)
    console.error('Load directory failed:', err)
  } finally {
    loading.value = false
  }
}

/** 打开文本文件到编辑器 */
async function openFileInEditor(entry: LocalFileEntry) {
  try {
    const result = await invoke<any>('local_read_text_file', { path: entry.path, offset: 0, maxBytes: 1048576 })
    const content = result.content || result || ''
    localStore.openEditorTab({
      id: `editor-${entry.path}`,
      path: entry.path,
      name: entry.name,
      content,
      dirty: false,
      language: localStore.getLanguage(entry.name),
    })
  } catch (err: any) {
    notify.notify({ message: `打开文件失败: ${String(err)}`, color: 'error', timeout: 3000 })
  }
}

// 初始加载
onMounted(async () => {
  const root = asset.value?.config?.rootPath
  if (root) {
    // 导入的是单个文件时:以所在目录为工作区根,并直接打开该文件
    try {
      const info = await invoke<any>('local_stat_path', { path: root })
      if (info.kind && info.kind !== 'directory') {
        const parent = parentOf(root)
        localStore.setRootPath(parent)
        await loadDirectory(parent)
        const fileEntry: LocalFileEntry = {
          name: info.name || root.split(/[/\\]/).pop() || root,
          path: root,
          isDir: false,
          size: info.size ?? 0,
          modifiedAt: info.modifiedAt ?? info.modified_at ?? 0,
        }
        if (localStore.isExcelFile(fileEntry.name)) {
          await onOpenExcel(fileEntry)
        } else {
          await openFileInEditor(fileEntry)
        }
        return
      }
    } catch {
      // stat 失败则按目录处理,错误会在 loadDirectory 里呈现
    }
    localStore.setRootPath(root)
    await loadDirectory(root)
  } else {
    // 默认打开用户目录
    const home = await invoke<string>('local_system_info').then(
      (info: any) => info.home_dir || info.homeDir || 'C:\\Users\\Public'
    ).catch(() => 'C:\\Users\\Public')
    localStore.setRootPath(home)
    await loadDirectory(home)
  }
})

// 点击文件:打开编辑器或 Excel
async function onSelectFile(entry: LocalFileEntry) {
  if (entry.isDir) {
    localStore.setCurrentPath(entry.path)
    await loadDirectory(entry.path)
    return
  }
  if (localStore.isExcelFile(entry.name)) {
    onOpenExcel(entry)
    return
  }
  await openFileInEditor(entry)
}

// ====== 文件操作(右键菜单 + 工具栏) ======
const ctxMenu = ref<{ x: number; y: number; entry: LocalFileEntry } | null>(null)

function onEntryCtx(payload: { event: MouseEvent; entry: LocalFileEntry }) {
  ctxMenu.value = { x: payload.event.clientX, y: payload.event.clientY, entry: payload.entry }
}

function closeCtxMenu() {
  ctxMenu.value = null
}

const ctxItems = computed<MenuItem[]>(() => {
  if (!ctxMenu.value) return []
  const entry = ctxMenu.value.entry
  const items: MenuItem[] = [
    { type: 'header', icon: entry.isDir ? 'mdi-folder-outline' : getFileIcon(entry.name), label: entry.name },
    {
      type: 'item',
      icon: 'mdi-open-in-new',
      label: '打开',
      onClick: () => onSelectFile(entry)
    }
  ]
  if (!entry.isDir && localStore.isExcelFile(entry.name)) {
    items.push({
      type: 'item',
      icon: 'mdi-file-excel-outline',
      label: '用 Excel 工具打开',
      onClick: () => onOpenExcel(entry)
    })
  }
  if (entry.isDir) {
    items.push(
      { type: 'divider' },
      {
        type: 'item',
        icon: 'mdi-file-plus-outline',
        label: '新建文件',
        onClick: () => ctxNewFile(entry.path)
      },
      {
        type: 'item',
        icon: 'mdi-folder-plus-outline',
        label: '新建文件夹',
        onClick: () => ctxNewFolder(entry.path)
      },
      {
        type: 'item',
        icon: 'mdi-refresh',
        label: '刷新',
        onClick: () => refreshChildren(entry.path)
      }
    )
  }
  items.push(
    { type: 'divider' },
    {
      type: 'item',
      icon: 'mdi-pencil-outline',
      label: '重命名',
      shortcut: 'F2',
      onClick: () => ctxRename(entry)
    },
    {
      type: 'item',
      icon: 'mdi-delete-outline',
      label: '删除',
      shortcut: 'Del',
      danger: true,
      onClick: () => ctxDelete(entry)
    }
  )
  return items
})

async function ctxNewFile(dirPath: string) {
  const name = await dlg.prompt({
    message: `在 ${dirPath} 下新建文件`,
    placeholder: 'new-file.txt',
    requireNonEmpty: true,
  })
  if (!name) return
  const full = joinLocalPath(dirPath, name)
  try {
    await invoke('local_write_text_file', { path: full, content: '', createParents: false })
    await refreshChildren(dirPath)
    notify.notify({ message: `已创建 ${name}`, color: 'success', timeout: 2000 })
    await openFileInEditor({ name, path: full, isDir: false, size: 0, modifiedAt: 0 })
  } catch (err: any) {
    notify.notify({ message: `新建文件失败: ${String(err)}`, color: 'error', timeout: 3000 })
  }
}

async function ctxNewFolder(dirPath: string) {
  const name = await dlg.prompt({
    message: `在 ${dirPath} 下新建文件夹`,
    placeholder: 'new-folder',
    requireNonEmpty: true,
  })
  if (!name) return
  const full = joinLocalPath(dirPath, name)
  try {
    await invoke('local_create_directory', { path: full, recursive: true })
    await refreshChildren(dirPath)
    notify.notify({ message: `已创建文件夹 ${name}`, color: 'success', timeout: 2000 })
  } catch (err: any) {
    notify.notify({ message: `新建文件夹失败: ${String(err)}`, color: 'error', timeout: 3000 })
  }
}

/** 重命名后同步修正节点自身及后代的路径前缀 */
function rewriteEntryPaths(entry: LocalFileEntry, oldPath: string, newPath: string, newName: string) {
  entry.name = newName
  entry.path = newPath
  const walk = (e: LocalFileEntry) => {
    if (!e.children) return
    for (const child of e.children) {
      child.path = newPath + child.path.slice(oldPath.length)
      walk(child)
    }
  }
  walk(entry)
}

async function ctxRename(entry: LocalFileEntry) {
  const newName = await dlg.prompt({
    message: `重命名 ${entry.name}`,
    defaultValue: entry.name,
    requireNonEmpty: true,
  })
  if (!newName || newName === entry.name) return
  const oldPath = entry.path
  const newPath = joinLocalPath(parentOf(oldPath), newName)
  try {
    await invoke('local_move_path', { source: oldPath, destination: newPath })
  } catch (err: any) {
    notify.notify({ message: `重命名失败: ${String(err)}`, color: 'error', timeout: 3000 })
    return
  }
  rewriteEntryPaths(entry, oldPath, newPath, newName)
  // 同步编辑器 tab 与被重命名目录下的 currentPath
  for (const tab of localStore.editorTabs) {
    if (samePath(tab.path, oldPath) || normPath(tab.path).startsWith(normPath(oldPath) + '/')) {
      tab.path = newPath + tab.path.slice(oldPath.length)
      tab.id = `editor-${tab.path}`
      if (samePath(tab.path, newPath)) tab.name = newName
    }
  }
  if (samePath(localStore.currentPath, oldPath) || normPath(localStore.currentPath).startsWith(normPath(oldPath) + '/')) {
    localStore.setCurrentPath(newPath + localStore.currentPath.slice(oldPath.length))
  }
  notify.notify({ message: `已重命名为 ${newName}`, color: 'success', timeout: 2000 })
}

async function ctxDelete(entry: LocalFileEntry) {
  const ok = await dlg.confirm({
    message: entry.isDir
      ? `确定删除文件夹 ${entry.name} 吗?将递归删除其中所有内容,此操作不可恢复。`
      : `确定删除文件 ${entry.name} 吗?此操作不可恢复。`,
    confirmText: '删除',
    danger: true,
  })
  if (!ok) return
  try {
    await invoke('local_remove_path', { path: entry.path, recursive: true })
  } catch (err: any) {
    notify.notify({ message: `删除失败: ${String(err)}`, color: 'error', timeout: 3000 })
    return
  }
  // 从树中移除节点
  const list = findParentList(localStore.dirTree, entry.path)
  if (list) {
    const idx = list.findIndex(e => samePath(e.path, entry.path))
    if (idx >= 0) list.splice(idx, 1)
  }
  // 关闭指向已删除路径的编辑器 tab
  const oldPrefix = normPath(entry.path)
  for (const tab of [...localStore.editorTabs]) {
    const tp = normPath(tab.path)
    if (tp === oldPrefix || tp.startsWith(oldPrefix + '/')) {
      localStore.closeEditorTab(tab.id)
    }
  }
  notify.notify({ message: `已删除 ${entry.name}`, color: 'success', timeout: 2000 })
}

/** 工具栏:当前浏览目录下新建文件 / 文件夹、刷新 */
function toolbarNewFile() { ctxNewFile(listedPath.value || localStore.currentPath) }
function toolbarNewFolder() { ctxNewFolder(listedPath.value || localStore.currentPath) }
function toolbarRefresh() { if (listedPath.value) refreshChildren(listedPath.value) }

// Excel 文件:复用 ExcelView
async function onOpenExcel(entry: LocalFileEntry) {
  const assetName = entry.name.replace(/\.(xlsx|xls|csv)$/i, '')
  try {
    const dto = {
      type: 'excel' as const,
      name: assetName,
      config: { filePath: entry.path, format: entry.name.endsWith('.csv') ? 'csv' as const : 'xlsx' as const }
    }
    const newAsset = await assetStore.createAsset(dto)
    const instanceId = generateInstanceId(newAsset.id)
    appStore.addTab({ id: instanceId, assetId: newAsset.id, title: newAsset.name, type: 'excel' })
    router.push({ name: 'excel', params: { id: instanceId } })
  } catch (err) {
    console.error('Failed to open Excel:', err)
  }
}

// 编辑器保存
async function saveEditorTab() {
  const tab = localStore.activeEditorTab
  if (!tab) return
  try {
    await invoke('local_write_text_file', { path: tab.path, content: tab.content })
    localStore.markEditorClean(tab.id)
  } catch (err) {
    console.error('Save file failed:', err)
  }
}

// 文件图标
function getFileIcon(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase()
  switch (ext) {
    case 'xlsx': case 'xls': case 'csv': return 'mdi-file-excel-outline'
    case 'ts': case 'tsx': case 'js': case 'jsx': return 'mdi-language-typescript'
    case 'json': return 'mdi-code-json'
    case 'md': return 'mdi-language-markdown'
    case 'py': return 'mdi-language-python'
    case 'rs': return 'mdi-language-rust'
    case 'go': return 'mdi-language-go'
    case 'html': return 'mdi-language-html5'
    case 'css': case 'scss': return 'mdi-language-css3'
    case 'yaml': case 'yml': return 'mdi-cog-outline'
    case 'sql': return 'mdi-database-outline'
    case 'sh': case 'bash': case 'ps1': return 'mdi-console'
    default: return 'mdi-file-outline'
  }
}

function formatSize(bytes: number): string {
  if (!bytes) return ''
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`
}
</script>

<template>
  <div class="local-view">
    <!-- 工具栏 -->
    <div class="local-toolbar">
      <div class="local-breadcrumb">
        <v-icon size="15" color="var(--color-accent-secondary)">mdi-folder-outline</v-icon>
        <template v-for="(seg, idx) in pathSegments" :key="idx">
          <span v-if="idx > 0" class="breadcrumb-sep">/</span>
          <span
            class="breadcrumb-seg"
            :class="{ last: idx === pathSegments.length - 1 }"
            @click="navigateToSegment(idx)"
          >{{ seg }}</span>
        </template>
      </div>
      <div class="local-actions">
        <button class="action-btn" :data-tooltip="'新建文件'" @click="toolbarNewFile">
          <v-icon size="14">mdi-file-plus-outline</v-icon>
        </button>
        <button class="action-btn" :data-tooltip="'新建文件夹'" @click="toolbarNewFolder">
          <v-icon size="14">mdi-folder-plus-outline</v-icon>
        </button>
        <button class="action-btn" :data-tooltip="'刷新'" @click="toolbarRefresh">
          <v-icon size="14">mdi-refresh</v-icon>
        </button>
      </div>
    </div>

    <!-- 主内容 -->
    <div class="local-body">
      <!-- 目录树 -->
      <div class="local-sidebar">
        <div class="local-sidebar-head">
          <v-icon size="12">mdi-file-tree-outline</v-icon>
          <span>目录树</span>
        </div>
        <DirTree
          v-if="localStore.dirTree.length > 0"
          :entries="localStore.dirTree"
          :parent-path="localStore.currentPath"
          :depth="0"
          @select-file="onSelectFile"
          @open-excel="onOpenExcel"
          @ctx="onEntryCtx"
        />
        <div v-else-if="loading" class="local-empty">
          <v-icon size="18" class="mdi-spin">mdi-loading</v-icon>
          <span>加载中…</span>
        </div>
        <div v-else class="local-empty">
          <v-icon size="24">mdi-folder-open-outline</v-icon>
          <span>选择文件夹开始工作</span>
        </div>
      </div>

      <!-- 内容区 -->
      <div class="local-content">
        <!-- 编辑器 -->
        <template v-if="localStore.editorTabs.length > 0">
          <div class="local-editor-tabs">
            <div
              v-for="tab in localStore.editorTabs"
              :key="tab.id"
              class="local-editor-tab"
              :class="{ active: tab.id === localStore.activeEditorTabId }"
              @click="localStore.activeEditorTabId = tab.id"
            >
              <v-icon size="12">{{ getFileIcon(tab.name) }}</v-icon>
              <span class="tab-name">{{ tab.name }}</span>
              <span v-if="tab.dirty" class="tab-dirty">●</span>
              <button
                class="tab-close"
                @click.stop="localStore.closeEditorTab(tab.id)"
              ><v-icon size="11">mdi-close</v-icon></button>
            </div>
            <button
              v-if="localStore.activeEditorTab?.dirty"
              class="cyber-btn-secondary tab-save-btn"
              @click="saveEditorTab"
            >
              <v-icon size="12">mdi-content-save-outline</v-icon>
              保存
            </button>
          </div>
          <div v-if="localStore.activeEditorTab" class="local-editor-body">
            <textarea
              class="local-editor-textarea cyber-input"
              :value="localStore.activeEditorTab.content"
              @input="(e) => localStore.updateEditorContent(localStore.activeEditorTab!.id, (e.target as HTMLTextAreaElement).value)"
              @keydown.ctrl.s.prevent="saveEditorTab"
              @keydown.meta.s.prevent="saveEditorTab"
              spellcheck="false"
            />
          </div>
        </template>

        <!-- 文件网格 (当无编辑器 tab 时) -->
        <template v-else>
          <div class="local-file-grid">
            <div
              v-for="entry in localStore.dirTree"
              :key="entry.path"
              class="local-file-card"
              @dblclick="onSelectFile(entry)"
              @click="onSelectFile(entry)"
              @contextmenu="onEntryCtx({ event: $event, entry })"
            >
              <v-icon size="28" :color="entry.isDir ? 'var(--color-accent-secondary)' : undefined">
                {{ entry.isDir ? 'mdi-folder-outline' : getFileIcon(entry.name) }}
              </v-icon>
              <span class="file-name">{{ entry.name }}</span>
              <span v-if="!entry.isDir" class="file-size">{{ formatSize(entry.size) }}</span>
            </div>
            <div v-if="localStore.dirTree.length === 0 && !loading" class="local-empty full">
              <v-icon size="32">mdi-folder-open-outline</v-icon>
              <span>空目录</span>
            </div>
          </div>
        </template>
      </div>
    </div>

    <!-- 错误提示 -->
    <div v-if="error" class="local-error">
      <v-icon size="13">mdi-alert-circle-outline</v-icon>
      <span>{{ error }}</span>
    </div>

    <!-- 文件 / 目录右键菜单 -->
    <ContextMenu
      v-if="ctxMenu"
      :x="ctxMenu.x"
      :y="ctxMenu.y"
      :items="ctxItems"
      @close="closeCtxMenu"
    />
  </div>
</template>

<style scoped>
.local-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--color-surface-primary);
}
.local-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--color-border-subtle);
  flex-shrink: 0;
  min-height: 36px;
}
.local-breadcrumb {
  display: flex;
  align-items: center;
  gap: 3px;
  flex: 1;
  overflow-x: auto;
  font-size: 12px;
}
.breadcrumb-sep {
  color: var(--color-text-muted);
  font-size: 11px;
}
.breadcrumb-seg {
  cursor: pointer;
  color: var(--color-text-secondary);
  white-space: nowrap;
  padding: 1px 4px;
  border-radius: 3px;
}
.breadcrumb-seg:hover {
  color: var(--color-text-primary);
  background: var(--color-surface-hover);
}
.breadcrumb-seg.last {
  color: var(--color-text-primary);
  font-weight: 500;
}
.local-actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}
.local-body {
  display: flex;
  flex: 1;
  overflow: hidden;
}
.local-sidebar {
  width: 220px;
  flex-shrink: 0;
  border-right: 1px solid var(--color-border-subtle);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.local-sidebar-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  font-size: 11px;
  font-weight: 500;
  color: var(--color-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  border-bottom: 1px solid var(--color-border-subtle);
  flex-shrink: 0;
}
.local-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.local-editor-tabs {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 4px 8px;
  border-bottom: 1px solid var(--color-border-subtle);
  flex-shrink: 0;
  overflow-x: auto;
  min-height: 32px;
}
.local-editor-tab {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  font-size: 11px;
  border-radius: 3px;
  cursor: pointer;
  white-space: nowrap;
  background: var(--color-surface-secondary);
  color: var(--color-text-secondary);
  border: 1px solid transparent;
}
.local-editor-tab.active {
  background: var(--color-surface-primary);
  color: var(--color-text-primary);
  border-color: var(--color-border);
}
.local-editor-tab:hover { background: var(--color-surface-hover); }
.tab-name { max-width: 120px; overflow: hidden; text-overflow: ellipsis; }
.tab-dirty { color: var(--color-accent); font-size: 8px; }
.tab-close {
  background: none; border: none; cursor: pointer; padding: 0;
  color: var(--color-text-muted); display: flex; align-items: center;
  border-radius: 2px;
}
.tab-close:hover { color: var(--color-text-primary); background: var(--color-surface-hover); }
.tab-save-btn { margin-left: auto; flex-shrink: 0; font-size: 11px; padding: 2px 8px; }
.local-editor-body {
  flex: 1;
  overflow: hidden;
}
.local-editor-textarea {
  width: 100%;
  height: 100%;
  border: none;
  border-radius: 0;
  resize: none;
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 1.5;
  padding: 12px;
  tab-size: 2;
  background: var(--color-surface-primary);
  color: var(--color-text-primary);
  outline: none;
}
.local-file-grid {
  display: flex;
  flex-wrap: wrap;
  align-content: flex-start;
  gap: 8px;
  padding: 12px;
  overflow-y: auto;
  flex: 1;
}
.local-file-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  width: 80px;
  padding: 10px 6px;
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.12s;
}
.local-file-card:hover { background: var(--color-surface-hover); }
.file-name {
  font-size: 11px;
  text-align: center;
  word-break: break-all;
  line-height: 1.3;
  max-height: 28px;
  overflow: hidden;
  color: var(--color-text-primary);
}
.file-size {
  font-size: 10px;
  color: var(--color-text-muted);
}
.local-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 32px;
  color: var(--color-text-muted);
  font-size: 12px;
}
.local-empty.full {
  flex: 1;
}
.local-error {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  font-size: 12px;
  color: var(--color-error);
  background: var(--color-error-bg);
  border-top: 1px solid var(--color-error);
  flex-shrink: 0;
}
</style>
