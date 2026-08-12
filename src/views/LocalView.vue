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

// 路径分段:Windows 盘符根("C:\")与 Unix 根("/")都作为首段保留
function segmentsOf(p: string): string[] {
  if (!p) return []
  const parts = p.replace(/\\/g, '/').split('/').filter(Boolean)
  if (p.match(/^[A-Z]:\\/i)) {
    return [p.substring(0, 3), ...parts.slice(1)]
  }
  if (p.startsWith('/')) {
    return ['/', ...parts]
  }
  return parts
}

/** 由路径与目标段索引还原该级目录的完整路径 */
function targetOfSegment(fullPath: string, idx: number): string {
  const picked = segmentsOf(fullPath).slice(0, idx + 1)
  if (picked.length === 0) return fullPath
  // Windows 盘符根:首段本身已是 "C:\",后续用 \ 连接
  if (/^[A-Za-z]:\\$/.test(picked[0])) {
    return picked[0] + picked.slice(1).join('\\')
  }
  if (picked[0] === '/') return '/' + picked.slice(1).join('/')
  return picked.join('/')
}

// 当前浏览路径的面包屑段
const pathSegments = computed(() => segmentsOf(localStore.currentPath))

// 编辑器顶部面包屑:激活文件的路径段(末段是文件名)
const fileSegments = computed(() =>
  localStore.activeEditorTab ? segmentsOf(localStore.activeEditorTab.path) : []
)

/** 跳转到指定段的目录并刷新列表 */
function navigateToDir(target: string) {
  localStore.setCurrentPath(target)
  loadDirectory(target)
}

// 路径面包屑点击(文件列表态,基于 currentPath)
function navigateToSegment(idx: number) {
  navigateToDir(targetOfSegment(localStore.currentPath, idx))
}

// 编辑器面包屑点击:末段是文件名不可跳转,其余段进入对应目录
function navigateToFileSegment(idx: number) {
  if (!localStore.activeEditorTab || idx >= fileSegments.value.length - 1) return
  navigateToDir(targetOfSegment(localStore.activeEditorTab.path, idx))
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
    notify.notify({ message: t('local.openFailed', { err: String(err) }), color: 'error', timeout: 3000 })
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
      label: t('local.open'),
      onClick: () => onSelectFile(entry)
    }
  ]
  if (!entry.isDir && localStore.isExcelFile(entry.name)) {
    items.push({
      type: 'item',
      icon: 'mdi-file-excel-outline',
      label: t('local.openExcel'),
      onClick: () => onOpenExcel(entry)
    })
  }
  if (entry.isDir) {
    items.push(
      { type: 'divider' },
      {
        type: 'item',
        icon: 'mdi-file-plus-outline',
        label: t('local.newFile'),
        onClick: () => ctxNewFile(entry.path)
      },
      {
        type: 'item',
        icon: 'mdi-folder-plus-outline',
        label: t('local.newFolder'),
        onClick: () => ctxNewFolder(entry.path)
      },
      {
        type: 'item',
        icon: 'mdi-refresh',
        label: t('local.refresh'),
        onClick: () => refreshChildren(entry.path)
      }
    )
  }
  items.push(
    { type: 'divider' },
    {
      type: 'item',
      icon: 'mdi-pencil-outline',
      label: t('local.rename'),
      shortcut: 'F2',
      onClick: () => ctxRename(entry)
    },
    {
      type: 'item',
      icon: 'mdi-delete-outline',
      label: t('local.delete'),
      shortcut: 'Del',
      danger: true,
      onClick: () => ctxDelete(entry)
    }
  )
  return items
})

async function ctxNewFile(dirPath: string) {
  const name = await dlg.prompt({
    message: t('local.newFilePrompt', { path: dirPath }),
    placeholder: 'new-file.txt',
    requireNonEmpty: true,
  })
  if (!name) return
  const full = joinLocalPath(dirPath, name)
  try {
    await invoke('local_write_text_file', { path: full, content: '', createParents: false })
    await refreshChildren(dirPath)
    notify.notify({ message: t('local.created', { name }), color: 'success', timeout: 2000 })
    await openFileInEditor({ name, path: full, isDir: false, size: 0, modifiedAt: 0 })
  } catch (err: any) {
    notify.notify({ message: t('local.createFailed', { err: String(err) }), color: 'error', timeout: 3000 })
  }
}

async function ctxNewFolder(dirPath: string) {
  const name = await dlg.prompt({
    message: t('local.newFolderPrompt', { path: dirPath }),
    placeholder: 'new-folder',
    requireNonEmpty: true,
  })
  if (!name) return
  const full = joinLocalPath(dirPath, name)
  try {
    await invoke('local_create_directory', { path: full, recursive: true })
    await refreshChildren(dirPath)
    notify.notify({ message: t('local.folderCreated', { name }), color: 'success', timeout: 2000 })
  } catch (err: any) {
    notify.notify({ message: t('local.createFolderFailed', { err: String(err) }), color: 'error', timeout: 3000 })
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
    message: t('local.renamePrompt', { name: entry.name }),
    defaultValue: entry.name,
    requireNonEmpty: true,
  })
  if (!newName || newName === entry.name) return
  const oldPath = entry.path
  const newPath = joinLocalPath(parentOf(oldPath), newName)
  try {
    await invoke('local_move_path', { source: oldPath, destination: newPath })
  } catch (err: any) {
    notify.notify({ message: t('local.renameFailed', { err: String(err) }), color: 'error', timeout: 3000 })
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
  notify.notify({ message: t('local.renamed', { name: newName }), color: 'success', timeout: 2000 })
}

