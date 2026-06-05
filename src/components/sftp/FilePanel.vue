<script setup lang="ts">
import { ref } from 'vue'
import type { FileEntry } from '../../services/sftp'
import PathBreadcrumb from './PathBreadcrumb.vue'
import FileList from './FileList.vue'

const props = defineProps<{
  side: 'local' | 'remote'
  path: string
  files: FileEntry[]
  loading: boolean
}>()

const emit = defineEmits<{
  navigate: [path: string]
  open: [entry: FileEntry]
  upload: [paths: string[]]
  download: [paths: string[]]
  contextmenu: [event: MouseEvent, entry: FileEntry | null]
  search: [pattern: string]
}>()

const selectedFiles = ref<Set<string>>(new Set())

function handleSelect(entry: FileEntry) {
  if (selectedFiles.value.has(entry.path)) {
    selectedFiles.value.delete(entry.path)
  } else {
    selectedFiles.value.add(entry.path)
  }
}

function handleDragStart(e: DragEvent, entry: FileEntry) {
  if (!e.dataTransfer) return
  e.dataTransfer.setData('application/json', JSON.stringify({
    sourceSide: props.side,
    entry
  }))
  e.dataTransfer.effectAllowed = 'copyMove'
}

function handleDrop(e: DragEvent) {
  if (!e.dataTransfer) return
  const raw = e.dataTransfer.getData('application/json')
  if (!raw) return
  try {
    const data = JSON.parse(raw) as { sourceSide: string; entry: FileEntry }
    if (data.sourceSide !== props.side) {
      if (props.side === 'remote') {
        emit('upload', [data.entry.path])
      } else {
        emit('download', [data.entry.path])
      }
    }
  } catch {
    // ignore invalid drop data
  }
}

function handlePanelContext(e: MouseEvent) {
  emit('contextmenu', e, null)
}
</script>

<template>
  <div class="file-panel cyber-panel" @contextmenu.prevent="handlePanelContext">
    <div class="panel-header">
      <span class="panel-title" :class="side">
        {{ side === 'local' ? 'LOCAL' : 'REMOTE' }}
      </span>
      <span class="panel-path">{{ path }}</span>
    </div>

    <PathBreadcrumb :path="path" :side="side" @navigate="emit('navigate', $event)" />

    <FileList
      :files="files"
      :selected-files="selectedFiles"
      :loading="loading"
      @open="emit('open', $event)"
      @select="handleSelect"
      @contextmenu="(e, entry) => emit('contextmenu', e, entry)"
      @dragstart="handleDragStart"
      @drop="handleDrop"
    />
  </div>
</template>

<style scoped>
.file-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
}

.panel-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--line);
}

.panel-title {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.1em;
  padding: 3px 8px;
  border-radius: 4px;
}

.panel-title.local {
  color: var(--purple);
  background: rgba(181, 107, 255, 0.1);
  border: 1px solid rgba(181, 107, 255, 0.25);
}

.panel-title.remote {
  color: var(--cyan);
  background: rgba(0, 240, 255, 0.1);
  border: 1px solid rgba(0, 240, 255, 0.25);
}

.panel-path {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
