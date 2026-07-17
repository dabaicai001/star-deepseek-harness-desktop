<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import * as dbService from '@/services/db'
import { generateDropIndexDDL } from '@/utils/ddlGenerator'
import type { IndexInfo } from '@/types/db'

const { t } = useI18n()

const props = defineProps<{
  connId: string
  db: string
  table: string
  modelValue: boolean
  indexName?: string
}>()

const emit = defineEmits<{
  'update:modelValue': [v: boolean]
  reload: []
}>()

const indexes = ref<IndexInfo[]>([])
const selectedIndex = ref('')
const executing = ref(false)
const error = ref<string | null>(null)

const selectedIndexInfo = computed(() => {
  if (!selectedIndex.value) return null
  const cols = indexes.value
    .filter(i => i.keyName === selectedIndex.value)
    .map(i => i.columnName)
  return { name: selectedIndex.value, columns: cols }
})

watch(() => props.modelValue, async (v) => {
  if (!v) return
  error.value = null
  try {
    indexes.value = await dbService.mysqlListIndexes(props.connId, props.table, props.db)
    // 预选指定索引名(来自 IndexListDialog 传入)
    if (props.indexName && indexNames.value.includes(props.indexName)) {
      selectedIndex.value = props.indexName
    } else {
      selectedIndex.value = ''
    }
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : String(err)
  }
})

const indexNames = computed(() => [...new Set(indexes.value.map(i => i.keyName))])

async function drop() {
  if (!selectedIndex.value) return
  executing.value = true
  error.value = null
  try {
    const ddl = generateDropIndexDDL(props.db, props.table, selectedIndex.value)
    const r = await dbService.mysqlExecute(props.connId, ddl)
    if (r.error) throw new Error(r.error)
    emit('reload')
    emit('update:modelValue', false)
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    executing.value = false
  }
}
</script>

<template>
  <v-dialog :model-value="modelValue" @update:model-value="emit('update:modelValue', $event)" max-width="400">
    <div class="cyber-panel" style="padding: 0;">
      <div class="dialog-header">
        <v-icon size="16" color="var(--red)">mdi-key-remove</v-icon>
        <span class="dialog-title">{{ t('db.dropIndexTitle') }}</span>
        <span class="dialog-subtitle">{{ db }}.{{ table }}</span>
        <v-spacer />
        <button class="action-btn" @click="emit('update:modelValue', false)">
            <v-icon size="16">mdi-close</v-icon>
          </button>
      </div>

      <div class="dialog-body" style="padding: 16px; display: flex; flex-direction: column; gap: 12px;">
        <div v-if="error" class="dialog-error">{{ error }}</div>

        <div class="form-row">
          <label class="form-label">{{ t('db.index') }}</label>
          <select v-model="selectedIndex" class="cyber-select" style="flex: 1;">
            <option value="">{{ t('db.selectIndex') }}</option>
            <option v-for="name in indexNames" :key="name" :value="name">{{ name }}</option>
          </select>
        </div>

        <div v-if="selectedIndexInfo" class="info-box">
          <code>{{ selectedIndexInfo.columns.join(', ') }}</code>
        </div>

        <div class="warning-box">
          <v-icon size="16" color="var(--red)">mdi-alert</v-icon>
          <span>{{ t('db.dropIndexWarning') }}</span>
        </div>
      </div>

      <div class="dialog-footer">
        <button class="cyber-btn-secondary" @click="emit('update:modelValue', false)">{{ t('common.cancel') }}</button>
        <button class="cyber-btn" style="background: var(--red);" :disabled="executing || !selectedIndex" @click="drop">
          <v-icon size="14" :class="{ spin: executing }">{{ executing ? 'mdi-loading' : 'mdi-delete' }}</v-icon>
          {{ t('db.dropIndex') }}
        </button>
      </div>
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
.dialog-error { padding: 8px 12px; font-size: 11px; color: var(--red); background: rgba(255,77,109,.08); border-radius: 6px; }
.dialog-footer {
  display: flex; justify-content: flex-end; gap: 8px;
  padding: 10px 16px; border-top: 1px solid var(--line); flex-shrink: 0;
}
.form-row { display: flex; align-items: center; gap: 12px; }
.form-label { width: 80px; font-size: 11px; color: var(--muted); text-align: right; text-transform: uppercase; letter-spacing: 0.06em; }
.info-box {
  padding: 8px 12px; background: var(--panel-solid); border-radius: 6px;
  font-size: 11px; font-family: 'JetBrains Mono', monospace; color: var(--cyan);
}
.warning-box {
  display: flex; align-items: flex-start; gap: 8px; padding: 10px 12px;
  background: var(--status-error-bg); border-radius: 6px; font-size: 11px; color: var(--red);
}
.spin { animation: spin 1s linear infinite; }
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
</style>
