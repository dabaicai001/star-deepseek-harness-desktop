<script setup lang="ts">
import { ref } from 'vue'
import { useLocalViewStore, type LocalFileEntry } from '@/stores/localView'
import { invoke } from '@tauri-apps/api/core'

defineOptions({ name: 'DirTree' })

const store = useLocalViewStore()

const props = defineProps<{
  entries: LocalFileEntry[]
  parentPath: string
  depth: number
}>()

const emit = defineEmits<{
  'select-file': [entry: LocalFileEntry]
  'pin-file': [entry: LocalFileEntry]
  'open-excel': [entry: LocalFileEntry]
  'ctx': [payload: { event: MouseEvent; entry: LocalFileEntry }]
}>()

const loadingDirs = ref<Set<string>>(new Set())

function isExpanded(path: string): boolean {
  return store.expandedDirs.has(path)
}

async function toggleDir(entry: LocalFileEntry) {
  const p = entry.path
  if (loadingDirs.value.has(p)) return
  store.toggleExpandedDir(p)
  if (!entry.children || entry.children.length === 0) {
    loadingDirs.value.add(p)
    try {
      const result = await invoke<any[]>('local_list_directory', { path: p, maxEntries: 200 })
      const children: LocalFileEntry[] = result.map((e) => ({
        name: e.name,
        path: e.path,
        isDir: e.kind === 'directory' || e.is_dir || e.isDir || false,
        size: e.size || 0,
        modifiedAt: e.modified_at || e.modifiedAt || 0,
      }))
      children.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
        return a.name.localeCompare(b.name)
      })
      entry.children = children
    } catch (err) {
      console.error('Failed to list directory:', err)
    } finally {
      loadingDirs.value.delete(p)
    }
  }
}

function onRowCtx(event: MouseEvent, entry: LocalFileEntry) {
  event.preventDefault()
  event.stopPropagation()
  store.setCurrentPath(entry.path)
  emit('ctx', { event, entry })
}

function onFileClick(entry: LocalFileEntry) {
  store.setCurrentPath(entry.path)
  if (entry.isDir) {
    toggleDir(entry)
    return
  }
  if (store.isExcelFile(entry.name)) {
    emit('open-excel', entry)
  } else {
    emit('select-file', entry)
  }
}

/** 双击:目录无额外行为(单击已展开/折叠),文件固定预览 tab */
function onFileDblClick(entry: LocalFileEntry) {
  if (entry.isDir || store.isExcelFile(entry.name)) return
  emit('pin-file', entry)
}

function getIcon(entry: LocalFileEntry): string {
  if (entry.isDir) return 'mdi-folder-outline'
  const ext = entry.name.split('.').pop()?.toLowerCase()
  switch (ext) {
    case 'xlsx': case 'xls': case 'csv': return 'mdi-file-excel-outline'
    case 'ts': case 'tsx': case 'js': case 'jsx': case 'vue': return 'mdi-language-typescript'
    case 'json': return 'mdi-code-json'
    case 'md': return 'mdi-language-markdown'
    case 'py': return 'mdi-language-python'
    case 'rs': return 'mdi-language-rust'
    case 'go': return 'mdi-language-go'
    case 'html': case 'css': case 'scss': return 'mdi-language-html5'
    case 'yaml': case 'yml': case 'toml': return 'mdi-cog-outline'
    case 'sql': return 'mdi-database-outline'
    case 'sh': case 'bash': case 'ps1': return 'mdi-console'
    case 'log': case 'txt': return 'mdi-file-document-outline'
    case 'png': case 'jpg': case 'jpeg': case 'gif': case 'svg': return 'mdi-file-image-outline'
    case 'zip': case 'tar': case 'gz': return 'mdi-folder-zip-outline'
    default: return 'mdi-file-outline'
  }
}

</script>

<template>
  <div class="local-tree">
    <div
      v-for="entry in entries"
      :key="entry.path"
      class="local-tree-node"
    >
      <div
        class="local-tree-row"
        :class="{ selected: store.currentPath === entry.path }"
        tabindex="0"
        @click="onFileClick(entry)"
        @dblclick="onFileDblClick(entry)"
        @contextmenu="onRowCtx($event, entry)"
      >
        <v-icon
          v-if="entry.isDir"
          class="local-tree-chevron"
          :class="{ open: isExpanded(entry.path) }"
          size="14"
          @click.stop="toggleDir(entry)"
        >
          {{ loadingDirs.has(entry.path) ? 'mdi-loading mdi-spin' : 'mdi-chevron-right' }}
        </v-icon>
        <span v-else class="local-tree-chevron-spacer" />
        <v-icon class="local-tree-icon" :class="{ 'is-dir': entry.isDir }" size="14">
          {{ getIcon(entry) }}
        </v-icon>
        <span class="local-tree-name">{{ entry.name }}</span>
      </div>
      <!-- 递归子目录(嵌套层自带缩进参考线) -->
      <div
        v-if="entry.isDir && isExpanded(entry.path) && entry.children"
        class="local-tree-children"
      >
        <DirTree
          :entries="entry.children"
          :parent-path="entry.path"
          :depth="props.depth + 1"
          @select-file="(e) => emit('select-file', e)"
          @pin-file="(e) => emit('pin-file', e)"
          @open-excel="(e) => emit('open-excel', e)"
          @ctx="(p) => emit('ctx', p)"
        />
      </div>
    </div>
  </div>
</template>

