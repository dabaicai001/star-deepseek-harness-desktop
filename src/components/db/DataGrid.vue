<script setup lang="ts">
/**
 * DataGrid — 数据结果表
 *
 * 支持两种模式:
 * 1. 自定义 SQL 结果(走 props.result,客户端分页)
 * 2. 表格数据浏览(走 props.result + totalRows + page + pageSize,服务端分页)
 *
 * - 默认 pageSize 1000,可在 toolbar 切换 [100, 500, 1000, 2000, 5000]
 * - 显示总行数(从 props.totalRows 拿,没传就显示 result.rows.length)
 * - 单击列名排序(触发 sort-change)
 * - editable=true + pkCols 非空时,行内编辑(emit cell-edit)
 */
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { QueryResult, ColumnInfo } from '@/types/db'
import ContextMenu from '@/components/common/ContextMenu.vue'
import type { MenuItem } from '@/components/common/ContextMenu.vue'

const { t } = useI18n()

const props = withDefaults(defineProps<{
  result: QueryResult | null
  loading?: boolean
  /** 服务端分页:总行数 */
  totalRows?: number
  /** 当前页(0-based) */
  page?: number
  /** 每页大小 */
  pageSize?: number
  /** 可选页大小 */
  pageSizeOptions?: number[]
  /** 表名(用于生成 INSERT 语句) */
  tableName?: string
  /** 是否可编辑 */
  editable?: boolean
  /** 主键列(用于构造 WHERE 定位行) */
  pkCols?: string[]
}>(), {
  totalRows: undefined,
  page: 0,
  pageSize: 100,
  pageSizeOptions: () => [100, 500, 1000, 2000, 5000],
  tableName: '',
  editable: false,
  pkCols: () => []
})

const emit = defineEmits<{
  cellEdit: [row: number, col: string, value: unknown]
  rowDelete: [row: number]
  export: [format: string]
  'page-change': [page: number]
  'page-size-change': [size: number]
  'sort-change': [col: string]
}>()

// Row selection
const selectedRows = ref<Set<number>>(new Set())

// Row context menu
const rowCtxMenu = ref<{ x: number; y: number; rowIdx: number; items: MenuItem[] } | null>(null)

function toggleRow(e: MouseEvent, rowIdx: number) {
  let set = new Set(selectedRows.value)
  if (e.ctrlKey || e.metaKey) {
    if (set.has(rowIdx)) set.delete(rowIdx)
    else set.add(rowIdx)
  } else {
    if (set.has(rowIdx) && set.size === 1) {
      set.clear()
    } else {
      set = new Set([rowIdx])
    }
  }
  selectedRows.value = set
}

function closeRowCtxMenu() {
  rowCtxMenu.value = null
}

function onRowContextMenu(e: MouseEvent, rowIdx: number) {
  if (!selectedRows.value.has(rowIdx)) {
    toggleRow(e, rowIdx)
  }
  const items: MenuItem[] = [
    { type: 'item', label: 'Copy INSERT', icon: 'mdi-content-copy', onClick: () => copyInsert(rowIdx) },
    { type: 'item', label: 'Delete Row', icon: 'mdi-delete', danger: true, onClick: () => deleteRow(rowIdx) },
  ]
  rowCtxMenu.value = { x: e.clientX, y: e.clientY, rowIdx, items }
}

function copyInsert(rowIdx: number) {
  const row = pagedRows.value[rowIdx]
  if (!row) return
  const cols = columns.value.map(c => `\`${c.name}\``).join(', ')
  const vals = row.map(cell => {
    if (cell === null || cell === undefined) return 'NULL'
    if (typeof cell === 'number') return String(cell)
    return `'${String(cell).replace(/'/g, "''")}'`
  }).join(', ')
  const sql = `INSERT INTO \`${props.tableName || 'table'}\` (${cols}) VALUES (${vals});`
  navigator.clipboard.writeText(sql).catch(() => {})
}

function deleteRow(rowIdx: number) {
  emit('rowDelete', rowIdx)
}

// 客户端过滤(只对客户端分页模式有效)
const filterText = ref('')
const sortColumn = ref<string | null>(null)
const sortDir = ref<'ASC' | 'DESC'>('ASC')

// 服务端模式 vs 客户端模式:有 totalRows 走服务端
const isServerMode = computed(() => props.totalRows != null)

const columns = computed(() => props.result?.columns || [])
const allRows = computed(() => props.result?.rows || [])

