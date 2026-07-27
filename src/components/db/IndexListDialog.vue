<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
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
const tableColumns = ref<string[]>([])
const edits = ref<Map<string, IndexEdit>>(new Map())
const loading = ref(false)
const executing = ref(false)
const error = ref<string | null>(null)
const successMsg = ref<string | null>(null)
const searchText = ref('')

const newIdx = ref({ name: '', columns: '', unique: false, indexType: 'BTREE' })

// ── Column picker state (fixed-position, outside scroll container) ──
const colPickerVisible = ref(false)
const colPickerTarget = ref<string | null>(null) // index name, or '__new__'
const colPickerQuery = ref('')
const colPickerHighlight = ref(0)
const colPickerRect = ref({ top: 0, left: 0, width: 0 })
const colPickerRef = ref<HTMLElement | null>(null)

const groupedEdits = computed(() => Array.from(edits.value.values()))

const filteredEdits = computed(() => {
  if (!searchText.value) return groupedEdits.value
  const q = searchText.value.toLowerCase()
  return groupedEdits.value.filter(e => e.name.toLowerCase().includes(q))
})

const matchingColumns = computed(() => {
  const q = colPickerQuery.value.trim().toLowerCase()
  if (!q) return tableColumns.value
  return tableColumns.value.filter(c => c.toLowerCase().includes(q))
})

// ── Click outside to close picker ──
function onDocumentMouseDown(e: MouseEvent) {
  if (!colPickerVisible.value) return
  const el = colPickerRef.value
  if (!el) return
  const target = e.target as HTMLElement
  if (!el.contains(target)) {
    // Check if the click is on the input that triggered the picker
    const colInputs = document.querySelectorAll('.col-picker-input')
    let clickedOnInput = false
    colInputs.forEach(inp => { if (inp.contains(target)) clickedOnInput = true })
    if (!clickedOnInput) {
      closeColPicker()
    }
  }
}

onMounted(() => document.addEventListener('mousedown', onDocumentMouseDown, true))
onBeforeUnmount(() => document.removeEventListener('mousedown', onDocumentMouseDown, true))

// ── Picker actions ──

function openColPicker(target: string, inputEl: HTMLElement) {
  colPickerTarget.value = target
  colPickerQuery.value = ''
  colPickerHighlight.value = 0
  const r = inputEl.getBoundingClientRect()
  colPickerRect.value = { top: r.bottom + 2, left: r.left, width: Math.max(r.width, 220) }
  colPickerVisible.value = true
}

function closeColPicker() {
  colPickerVisible.value = false
  colPickerTarget.value = null
  colPickerQuery.value = ''
}

function appendColumn(target: string, col: string) {
  if (target === '__new__') {
    const current = newIdx.value.columns.trim()
    newIdx.value.columns = current ? current + ', ' + col : col
  } else {
    const e = edits.value.get(target)
    if (e) {
      const current = e.newColumns.trim()
      e.newColumns = current ? current + ', ' + col : col
      markDirty(e)
    }
  }
  closeColPicker()
}

function onColPickerKeydown(e: KeyboardEvent) {
  const list = matchingColumns.value
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    colPickerHighlight.value = Math.min(colPickerHighlight.value + 1, Math.max(list.length - 1, 0))
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    colPickerHighlight.value = Math.max(colPickerHighlight.value - 1, 0)
  } else if (e.key === 'Enter') {
    e.preventDefault()
    if (list.length && colPickerHighlight.value < list.length) {
      appendColumn(colPickerTarget.value!, list[colPickerHighlight.value])
    } else if (colPickerQuery.value.trim()) {
      appendColumn(colPickerTarget.value!, colPickerQuery.value.trim())
    }
  } else if (e.key === 'Escape') {
    e.preventDefault()
    closeColPicker()
  }
}

// ── Data loading ──

