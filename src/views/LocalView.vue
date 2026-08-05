<script setup lang="ts">
import { ref, computed, onMounted, watch, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '@/stores/app'
import { useAssetStore } from '@/stores/asset'
import { useLocalViewStore, type LocalFileEntry } from '@/stores/localView'
import { generateInstanceId } from '@/utils/tabId'
import { invoke } from '@tauri-apps/api/core'
import DirTree from '@/components/local/DirTree.vue'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const appStore = useAppStore()
const assetStore = useAssetStore()
const localStore = useLocalViewStore()

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

// 加载目录
async function loadDirectory(dirPath: string) {
  loading.value = true
  error.value = ''
  try {
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
    localStore.setDirTree(entries)
  } catch (err: any) {
    error.value = String(err)
    console.error('Load directory failed:', err)
  } finally {
    loading.value = false
  }
}

// 初始加载
onMounted(async () => {
  if (asset.value?.config?.rootPath) {
    localStore.setRootPath(asset.value.config.rootPath)
    await loadDirectory(asset.value.config.rootPath)
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
  // 打开文本文件到编辑器
  try {
    const result = await invoke<any>('local_read_text_file', { path: entry.path, offset: 0, maxBytes: 1048576 })
    const content = result.content || result || ''
    const tabEntry = {
      id: `editor-${entry.path}`,
      path: entry.path,
      name: entry.name,
      content,
      dirty: false,
      language: localStore.getLanguage(entry.name),
    }
    localStore.openEditorTab(tabEntry)
  } catch (err) {
    console.error('Failed to read file:', err)
  }
}

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
