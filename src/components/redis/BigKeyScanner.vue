<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import * as dbService from '@/services/db'
import type { BigKeyEntry } from '@/types/db'

const props = defineProps<{ connId: string }>()
const { t } = useI18n()

const results = ref<BigKeyEntry[]>([])
const scanning = ref(false)
const strThreshold = ref(10240)
const memThreshold = ref(1000)
const error = ref('')

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

function formatLength(len: number): string {
  if (len < 1000) return String(len)
  if (len < 1_000_000) return `${(len / 1000).toFixed(1)}K`
  return `${(len / 1_000_000).toFixed(1)}M`
}

function sizeColor(bytes: number): string {
  if (bytes > 10 * 1024 * 1024) return 'var(--red)'
  if (bytes > 1 * 1024 * 1024) return 'var(--yellow)'
  return 'var(--muted)'
}

function lengthColor(len: number): string {
  if (len > 100_000) return 'var(--red)'
  if (len > 10_000) return 'var(--yellow)'
  return 'var(--muted)'
}

function typeIcon(typ: string): string {
  switch (typ) {
    case 'string': return 'mdi-format-text'
    case 'hash': return 'mdi-pound'
    case 'list': return 'mdi-format-list-bulleted'
    case 'set': return 'mdi-set'
    case 'zset': return 'mdi-sort'
    default: return 'mdi-help-circle-outline'
  }
}

async function startScan() {
  if (!props.connId) return
  scanning.value = true
  error.value = ''
  try {
    results.value = (await dbService.redisBigKeyScan(props.connId, '', strThreshold.value, memThreshold.value)) ?? []
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    scanning.value = false
  }
}

function cancelScan() {
  // 后端扫描无法中途取消，仅重置 UI 状态并清空结果
  scanning.value = false
  results.value = []
}
</script>

<template>
  <div class="bigkey-scanner">
    <div class="scan-config">
      <div class="config-row">
        <span class="field-label">{{ t('redis.stringThreshold') }}</span>
        <input
          v-model.number="strThreshold"
          type="number"
          class="cyber-input"
          :placeholder="t('redis.bytes')"
        />
        <span class="unit-label">{{ t('redis.bytes') }}</span>
      </div>
      <div class="config-row">
        <span class="field-label">{{ t('redis.collectionThreshold') }}</span>
        <input
          v-model.number="memThreshold"
          type="number"
          class="cyber-input"
          :placeholder="t('redis.members')"
        />
        <span class="unit-label">{{ t('redis.members') }}</span>
      </div>
      <div class="config-actions">
        <button class="cyber-btn" :disabled="scanning" @click="startScan">
          <v-icon v-if="scanning" size="12" class="spin" style="margin-right: 4px;">mdi-loading</v-icon>
          {{ t('redis.startScan') }}
        </button>
        <button v-if="scanning" class="cyber-btn-secondary" @click="cancelScan">{{ t('redis.cancel') }}</button>
      </div>
      <div v-if="error" class="scan-error">{{ error }}</div>
    </div>

    <div v-if="scanning" class="scan-progress">
      <span>{{ t('redis.scanning') }} {{ t('redis.bigKeysFound', { count: results.length }) }}</span>
    </div>

    <div class="results-table">
      <div class="table-header">
        <span style="flex: 1;">{{ t('redis.colKey') }}</span>
        <span style="width: 80px;">{{ t('redis.colType') }}</span>
        <span style="width: 100px;">{{ t('redis.colSize') }}</span>
        <span style="width: 100px;">{{ t('redis.colLength') }}</span>
      </div>
      <div v-for="entry in results" :key="entry.key" class="table-row">
        <span class="col-key">{{ entry.key }}</span>
        <span class="col-type">
          <v-icon size="12">{{ typeIcon(entry.type) }}</v-icon>
          {{ entry.type }}
        </span>
        <span class="col-size" :style="{ color: sizeColor(entry.size) }">
          {{ formatSize(entry.size) }}
        </span>
        <span class="col-length" :style="{ color: lengthColor(entry.length) }">
          {{ formatLength(entry.length) }}
        </span>
      </div>
      <div v-if="results.length === 0 && !scanning" class="empty-message">
        {{ t('redis.noBigKeys') }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.bigkey-scanner {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}
.scan-config {
  padding: 8px;
  border-bottom: 1px solid var(--line);
  flex-shrink: 0;
}
.config-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.field-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-2);
  font-family: 'Outfit', sans-serif;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  flex-shrink: 0;
  min-width: 80px;
}
.config-row .cyber-input {
  padding: 4px 8px;
  font-size: 11px;
  font-family: 'JetBrains Mono', monospace;
  width: 120px;
}
.unit-label {
  font-size: 11px;
  color: var(--muted);
  font-family: 'JetBrains Mono', monospace;
}
.config-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}
.config-actions .cyber-btn {
  padding: 6px 14px;
  font-size: 12px;
}
.config-actions .cyber-btn-secondary {
  padding: 6px 14px;
  font-size: 12px;
}
.scan-error {
  margin-top: 6px;
  font-size: 11px;
  color: var(--red);
  font-family: 'JetBrains Mono', monospace;
}
.scan-progress {
  padding: 8px;
  text-align: center;
}
.scan-progress span {
  font-family: 'JetBrains Mono', monospace;
  font-size: 12px;
  color: var(--cyan);
}
.results-table {
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
.col-key {
  flex: 1;
  font-size: 12px;
  font-family: 'JetBrains Mono', monospace;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.col-type {
  width: 80px;
  font-size: 11px;
  font-family: 'JetBrains Mono', monospace;
  color: var(--text-2);
  display: flex;
  align-items: center;
  gap: 4px;
}
.col-size {
  width: 100px;
  font-size: 12px;
  font-family: 'JetBrains Mono', monospace;
  font-weight: 600;
}
.col-length {
  width: 100px;
  font-size: 12px;
  font-family: 'JetBrains Mono', monospace;
  font-weight: 600;
}
.empty-message {
  padding: 32px 16px;
  text-align: center;
  font-size: 12px;
  color: var(--muted);
  font-family: 'Outfit', sans-serif;
}
.spin { animation: spin 1s linear infinite; }
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
</style>
