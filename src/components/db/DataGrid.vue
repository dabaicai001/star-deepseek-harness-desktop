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
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import { useThemeStore } from '@/stores/theme'
import type { QueryResult, ColumnInfo } from '@/types/db'
import ContextMenu from '@/components/common/ContextMenu.vue'
import type { MenuItem } from '@/components/common/ContextMenu.vue'

const { t } = useI18n()
const themeStore = useThemeStore()

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
  /** 当前活跃的列筛选 */
  columnFilters?: Record<string, string>
  /** 是否显示刷新按钮 */
  refreshable?: boolean
}>(), {
  totalRows: undefined,
  page: 0,
  pageSize: 100,
  pageSizeOptions: () => [100, 500, 1000, 2000, 5000],
  tableName: '',
  editable: false,
  pkCols: () => [],
  columnFilters: () => ({}),
  refreshable: false
})

const emit = defineEmits<{
  cellEdit: [row: number, col: string, value: unknown]
  rowDelete: [row: number]
  export: [format: string]
  'export-excel': [columns: string[], rows: string[][]]
  'page-change': [page: number]
  'page-size-change': [size: number]
  'sort-change': [col: string]
  'column-filter': [col: string, value: string]
  refresh: []
  saveBatch: [changes: Array<{ rowIndex: number; column: string; originalValue: unknown; newValue: unknown }>]
  saved: []
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
    { type: 'item', label: t('db.copyInsert'), icon: 'mdi-content-copy', onClick: () => copyInsert(rowIdx) },
    { type: 'item', label: t('db.deleteRow'), icon: 'mdi-delete', danger: true, onClick: () => deleteRow(rowIdx) },
  ]
  rowCtxMenu.value = { x: e.clientX, y: e.clientY, rowIdx, items }
}

