<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import * as dbService from '@/services/db'
import type { IndexInfo } from '@/types/db'

const { t } = useI18n()

const props = defineProps<{
  connId: string
  db: string
  table: string
  modelValue: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [v: boolean]
  'create-index': []
  'modify-index': [indexName: string]
  'drop-index': [indexName: string]
}>()

const indexes = ref<IndexInfo[]>([])
const loading = ref(false)
const error = ref<string | null>(null)
const selectedIndex = ref<string | null>(null)

watch(() => props.modelValue, async (v) => {
  if (!v) return
  loading.value = true
  error.value = null
  try {
    console.log('IndexListDialog: loading indexes for', props.connId, props.db, props.table)
    indexes.value = await dbService.mysqlListIndexes(props.connId, props.table, props.db)
    console.log('IndexListDialog: got', indexes.value.length, 'indexes', indexes.value)
  } catch (err: unknown) {
    console.error('IndexListDialog: failed to load indexes', err)
    error.value = err instanceof Error ? err.message : String(err)
    indexes.value = []
  } finally {
    loading.value = false
  }
})

const groupedIndexes = computed(() => {
  const map = new Map<string, { nonUnique: number; indexType: string; comment: string; columns: string[] }>()
  for (const idx of indexes.value) {
    if (!map.has(idx.keyName)) {
      map.set(idx.keyName, { nonUnique: idx.nonUnique, indexType: idx.indexType, comment: idx.indexComment, columns: [] })
    }
    map.get(idx.keyName)!.columns.push(idx.columnName)
  }
  return Array.from(map.entries()).map(([name, info]) => ({ name, ...info }))
})
</script>

<template>
  <v-dialog :model-value="modelValue" @update:model-value="emit('update:modelValue', $event)" max-width="640">
    <div class="cyber-panel" style="padding: 0; max-height: 70vh; display: flex; flex-direction: column;">
      <div class="dialog-header">
        <v-icon size="16" color="var(--yellow)">mdi-key-variant</v-icon>
        <span class="dialog-title">{{ t('db.indexesTitle') }}</span>
        <span class="dialog-subtitle">{{ db }}.{{ table }}</span>
        <v-spacer />
        <v-btn variant="text" size="small" icon="mdi-close" @click="emit('update:modelValue', false)" />
      </div>

      <div v-if="loading" class="dialog-loading">
        <v-icon size="20" class="spin">mdi-loading</v-icon>
        {{ t('db.loadingIndexes') }}
      </div>

      <template v-else>
        <div v-if="error" class="dialog-error">{{ error }}</div>
        <div class="dialog-scroll" style="flex: 1; overflow: auto; min-height: 0;">
          <table class="struct-table">
            <thead>
              <tr>
                <th>{{ t('db.indexName') }}</th>
                <th>{{ t('db.indexColumns') }}</th>
                <th style="width: 80px;">{{ t('db.uniqueTitle') }}</th>
                <th style="width: 80px;">{{ t('db.type') }}</th>
                <th>{{ t('db.comment') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="groupedIndexes.length === 0">
                <td colspan="5" style="text-align: center; color: var(--muted); padding: 24px;">{{ t('db.noIndexes') }}</td>
              </tr>
              <tr v-for="idx in groupedIndexes" :key="idx.name"
                :class="{ 'row-selected': selectedIndex === idx.name }"
                @click="selectedIndex = idx.name">
                <td>
                  <span style="font-weight: 600; color: var(--text);">{{ idx.name }}</span>
                </td>
                <td><code style="font-size: 11px;">{{ idx.columns.join(', ') }}</code></td>
                <td class="td-center">
                  <span :style="{ color: idx.nonUnique ? 'var(--muted)' : 'var(--green)' }">
                    {{ idx.nonUnique ? 'No' : 'Yes' }}
                  </span>
                </td>
                <td class="td-center">
                  <span class="key-badge">{{ idx.indexType }}</span>
                </td>
                <td style="color: var(--muted); font-size: 11px;">{{ idx.comment || '-' }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="dialog-footer">
          <button class="cyber-btn" @click="emit('create-index')">
            <v-icon size="14">mdi-key-plus</v-icon>
            {{ t('db.createIndex') }}
          </button>
          <button
            class="cyber-btn-secondary"
            :disabled="!selectedIndex"
            @click="selectedIndex && emit('modify-index', selectedIndex)"
          >
            <v-icon size="14">mdi-key-edit</v-icon>
            {{ t('db.modifyIndex') }}
          </button>
          <div class="footer-spacer"></div>
          <button
            class="cyber-btn-danger"
            :disabled="!selectedIndex"
            @click="selectedIndex && emit('drop-index', selectedIndex)"
          >
            <v-icon size="14">mdi-key-remove</v-icon>
            {{ t('db.deleteIndex') }}
          </button>
          <button class="action-btn" @click="emit('update:modelValue', false)" :title="t('common.cancel')">
            <v-icon size="14">mdi-close</v-icon>
          </button>
        </div>
      </template>
    </div>
  </v-dialog>
</template>

<style scoped>
.dialog-header {
  display: flex; align-items: center; gap: 8px;
  padding: 12px 16px; border-bottom: 1px solid var(--line); flex-shrink: 0;
}
.dialog-title { font-weight: 600; font-size: 14px; color: var(--text); }
.dialog-subtitle { font-size: 11px; color: var(--muted); font-family: 'JetBrains Mono', monospace; }
.dialog-loading { padding: 16px; text-align: center; }
.dialog-footer {
  display: flex; align-items: center; gap: 8px;
  padding: 10px 16px; border-top: 1px solid var(--line); flex-shrink: 0;
}
.footer-spacer { flex: 1; }
.row-selected {
  background: rgba(0, 240, 255, 0.06);
}
.row-selected td:first-child {
  border-left: 2px solid var(--cyan);
}
.struct-table tr {
  cursor: pointer;
}
.struct-table tr:hover {
  background: rgba(0, 240, 255, 0.03);
}
.cyber-btn-danger {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 6px 14px; border-radius: 6px;
  font-size: 12px; font-weight: 500; font-family: inherit;
  color: var(--red);
  background: transparent;
  border: 1px solid rgba(255, 77, 109, 0.3);
  cursor: pointer;
  transition: all 0.2s;
}
.cyber-btn-danger:hover:not(:disabled) {
  background: rgba(255, 77, 109, 0.1);
  border-color: var(--red);
}
.cyber-btn-danger:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
.struct-table { width: 100%; border-collapse: collapse; font-size: 12px; font-family: 'JetBrains Mono', monospace; }
.struct-table thead { position: sticky; top: 0; z-index: 1; background: var(--panel-solid-2); }
.struct-table th { text-align: left; padding: 6px 10px; color: var(--muted); font-size: 10px; border-bottom: 1px solid var(--line-2); }
.struct-table td { padding: 6px 10px; border-bottom: 1px solid var(--line); }
.td-center { text-align: center; }
.key-badge { font-size: 9px; padding: 1px 5px; border-radius: 3px; background: rgba(0,240,255,.12); color: var(--cyan); }
.spin { animation: spin 1s linear infinite; }
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
</style>
