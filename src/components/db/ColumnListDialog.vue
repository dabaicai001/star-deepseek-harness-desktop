<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import * as dbService from '@/services/db'
import { generateBatchColumnDDL, type ColumnEdit } from '@/utils/ddlGenerator'
import type { ColumnMeta } from '@/types/db'
import ContextMenu from '@/components/common/ContextMenu.vue'
import type { MenuItem } from '@/components/common/ContextMenu.vue'

const COMMON_TYPES = [
  'TINYINT', 'TINYINT(1)', 'SMALLINT', 'MEDIUMINT', 'INT', 'INT(11)', 'BIGINT',
  'FLOAT', 'DOUBLE', 'DECIMAL(10,2)',
  'CHAR(36)', 'VARCHAR(64)', 'VARCHAR(128)', 'VARCHAR(255)', 'VARCHAR(500)',
  'TEXT', 'MEDIUMTEXT', 'LONGTEXT',
  'TINYBLOB', 'BLOB', 'MEDIUMBLOB', 'LONGBLOB',
  'DATE', 'TIME', 'DATETIME', 'TIMESTAMP', 'YEAR',
  'JSON', 'BOOLEAN', 'BIT', 'ENUM', 'SET', 'BINARY', 'VARBINARY'
]

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
const edits = ref<Map<string, ColumnEdit>>(new Map())
const loading = ref(false)
const executing = ref(false)
const error = ref<string | null>(null)
const successMsg = ref<string | null>(null)
const newCol = ref({ name: '', type: 'VARCHAR(255)', nullable: true, defaultVal: '', comment: '' })

const editList = computed(() => Array.from(edits.value.values()))

const typeSearch = ref('')
const filteredList = computed(() => {
  if (!typeSearch.value) return editList.value
  const q = typeSearch.value.toLowerCase()
  return editList.value.filter(c => (c.type || c.newType).toLowerCase().includes(q))
})

const existingTypes = computed(() => {
  const set = new Set<string>()
  for (const c of editList.value) {
    const t = (c.type || c.newType || '').trim()
    if (t) set.add(t)
  }
  return Array.from(set)
})

// ── Type picker (fixed-position via Teleport) ──
const typePickerVisible = ref(false)
const typePickerTarget = ref<ColumnEdit | '__new__' | null>(null)
const typePickerHighlight = ref(0)
const typePickerRect = ref({ top: 0, left: 0, width: 0 })
const typePickerRef = ref<HTMLElement | null>(null)

function onDocMouseDown(e: MouseEvent) {
  if (!typePickerVisible.value) return
  const el = typePickerRef.value
  if (!el) return
  const t = e.target as HTMLElement
  if (!el.contains(t)) {
    const inputs = document.querySelectorAll('.type-picker-input')
    let onInput = false
    inputs.forEach(inp => { if (inp.contains(t)) onInput = true })
    if (!onInput) closeTypePicker()
  }
}

onMounted(() => document.addEventListener('mousedown', onDocMouseDown, true))
onBeforeUnmount(() => document.removeEventListener('mousedown', onDocMouseDown, true))

function getTargetType(): string {
  if (!typePickerTarget.value) return ''
  if (typePickerTarget.value === '__new__') return newCol.value.type
  return typePickerTarget.value.newType
}

const typeCandidates = computed(() => {
  const q = getTargetType().trim().toLowerCase()
  const merged: string[] = []
  const seen = new Set<string>()
  for (const t of existingTypes.value) {
    if (!q || t.toLowerCase().includes(q)) { merged.push(t); seen.add(t.toUpperCase()) }
  }
  for (const t of COMMON_TYPES) {
    const up = t.toUpperCase()
    if (seen.has(up)) continue
    if (!q || t.toLowerCase().includes(q)) merged.push(t)
  }
  return merged
})

function openTypePicker(col: ColumnEdit, inputEl: HTMLElement) {
  typePickerTarget.value = col
  typePickerHighlight.value = 0
  const r = inputEl.getBoundingClientRect()
  typePickerRect.value = { top: r.bottom + 2, left: r.left, width: Math.max(r.width, 240) }
  typePickerVisible.value = true
}

function openNewColTypePicker(inputEl: HTMLElement) {
  typePickerTarget.value = '__new__'
  typePickerHighlight.value = 0
  const r = inputEl.getBoundingClientRect()
  typePickerRect.value = { top: r.bottom + 2, left: r.left, width: Math.max(r.width, 240) }
  typePickerVisible.value = true
}

function closeTypePicker() {
  typePickerVisible.value = false
  typePickerTarget.value = null
}