// 客户端模式下,先过滤再排序再分页
const sortedRows = computed(() => {
  let rows = [...allRows.value]
  if (isServerMode.value) return rows // 服务端已经处理
  if (sortColumn.value && columns.value.length > 0) {
    const colIdx = columns.value.findIndex(c => c.name === sortColumn.value)
    if (colIdx >= 0) {
      rows.sort((a, b) => {
        const va = a[colIdx]
        const vb = b[colIdx]
        if (va == null && vb == null) return 0
        if (va == null) return 1
        if (vb == null) return -1
        const cmp = String(va).localeCompare(String(vb), undefined, { numeric: true })
        return sortDir.value === 'ASC' ? cmp : -cmp
      })
    }
  }
  return rows
})

const filteredRows = computed(() => {
  if (isServerMode.value) return sortedRows.value
  if (!filterText.value) return sortedRows.value
  const q = filterText.value.toLowerCase()
  return sortedRows.value.filter(row =>
    row.some(cell => cell != null && String(cell).toLowerCase().includes(q))
  )
})

// 服务端模式:直接显示所有返回的行,翻页走 emit
// 客户端模式:在 filteredRows 基础上分页
const pagedRows = computed(() => {
  if (isServerMode.value) return filteredRows.value
  const start = (props.page || 0) * (props.pageSize || 1000)
  return filteredRows.value.slice(start, start + (props.pageSize || 1000))
})

const totalForPaging = computed(() => {
  if (isServerMode.value) return props.totalRows || 0
  return filteredRows.value.length
})

const totalPages = computed(() => Math.max(1, Math.ceil(totalForPaging.value / (props.pageSize || 1000))))

const visibleRange = computed(() => {
  const size = props.pageSize || 1000
  const cur = props.page || 0
  const start = cur * size + 1
  const end = Math.min(start + size - 1, totalForPaging.value)
  return { start, end, total: totalForPaging.value }
})

// 当 result 变化(查询完成)时重置
watch(() => props.result, () => {
  if (!isServerMode.value) {
    sortColumn.value = null
    filterText.value = ''
  }
})

function toggleSort(col: string) {
  if (isServerMode.value) {
    // 服务端模式:由父组件发 sort-change
    sortColumn.value = col
    sortDir.value = sortColumn.value === col && sortDir.value === 'ASC' ? 'DESC' : 'ASC'
    emit('sort-change', col)
  } else {
    if (sortColumn.value === col) {
      sortDir.value = sortDir.value === 'ASC' ? 'DESC' : 'ASC'
    } else {
      sortColumn.value = col
      sortDir.value = 'ASC'
    }
  }
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'object') return JSON.stringify(value, null, 2)
  return String(value)
}

function getCellClass(value: unknown): string {
  if (value === null || value === undefined) return 'cell-null'
  if (typeof value === 'number') return 'cell-number'
  if (typeof value === 'boolean') return 'cell-boolean'
  return 'cell-text'
}

function prevPage() {
  if ((props.page || 0) > 0) emit('page-change', (props.page || 0) - 1)
}
function nextPage() {
  if ((props.page || 0) < totalPages.value - 1) emit('page-change', (props.page || 0) + 1)
}
function onPageSizeChange(e: Event) {
  const v = parseInt((e.target as HTMLSelectElement).value, 10)
  if (!isNaN(v)) emit('page-size-change', v)
}

// 内联编辑
const editing = ref<{ row: number; col: string } | null>(null)
const editValue = ref<string>('')

function startEdit(rowIdx: number, col: string, currentValue: unknown) {
  if (!props.editable) return
  editing.value = { row: rowIdx, col }
  editValue.value = currentValue == null ? '' : String(currentValue)
}

function commitEdit() {
  if (!editing.value) return
  const { row, col } = editing.value
  let newVal: unknown = editValue.value
  // 尝试按列类型转换(简单的:数字列变 number)
  const colDef = columns.value.find(c => c.name === col)
  if (colDef) {
    const t = (colDef.type || '').toLowerCase()
    if (/int|decimal|numeric|float|double|real/.test(t)) {
      const n = Number(editValue.value)
      if (!isNaN(n)) newVal = n
    } else if (/bool/.test(t)) {
      if (editValue.value === 'true' || editValue.value === '1') newVal = true
      else if (editValue.value === 'false' || editValue.value === '0') newVal = false
    }
  }
  emit('cellEdit', row, col, newVal)
  editing.value = null
}

function cancelEdit() {
  editing.value = null
}
</script>

