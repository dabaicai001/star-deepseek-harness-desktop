<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import * as dbService from '@/services/db'
import { generateBatchColumnDDL, type ColumnEdit } from '@/utils/ddlGenerator'
import type { ColumnMeta } from '@/types/db'

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
const edits = ref<Map<string, ColumnEdit>>(new Map())
const loading = ref(false)
const executing = ref(false)
const error = ref<string | null>(null)
const successMsg = ref<string | null>(null)
const adding = ref(false)
const newCol = ref({ name: '', type: 'VARCHAR(255)', nullable: true, defaultVal: '', comment: '' })

const editList = computed(() => Array.from(edits.value.values()))

async function load() {
  loading.value = true
  try {
    columns.value = await dbService.mysqlListColumns(props.connId, props.table, props.db)
    resetEdits()
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

function resetEdits() {
  edits.value = new Map(
    columns.value.map(c => [c.name, {
      ...c,
      newName: c.name,
      newType: c.type,
      newNullable: c.nullable === 'YES',
      newDefault: c.defaultValue ?? '',
      newComment: c.comment ?? '',
      dirty: false,
      dropped: false
    }])
  )
  error.value = null
  successMsg.value = null
}

function markDirty(col: ColumnEdit) {
  col.dirty =
    col.newName !== col.name ||
    col.newType !== col.type ||
    col.newNullable !== (col.nullable === 'YES') ||
    col.newDefault !== (col.defaultValue ?? '') ||
    col.newComment !== (col.comment ?? '')
}

function toggleDrop(col: ColumnEdit) {
  col.dropped = !col.dropped
  col.dirty = true
}

function resetCol(col: ColumnEdit) {
  col.newName = col.name
  col.newType = col.type
  col.newNullable = col.nullable === 'YES'
  col.newDefault = col.defaultValue ?? ''
  col.newComment = col.comment ?? ''
  col.dropped = false
  col.dirty = false
}

function addNewCol() {
  if (!newCol.value.name.trim()) return
  const name = newCol.value.name.trim()
  const entry: ColumnEdit = {
    name, newName: name, type: newCol.value.type, newType: newCol.value.type,
    dataType: '', nullable: 'YES', newNullable: newCol.value.nullable,
    key: '', defaultValue: null, newDefault: newCol.value.defaultVal,
    extra: '', comment: '', newComment: newCol.value.comment,
    ordinalPosition: 0, dirty: true, dropped: false
  }
  edits.value.set(name, entry)
  edits.value = new Map(edits.value)
  newCol.value = { name: '', type: 'VARCHAR(255)', nullable: true, defaultVal: '', comment: '' }
}

async function applyChanges() {
  const ddls = generateBatchColumnDDL(props.db, props.table, columns.value, editList.value)
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

function keyBadge(col: ColumnMeta): string {
  if (col.key === 'PRI') return 'PK'
  if (col.key === 'UNI') return 'UQ'
  if (col.key === 'MUL') return 'IDX'
  return ''
}

watch(() => props.modelValue, (v) => { if (v) load() }, { immediate: true })
</script>

<template>
  <v-dialog :model-value="modelValue" @update:model-value="emit('update:modelValue', $event)" max-width="720">
    <div class="cyber-panel" style="padding: 0; max-height: 80vh; display: flex; flex-direction: column;">
      <div class="dialog-header">
        <v-icon size="16" color="purple">mdi-table-column</v-icon>
        <span class="dialog-title">{{ db }}.{{ table }}</span>
        <span class="dialog-subtitle">{{ editList.length }} columns</span>
        <v-spacer />
        <v-btn variant="text" size="small" icon="mdi-close" @click="emit('update:modelValue', false)" />
      </div>

      <div v-if="loading" class="dialog-loading">
        <v-icon size="20" class="spin">mdi-loading</v-icon>
        Loading columns...
      </div>

      <template v-else>
        <div v-if="error" class="dialog-error">{{ error }}</div>
        <div v-if="successMsg" class="dialog-success">{{ successMsg }}</div>

        <div class="dialog-scroll" style="flex: 1; overflow: auto; min-height: 0;">
          <table class="struct-table">
            <thead>
              <tr>
                <th style="width: 28px;">#</th>
                <th>Name</th>
                <th>Type</th>
                <th style="width: 60px;">Nullable</th>
                <th>Default</th>
                <th>Comment</th>
                <th style="width: 44px;">Key</th>
                <th style="width: 80px;">Actions</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(col, idx) in editList" :key="col.name" :class="{ dirty: col.dirty, dropped: col.dropped }">
                <td class="td-idx">{{ idx + 1 }}</td>
                <td>
                  <input v-model="col.newName" class="cell-input" @input="markDirty(col)" />
                </td>
                <td>
                  <input v-model="col.newType" class="cell-input" @input="markDirty(col)" />
                </td>
                <td class="td-center">
                  <input type="checkbox" v-model="col.newNullable" @change="markDirty(col)" />
                </td>
                <td>
                  <input v-model="col.newDefault" class="cell-input" @input="markDirty(col)" />
                </td>
                <td>
                  <input v-model="col.newComment" class="cell-input" @input="markDirty(col)" />
                </td>
                <td class="td-center">
                  <span v-if="keyBadge(col)" class="key-badge">{{ keyBadge(col) }}</span>
                </td>
                <td class="td-center">
                  <button class="action-btn-sm" :class="{ active: col.dropped }" @click="toggleDrop(col)" title="Drop">
                    <v-icon size="12" :color="col.dropped ? 'var(--red)' : undefined">mdi-delete-outline</v-icon>
                  </button>
                  <button v-if="col.dirty && !col.dropped" class="action-btn-sm" @click="resetCol(col)" title="Reset">
                    <v-icon size="12">mdi-undo</v-icon>
                  </button>
                </td>
              </tr>
            </tbody>
          </table>

          <div class="add-row">
            <input v-model="newCol.name" class="cell-input" placeholder="new column" style="width: 120px;" @keyup.enter="addNewCol" />
            <input v-model="newCol.type" class="cell-input" placeholder="VARCHAR(255)" style="width: 120px;" @keyup.enter="addNewCol" />
            <label><input type="checkbox" v-model="newCol.nullable" /> NULL</label>
            <input v-model="newCol.defaultVal" class="cell-input" placeholder="default" style="width: 80px;" @keyup.enter="addNewCol" />
            <input v-model="newCol.comment" class="cell-input" placeholder="comment" style="width: 120px;" @keyup.enter="addNewCol" />
            <button class="cyber-btn-secondary" @click="addNewCol" style="padding: 2px 8px; font-size: 11px;">
              <v-icon size="12">mdi-plus</v-icon> Add
            </button>
          </div>
        </div>

        <div class="dialog-footer">
          <button class="cyber-btn-secondary" @click="emit('update:modelValue', false)">Cancel</button>
          <button class="cyber-btn" :disabled="executing" @click="applyChanges">
            <v-icon size="14" :class="{ spin: executing }">{{ executing ? 'mdi-loading' : 'mdi-content-save' }}</v-icon>
            Apply Changes
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
tr.dirty td { background: rgba(255, 193, 7, 0.04); }
tr.dropped td { opacity: 0.4; text-decoration: line-through; }
.key-badge { font-size: 9px; padding: 1px 4px; border-radius: 3px; background: var(--purple); color: #fff; }
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