function pickType(col: ColumnEdit, val: string) {
  col.newType = val
  markDirty(col)
  closeTypePicker()
}

function pickNewColType(val: string) {
  newCol.value.type = val
  closeTypePicker()
}

function onTypeKeydown(e: KeyboardEvent, col: ColumnEdit) {
  const list = typeCandidates.value
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    typePickerHighlight.value = Math.min(typePickerHighlight.value + 1, Math.max(list.length - 1, 0))
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    typePickerHighlight.value = Math.max(typePickerHighlight.value - 1, 0)
  } else if (e.key === 'Enter') {
    e.preventDefault()
    if (list.length && typePickerHighlight.value < list.length) {
      pickType(col, list[typePickerHighlight.value])
    } else if (col.newType.trim()) {
      markDirty(col)
      closeTypePicker()
    }
  } else if (e.key === 'Escape') {
    e.preventDefault()
    closeTypePicker()
  }
}

function onNewColTypeKeydown(e: KeyboardEvent) {
  const list = typeCandidates.value
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    typePickerHighlight.value = Math.min(typePickerHighlight.value + 1, Math.max(list.length - 1, 0))
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    typePickerHighlight.value = Math.max(typePickerHighlight.value - 1, 0)
  } else if (e.key === 'Enter') {
    if (list.length && typePickerHighlight.value < list.length) {
      newCol.value.type = list[typePickerHighlight.value]
    }
    closeTypePicker()
    addNewCol()
  } else if (e.key === 'Escape') {
    e.preventDefault()
    closeTypePicker()
  }
}

const selectedColIdx = ref<number | null>(null)
const colCtxMenu = ref<{ x: number; y: number; items: MenuItem[] } | null>(null)

function selectColumn(idx: number) {
  selectedColIdx.value = selectedColIdx.value === idx ? null : idx
}

function onColContextMenu(e: MouseEvent, idx: number) {
  selectColumn(idx)
  const col = filteredList.value[idx]
  if (!col) return
  const nullStr = col.newNullable ? 'NULL' : 'NOT NULL'
  const defStr = col.newDefault ? ` DEFAULT '${col.newDefault}'` : ''
  const commentStr = col.newComment ? ` COMMENT '${col.newComment}'` : ''
  const alter = `ALTER TABLE \`${props.db}\`.\`${props.table}\` MODIFY COLUMN \`${col.newName || col.name}\` ${col.newType || col.type} ${nullStr}${defStr}${commentStr};`
  colCtxMenu.value = {
    x: e.clientX, y: e.clientY,
    items: [
      { type: 'item', label: 'Copy ALTER', icon: 'mdi-content-copy', onClick: () => { navigator.clipboard.writeText(alter).catch(() => {}) } },
    ]
  }
}