async function ctxDelete(entry: LocalFileEntry) {
  const ok = await dlg.confirm({
    message: entry.isDir
      ? t('local.confirmDeleteDir', { name: entry.name })
      : t('local.confirmDeleteFile', { name: entry.name }),
    confirmText: t('local.delete'),
    danger: true,
  })
  if (!ok) return
  try {
    await invoke('local_remove_path', { path: entry.path, recursive: true })
  } catch (err: any) {
    notify.notify({ message: t('local.deleteFailed', { err: String(err) }), color: 'error', timeout: 3000 })
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
  notify.notify({ message: t('local.deleted', { name: entry.name }), color: 'success', timeout: 2000 })
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

// 修改时间:后端可能给秒或毫秒,按量级兼容
function formatTime(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts > 1e12 ? ts : ts * 1000)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

// ====== 状态栏数据(纯展示) ======
// 工作区根目录名(侧栏 section 头)
const rootName = computed(() => {
  const rp = localStore.rootPath
  if (!rp) return ''
  const norm = rp.replace(/[/\\]+$/, '')
  return norm.split(/[/\\]/).pop() || rp
})

// 当前浏览目录的条目统计
const dirCount = computed(() => localStore.dirTree.filter(e => e.isDir).length)
const fileCount = computed(() => localStore.dirTree.filter(e => !e.isDir).length)

// 状态栏显示的路径:优先当前列出目录,其次激活文件
const statusPath = computed(() =>
  localStore.activeEditorTab?.path || listedPath.value || localStore.currentPath
)
</script>

<template>
  <div class="local-view">
    <div class="local-body">
      <!-- 目录树(VSCode Explorer 式:分区标题条 + hover 显现操作) -->
      <aside class="local-sidebar">
        <div class="local-side-head">
          <span class="local-side-title">{{ t('local.explorer') }}</span>
          <div class="local-side-actions">
            <button class="action-btn" :data-tooltip="t('local.newFile')" @click="toolbarNewFile">
              <v-icon size="13">mdi-file-plus-outline</v-icon>
            </button>
            <button class="action-btn" :data-tooltip="t('local.newFolder')" @click="toolbarNewFolder">
              <v-icon size="13">mdi-folder-plus-outline</v-icon>
            </button>
            <button class="action-btn" :data-tooltip="t('local.refresh')" @click="toolbarRefresh">
              <v-icon size="13">mdi-refresh</v-icon>
            </button>
          </div>
        </div>
        <div
          v-if="rootName"
          class="local-side-root"
          :title="localStore.rootPath"
          @click="localStore.setCurrentPath(localStore.rootPath)"
        >
          <v-icon size="13">mdi-folder-outline</v-icon>
          <span>{{ rootName }}</span>
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
        <div v-else-if="loading" class="local-tree-loading">
          <div
            v-for="i in 5"
            :key="i"
            class="cyber-skeleton"
            :style="{ width: `${100 - i * 12}%` }"
          />
        </div>
        <div v-else class="empty-state local-fill">
          <v-icon size="40" class="empty-state-icon">mdi-folder-open-outline</v-icon>
          <div class="empty-state-title">{{ t('local.emptyTreeTitle') }}</div>
          <div class="empty-state-desc">{{ t('local.emptyTreeDesc') }}</div>
        </div>
      </aside>

      <!-- 主区域:编辑器 / 文件列表 -->
      <main class="local-content">
        <template v-if="localStore.editorTabs.length > 0">
          <!-- 打开文件 tab 条(dirty 点 / hover 关闭钮) -->
          <div class="local-editor-tabs">
            <TransitionGroup name="cyber-tab" tag="div" class="local-editor-tab-list">
              <div
                v-for="tab in localStore.editorTabs"
                :key="tab.id"
                class="local-editor-tab"
                :class="{ active: tab.id === localStore.activeEditorTabId, dirty: tab.dirty }"
                :title="tab.path"
                @click="localStore.activeEditorTabId = tab.id"
              >
                <v-icon size="13" class="local-tab-icon">{{ getFileIcon(tab.name) }}</v-icon>
                <span class="local-tab-name">{{ tab.name }}</span>
                <span class="local-tab-tail">
                  <span v-if="tab.dirty" class="local-tab-dirty" />
                  <button
                    class="local-tab-close"
                    @click.stop="localStore.closeEditorTab(tab.id)"
                  ><v-icon size="11">mdi-close</v-icon></button>
                </span>
              </div>
            </TransitionGroup>
            <button
              v-if="localStore.activeEditorTab?.dirty"
              class="cyber-btn-secondary local-tab-save"
              @click="saveEditorTab"
            >
              <v-icon size="12">mdi-content-save-outline</v-icon>
              {{ t('local.save') }}
            </button>
          </div>
          <!-- 编辑器面包屑:激活文件路径,目录段可点击跳转 -->
          <div v-if="localStore.activeEditorTab" class="local-breadcrumb">
            <template v-for="(seg, idx) in fileSegments" :key="idx">
              <v-icon v-if="idx > 0" size="11" class="local-crumb-sep">mdi-chevron-right</v-icon>
              <span
                class="local-crumb"
                :class="{ last: idx === fileSegments.length - 1 }"
                @click="navigateToFileSegment(idx)"
              >{{ seg }}</span>
            </template>
          </div>
          <div v-if="localStore.activeEditorTab" class="local-editor-body">
            <textarea
              class="local-editor-textarea"
              :value="localStore.activeEditorTab.content"
              @input="(e) => localStore.updateEditorContent(localStore.activeEditorTab!.id, (e.target as HTMLTextAreaElement).value)"
              @keydown.ctrl.s.prevent="saveEditorTab"
              @keydown.meta.s.prevent="saveEditorTab"
              spellcheck="false"
            />
          </div>
        </template>

        <template v-else>
          <!-- 目录面包屑:可点击逐级跳转 -->
          <div class="local-breadcrumb">
            <template v-for="(seg, idx) in pathSegments" :key="idx">
              <v-icon v-if="idx > 0" size="11" class="local-crumb-sep">mdi-chevron-right</v-icon>
              <span
                class="local-crumb"
                :class="{ last: idx === pathSegments.length - 1 }"
                @click="navigateToSegment(idx)"
              >{{ seg }}</span>
            </template>
          </div>
          <!-- 文件列表(名称 / 大小 / 修改时间) -->
          <div v-if="localStore.dirTree.length > 0" class="local-file-list">
            <div class="local-file-head">
              <span>{{ t('local.colName') }}</span>
              <span class="local-file-size">{{ t('local.colSize') }}</span>
              <span class="local-file-mtime">{{ t('local.colModified') }}</span>
            </div>
            <div
              v-for="entry in localStore.dirTree"
              :key="entry.path"
              class="local-file-row"
              @dblclick="onSelectFile(entry)"
              @click="onSelectFile(entry)"
              @contextmenu="onEntryCtx({ event: $event, entry })"
            >
              <span class="local-file-name">
                <v-icon size="15" :class="{ 'is-dir': entry.isDir }">
                  {{ entry.isDir ? 'mdi-folder-outline' : getFileIcon(entry.name) }}
                </v-icon>
                <span>{{ entry.name }}</span>
              </span>
              <span class="local-file-size">{{ entry.isDir ? '' : formatSize(entry.size) }}</span>
              <span class="local-file-mtime">{{ formatTime(entry.modifiedAt) }}</span>
            </div>
          </div>
          <div v-else-if="loading" class="local-tree-loading local-fill">
            <div
              v-for="i in 6"
              :key="i"
              class="cyber-skeleton"
              :style="{ width: `${100 - i * 10}%` }"
            />
          </div>
          <div v-else class="empty-state local-fill">
            <v-icon size="40" class="empty-state-icon">mdi-folder-open-outline</v-icon>
            <div class="empty-state-title">{{ t('local.emptyDirTitle') }}</div>
            <div class="empty-state-desc">{{ t('local.emptyDirDesc') }}</div>
            <button class="cyber-btn-secondary" @click="toolbarNewFile">
              <v-icon size="13">mdi-file-plus-outline</v-icon>
              {{ t('local.newFile') }}
            </button>
          </div>
        </template>
      </main>
    </div>

    <!-- 错误提示 -->
    <div v-if="error" class="local-error">
      <v-icon size="13">mdi-alert-circle-outline</v-icon>
      <span>{{ error }}</span>
    </div>

    <!-- 状态栏(等宽数字) -->
    <footer class="local-statusbar">
      <span class="local-status-item local-status-path" :title="statusPath">
        <v-icon size="11">mdi-folder-outline</v-icon>
        <span>{{ statusPath }}</span>
      </span>
      <span v-if="localStore.dirTree.length > 0" class="local-status-item">
        <v-icon size="11">mdi-format-list-bulleted</v-icon>
        {{ t('local.entries', { dirs: dirCount, files: fileCount }) }}
      </span>
      <template v-if="localStore.activeEditorTab">
        <span class="local-status-item accent">{{ localStore.activeEditorTab.language.toUpperCase() }}</span>
        <span class="local-status-item" :class="{ warn: localStore.activeEditorTab.dirty }">
          <v-icon size="11">{{ localStore.activeEditorTab.dirty ? 'mdi-circle-small' : 'mdi-check' }}</v-icon>
          {{ localStore.activeEditorTab.dirty ? t('local.modified') : t('local.saved') }}
        </span>
      </template>
    </footer>

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

