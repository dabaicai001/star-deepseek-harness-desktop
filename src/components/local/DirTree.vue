<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useLocalViewStore, type LocalFileEntry } from '@/stores/localView'
import { invoke } from '@tauri-apps/api/core'

defineOptions({ name: 'DirTree' })

const { t } = useI18n()
const store = useLocalViewStore()

const props = defineProps<{
  entries: LocalFileEntry[]
  parentPath: string
  depth: number
}>()

const emit = defineEmits<{
  'select-file': [entry: LocalFileEntry]
  'open-excel': [entry: LocalFileEntry]
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
      const result = await invoke<any>('local_list_directory', { path: p, depth: 1 })
      const children: LocalFileEntry[] = (result.entries || []).map((e: any) => ({
        name: e.name,
        path: e.path,
        isDir: e.is_dir || e.isDir || false,
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

function onFileClick(entry: LocalFileEntry) {
  if (entry.isDir) {
    toggleDir(entry)
    store.setCurrentPath(entry.path)
  } else {
    store.setCurrentPath(entry.path)
    emit('select-file', entry)
  }
}

function onFileDblClick(entry: LocalFileEntry) {
  if (entry.isDir) {
    toggleDir(entry)
    store.setCurrentPath(entry.path)
  } else {
    if (store.isExcelFile(entry.name)) {
      emit('open-excel', entry)
    } else {
      emit('select-file', entry)
    }
  }
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

function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`
}
</script>

<template>
  <div class="local-dir-tree">
    <div
      v-for="entry in entries"
      :key="entry.path"
      class="local-tree-node"
    >
      <div
        class="local-tree-row"
        :class="{ selected: store.currentPath === entry.path }"
        :style="{ paddingLeft: `${props.depth * 16 + 4}px` }"
        @click="onFileClick(entry)"
        @dblclick="onFileDblClick(entry)"
      >
        <v-icon
          v-if="entry.isDir"
          class="chevron"
          :class="{ open: isExpanded(entry.path), loading: loadingDirs.has(entry.path) }"
          size="14"
          @click.stop="toggleDir(entry)"
        >
          {{ loadingDirs.has(entry.path) ? 'mdi-loading mdi-spin' : 'mdi-chevron-right' }}
        </v-icon>
        <span v-else class="chevron-spacer" />
        <v-icon :color="entry.isDir ? 'var(--color-accent-secondary)' : undefined" size="14">
          {{ getIcon(entry) }}
        </v-icon>
        <span class="name">{{ entry.name }}</span>
        <span v-if="!entry.isDir" class="size">{{ formatSize(entry.size) }}</span>
      </div>
      <!-- 递归子目录 -->
      <template v-if="entry.isDir && isExpanded(entry.path) && entry.children">
        <DirTree
          :entries="entry.children"
          :parent-path="entry.path"
          :depth="props.depth + 1"
          @select-file="(e) => emit('select-file', e)"
          @open-excel="(e) => emit('open-excel', e)"
        />
      </template>
    </div>
  </div>
</template>

<style scoped>
.local-dir-tree {
  overflow-y: auto;
  flex: 1;
}
.local-tree-node {
  user-select: none;
}
.local-tree-row {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 26px;
  padding-right: 8px;
  cursor: pointer;
  border-radius: 3px;
  transition: background 0.12s;
}
.local-tree-row:hover {
  background: var(--color-surface-hover);
}
.local-tree-row.selected {
  background: var(--color-accent-bg);
}
.chevron {
  flex-shrink: 0;
  transition: transform 0.15s;
  color: var(--color-text-muted);
}
.chevron.open {
  transform: rotate(90deg);
}
.chevron-spacer {
  width: 14px;
  flex-shrink: 0;
}
.name {
  flex: 1;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text-primary);
}
.size {
  font-size: 10px;
  color: var(--color-text-muted);
  font-family: var(--font-mono);
  flex-shrink: 0;
}
</style>
