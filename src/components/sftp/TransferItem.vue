<script setup lang="ts">
import { computed } from 'vue'
import type { TransferTask } from '../../services/sftp'

const props = defineProps<{
  task: TransferTask
}>()

const emit = defineEmits<{
  cancel: []
}>()

const progress = computed(() => {
  if (props.task.total_bytes === 0) return 0
  return Math.round((props.task.transferred_bytes / props.task.total_bytes) * 100)
})

const statusColor = computed(() => {
  switch (props.task.status) {
    case 'Running': return 'var(--cyan)'
    case 'Done': return 'var(--green)'
    case 'Failed': return 'var(--red)'
    case 'Cancelled': return 'var(--muted)'
    default: return 'var(--line-2)'
  }
})

const directionIcon = computed(() => props.task.direction === 'Upload' ? '↑' : '↓')

const directionColor = computed(() =>
  props.task.direction === 'Upload' ? 'var(--cyan)' : 'var(--purple)'
)

const fileName = computed(() => {
  if (props.task.files.length === 0) return '...'
  if (props.task.files.length === 1) return props.task.files[0].name
  return `${props.task.files[0].name} +${props.task.files.length - 1}`
})
</script>

<template>
  <div class="transfer-item">
    <span class="direction" :style="{ color: directionColor }">{{ directionIcon }}</span>
    <span class="file-name" :title="fileName">{{ fileName }}</span>
    <div class="progress-bar">
      <div class="progress-fill" :style="{ width: `${progress}%`, background: statusColor }"></div>
    </div>
    <span class="progress-text" :style="{ color: statusColor }">{{ progress }}%</span>
    <button
      v-if="task.status === 'Running' || task.status === 'Queued'"
      class="cancel-btn"
      @click="emit('cancel')"
      title="Cancel"
    >✕</button>
    <span v-else class="status-icon" :style="{ color: statusColor }">
      {{ task.status === 'Done' ? '✓' : task.status === 'Failed' ? '✕' : '○' }}
    </span>
  </div>
</template>

<style scoped>
.transfer-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 12px;
  font-size: 12px;
}

.direction {
  font-family: 'JetBrains Mono', monospace;
  font-size: 14px;
  font-weight: 700;
  width: 16px;
  text-align: center;
}

.file-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-2);
}

.progress-bar {
  width: 80px;
  height: 4px;
  background: var(--line);
  border-radius: 2px;
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  border-radius: 2px;
  transition: width 0.3s;
}

.progress-text {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  width: 36px;
  text-align: right;
}

.cancel-btn {
  width: 20px;
  height: 20px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  color: var(--muted);
  background: transparent;
  border: 1px solid transparent;
  cursor: pointer;
  transition: all 0.15s;
}

.cancel-btn:hover {
  color: var(--red);
  background: rgba(255, 77, 109, 0.1);
  border-color: rgba(255, 77, 109, 0.3);
}

.status-icon {
  font-size: 12px;
  width: 20px;
  text-align: center;
}
</style>