function closeColCtxMenu() { colCtxMenu.value = null }

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

      <div class="search-row" style="padding: 8px 16px; border-bottom: 1px solid var(--line); display: flex; align-items: center;">
        <input v-model="typeSearch" class="cyber-input" style="flex: 1; font-size: 11px;" :placeholder="t('db.searchTypeHint')" />
        <v-icon v-if="typeSearch" size="12" @click="typeSearch = ''" style="cursor: pointer; color: var(--muted); margin-left: 4px;">mdi-close</v-icon>
      </div>

      <div v-if="loading" class="dialog-loading">
        <v-icon size="20" class="spin">mdi-loading</v-icon>
        {{ t('db.loadingColumns') }}
      </div>

      <template v-else>
        <div v-if="error" class="dialog-error">{{ error }}</div>
        <div v-if="successMsg" class="dialog-success">{{ successMsg }}</div>

        <div class="dialog-scroll" style="flex: 1; overflow: auto; min-height: 0;">
          <table class="struct-table">
            <thead>
              <tr>
                <th style="width: 28px;">#</th>
                <th>{{ t('db.name') }}</th>
                <th>{{ t('db.type') }}</th>
                <th style="width: 60px;">{{ t('db.nullable') }}</th>
                <th>{{ t('db.default') }}</th>
                <th>{{ t('db.comment') }}</th>
                <th style="width: 44px;">{{ t('db.key') }}</th>
                <th style="width: 80px;">{{ t('db.actions') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(col, idx) in filteredList" :key="col.name" :class="{ dirty: col.dirty, dropped: col.dropped, 'row-selected': selectedColIdx === idx }" @contextmenu.prevent="onColContextMenu($event, idx)">
                <td class="td-idx" :class="{ selected: selectedColIdx === idx }" @click="selectColumn(idx)" style="cursor: pointer;">{{ idx + 1 }}</td>
                <td>
                  <input v-model="col.newName" class="cell-input" @input="markDirty(col)" />
                </td>
                <td>
                  <input
                    v-model="col.newType"
                    class="cell-input type-picker-input"
                    @input="markDirty(col)"
                    @focus="openTypePicker(col, $event.target as HTMLElement)"
                    @keydown="typePickerVisible && typePickerTarget === col ? onTypeKeydown($event, col) : undefined"
                    placeholder="VARCHAR(255)"
                  />
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
            <input v-model="newCol.name" class="cell-input" :placeholder="t('db.newColumn')" style="width: 120px;" @keyup.enter="addNewCol" />
            <div style="width: 120px;">
              <input
                v-model="newCol.type"
                class="cell-input type-picker-input"
                placeholder="VARCHAR(255)"
                @focus="openNewColTypePicker($event.target as HTMLElement)"
                @keydown="typePickerVisible && typePickerTarget === '__new__' ? onNewColTypeKeydown($event) : undefined"
                @keyup.enter="typePickerVisible ? undefined : addNewCol()"
              />
            </div>
            <label><input type="checkbox" v-model="newCol.nullable" /> NULL</label>
            <input v-model="newCol.defaultVal" class="cell-input" placeholder="default" style="width: 80px;" @keyup.enter="addNewCol" />
            <input v-model="newCol.comment" class="cell-input" placeholder="comment" style="width: 120px;" @keyup.enter="addNewCol" />
            <button class="cyber-btn-secondary" @click="addNewCol" style="padding: 2px 8px; font-size: 11px;">
              <v-icon size="12">mdi-plus</v-icon> {{ t('db.newColumn') }}
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

    <!-- Type picker (fixed-position via Teleport, renders outside dialog) -->
    <Teleport to="body">
      <div
        v-if="typePickerVisible"
        ref="typePickerRef"
        class="type-picker-fixed"
        :style="{ top: typePickerRect.top + 'px', left: typePickerRect.left + 'px', width: typePickerRect.width + 'px' }"
      >
        <div class="type-picker-hint">↑↓ 选择 · Enter 确认 · Esc 取消 · 输入过滤</div>
        <div v-if="typeCandidates.length === 0" class="type-picker-empty">无匹配类型</div>
        <div
          v-for="(t, i) in typeCandidates"
          :key="t"
          class="type-picker-item"
          :class="{ active: i === typePickerHighlight }"
          @mousedown.prevent="typePickerTarget === '__new__' ? pickNewColType(t) : pickType(typePickerTarget as ColumnEdit, t)"
          @mouseenter="typePickerHighlight = i"
        >
          <span class="type-picker-label">{{ t }}</span>
          <v-icon v-if="existingTypes.includes(t)" size="10" color="cyan" class="type-picker-tag">mdi-database</v-icon>
        </div>
      </div>
    </Teleport>
  </v-dialog>

  <ContextMenu
    v-if="colCtxMenu"
    :x="colCtxMenu.x"
    :y="colCtxMenu.y"
    :items="colCtxMenu.items"
    @close="closeColCtxMenu"
  />
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
.row-selected td { background: rgba(0, 240, 255, 0.06); }
.td-idx.selected { color: var(--cyan); font-weight: 700; }
</style>

<style>
/* global: fixed-position type picker (Teleport to body) */
.type-picker-fixed {
  position: fixed;
  z-index: 9999;
  max-height: 240px;
  overflow: auto;
  background: var(--panel-solid-2);
  border: 1px solid var(--line-2);
  border-radius: 6px;
  box-shadow: 0 16px 48px -12px rgba(0,0,0,.6), 0 0 0 1px rgba(0, 240, 255, 0.15);
  padding: 4px;
}
.type-picker-hint {
  padding: 4px 8px; font-size: 9px; color: var(--muted);
  border-bottom: 1px solid var(--line); margin-bottom: 2px;
  font-family: 'JetBrains Mono', monospace;
}
.type-picker-empty {
  padding: 6px 8px; font-size: 10px; color: var(--muted); font-style: italic;
}
.type-picker-item {
  display: flex; align-items: center; gap: 6px;
  padding: 4px 8px; border-radius: 4px; cursor: pointer;
  font-size: 11px; font-family: 'JetBrains Mono', monospace; color: var(--text-2);
}
.type-picker-item.active { background: rgba(0, 240, 255, 0.1); color: var(--cyan); }
.type-picker-item:hover { background: rgba(0, 240, 255, 0.06); }
.type-picker-tag { margin-left: auto; opacity: 0.7; }
</style>
