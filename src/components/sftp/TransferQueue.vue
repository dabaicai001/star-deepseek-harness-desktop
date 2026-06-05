<script setup lang="ts">
import { computed } from 'vue'
import type { TransferTask } from '../../services/sftp'
import TransferItem from './TransferItem.vue'

const props = defineProps<{
  transfers: TransferTask[]
}>()

const emit = defineEmits<{
  cancel: [id: string]
}>()

const activeCount = computed(() =>
  props.transfers.filter(t => t.status === 'Running' || t.status === 'Queued').length
)
</script>

<template>
  <div class="transfer-queue cyber-panel">
    <div class="queue-header">
      <span class="queue-title">TRANSFERS</span>
      <span v-if="activeCount > 0" class="cyber-badge">{{ activeCount }}</span>
    </div>
    <div class="queue-list">
      <div v-if="transfers.length === 0" class="queue-empty">
        No active transfers
      </div>
      <TransferItem
        v-for="task in transfers"
        :key="task.id"
        :task="task"
        @cancel="emit('cancel', task.id)"
      />
    </div>
  </div>
</template>

<style scoped>
.transfer-queue {
  display: flex;
  flex-direction: column;
  height: 180px;
  flex-shrink: 0;
}

.queue-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--line);
}

.queue-title {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.1em;
  color: var(--muted);
  text-transform: uppercase;
}

.queue-list {
  flex: 1;
  overflow-y: auto;
}

.queue-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  font-size: 12px;
  color: var(--muted);
}
</style>
