<script setup lang="ts">
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import * as dbService from '@/services/db'
import { generateDropColumnDDL } from '@/utils/ddlGenerator'
import type { ColumnMeta } from '@/types/db'

const { t } = useI18n()

const props = defineProps<{
  connId: string
  db: string
  table: string
  modelValue: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [v: boolean]
  reload: []
}>()

const columns = ref<ColumnMeta[]>([])
const selectedColumn = ref('')
const executing = ref(false)
const error = ref<string | null>(null)

watch(() => props.modelValue, async (v) => {
  if (!v) return
  error.value = null
  selectedColumn.value = ''
  try {
    columns.value = await dbService.mysqlListColumns(props.connId, props.table, props.db)
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : String(err)
  }
})

async function drop() {
  if (!selectedColumn.value) return
  executing.value = true
  error.value = null
  try {
    const ddl = generateDropColumnDDL(props.db, props.table, selectedColumn.value)
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
        <v-icon size="16" color="var(--red)">mdi-delete-circle</v-icon>
        <span class="dialog-title">{{ t('db.dropColumnTitle') }}</span>
        <span class="dialog-subtitle">{{ db }}.{{ table }}</span>
        <v-spacer />
        <v-btn variant="text" size="small" icon="mdi-close" @click="emit('update:modelValue', false)" />
      </div>

      <div class="dialog-body" style="padding: 16px; display: flex; flex-direction: column; gap: 12px;">
        <div v-if="error" class="dialog-error">{{ error }}</div>

        <div class="form-row">
          <label class="form-label">{{ t('db.column') }}</label>
          <select v-model="selectedColumn" class="cyber-select" style="flex: 1;">
            <option value="">{{ t('db.selectColumn') }}</option>
            <option v-for="c in columns" :key="c.name" :value="c.name">{{ c.name }} ({{ c.type }})</option>
          </select>
        </div>

        <div class="warning-box">
          <v-icon size="16" color="var(--red)">mdi-alert</v-icon>
          <span>{{ t('db.dropColumnWarning') }}</span>
        </div>
      </div>

      <div class="dialog-footer">
        <button class="cyber-btn-secondary" @click="emit('update:modelValue', false)">{{ t('common.cancel') }}</button>
        <button class="cyber-btn" style="background: var(--red);" :disabled="executing || !selectedColumn" @click="drop">
          <v-icon size="14" :class="{ spin: executing }">{{ executing ? 'mdi-loading' : 'mdi-delete' }}</v-icon>
          {{ t('db.dropColumn') }}
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
.warning-box {
  display: flex; align-items: flex-start; gap: 8px; padding: 10px 12px;
  background: var(--status-error-bg); border-radius: 6px; font-size: 11px; color: var(--red);
}
.spin { animation: spin 1s linear infinite; }
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
</style>
