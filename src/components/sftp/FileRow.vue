<script setup lang="ts">
import type { FileEntry } from '../../services/sftp'
import { formatFileSize, formatPermissions } from '../../services/sftp'

defineProps<{
  entry: FileEntry
  selected: boolean
}>()

const emit = defineEmits<{
  open: []
  select: []
  contextmenu: [event: MouseEvent]
  dragstart: [event: DragEvent]
}>()

function formatDate(ts: number): string {
  const d = new Date(ts * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function handleDragStart(e: DragEvent) {
  emit('dragstart', e)
}
</script>

<template>
  <div
    class="file-row"
    :class="{ selected, 'is-dir': entry.is_dir }"
    draggable="true"
    @dblclick="emit('open')"
    @click="emit('select')"
    @contextmenu.prevent="emit('contextmenu', $event)"
    @dragstart="handleDragStart"
  >
    <span class="col-icon">{{ entry.is_dir ? '📁' : '📄' }}</span>
    <span class="col-name" :title="entry.name">{{ entry.name }}</span>
    <span class="col-size">{{ entry.is_dir ? '-' : formatFileSize(entry.size) }}</span>
    <span class="col-date">{{ formatDate(entry.modified) }}</span>
    <span class="col-perms">{{ formatPermissions(entry.permissions) }}</span>
  </div>
</template>

<style scoped>
.file-row {
  display: grid;
  grid-template-columns: 28px 1fr 80px 140px 80px;
  align-items: center;
  gap: 8px;
  padding: 5px 12px;
  font-size: 12.5px;
  color: var(--text-2);
  cursor: pointer;
  border-left: 2px solid transparent;
  transition: all 0.15s;
  user-select: none;
}

.file-row:hover {
  background: rgba(0, 240, 255, 0.05);
  color: var(--text);
}

.file-row.selected {
  background: linear-gradient(90deg, rgba(0, 240, 255, 0.15) 0%, transparent 100%);
  border-left-color: var(--cyan);
  color: var(--cyan);
}

.col-icon {
  font-size: 14px;
  text-align: center;
}

.col-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
}

.is-dir .col-name {
  color: var(--cyan-2);
}

.col-size,
.col-date,
.col-perms {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  color: var(--muted);
  white-space: nowrap;
}
</style>