<template>
  <div class="data-grid">
    <!-- Toolbar -->
    <div class="grid-toolbar">
      <div class="toolbar-left">
        <!-- 总行数(粗体高亮) -->
        <span v-if="result && !result.error" class="row-count">
          <span class="total-num">{{ totalForPaging.toLocaleString() }}</span>
          <span class="total-label">{{ t('db.totalRows') }}</span>
          <span v-if="result.durationMs != null" class="duration">· {{ result.durationMs }}ms</span>
        </span>
        <span v-if="result?.error" class="error-badge">
          <v-icon size="12">mdi-alert-circle</v-icon>
          {{ result.error }}
        </span>
      </div>
      <div class="toolbar-right">
        <!-- 客户端过滤(自定义 SQL 模式) -->
        <input
          v-if="!isServerMode"
          v-model="filterText"
          type="text"
          class="cyber-input filter-input"
          :placeholder="t('common.search') + '...'"
        />
        <!-- 页大小选择器 -->
        <div class="page-size-selector">
          <span class="size-label">{{ t('db.pageSize') }}</span>
          <select :value="pageSize" class="cyber-select" @change="onPageSizeChange">
            <option v-for="opt in pageSizeOptions" :key="opt" :value="opt">{{ opt.toLocaleString() }}</option>
          </select>
        </div>
        <button class="action-btn" @click="emit('export', 'csv')" :title="t('db.export')">
          <v-icon size="14">mdi-download</v-icon>
        </button>
      </div>
    </div>

    <!-- Table -->
    <div v-if="loading" class="grid-loading">
      <v-icon size="24" class="spin">mdi-loading</v-icon>
      <span>{{ t('common.loading') }}</span>
    </div>

    <div v-else-if="!result || columns.length === 0" class="grid-empty">
      <v-icon size="32" color="muted">mdi-table-off</v-icon>
      <span>{{ t('common.noData') }}</span>
    </div>

    <template v-else>
      <div class="grid-scroll">
        <table class="grid-table">
          <thead>
            <tr>
              <th class="col-index" style="cursor: pointer;">#</th>
              <th
                v-for="col in columns"
                :key="col.name"
                class="col-header"
                :class="{ sorted: sortColumn === col.name, desc: sortDir === 'DESC' }"
                @click="toggleSort(col.name)"
              >
                <span class="col-name">{{ col.name }}</span>
                <span class="col-type">{{ col.type }}</span>
                <v-icon v-if="sortColumn === col.name" size="10" class="sort-icon">
                  {{ sortDir === 'ASC' ? 'mdi-arrow-up' : 'mdi-arrow-down' }}
                </v-icon>
                <span v-if="editable && pkCols.includes(col.name)" class="pk-marker" :title="t('db.primaryKey')">🔑</span>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(row, rowIdx) in pagedRows"
              :key="rowIdx"
              :class="{ 'row-selected': selectedRows.has(rowIdx) }"
              @contextmenu.prevent="onRowContextMenu($event, rowIdx)"
            >
              <td
                class="col-index"
                :class="{ selected: selectedRows.has(rowIdx) }"
                @click="toggleRow($event, rowIdx)"
                style="cursor: pointer;"
              >{{ (page || 0) * (pageSize || 1000) + rowIdx + 1 }}</td>
              <td
                v-for="(cell, colIdx) in row"
                :key="colIdx"
                :class="[getCellClass(cell), { editable: editable }]"
                class="cell"
                @dblclick="startEdit(rowIdx, columns[colIdx].name, cell)"
              >
                <input
                  v-if="editing?.row === rowIdx && editing?.col === columns[colIdx].name"
                  v-model="editValue"
                  class="cell-edit-input"
                  @keyup.enter="commitEdit"
                  @keyup.esc="cancelEdit"
                  @blur="commitEdit"
                  autofocus
                />
                <span
                  v-else
                  class="cell-value"
                  :title="formatCell(cell)"
                >{{ formatCell(cell) }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Pagination -->
      <div class="grid-pagination" v-if="totalForPaging > 0">
        <span class="page-info">
          {{ visibleRange.start }}-{{ visibleRange.end }} / {{ visibleRange.total.toLocaleString() }}
        </span>
        <button class="page-btn" :disabled="(page || 0) === 0" @click="prevPage">
          <v-icon size="14">mdi-chevron-left</v-icon>
        </button>
        <span class="page-num">{{ (page || 0) + 1 }} / {{ totalPages.toLocaleString() }}</span>
        <button class="page-btn" :disabled="(page || 0) >= totalPages - 1" @click="nextPage">
          <v-icon size="14">mdi-chevron-right</v-icon>
        </button>
      </div>

      <ContextMenu
        v-if="rowCtxMenu"
        :x="rowCtxMenu.x"
        :y="rowCtxMenu.y"
        :items="rowCtxMenu.items"
        @close="closeRowCtxMenu"
      />
    </template>
  </div>
</template>

<style scoped>
.data-grid {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.grid-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 3px 8px;
  border-bottom: 1px solid var(--line);
  flex-shrink: 0;
  gap: 8px;
  min-height: 24px;
}

.toolbar-left {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--text-2);
}

