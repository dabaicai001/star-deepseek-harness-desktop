import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

export interface LocalFileEntry {
  name: string
  path: string
  isDir: boolean
  size: number
  modifiedAt: number
  children?: LocalFileEntry[]
}

export interface LocalEditorTab {
  id: string
  path: string
  name: string
  content: string
  dirty: boolean
  language: string
  /** VSCode 式预览 tab:单击打开为预览(斜体),编辑 / 双击后固定 */
  preview?: boolean
}

export const useLocalViewStore = defineStore('localView', () => {
  // 当前根路径
  const rootPath = ref('')
  // 当前浏览路径
  const currentPath = ref('')
  // 目录树数据
  const dirTree = ref<LocalFileEntry[]>([])
  // 树加载状态
  const treeLoading = ref(false)
  // 展开的目录集合
  const expandedDirs = ref<Set<string>>(new Set())
  // 编辑器 tab 列表
  const editorTabs = ref<LocalEditorTab[]>([])
  // 当前激活的编辑器 tab id
  const activeEditorTabId = ref<string | null>(null)
  // 终端 CWD
  const terminalCwd = ref('')
  // 视图模式: tree | grid
  const viewMode = ref<'tree' | 'grid'>('tree')

  const activeEditorTab = computed(() =>
    editorTabs.value.find(t => t.id === activeEditorTabId.value) ?? null
  )

  function setRootPath(path: string) {
    rootPath.value = path
    currentPath.value = path
    terminalCwd.value = path
    expandedDirs.value = new Set([path])
  }

  function setDirTree(tree: LocalFileEntry[]) {
    dirTree.value = tree
  }

  function setCurrentPath(path: string) {
    currentPath.value = path
  }

  function toggleExpandedDir(path: string) {
    if (expandedDirs.value.has(path)) {
      expandedDirs.value.delete(path)
    } else {
      expandedDirs.value.add(path)
    }
  }

  function openEditorTab(tab: LocalEditorTab, opts?: { preview?: boolean }) {
    const existing = editorTabs.value.find(t => t.path === tab.path)
    if (existing) {
      activeEditorTabId.value = existing.id
      return
    }
    tab.preview = opts?.preview ?? false
    if (tab.preview) {
      // 预览 tab 全局只保留一个:新预览就地替换旧预览
      const idx = editorTabs.value.findIndex(t => t.preview)
      if (idx >= 0) editorTabs.value.splice(idx, 1, tab)
      else editorTabs.value.push(tab)
    } else {
      editorTabs.value.push(tab)
    }
    activeEditorTabId.value = tab.id
  }

  /** 固定预览 tab(双击树节点 / 双击 tab / 产生编辑时) */
  function pinEditorTab(tabId: string) {
    const tab = editorTabs.value.find(t => t.id === tabId)
    if (tab) tab.preview = false
  }

  /** 折叠全部目录(VSCode Collapse All) */
  function collapseAllDirs() {
    expandedDirs.value = new Set()
  }

  function closeEditorTab(tabId: string) {
    const idx = editorTabs.value.findIndex(t => t.id === tabId)
    if (idx < 0) return
    editorTabs.value.splice(idx, 1)
    if (activeEditorTabId.value === tabId) {
      activeEditorTabId.value = editorTabs.value[Math.min(idx, editorTabs.value.length - 1)]?.id ?? null
    }
  }

  function updateEditorContent(tabId: string, content: string) {
    const tab = editorTabs.value.find(t => t.id === tabId)
    if (tab) {
      tab.content = content
      tab.dirty = true
      tab.preview = false
    }
  }

  function markEditorClean(tabId: string) {
    const tab = editorTabs.value.find(t => t.id === tabId)
    if (tab) tab.dirty = false
  }

  function getLanguage(filename: string): string {
    const ext = filename.split('.').pop()?.toLowerCase()
    const map: Record<string, string> = {
      ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
      vue: 'html', html: 'html', css: 'css', scss: 'scss', less: 'less',
      json: 'json', xml: 'xml', yaml: 'yaml', yml: 'yaml', toml: 'toml',
      md: 'markdown', py: 'python', rs: 'rust', go: 'go', java: 'java',
      c: 'c', cpp: 'cpp', h: 'c', sh: 'shell', bash: 'shell', ps1: 'powershell',
      sql: 'sql', dockerfile: 'dockerfile', env: 'plaintext',
      txt: 'plaintext', log: 'plaintext', csv: 'plaintext',
    }
    return ext ? (map[ext] || 'plaintext') : 'plaintext'
  }

  /** 判断是否 Excel 文件 */
  function isExcelFile(filename: string): boolean {
    const ext = filename.split('.').pop()?.toLowerCase()
    return ext === 'xlsx' || ext === 'xls' || ext === 'csv'
  }

  function reset() {
    rootPath.value = ''
    currentPath.value = ''
    dirTree.value = []
    expandedDirs.value = new Set()
    editorTabs.value = []
    activeEditorTabId.value = null
    terminalCwd.value = ''
    treeLoading.value = false
  }

  return {
    rootPath, currentPath, dirTree, treeLoading, expandedDirs,
    editorTabs, activeEditorTabId, activeEditorTab, terminalCwd, viewMode,
    setRootPath, setDirTree, setCurrentPath, toggleExpandedDir,
    openEditorTab, closeEditorTab, updateEditorContent, markEditorClean,
    pinEditorTab, collapseAllDirs,
    getLanguage, isExcelFile, reset,
  }
})
