<script setup lang="ts">
import { ref } from 'vue'
import PubSubMonitor from './PubSubMonitor.vue'
import SlowlogViewer from './SlowlogViewer.vue'
import BigKeyScanner from './BigKeyScanner.vue'
import MemoryAnalyzer from './MemoryAnalyzer.vue'

defineProps<{ connId: string; currentDb: number }>()

const activeTool = ref('pubsub')

const tools = [
  { key: 'pubsub', label: 'Pub/Sub', icon: 'mdi-broadcast' },
  { key: 'slowlog', label: 'Slowlog', icon: 'mdi-timer-sand' },
  { key: 'bigkey', label: 'BigKey', icon: 'mdi-magnify-expand' },
  { key: 'memory', label: 'Memory', icon: 'mdi-memory' },
]
</script>

<template>
  <div class="redis-tools">
    <div class="tool-tabs">
      <button
        v-for="t in tools"
        :key="t.key"
        class="cyber-tab"
        :class="{ active: activeTool === t.key }"
        @click="activeTool = t.key"
      >
        <v-icon size="12">{{ t.icon }}</v-icon>
        <span class="tool-label">{{ t.label }}</span>
      </button>
    </div>
    <div class="tool-body">
      <PubSubMonitor v-if="activeTool === 'pubsub'" :conn-id="connId" />
      <SlowlogViewer v-if="activeTool === 'slowlog'" :conn-id="connId" />
      <BigKeyScanner v-if="activeTool === 'bigkey'" :conn-id="connId" />
      <MemoryAnalyzer v-if="activeTool === 'memory'" :conn-id="connId" />
    </div>
  </div>
</template>

<style scoped>
.redis-tools {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}
.tool-tabs {
  display: flex;
  align-items: center;
  padding: 4px 8px;
  border-bottom: 1px solid var(--line);
  flex-shrink: 0;
  gap: 2px;
  overflow-x: auto;
}
.tool-label {
  font-size: 11px;
}
.tool-body {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}
</style>