function copyInsert(rowIdx: number) {
  const row = pagedRows.value[rowIdx]
  if (!row) return
  const cols = columns.value.map(c => `\`${c.name}\``).join(', ')
  const vals = columns.value.map((col, colIdx) => {
    const cell = getDisplayedCellValue(rowIdx, col.name, row[colIdx])
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

// ─── 列筛选 popover ───
const filterPopoverCol = ref<string | null>(null)
const filterPopoverInput = ref('')
const filterPopoverPos = ref({ top: 0, left: 0 })

function openFilterPopover(e: MouseEvent, colName: string) {
  const rect = (e.target as HTMLElement).getBoundingClientRect()
  filterPopoverPos.value = { top: rect.bottom + 4, left: rect.left }
  filterPopoverCol.value = colName
  filterPopoverInput.value = props.columnFilters?.[colName] || ''
}

function closeFilterPopover() {
  filterPopoverCol.value = null
  filterPopoverInput.value = ''
}

function applyColumnFilter() {
  if (filterPopoverCol.value) {
    emit('column-filter', filterPopoverCol.value, filterPopoverInput.value)
  }
  closeFilterPopover()
}

function clearColumnFilter() {
  if (filterPopoverCol.value) {
    emit('column-filter', filterPopoverCol.value, '')
  }
  closeFilterPopover()
}

function onFilterKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') applyColumnFilter()
  if (e.key === 'Escape') closeFilterPopover()
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

// ─── Ctrl+S 全局快捷键 ───
function onKeyDown(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault()
    saveAll()
  }
}

watch(() => props.editable, (val) => {
  if (val) {
    window.addEventListener('keydown', onKeyDown)
  } else {
    window.removeEventListener('keydown', onKeyDown)
  }
}, { immediate: true })

function toggleSort(col: string) {
  if (isServerMode.value) {
    // 服务端模式:由父组件发 sort-change
    const wasSameCol = sortColumn.value === col
    sortColumn.value = col
    sortDir.value = wasSameCol && sortDir.value === 'ASC' ? 'DESC' : 'ASC'
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

function handleExportExcel() {
  if (!props.result?.columns || !props.result?.rows) return
  const cols = props.result.columns.map(c => c.name)
  const rows = props.result.rows.map((row: any[], rowIdx) =>
    cols.map((_, ci) => {
      const val = getDisplayedCellValue(rowIdx, cols[ci], row[ci])
      if (val === null || val === undefined) return ''
      return String(val)
    })
  )
  emit('export-excel', cols, rows)
}

// ─── 批量保存:dirty 状态 ───
const dirtyCells = ref<Map<string, { col: string; originalValue: unknown; newValue: unknown }>>(new Map())

const hasDirty = computed(() => dirtyCells.value.size > 0)

function dirtyKey(rowIdx: number, col: string) {
  return `${rowIdx}::${col}`
}

function getDirtyCell(rowIdx: number, col: string) {
  return dirtyCells.value.get(dirtyKey(rowIdx, col))
}

function isDirty(rowIdx: number, col: string) {
  return !!getDirtyCell(rowIdx, col)
}

function valuesEqual(a: unknown, b: unknown) {
  return Object.is(a, b)
}

function getDisplayedCellValue(rowIdx: number, col: string, fallback: unknown) {
  const dirty = getDirtyCell(rowIdx, col)
  return dirty ? dirty.newValue : fallback
}

function stageCellChange(rowIdx: number, col: string, originalValue: unknown, newValue: unknown) {
  const key = dirtyKey(rowIdx, col)
  if (valuesEqual(originalValue, newValue)) {
    dirtyCells.value.delete(key)
  } else {
    dirtyCells.value.set(key, { col, originalValue, newValue })
  }
  dirtyCells.value = new Map(dirtyCells.value)
}

// 内联编辑(保留给短文本直接双击编辑)
const editing = ref<{ row: number; col: string } | null>(null)
const editValue = ref<string>('')

// ─── 单元格编辑器弹窗 ───
const cellPopover = ref<{
  row: number
  col: string
  colIdx: number
  value: string
  originalValue: unknown
  colType: string
  readOnly: boolean
} | null>(null)
const cellPopoverTextarea = ref<HTMLTextAreaElement | null>(null)

function commitCellPopover() {
  if (!cellPopover.value) return
  const { row, col, colIdx, value, originalValue } = cellPopover.value
  let newVal: unknown = value
  const colDef = columns.value[colIdx]
  if (colDef) {
    const t = (colDef.type || '').toLowerCase()
    if (/int|decimal|numeric|float|double|real/.test(t)) {
      const n = Number(value)
      if (!isNaN(n)) newVal = n
    } else if (/bool/.test(t)) {
      if (value === 'true' || value === '1') newVal = true
      else if (value === 'false' || value === '0') newVal = false
    }
  }
  stageCellChange(row, col, originalValue, newVal)
  cellPopover.value = null
}

function cancelCellPopover() {
  cellPopover.value = null
}

function copyCellContent() {
  if (!cellPopover.value) return
  navigator.clipboard.writeText(cellPopover.value.value).catch(() => {})
}

function onCellPopoverKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    cancelCellPopover()
  } else if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault()
    commitCellPopover()
  }
}

function startEdit(e: MouseEvent, rowIdx: number, col: string, currentValue: unknown) {
  const colIdx = columns.value.findIndex(c => c.name === col)
  if (colIdx < 0) return
  const staged = getDirtyCell(rowIdx, col)
  const displayedValue = staged ? staged.newValue : currentValue
  cellPopover.value = {
    row: rowIdx, col, colIdx,
    value: displayedValue == null ? '' : String(displayedValue),
    originalValue: staged ? staged.originalValue : currentValue,
    colType: columns.value[colIdx].type || '',
    readOnly: !props.editable,
  }
  requestAnimationFrame(() => {
    cellPopoverTextarea.value?.focus()
  })
}

function commitEdit() {
  if (!editing.value) return
  const { row, col } = editing.value
  let newVal: unknown = editValue.value
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
  // 获取原始值
  const currentRow = pagedRows.value[row]
  const colIdx = columns.value.findIndex(c => c.name === col)
  const originalValue = currentRow ? currentRow[colIdx] : undefined
  // 值没变则不标记 dirty
  stageCellChange(row, col, originalValue, newVal)
  editing.value = null
}

function cancelEdit() {
  editing.value = null
}

function saveAll() {
  if (dirtyCells.value.size === 0) return
  const changes: Array<{ rowIndex: number; column: string; originalValue: unknown; newValue: unknown }> = []
  for (const [key, val] of dirtyCells.value) {
    const rowIdx = parseInt(key.split('::')[0], 10)
    changes.push({ rowIndex: rowIdx, column: val.col, originalValue: val.originalValue, newValue: val.newValue })
  }
  emit('saveBatch', changes)
}

function clearDirty() {
  dirtyCells.value = new Map()
}

defineExpose({ clearDirty, hasDirty })
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
        <button
          v-if="refreshable"
          class="action-btn"
          :disabled="loading"
          @click="emit('refresh')"
          :title="t('common.refresh')"
        >
          <v-icon size="14" :class="{ spin: loading }">mdi-refresh</v-icon>
        </button>
        <button
          v-if="editable"
          class="save-btn"
          :class="{ active: hasDirty }"
          :disabled="!hasDirty || loading"
          @click="saveAll"
          :title="t('db.saveBatch') + ' (Ctrl/Cmd+S)'"
        >
          <v-icon size="13">mdi-content-save-outline</v-icon>
          <span>{{ hasDirty ? dirtyCells.size : 0 }}</span>
        </button>
        <button class="action-btn" @click="emit('export', 'csv')" :title="t('db.export')">
          <v-icon size="14">mdi-download</v-icon>
        </button>
        <button
          class="action-btn"
          :disabled="!result || !!result.error || !result.columns"
          @click="handleExportExcel"
          :title="'导出为 Excel'"
        >
          <v-icon size="14">mdi-file-excel-outline</v-icon>
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
        <table class="grid-table" :style="{ fontSize: themeStore.fontSize + 'px' }">
          <thead>
            <tr>
              <th class="col-index" style="cursor: pointer;">#</th>
              <th
                v-for="col in columns"
                :key="col.name"
                class="col-header"
                :class="{ sorted: sortColumn === col.name, desc: sortDir === 'DESC' }"
              >
                <div class="col-header-inner" @click="toggleSort(col.name)">
                  <span class="col-name">{{ col.name }}</span>
                  <span class="col-type">{{ col.type }}</span>
                  <v-icon v-if="sortColumn === col.name" size="10" class="sort-icon">
                    {{ sortDir === 'ASC' ? 'mdi-arrow-up' : 'mdi-arrow-down' }}
                  </v-icon>
                  <span v-if="editable && pkCols.includes(col.name)" class="pk-marker" :title="t('db.primaryKey')">🔑</span>
                </div>
                <button
                  class="col-filter-btn"
                  :class="{ active: columnFilters?.[col.name] }"
                  @click.stop="openFilterPopover($event, col.name)"
                  :title="t('common.filter', '筛选')"
                >
                  <v-icon size="10">{{ columnFilters?.[col.name] ? 'mdi-filter' : 'mdi-filter-outline' }}</v-icon>
                </button>
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
                :class="[
                  getCellClass(getDisplayedCellValue(rowIdx, columns[colIdx].name, cell)),
                  { editable: editable, dirty: isDirty(rowIdx, columns[colIdx].name) }
                ]"
                class="cell"
                @dblclick="startEdit($event, rowIdx, columns[colIdx].name, cell)"
              >
                <span
                  class="cell-value"
                  :title="formatCell(getDisplayedCellValue(rowIdx, columns[colIdx].name, cell))"
                >{{ formatCell(getDisplayedCellValue(rowIdx, columns[colIdx].name, cell)) }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Column filter popover -->
      <teleport to="body">
        <div
          v-if="filterPopoverCol"
          class="col-filter-popover"
          :style="{
            position: 'fixed',
            top: filterPopoverPos.top + 'px',
            left: filterPopoverPos.left + 'px',
            zIndex: 9999
          }"
        >
          <div class="col-filter-popover-header">{{ filterPopoverCol }}</div>
          <div class="col-filter-popover-body">
            <input
              ref="filterPopoverInputRef"
              v-model="filterPopoverInput"
              type="text"
              class="cyber-input col-filter-popover-input"
              :placeholder="t('db.filterPlaceholder')"
              @keydown="onFilterKeydown"
              autofocus
            />
          </div>
          <div class="col-filter-popover-actions">
            <button class="cyber-btn-secondary" style="font-size:11px;padding:2px 8px;" @click="clearColumnFilter">
              {{ t('db.clear') }}
            </button>
            <button class="cyber-btn" style="font-size:11px;padding:2px 8px;" @click="applyColumnFilter">
              {{ t('db.apply') }}
            </button>
          </div>
        </div>
      </teleport>
      <div
        v-if="filterPopoverCol"
        class="col-filter-backdrop"
        @click="closeFilterPopover"
      />

      <!-- Cell editor popover -->
      <teleport to="body">
        <div
          v-if="cellPopover"
          class="cell-popover-backdrop"
          @click.self="cancelCellPopover"
        >
          <div
            class="cell-popover"
            @keydown="onCellPopoverKeydown"
          >
            <div class="cell-popover-header">
              <span class="cell-popover-col">{{ cellPopover.col }}</span>
              <span class="cell-popover-type">{{ cellPopover.colType }}</span>
              <span v-if="cellPopover.readOnly" class="cell-popover-readonly">只读</span>
              <div class="cell-popover-header-actions">
                <button class="cell-popover-copy" @click="copyCellContent" title="复制">
                  <v-icon size="14">mdi-content-copy</v-icon>
                </button>
              </div>
            </div>
            <div class="cell-popover-body">
              <textarea
                ref="cellPopoverTextarea"
                v-model="cellPopover.value"
                class="cell-popover-textarea"
                :readonly="cellPopover.readOnly"
                :placeholder="cellPopover.readOnly ? '' : '输入值... (NULL 表示空值)'"
                spellcheck="false"
              />
            </div>
            <div class="cell-popover-footer">
              <span class="cell-popover-hint">
                <kbd>Ctrl</kbd>+<kbd>Enter</kbd> 保存 · <kbd>Esc</kbd> 取消
              </span>
              <div class="cell-popover-actions">
                <button class="cyber-btn-secondary cell-popover-btn" @click="cancelCellPopover">取消</button>
                <button
                  v-if="!cellPopover.readOnly"
                  class="cyber-btn cell-popover-btn"
                  @click="commitCellPopover"
                >保存</button>
              </div>
            </div>
          </div>
        </div>
      </teleport>

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
  text-shadow: 0 0 8px var(--focus-cyan);
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
  background: var(--status-error-bg);
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
  padding: 4px 8px;
  text-align: left;
  user-select: none;
  white-space: nowrap;
  transition: background 0.15s;
  position: relative;
}

