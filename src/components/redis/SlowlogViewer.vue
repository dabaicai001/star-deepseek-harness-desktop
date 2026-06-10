<script setup lang="ts">
import { ref, onMounted } from 'vue'
import * as dbService from '@/services/db'
import type { SlowlogEntry } from '@/types/db'

const props = defineProps<{ connId: string }>()

const entries = ref<SlowlogEntry[]>([])
const count = ref(50)
const loading = ref(false)

function formatDuration(us: number): string {
  if (us < 1000) return `${us}us`
  if (us < 1_000_000) return `${Math.round(us / 1000)}ms`
  return `${((us / 1_000_000) * 10 / 10).toFixed(1)}s`
}

function durationColor(us: number): string {
  if (us > 500_000) return 'var(--red)'
  if (us > 100_000) return 'var(--yellow)'
  return 'var(--muted)'
}

function formatTime(ts: number): string {
  const d = new Date(ts * 1000)
  return d.toLocaleString()
}

async function load() {
  if (!props.connId) return
  loading.value = true
  try {
    entries.value = await dbService.redisSlowlogGet(props.connId, count.value)
  } catch (err: unknown) {
    console.error('Slowlog load failed:', err)
  } finally {
    loading.value = false
  }
}

async function reset() {
  if (!props.connId) return
  try {
    await dbService.redisSlowlogReset(props.connId)
    await load()
  } catch (err: unknown) {
    console.error('Slowlog reset failed:', err)
  }
}

onMounted(() => {
  load()
})
</script>

<template>
  <div class="slowlog-viewer">
    <div class="tool-toolbar">
      <select v-model.number="count" class="cyber-input" style="width: 80px;" @change="load">
        <option :value="10">Top 10</option>
        <option :value="25">Top 25</option>
        <option :value="50">Top 50</option>
        <option :value="100">Top 100</option>
      </select>
      <button class="action-btn" title="Refresh" :disabled="loading" @click="load">
        <v-icon size="14">mdi-refresh</v-icon>
      </button>
    </div>

    <div class="slowlog-table">
      <div class="table-header">
        <span style="width: 60px;">ID</span>
        <span style="width: 80px;">Duration</span>
        <span style="width: 100px;">Time</span>
        <span style="flex: 1;">Command</span>
      </div>
      <div v-for="entry in entries" :key="entry.id" class="table-row">
        <span class="col-id">{{ entry.id }}</span>
        <span class="col-duration" :style="{ color: durationColor(entry.duration) }">
          {{ formatDuration(entry.duration) }}
        </span>
        <span class="col-time">{{ formatTime(entry.timestamp) }}</span>
        <span class="col-command">{{ entry.command }}</span>
      </div>
      <div v-if="entries.length === 0 && !loading" class="empty-message">
        No slowlog entries found.
      </div>
    </div>

    <div class="tool-footer">
      <button class="cyber-btn-secondary" @click="reset">Reset Slowlog</button>
    </div>
  </div>
</template>

<style scoped>
.slowlog-viewer {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}
.tool-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px;
  border-bottom: 1px solid var(--line);
  flex-shrink: 0;
}
.tool-toolbar .cyber-input {
  padding: 4px 8px;
  font-size: 11px;
  font-family: 'JetBrains Mono', monospace;
}
.slowlog-table {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}
.table-header {
  display: flex;
  align-items: center;
  padding: 6px 12px;
  background: var(--panel-solid-2);
  font-size: 10px;
  font-weight: 700;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-family: 'Outfit', sans-serif;
  position: sticky;
  top: 0;
  z-index: 1;
}
.table-row {
  display: flex;
  align-items: center;
  padding: 4px 12px;
  border-bottom: 1px solid var(--line-2);
}
.col-id {
  width: 60px;
  font-size: 10px;
  color: var(--muted);
  font-family: 'JetBrains Mono', monospace;
}
.col-duration {
  width: 80px;
  font-size: 12px;
  font-family: 'JetBrains Mono', monospace;
  font-weight: 600;
}
.col-time {
  width: 100px;
  font-size: 11px;
  color: var(--text-2);
  font-family: 'JetBrains Mono', monospace;
}
.col-command {
  flex: 1;
  font-size: 12px;
  font-family: 'JetBrains Mono', monospace;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.empty-message {
  padding: 32px 16px;
  text-align: center;
  font-size: 12px;
  color: var(--muted);
  font-family: 'Outfit', sans-serif;
}
.tool-footer {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-top: 1px solid var(--line);
  flex-shrink: 0;
}
.tool-footer .cyber-btn-secondary {
  padding: 4px 12px;
  font-size: 11px;
}
</style>
