<script setup lang="ts">
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import * as dbService from '@/services/db'
import { generateCreateIndexDDL, generateDropIndexDDL } from '@/utils/ddlGenerator'
import type { ColumnMeta } from '@/types/db'

const { t } = useI18n()

const props = defineProps<{
  connId: string
  db: string
  table: string
  mode: 'create' | 'modify'
  index?: { name: string; columns: string[]; unique: boolean; indexType: string }
  modelValue: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [v: boolean]
  reload: []
}>()

const columns = ref<ColumnMeta[]>([])
const indexName = ref('')
const selectedColumns = ref<string[]>([])
const unique = ref(false)
const indexType = ref('BTREE')
const executing = ref(false)
const error = ref<string | null>(null)

const indexTypeOptions = ['BTREE', 'HASH', 'FULLTEXT']

watch(() => props.modelValue, async (v) => {
  if (!v) return
  error.value = null
  try {
    columns.value = await dbService.mysqlListColumns(props.connId, props.table, props.db)
  } catch (err: unknown) {
    console.error('IndexFormDialog: failed to load columns', err)
    error.value = err instanceof Error ? err.message : String(err)
    columns.value = []
  }
  if (props.mode === 'modify' && props.index) {
    indexName.value = props.index.name
    selectedColumns.value = [...props.index.columns]
    unique.value = props.index.unique
    indexType.value = props.index.indexType
  } else {
    indexName.value = ''
    selectedColumns.value = []
    unique.value = false
    indexType.value = 'BTREE'
  }
})

function toggleColumn(name: string) {
  const idx = selectedColumns.value.indexOf(name)
  if (idx >= 0) selectedColumns.value.splice(idx, 1)
  else selectedColumns.value.push(name)
}

async function submit() {
  if (!indexName.value.trim() || selectedColumns.value.length === 0) return
  executing.value = true
  error.value = null
  try {
    if (props.mode === 'modify' && props.index) {
      const dropDDL = generateDropIndexDDL(props.db, props.table, props.index.name)
      const r1 = await dbService.mysqlExecute(props.connId, dropDDL)
      if (r1.error) throw new Error(r1.error)
    }
    const createDDL = generateCreateIndexDDL(props.db, props.table, indexName.value.trim(), selectedColumns.value, unique.value, indexType.value)
    const r2 = await dbService.mysqlExecute(props.connId, createDDL)
    if (r2.error) throw new Error(r2.error)
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
  <v-dialog :model-value="modelValue" @update:model-value="emit('update:modelValue', $event)" max-width="480">
    <div class="cyber-panel" style="padding: 0;">
      <div class="dialog-header">
        <v-icon size="16" color="var(--yellow)">
          {{ mode === 'create' ? 'mdi-key-plus' : 'mdi-key-edit' }}
        </v-icon>
        <span class="dialog-title">{{ mode === 'create' ? t('db.createIndexTitle') : t('db.modifyIndexTitle') }}</span>
        <span class="dialog-subtitle">{{ db }}.{{ table }}</span>
        <v-spacer />
        <button class="action-btn" @click="emit('update:modelValue', false)">
            <v-icon size="16">mdi-close</v-icon>
          </button>
      </div>

      <div class="dialog-body" style="padding: 16px; display: flex; flex-direction: column; gap: 12px;">
        <div v-if="error" class="dialog-error">{{ error }}</div>

        <div class="form-row">
          <label class="form-label">{{ t('db.indexName') }}</label>
          <input v-model="indexName" class="cyber-input" style="flex: 1;" placeholder="idx_name" />
        </div>

        <div class="form-row" style="align-items: flex-start;">
          <label class="form-label">{{ t('db.indexColumns') }}</label>
          <div class="col-check-list">
            <label v-for="c in columns" :key="c.name" class="col-check-item">
              <input type="checkbox" :checked="selectedColumns.includes(c.name)" @change="toggleColumn(c.name)" />
              <span>{{ c.name }}</span>
              <span class="col-type-hint">{{ c.type }}</span>
            </label>
          </div>
        </div>

        <div class="form-row">
          <label class="form-label">{{ t('db.indexType') }}</label>
          <select v-model="indexType" class="cyber-select" style="flex: 1;">
            <option v-for="t in indexTypeOptions" :key="t" :value="t">{{ t }}</option>
          </select>
        </div>

        <div class="form-row">
          <label class="form-label">{{ t('db.uniqueTitle') }}</label>
          <input type="checkbox" v-model="unique" :disabled="indexType === 'FULLTEXT'" />
        </div>
      </div>

      <div class="dialog-footer">
        <button class="cyber-btn-secondary" @click="emit('update:modelValue', false)">{{ t('common.cancel') }}</button>
        <button class="cyber-btn" :disabled="executing || !indexName.trim() || selectedColumns.length === 0" @click="submit">
          <v-icon size="14" :class="{ spin: executing }">{{ executing ? 'mdi-loading' : 'mdi-check' }}</v-icon>
          {{ mode === 'create' ? t('db.createIndex') : t('db.saveChanges') }}
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
.form-label { width: 80px; font-size: 11px; color: var(--muted); text-align: right; text-transform: uppercase; letter-spacing: 0.06em; flex-shrink: 0; }
.col-check-list {
  flex: 1; max-height: 200px; overflow: auto;
  display: flex; flex-direction: column; gap: 4px;
  padding: 8px; background: var(--panel-solid); border-radius: 6px; border: 1px solid var(--line-2);
}
.col-check-item {
  display: flex; align-items: center; gap: 6px; font-size: 12px;
  font-family: 'JetBrains Mono', monospace; cursor: pointer; padding: 2px 0;
}
.col-type-hint { font-size: 10px; color: var(--muted); }
.spin { animation: spin 1s linear infinite; }
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
</style>
