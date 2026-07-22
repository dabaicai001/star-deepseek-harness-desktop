<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import * as dbService from '@/services/db'
import type { MemoryAnalysisEntry } from '@/types/db'

const props = defineProps<{ connId: string }>()
const { t } = useI18n()

const entries = ref<MemoryAnalysisEntry[]>([])
const loading = ref(false)
const sampleSize = ref(0)
const error = ref('')

function formatMemory(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

const totalKeys = computed(() => entries.value.reduce((sum, e) => sum + e.keys, 0))
const totalMemory = computed(() => {
  const bytes = entries.value.reduce((sum, e) => sum + e.memory, 0)
  return formatMemory(bytes)
})

async function analyze() {
  if (!props.connId) return
  loading.value = true
  error.value = ''
  try {
    entries.value = (await dbService.redisMemoryAnalysis(props.connId, '', sampleSize.value)) ?? []
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="memory-analyzer">
    <div class="analyze-config">
      <button class="cyber-btn" :disabled="loading" @click="analyze">
        <v-icon v-if="loading" size="12" class="spin" style="margin-right: 4px;">mdi-loading</v-icon>
        {{ loading ? t('redis.analyzing') : t('redis.analyze') }}
      </button>
      <span class="field-label">{{ t('redis.sample') }}</span>
      <select v-model.number="sampleSize" class="cyber-input" style="width: 100px;">
        <option :value="10">{{ t('redis.sampleKeys', { count: 10 }) }}</option>
        <option :value="50">{{ t('redis.sampleKeys', { count: 50 }) }}</option>
        <option :value="100">{{ t('redis.sampleKeys', { count: 100 }) }}</option>
        <option :value="0">{{ t('redis.sampleAll') }}</option>
      </select>
      <div v-if="error" class="analyze-error">{{ error }}</div>
    </div>

    <div class="memory-table">
      <div class="table-header">
        <span style="flex: 1;">{{ t('redis.colPrefix') }}</span>
        <span style="width: 80px;">{{ t('redis.colKeys') }}</span>
        <span style="width: 100px;">{{ t('redis.colMemory') }}</span>
        <span style="width: 80px;">{{ t('redis.colPercent') }}</span>
      </div>
      <div v-for="entry in entries" :key="entry.prefix" class="table-row">
        <div class="row-main">
          <span class="col-prefix">{{ entry.prefix || t('redis.root') }}</span>
          <span class="col-keys">{{ entry.keys }}</span>
          <span class="col-memory">{{ formatMemory(entry.memory) }}</span>
          <span class="col-pct">{{ entry.percentage.toFixed(1) }}%</span>
        </div>
        <div class="pct-bar">
          <div class="pct-fill" :style="{ width: Math.max(entry.percentage, 0.5) + '%' }"></div>
        </div>
      </div>
      <div v-if="entries.length === 0 && !loading" class="empty-message">
        {{ t('redis.noMemoryData') }}
      </div>
    </div>

    <div v-if="entries.length" class="summary-footer">
      <span>{{ t('redis.total') }}: {{ totalKeys }} keys | {{ totalMemory }}</span>
    </div>
  </div>
</template>

<style scoped>
.memory-analyzer {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}
.analyze-config {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px;
  border-bottom: 1px solid var(--line);
  flex-shrink: 0;
  flex-wrap: wrap;
}
.field-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-2);
  font-family: 'Outfit', sans-serif;
}
.analyze-config .cyber-input {
  padding: 4px 8px;
  font-size: 11px;
  font-family: 'JetBrains Mono', monospace;
}
.analyze-config .cyber-btn {
  padding: 6px 14px;
  font-size: 12px;
}
.analyze-error {
  width: 100%;
  font-size: 11px;
  color: var(--red);
  font-family: 'JetBrains Mono', monospace;
  margin-top: 4px;
}
.memory-table {
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
  padding: 4px 12px;
  border-bottom: 1px solid var(--line-2);
}
.row-main {
  display: flex;
  align-items: center;
}
.col-prefix {
  flex: 1;
  font-size: 12px;
  font-family: 'JetBrains Mono', monospace;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.col-keys {
  width: 80px;
  font-size: 11px;
  color: var(--muted);
  font-family: 'JetBrains Mono', monospace;
}
.col-memory {
  width: 100px;
  font-size: 12px;
  color: var(--cyan);
  font-family: 'JetBrains Mono', monospace;
  font-weight: 600;
}
.col-pct {
  width: 80px;
  font-size: 11px;
  color: var(--text-2);
  font-family: 'JetBrains Mono', monospace;
}
.pct-bar {
  margin-top: 4px;
  height: 6px;
  border-radius: 3px;
  background: var(--line);
  overflow: hidden;
}
.pct-fill {
  height: 6px;
  border-radius: 3px;
  background: var(--cyan);
  min-width: 2px;
  transition: width 0.4s cubic-bezier(0.4, 0, 0.2, 1);
}
.empty-message {
  padding: 32px 16px;
  text-align: center;
  font-size: 12px;
  color: var(--muted);
  font-family: 'Outfit', sans-serif;
}
.summary-footer {
  padding: 8px;
  border-top: 1px solid var(--line);
  flex-shrink: 0;
}
.summary-footer span {
  font-family: 'JetBrains Mono', monospace;
  font-size: 12px;
  color: var(--text-2);
}
.spin { animation: spin 1s linear infinite; }
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
</style>
