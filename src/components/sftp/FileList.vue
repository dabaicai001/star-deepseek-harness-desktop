<script setup lang="ts">
import type { FileEntry } from '../../services/sftp'
import FileRow from './FileRow.vue'

defineProps<{
  files: FileEntry[]
  selectedFiles: Set<string>
  loading: boolean
}>()

const emit = defineEmits<{
  open: [entry: FileEntry]
  select: [entry: FileEntry]
  contextmenu: [event: MouseEvent, entry: FileEntry]
  dragstart: [event: DragEvent, entry: FileEntry]
  drop: [event: DragEvent]
}>()

function handleDrop(e: DragEvent) {
  e.preventDefault()
  emit('drop', e)
}

function handleDragOver(e: DragEvent) {
  e.preventDefault()
}
</script>

<template>
  <div class="file-list" @drop="handleDrop" @dragover="handleDragOver">
    <div class="file-list-header">
      <span class="col-icon"></span>
      <span class="col-name">Name</span>
      <span class="col-size">Size</span>
      <span class="col-date">Modified</span>
      <span class="col-perms">Perms</span>
    </div>

    <div v-if="loading" class="file-list-loading">
      <div class="loading-spinner"></div>
      <span>Loading...</span>
    </div>

    <div v-else-if="files.length === 0" class="empty-state">
      <div class="empty-state-icon">📂</div>
      <div class="empty-state-title">No files</div>
      <div class="empty-state-desc">This directory is empty</div>
    </div>

    <template v-else>
      <FileRow
        v-for="entry in files"
        :key="entry.path"
        :entry="entry"
        :selected="selectedFiles.has(entry.path)"
        @open="emit('open', entry)"
        @select="emit('select', entry)"
        @contextmenu="(e) => emit('contextmenu', e, entry)"
        @dragstart="(e) => emit('dragstart', e, entry)"
      />
    </template>
  </div>
</template>

<style scoped>
.file-list {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}

.file-list-header {
  display: grid;
  grid-template-columns: 28px 1fr 80px 140px 80px;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--muted);
  border-bottom: 1px solid var(--line);
  position: sticky;
  top: 0;
  background: var(--panel-solid-2);
  z-index: 1;
}

.file-list-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 48px;
  color: var(--muted);
  font-size: 13px;
}

.loading-spinner {
  width: 18px;
  height: 18px;
  border: 2px solid var(--line-2);
  border-top-color: var(--cyan);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>