.toolbar-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.filter-input {
  width: 180px;
  padding: 4px 8px;
  font-size: 11px;
}

.row-count {
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
  font-family: 'JetBrains Mono', monospace;
}

.total-num {
  font-size: 14px;
  font-weight: 700;
  color: var(--cyan);
  text-shadow: 0 0 8px rgba(0, 240, 255, 0.4);
}

.total-label {
  font-size: 10px;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.duration {
  color: var(--muted);
  font-size: 10px;
}

.page-size-selector {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.cyber-select {
  padding: 3px 6px;
  background: var(--panel-solid-2);
  border: 1px solid var(--line-2);
  border-radius: 4px;
  color: var(--text);
  font-size: 11px;
  font-family: 'JetBrains Mono', monospace;
  outline: none;
  cursor: pointer;
}

.cyber-select:focus {
  border-color: var(--cyan);
}

.size-label {
  white-space: nowrap;
}

.error-badge {
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--red);
  font-size: 11px;
  background: rgba(255, 77, 109, 0.08);
  padding: 2px 8px;
  border-radius: 4px;
}

.grid-loading, .grid-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 40px;
  color: var(--muted);
  font-size: 13px;
}

.spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.grid-scroll {
  flex: 1;
  overflow: auto;
  min-height: 0;
}

.grid-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  font-family: 'JetBrains Mono', monospace;
}

.grid-table thead {
  position: sticky;
  top: 0;
  z-index: 1;
}

.col-header {
  background: var(--panel-solid-2);
  border-bottom: 1px solid var(--line-2);
  padding: 6px 10px;
  text-align: left;
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
  transition: background 0.15s;
  position: relative;
}

.col-header:hover {
  background: rgba(0, 240, 255, 0.06);
}

.col-header.sorted {
  background: rgba(181, 107, 255, 0.06);
}

.col-name {
  font-weight: 600;
  color: var(--text);
  margin-right: 6px;
}

.col-type {
  font-size: 10px;
  color: var(--muted);
  font-weight: 400;
}

.sort-icon {
  margin-left: 4px;
  color: var(--purple);
}

.pk-marker {
  margin-left: 4px;
  font-size: 10px;
  opacity: 0.6;
}

.col-index {
  width: 50px;
  text-align: right;
  padding: 4px 8px;
  color: var(--muted);
  font-size: 10px;
  background: var(--panel-solid-2);
  border-bottom: 1px solid var(--line);
  position: sticky;
  left: 0;
  z-index: 1;
}

.cell {
  padding: 4px 10px;
  border-bottom: 1px solid var(--line);
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  position: relative;
}

.cell:hover {
  background: rgba(0, 240, 255, 0.04);
}

.cell.editable {
  cursor: text;
}

.cell.editable:hover {
  background: rgba(0, 240, 255, 0.08);
  outline: 1px dashed var(--cyan);
  outline-offset: -1px;
}

.cell-edit-input {
  width: 100%;
  padding: 2px 4px;
  background: rgba(0, 240, 255, 0.08);
  border: 1px solid var(--cyan);
  border-radius: 2px;
  color: var(--text);
  font-family: 'JetBrains Mono', monospace;
  font-size: 12px;
  outline: none;
}

.cell-null {
  color: var(--muted);
  font-style: italic;
  font-size: 10px;
}

.cell-number {
  color: var(--cyan);
}

.cell-boolean {
  color: var(--purple);
}

.cell-text {
  color: var(--text);
}

.cell-value {
  display: inline-block;
  max-width: 300px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.grid-pagination {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 8px 12px;
  border-top: 1px solid var(--line);
  font-size: 11px;
  color: var(--text-2);
  flex-shrink: 0;
}

.page-info {
  font-family: 'JetBrains Mono', monospace;
  color: var(--muted);
}

.page-btn {
  width: 28px;
  height: 28px;
  border-radius: 6px;
  border: 1px solid var(--line-2);
  background: transparent;
  color: var(--text-2);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s;
}

.page-btn:hover:not(:disabled) {
  border-color: var(--cyan);
  color: var(--cyan);
}

.page-btn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.page-num {
  font-family: 'JetBrains Mono', monospace;
  min-width: 80px;
  text-align: center;
}

.action-btn {
  width: 28px;
  height: 28px;
  border-radius: 6px;
  border: 1px solid var(--line-2);
  background: transparent;
  color: var(--text-2);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s;
}

.action-btn:hover {
  border-color: var(--cyan);
  color: var(--cyan);
}

.row-selected td { background: rgba(0, 240, 255, 0.06); }
.row-selected:hover td { background: rgba(0, 240, 255, 0.1); }
.col-index.selected { color: var(--cyan); font-weight: 700; }
</style>