async function load() {
  loading.value = true
  error.value = null
  try {
    const [idxList, cols] = await Promise.all([
      dbService.mysqlListIndexes(props.connId, props.table, props.db),
      dbService.mysqlListColumns(props.connId, props.table, props.db)
    ])
    indexes.value = idxList
    tableColumns.value = cols.map(c => c.name)
    resetEdits()
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

function resetEdits() {
  const map = new Map<string, IndexEdit>()
  const groups = new Map<string, { nonUnique: number; indexType: string; columns: string[] }>()
  for (const idx of indexes.value) {
    if (!groups.has(idx.keyName)) {
      groups.set(idx.keyName, { nonUnique: idx.nonUnique, indexType: idx.indexType, columns: [] })
    }
    groups.get(idx.keyName)!.columns.push(idx.columnName)
  }
  for (const [name, info] of groups) {
    const colsStr = info.columns.join(', ')
    map.set(name, {
      name,
      newName: name,
      columns: colsStr,
      newColumns: colsStr,
      unique: info.nonUnique === 0,
      newUnique: info.nonUnique === 0,
      indexType: info.indexType || 'BTREE',
      newIndexType: info.indexType || 'BTREE',
      dirty: false,
      dropped: false,
      isNew: false
    })
  }
  edits.value = map
  error.value = null
  successMsg.value = null
}

function markDirty(e: IndexEdit) {
  e.dirty =
    e.newName !== e.name ||
    e.newColumns !== e.columns ||
    e.newUnique !== e.unique ||
    e.newIndexType !== e.indexType
}

function toggleDrop(e: IndexEdit) {
  e.dropped = !e.dropped
  e.dirty = true
}

function resetEdit(e: IndexEdit) {
  e.newName = e.name
  e.newColumns = e.columns
  e.newUnique = e.unique
  e.newIndexType = e.indexType
  e.dropped = false
  e.dirty = false
}

function addNewIdx() {
  const name = newIdx.value.name.trim()
  const cols = newIdx.value.columns.trim()
  if (!name || !cols) return
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
    dropped: false,
    isNew: true
  }
  edits.value.set(name, entry)
  edits.value = new Map(edits.value)
  newIdx.value = { name: '', columns: '', unique: false, indexType: 'BTREE' }
}

async function applyChanges() {
  const ddls = generateBatchIndexDDL(props.db, props.table, groupedEdits.value)
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
  <v-dialog :model-value="modelValue" @update:model-value="emit('update:modelValue', $event)" max-width="780">
    <div class="cyber-panel" style="padding: 0; max-height: 80vh; display: flex; flex-direction: column;">
      <div class="dialog-header">
        <v-icon size="16" color="var(--yellow)">mdi-key-variant</v-icon>
        <span class="dialog-title">{{ db }}.{{ table }}</span>
        <span class="dialog-subtitle">{{ groupedEdits.length }} indexes · {{ tableColumns.length }} columns</span>
        <v-spacer />
        <button class="action-btn" @click="emit('update:modelValue', false)">
            <v-icon size="16">mdi-close</v-icon>
          </button>
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
                    class="cell-input col-picker-input"
                    @input="markDirty(e)"
                    @focus="openColPicker(e.name, $event.target as HTMLElement)"
                    @keydown="colPickerVisible && colPickerTarget === e.name ? onColPickerKeydown($event) : undefined"
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
            <div style="width: 180px;">
              <input
                v-model="newIdx.columns"
                class="cell-input col-picker-input"
                placeholder="col1, col2"
                @focus="openColPicker('__new__', $event.target as HTMLElement)"
                @keydown="colPickerVisible && colPickerTarget === '__new__' ? onColPickerKeydown($event) : undefined"
                @keyup.enter="colPickerVisible ? undefined : addNewIdx()"
              />
            </div>
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

    <!-- Column picker (fixed-position, renders outside dialog scroll) -->
    <Teleport to="body">
      <div
        v-if="colPickerVisible"
        ref="colPickerRef"
        class="col-picker-fixed"
        :style="{ top: colPickerRect.top + 'px', left: colPickerRect.left + 'px', width: colPickerRect.width + 'px' }"
      >
        <div class="col-picker-hint">↑↓ 选择 · Enter 追加 · Esc 取消 · 输入过滤</div>
        <input
          v-model="colPickerQuery"
          class="col-picker-search"
          placeholder="搜索列名..."
          @keydown.stop="onColPickerKeydown"
        />
        <div v-if="matchingColumns.length === 0" class="col-picker-empty">无匹配列名</div>
        <div
          v-for="(c, i) in matchingColumns"
          :key="c"
          class="col-picker-item"
          :class="{ active: i === colPickerHighlight }"
          @mousedown.prevent="appendColumn(colPickerTarget!, c)"
          @mouseenter="colPickerHighlight = i"
        >
          <v-icon size="10" color="var(--cyan)">mdi-table-column</v-icon>
          <span>{{ c }}</span>
        </div>
      </div>
    </Teleport>
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

<style>
/* global: fixed-position column picker (Teleport to body) */
.col-picker-fixed {
  position: fixed;
  z-index: 9999;
  max-height: 240px;
  overflow: auto;
  background: var(--panel-solid-2);
  border: 1px solid var(--line-2);
  border-radius: 6px;
  box-shadow: var(--shadow), 0 0 0 1px var(--focus-cyan);
  padding: 4px;
}
.col-picker-hint {
  padding: 4px 8px; font-size: 9px; color: var(--muted);
  border-bottom: 1px solid var(--line); margin-bottom: 2px;
  font-family: 'JetBrains Mono', monospace;
}
.col-picker-search {
  width: 100%; padding: 4px 8px; background: var(--panel-solid); border: 1px solid var(--line-2);
  border-radius: 4px; color: var(--text); font-size: 11px;
  font-family: 'JetBrains Mono', monospace; outline: none; margin-bottom: 4px;
}
.col-picker-search:focus { border-color: var(--cyan); }
.col-picker-empty {
  padding: 6px 8px; font-size: 10px; color: var(--muted); font-style: italic;
}
.col-picker-item {
  display: flex; align-items: center; gap: 6px;
  padding: 4px 8px; border-radius: 4px; cursor: pointer;
  font-size: 11px; font-family: 'JetBrains Mono', monospace; color: var(--text-2);
}
.col-picker-item.active { background: var(--active-cyan); color: var(--cyan); }
.col-picker-item:hover { background: var(--hover-cyan-soft); }
</style>