.col-header:hover {
  background: var(--hover-cyan-soft);
}

.col-header.sorted {
  background: var(--hover-cyan-faint);
}

.col-header-inner {
  display: inline-flex;
  align-items: center;
  cursor: pointer;
  max-width: calc(100% - 20px);
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

.col-filter-btn {
  position: absolute;
  right: 2px;
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  background: none;
  border: none;
  color: var(--muted);
  cursor: pointer;
  border-radius: 2px;
  padding: 0;
  opacity: 0;
  transition: opacity 0.15s, color 0.15s;
}
.col-header:hover .col-filter-btn {
  opacity: 1;
}
.col-filter-btn.active {
  opacity: 1;
  color: var(--cyan);
}
.col-filter-btn:hover {
  color: var(--cyan);
  background: var(--active-cyan);
}

/* ─── 列筛选 popover ─── */
.col-filter-popover {
  background: var(--panel-solid);
  border: 1px solid var(--line-2);
  border-radius: 8px;
  box-shadow: var(--shadow);
  min-width: 180px;
  max-width: 260px;
  overflow: hidden;
}
.col-filter-popover-header {
  padding: 6px 10px;
  font-size: 11px;
  font-weight: 600;
  color: var(--cyan);
  background: var(--hover-cyan-soft);
  border-bottom: 1px solid var(--line);
}
.col-filter-popover-body {
  padding: 8px;
}
.col-filter-popover-input {
  width: 100%;
  font-size: 12px;
  padding: 4px 8px !important;
  height: 28px;
}
.col-filter-popover-actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
  padding: 6px 8px;
  border-top: 1px solid var(--line);
}
.col-filter-backdrop {
  position: fixed;
  inset: 0;
  z-index: 9998;
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
  background: var(--hover-cyan-faint);
}

