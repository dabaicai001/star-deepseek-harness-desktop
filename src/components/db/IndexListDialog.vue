<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import * as dbService from '@/services/db'
import { generateBatchIndexDDL } from '@/utils/ddlGenerator'
import type { IndexInfo } from '@/types/db'
import type { IndexEdit } from '@/utils/ddlGenerator'

const INDEX_TYPES = ['BTREE', 'HASH', 'FULLTEXT', 'SPATIAL']

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

const indexes = ref<IndexInfo[]>([])
const edits = ref<Map<string, IndexEdit>>(new Map())
const loading = ref(false)
const executing = ref(false)
const error = ref<string | null>(null)
const successMsg = ref<string | null>(null)
const searchText = ref('')

const newIdx = ref({ name: '', columns: '', unique: false, indexType: 'BTREE' })

const groupedEdits = computed(() => Array.from(edits.value.values()))

const filteredEdits = computed(() => {
  if (!searchText.value) return groupedEdits.value
  const q = searchText.value.toLowerCase()
  return groupedEdits.value.filter(e => e.name.toLowerCase().includes(q))
})

async function load() {
  loading.value = true
  error.value = null
  try {
    indexes.value = await dbService.mysqlListIndexes(props.connId, props.table, props.db)
    resetEdits()
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

function resetEdits() {
  const map = new Map<string, IndexEdit>()
  // group by keyName
  const groups = new Map<string, { nonUnique: number; indexType: string; columns: string[] }>()
  for (const idx of indexes.value) {
    if (!groups.has(idx.keyName)) {
      groups.set(idx.keyName, { nonUnique: idx.nonUnique, indexType: idx.indexType, columns: [] })
    }
    groups.get(idx.keyName)!.columns.push(idx.columnName)
  }
  for (const [name, info] of groups) {
    map.set(name, {
      name,
      newName: name,
      columns: [...info.columns],
      newColumns: [...info.columns],
      unique: info.nonUnique === 0,
      newUnique: info.nonUnique === 0,
      indexType: info.indexType || 'BTREE',
      newIndexType: info.indexType || 'BTREE',
      dirty: false,
      dropped: false
    })
  }
  edits.value = map
  error.value = null
  successMsg.value = null
}

function markDirty(e: IndexEdit) {
  e.dirty =
    e.newName !== e.name ||
    String(e.newColumns) !== String(e.columns) ||
    e.newUnique !== e.unique ||
    e.newIndexType !== e.indexType
}

function toggleDrop(e: IndexEdit) {
  e.dropped = !e.dropped
  e.dirty = true
}

function resetEdit(e: IndexEdit) {
  e.newName = e.name
  e.newColumns = [...e.columns]
  e.newUnique = e.unique
  e.newIndexType = e.indexType
  e.dropped = false
  e.dirty = false
}

function addNewIdx() {
  const name = newIdx.value.name.trim()
  const cols = newIdx.value.columns
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
  if (!name || cols.length === 0) return
  const entry: IndexEdit = {
    name,
    newName: name,
    columns: cols,
    newColumns: cols,
    unique: newIdx.value.unique,
    newUnique: newIdx.value.unique,
    indexType: newIdx.value.indexType,
    newIndexType: newIdx.value.indexType,
    dirty: true,
    dropped: false
  }
  edits.value.set(name, entry)
  edits.value = new Map(edits.value)
  newIdx.value = { name: '', columns: '', unique: false, indexType: 'BTREE' }
}

async function applyChanges() {
  const list = groupedEdits.value
  const ddls = generateBatchIndexDDL(props.db, props.table, list)
  if (ddls.length === 0) return
  executing.value = true
  error.value = null
  successMsg.value = null
  try {
    for (const ddl of ddls) {
      const r = await dbService.mysqlExecute(props.connId, ddl)
      if (r.error) throw new Error(r.error)
    }
    successMsg.value = `Applied ${ddls.length} DDL statement(s)`
    emit('reload')
    await load()
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    executing.value = false
  }
}

watch(() => props.modelValue, (v) => { if (v) load() }, { immediate: true })
</script>

<template>
  <v-dialog :model-value="modelValue" @update:model-value="emit('update:modelValue', $event)" max-width="720">
    <div class="cyber-panel" style="padding: 0; max-height: 80vh; display: flex; flex-direction: column;">
      <div class="dialog-header">
        <v-icon size="16" color="var(--yellow)">mdi-key-variant</v-icon>
        <span class="dialog-title">{{ db }}.{{ table }}</span>
        <span class="dialog-subtitle">{{ groupedEdits.length }} indexes</span>
        <v-spacer />
        <v-btn variant="text" size="small" icon="mdi-close" @click="emit('update:modelValue', false)" />
      </div>

      <div class="search-row" style="padding: 8px 16px; border-bottom: 1px solid var(--line); display: flex; align-items: center;">
        <v-icon size="14" color="var(--muted)">mdi-magnify</v-icon>
        <input v-model="searchText" class="cyber-input" style="flex: 1; font-size: 11px; border: none; margin-left: 6px;" :placeholder="t('db.searchIndex') || '搜索索引名...'" />
        <v-icon v-if="searchText" size="12" @click="searchText = ''" style="cursor: pointer; color: var(--muted); margin-left: 4px;">mdi-close</v-icon>
      </div>

      <div v-if="loading" class="dialog-loading">
        <v-icon size="20" class="spin">mdi-loading</v-icon>
        {{ t('db.loadingIndexes') }}
      </div>

      <template v-else>
        <div v-if="error" class="dialog-error">{{ error }}</div>
        <div v-if="successMsg" class="dialog-success">{{ successMsg }}</div>

        <div class="dialog-scroll" style="flex: 1; overflow: auto; min-height: 0;">
          <table class="struct-table">
            <thead>
              <tr>
                <th style="width: 28px;">#</th>
                <th>{{ t('db.indexName') }}</th>
                <th>{{ t('db.indexColumns') }}</th>
                <th style="width: 56px;">{{ t('db.uniqueTitle') }}</th>
                <th style="width: 90px;">{{ t('db.type') }}</th>
                <th style="width: 64px;">{{ t('db.actions') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(e, idx) in filteredEdits" :key="e.name" :class="{ dirty: e.dirty, dropped: e.dropped }">
                <td class="td-idx">{{ idx + 1 }}</td>
                <td>
                  <input v-model="e.newName" class="cell-input" @input="markDirty(e)" />
                </td>
                <td>
                  <input
                    v-model="e.newColumns"
                    class="cell-input"
                    @input="markDirty(e)"
                    placeholder="col1, col2"
                  />
                </td>
                <td class="td-center">
                  <input type="checkbox" :checked="e.newUnique" @change="e.newUnique = ($event.target as HTMLInputElement).checked; markDirty(e)" />
                </td>
                <td>
                  <select v-model="e.newIndexType" class="cell-select" @change="markDirty(e)">
                    <option v-for="t in INDEX_TYPES" :key="t" :value="t">{{ t }}</option>
                  </select>
                </td>
                <td class="td-center">
                  <button class="action-btn-sm" :class="{ active: e.dropped }" @click="toggleDrop(e)" :title="t('db.dropIndex')">
                    <v-icon size="12" :color="e.dropped ? 'var(--red)' : undefined">mdi-delete-outline</v-icon>
                  </button>
                  <button v-if="e.dirty && !e.dropped" class="action-btn-sm" @click="resetEdit(e)" :title="t('common.reset')">
                    <v-icon size="12">mdi-undo</v-icon>
                  </button>
                </td>
              </tr>
            </tbody>
          </table>

          <div class="add-row">
            <input v-model="newIdx.name" class="cell-input" :placeholder="t('db.newIndex')" style="width: 120px;" @keyup.enter="addNewIdx" />
            <input v-model="newIdx.columns" class="cell-input" placeholder="col1, col2" style="width: 180px;" @keyup.enter="addNewIdx" />
            <label style="display: flex; align-items: center; gap: 2px; font-size: 10px;">
              <input type="checkbox" v-model="newIdx.unique" /> UNIQUE
            </label>
            <select v-model="newIdx.indexType" class="cell-select" style="width: 80px;">
              <option v-for="t in INDEX_TYPES" :key="t" :value="t">{{ t }}</option>
            </select>
            <button class="cyber-btn-secondary" @click="addNewIdx" style="padding: 2px 8px; font-size: 11px;">
              <v-icon size="12">mdi-plus</v-icon> {{ t('db.newIndex') }}
            </button>
          </div>
        </div>

        <div class="dialog-footer">
          <button class="cyber-btn-secondary" @click="emit('update:modelValue', false)">{{ t('common.cancel') }}</button>
          <button class="cyber-btn" :disabled="executing" @click="applyChanges">
            <v-icon size="14" :class="{ spin: executing }">{{ executing ? 'mdi-loading' : 'mdi-content-save' }}</v-icon>
            {{ t('db.applyChanges') }}
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
.dialog-loading, .dialog-error, .dialog-success {
  padding: 16px; text-align: center; font-size: 12px;
}
.dialog-error { color: var(--red); }
.dialog-success { color: var(--green); }
.dialog-footer {
  display: flex; justify-content: flex-end; gap: 8px;
  padding: 10px 16px; border-top: 1px solid var(--line); flex-shrink: 0;
}
.struct-table { width: 100%; border-collapse: collapse; font-size: 12px; font-family: 'JetBrains Mono', monospace; }
.struct-table thead { position: sticky; top: 0; z-index: 1; background: var(--panel-solid-2); }
.struct-table th { text-align: left; padding: 6px 8px; color: var(--muted); font-size: 10px; border-bottom: 1px solid var(--line-2); }
.struct-table td { padding: 4px 8px; border-bottom: 1px solid var(--line); }
.td-idx { width: 28px; text-align: right; color: var(--muted); font-size: 10px; }
.td-center { text-align: center; }
.cell-input {
  width: 100%; padding: 3px 6px; background: var(--panel-solid); border: 1px solid var(--line-2);
  border-radius: 4px; color: var(--text); font-size: 11px; font-family: 'JetBrains Mono', monospace; outline: none;
}
.cell-input:focus { border-color: var(--cyan); }
.cell-select {
  width: 100%; padding: 3px 4px; background: var(--panel-solid); border: 1px solid var(--line-2);
  border-radius: 4px; color: var(--text); font-size: 11px; font-family: 'JetBrains Mono', monospace; outline: none; cursor: pointer;
}
.cell-select:focus { border-color: var(--cyan); }
tr.dirty td { background: rgba(255, 193, 7, 0.04); }
tr.dropped td { opacity: 0.4; text-decoration: line-through; }
.add-row { display: flex; align-items: center; gap: 6px; padding: 8px 16px; border-bottom: 1px solid var(--line); }
.action-btn-sm {
  width: 24px; height: 24px; border-radius: 4px; border: 1px solid var(--line-2);
  background: transparent; color: var(--text-2); cursor: pointer; display: inline-flex;
  align-items: center; justify-content: center; margin-left: 2px;
}
.action-btn-sm:hover, .action-btn-sm.active { border-color: var(--cyan); color: var(--cyan); }
.spin { animation: spin 1s linear infinite; }
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
</style>