.cell.editable {
  cursor: text;
}

.cell.editable:hover {
  background: var(--hover-cyan);
  outline: 1px dashed var(--cyan);
  outline-offset: -1px;
}

.cell.dirty {
  border-left: 2px solid var(--cyan);
  background: var(--hover-cyan-faint);
}

.cell-edit-input {
  width: 100%;
  padding: 2px 4px;
  background: var(--hover-cyan);
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

.action-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.save-btn {
  min-width: 42px;
  height: 28px;
  padding: 0 8px;
  border-radius: 6px;
  border: 1px solid var(--line-2);
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  transition: all 0.2s;
}

.save-btn.active {
  border-color: var(--status-connecting-border);
  color: var(--cyan);
  background: var(--active-cyan);
  box-shadow: 0 0 10px -6px var(--cyan);
}

.save-btn:hover:not(:disabled) {
  border-color: var(--cyan);
  color: var(--cyan);
}

.save-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.row-selected td { background: var(--hover-cyan-soft); }
.row-selected:hover td { background: var(--active-cyan); }
.col-index.selected { color: var(--cyan); font-weight: 700; }

/* ─── 单元格编辑器弹窗 ─── */
.cell-popover-backdrop {
  position: fixed;
  inset: 0;
  z-index: 9999;
  background: rgba(0, 0, 0, 0.25);
  display: flex;
  align-items: center;
  justify-content: center;
}
.cell-popover {
  background: var(--panel-solid);
  border: 1px solid var(--line-2);
  border-radius: 12px;
  box-shadow: var(--shadow), var(--glow-soft);
  width: 440px;
  max-width: calc(100vw - 32px);
  max-height: 420px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  animation: cell-popover-in 0.15s cubic-bezier(0.4, 0, 0.2, 1);
}
@keyframes cell-popover-in {
  from { opacity: 0; transform: translateY(-6px) scale(0.97); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
.cell-popover-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--hover-cyan-faint);
  border-bottom: 1px solid var(--line);
}
.cell-popover-col {
  font-size: 12px;
  font-weight: 600;
  color: var(--cyan);
  font-family: 'JetBrains Mono', monospace;
}
.cell-popover-type {
  font-size: 10px;
  color: var(--muted);
  padding: 1px 6px;
  background: var(--hover-cyan);
  border-radius: 4px;
}
.cell-popover-readonly {
  font-size: 10px;
  color: var(--yellow);
  padding: 1px 6px;
  background: rgba(255, 200, 0, 0.1);
  border-radius: 4px;
}
.cell-popover-header-actions {
  margin-left: auto;
  display: flex;
  gap: 4px;
}
.cell-popover-copy {
  width: 26px;
  height: 26px;
  border: 1px solid var(--line-2);
  border-radius: 6px;
  background: transparent;
  color: var(--text-2);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s;
}
.cell-popover-copy:hover {
  border-color: var(--cyan);
  color: var(--cyan);
  background: var(--hover-cyan);
}
.cell-popover-body {
  flex: 1;
  padding: 8px 12px;
  overflow: hidden;
  display: flex;
}
.cell-popover-textarea {
  width: 100%;
  min-height: 120px;
  max-height: 280px;
  resize: vertical;
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 8px 10px;
  color: var(--text);
  font-family: 'JetBrains Mono', monospace;
  font-size: 12px;
  line-height: 1.6;
  outline: none;
  transition: border-color 0.15s;
}
.cell-popover-textarea:focus {
  border-color: var(--cyan);
  box-shadow: 0 0 0 2px var(--focus-cyan);
}
.cell-popover-textarea[readonly] {
  color: var(--text-2);
  cursor: default;
}
.cell-popover-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-top: 1px solid var(--line);
}
.cell-popover-hint {
  font-size: 10px;
  color: var(--muted);
  display: flex;
  align-items: center;
  gap: 4px;
}
.cell-popover-hint kbd {
  display: inline-block;
  padding: 1px 5px;
  background: var(--panel-solid-2);
  border: 1px solid var(--line-2);
  border-radius: 3px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  color: var(--text-2);
}
.cell-popover-actions {
  display: flex;
  gap: 6px;
}
.cell-popover-btn {
  font-size: 11px !important;
  padding: 4px 14px !important;
}
</style>
