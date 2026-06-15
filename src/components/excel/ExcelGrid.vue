<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { useExcelStore, type CellEdit } from '@/stores/excel'

const store = useExcelStore()

const containerRef = ref<HTMLElement | null>(null)
const scrollLeft = ref(0)
const scrollTop = ref(0)
const editingCell = ref<{ row: number; col: number } | null>(null)
const editValue = ref('')
const editInputRef = ref<HTMLInputElement | null>(null)

const emit = defineEmits<{
  'cell-change': [edits: CellEdit[]]
}>()

const containerHeight = computed(() => containerRef.value?.clientHeight ?? 600)
const containerWidth = computed(() => containerRef.value?.clientWidth ?? 800)

const HEADER_HEIGHT = 30
const ROW_HEADER_WIDTH = 52

// 使用筛选后的数据
const displayData = computed(() => store.filteredRowData)

const visibleStartRow = computed(() => Math.max(0, Math.floor(scrollTop.value / store.ROW_HEIGHT) - 5))
const visibleEndRow = computed(() => {
  const visible = Math.ceil((containerHeight.value - HEADER_HEIGHT) / store.ROW_HEIGHT) + 5
  return Math.min(Math.max(displayData.value.length, 1), visibleStartRow.value + visible + 10)
})

const visibleStartCol = computed(() => {
  let x = 0
  for (let c = 0; c < store.columns.length; c++) {
    const w = store.getColWidth(c)
    if (x + w > scrollLeft.value) return Math.max(0, c - 1)
    x += w
  }
  return Math.max(0, store.columns.length - 1)
})

const visibleEndCol = computed(() => {
  let x = 0
  const start = visibleStartCol.value
  for (let c = start; c < store.columns.length; c++) {
    x += store.getColWidth(c)
    if (x > containerWidth.value + 200) return Math.min(store.columns.length, c + 1)
  }
  return store.columns.length
})

const totalWidth = computed(() => {
  let w = ROW_HEADER_WIDTH
  for (let i = 0; i < store.columns.length; i++) {
    w += store.getColWidth(i)
  }
  return Math.max(w, containerWidth.value)
})

const totalHeight = computed(() => {
  const rows = Math.max(displayData.value.length, 1)
  return rows * store.ROW_HEIGHT + HEADER_HEIGHT
})

function colLeftOffset(col: number): number {
  let x = ROW_HEADER_WIDTH
  for (let c = 0; c < col; c++) {
    x += store.getColWidth(c)
  }
  return x
}

const visibleCols = computed(() => {
  const cols: { index: number; name: string; width: number; left: number }[] = []
  for (let c = visibleStartCol.value; c < visibleEndCol.value; c++) {
    cols.push({
      index: c,
      name: store.colIndexToLetter(c),
      width: store.getColWidth(c),
      left: colLeftOffset(c),
    })
  }
  return cols
})

const visibleRows = computed(() => {
  const rows: { row: number; cells: string[] }[] = []
  const data = displayData.value
  for (let r = visibleStartRow.value; r < visibleEndRow.value; r++) {
    const cells: string[] = []
    for (let c = visibleStartCol.value; c < visibleEndCol.value; c++) {
      cells.push(r < data.length ? (data[r][c] ?? '') : '')
    }
    rows.push({ row: r, cells })
  }
  return rows
})

function isSelected(row: number, col: number): boolean {
  const sel = store.selectedCell
  return sel?.row === row && sel?.col === col
}

function isRowSelected(row: number): boolean {
  return store.selectionMode === 'row' && store.selectedRange !== null &&
    row >= store.selectedRange.startRow && row <= store.selectedRange.endRow
}

function isColSelected(col: number): boolean {
  return store.selectionMode === 'col' && store.selectedRange !== null &&
    col >= store.selectedRange.startCol && col <= store.selectedRange.endCol
}

function isInSelectedRange(row: number, col: number): boolean {
  const r = store.selectedRange
  if (!r) return false
  return row >= r.startRow && row <= r.endRow && col >= r.startCol && col <= r.endCol
}

function handleContainerScroll() {
  if (!containerRef.value) return
  scrollLeft.value = containerRef.value.scrollLeft
  scrollTop.value = containerRef.value.scrollTop
  closeEditor()
}

function handleCellClick(row: number, col: number) {
  store.selectCell(row, col)
}

function handleRowHeaderClick(row: number) {
  store.selectRow(row)
}

function handleColHeaderClick(col: number) {
  store.selectCol(col)
}

function handleCellDblClick(row: number, col: number) {
  editingCell.value = { row, col }
  editValue.value = store.getCell(row, col)
  nextTick(() => {
    editInputRef.value?.focus()
    editInputRef.value?.select()
  })
}

function closeEditor() {
  if (editingCell.value) {
    const { row, col } = editingCell.value
    const oldValue = store.getCell(row, col)
    if (editValue.value !== oldValue) {
      store.updateCellValue(row, col, editValue.value)
      emit('cell-change', [{ row, col, value: editValue.value }])
    }
  }
  editingCell.value = null
  editValue.value = ''
}

function handleEditKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') {
    e.preventDefault()
    closeEditor()
  } else if (e.key === 'Escape') {
    editingCell.value = null
    editValue.value = ''
  } else if (e.key === 'Tab') {
    e.preventDefault()
    closeEditor()
    const sel = store.selectedCell
    if (sel) {
      store.selectCell(sel.row, sel.col + (e.shiftKey ? -1 : 1))
    }
  }
}

function handleKeydown(e: KeyboardEvent) {
  if (editingCell.value) return
  const sel = store.selectedCell
  if (!sel) return

  const { row, col } = sel
  const maxRow = Math.max(displayData.value.length - 1, 0)

  switch (e.key) {
    case 'ArrowUp':
      e.preventDefault()
      store.selectCell(Math.max(0, row - 1), col)
      break
    case 'ArrowDown':
      e.preventDefault()
      store.selectCell(Math.min(maxRow, row + 1), col)
      break
    case 'ArrowLeft':
      e.preventDefault()
      store.selectCell(row, Math.max(0, col - 1))
      break
    case 'ArrowRight':
      e.preventDefault()
      store.selectCell(row, Math.min(store.columns.length - 1, col + 1))
      break
    case 'Enter':
      e.preventDefault()
      handleCellDblClick(row, col)
      break
    case 'F2':
      e.preventDefault()
      handleCellDblClick(row, col)
      break
    case 'Delete':
    case 'Backspace':
      e.preventDefault()
      store.updateCellValue(row, col, '')
      emit('cell-change', [{ row, col, value: '' }])
      break
    default:
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
        e.preventDefault()
        editingCell.value = { row, col }
        editValue.value = e.key
        nextTick(() => {
          if (editInputRef.value) {
            editInputRef.value.focus()
            editInputRef.value.setSelectionRange(1, 1)
          }
        })
      }
      break
  }
}

const colResizeStartCol = ref<number | null>(null)
const colResizeStartX = ref(0)
const colResizeStartW = ref(0)

function handleColResizeMousedown(col: number, e: MouseEvent) {
  e.preventDefault()
  e.stopPropagation()
  colResizeStartCol.value = col
  colResizeStartX.value = e.clientX
  colResizeStartW.value = store.getColWidth(col)
  document.addEventListener('mousemove', handleColResizeMousemove)
  document.addEventListener('mouseup', handleColResizeMouseup)
}

function handleColResizeMousemove(e: MouseEvent) {
  if (colResizeStartCol.value === null) return
  const diff = e.clientX - colResizeStartX.value
  store.setColWidth(colResizeStartCol.value, colResizeStartW.value + diff)
}

function handleColResizeMouseup() {
  colResizeStartCol.value = null
  document.removeEventListener('mousemove', handleColResizeMousemove)
  document.removeEventListener('mouseup', handleColResizeMouseup)
}

onMounted(() => {
  window.addEventListener('keydown', handleKeydown)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleKeydown)
  document.removeEventListener('mousemove', handleColResizeMousemove)
  document.removeEventListener('mouseup', handleColResizeMouseup)
})
</script>

<template>
  <div class="excel-grid-container">
    <div
      ref="containerRef"
      class="excel-grid-scroll"
      @scroll="handleContainerScroll"
    >
      <div class="excel-grid-inner" :style="{ width: totalWidth + 'px', height: totalHeight + 'px' }">
        <!-- Column headers row -->
        <div class="excel-header-row" :style="{ height: HEADER_HEIGHT + 'px' }">
          <div
            class="excel-corner-header"
            :style="{ width: ROW_HEADER_WIDTH + 'px', height: HEADER_HEIGHT + 'px' }"
            @click="store.clearSelection()"
          />
          <div
            v-for="col in visibleCols"
            :key="'h' + col.index"
            class="excel-col-header"
            :class="{ selected: isColSelected(col.index) }"
            :style="{
              left: col.left + 'px',
              width: col.width + 'px',
              height: HEADER_HEIGHT + 'px',
            }"
            @click="handleColHeaderClick(col.index)"
          >
            <span>{{ col.name }}</span>
            <span
              class="col-resize-handle"
              @mousedown.stop="handleColResizeMousedown(col.index, $event)"
            />
          </div>
        </div>

        <!-- Data rows -->
        <div
          v-for="r in visibleRows"
          :key="r.row"
          class="excel-data-row"
          :class="{ 'row-selected': isRowSelected(r.row) }"
          :style="{
            top: HEADER_HEIGHT + (r.row * store.ROW_HEIGHT) + 'px',
            height: store.ROW_HEIGHT + 'px',
          }"
        >
          <div
            class="excel-row-header"
            :class="{ selected: isRowSelected(r.row) }"
            :style="{
              width: ROW_HEADER_WIDTH + 'px',
              height: store.ROW_HEIGHT + 'px',
            }"
            @click="handleRowHeaderClick(r.row)"
          >
            {{ r.row + 1 }}
          </div>

          <div
            v-for="(cell, ci) in r.cells"
            :key="visibleStartCol + ci"
            class="excel-cell"
            :class="{
              selected: isSelected(r.row, visibleStartCol + ci),
              'in-range': isInSelectedRange(r.row, visibleStartCol + ci),
              'col-highlight': isColSelected(visibleStartCol + ci),
              editing: editingCell?.row === r.row && editingCell?.col === visibleStartCol + ci,
            }"
            :style="{
              left: (visibleCols[ci]?.left || 0) + 'px',
              width: (visibleCols[ci]?.width || 120) + 'px',
              height: store.ROW_HEIGHT + 'px',
            }"
            @click.stop="handleCellClick(r.row, visibleStartCol + ci)"
            @dblclick.stop="handleCellDblClick(r.row, visibleStartCol + ci)"
          >
            <template v-if="editingCell?.row === r.row && editingCell?.col === visibleStartCol + ci">
              <input
                ref="editInputRef"
                v-model="editValue"
                class="excel-cell-input"
                @keydown.stop="handleEditKeydown"
                @click.stop
              />
            </template>
            <template v-else>
              <span class="cell-content">{{ cell }}</span>
            </template>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.excel-grid-container {
  flex: 1;
  overflow: hidden;
  background: var(--bg);
}

.excel-grid-scroll {
  width: 100%;
  height: 100%;
  overflow: auto;
  position: relative;
}

.excel-grid-inner {
  position: relative;
}

.excel-header-row {
  position: sticky;
  top: 0;
  z-index: 3;
  background: var(--panel-solid-2);
  border-bottom: 1px solid var(--line);
}

.excel-corner-header {
  position: sticky;
  left: 0;
  z-index: 4;
  background: var(--panel-solid-2);
  border-right: 1px solid var(--line);
}

.excel-col-header {
  position: absolute;
  top: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-2);
  font-family: 'JetBrains Mono', monospace;
  border-right: 1px solid var(--line);
  user-select: none;
  overflow: hidden;
  cursor: pointer;
}

.excel-col-header.selected {
  background: rgba(0, 240, 255, 0.12);
  color: var(--cyan);
}

.col-resize-handle {
  position: absolute;
  right: 0;
  top: 0;
  bottom: 0;
  width: 4px;
  cursor: col-resize;
}

.col-resize-handle:hover {
  background: var(--cyan);
  opacity: 0.5;
}

.excel-data-row {
  position: absolute;
  left: 0;
  right: 0;
}

.excel-data-row.row-selected .excel-cell {
  background: rgba(0, 240, 255, 0.04);
}

.excel-row-header {
  position: sticky;
  left: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  color: var(--muted);
  font-family: 'JetBrains Mono', monospace;
  background: var(--panel-solid-2);
  border-right: 1px solid var(--line);
  border-bottom: 1px solid var(--line);
  user-select: none;
  cursor: pointer;
}

.excel-row-header.selected {
  background: rgba(0, 240, 255, 0.12);
  color: var(--cyan);
}

.excel-cell {
  position: absolute;
  display: flex;
  align-items: center;
  top: 0;
  padding: 2px 6px;
  font-size: 12px;
  color: var(--text);
  font-family: 'JetBrains Mono', monospace;
  border-right: 1px solid var(--line);
  border-bottom: 1px solid var(--line);
  cursor: cell;
  overflow: hidden;
}

.excel-cell.selected {
  background: rgba(0, 240, 255, 0.08);
  outline: 2px solid var(--cyan);
  outline-offset: -2px;
  z-index: 1;
}

.excel-cell.in-range {
  background: rgba(0, 240, 255, 0.04);
}

.excel-cell.col-highlight {
  background: rgba(0, 240, 255, 0.04);
}

.excel-cell.editing {
  outline: 2px solid var(--cyan);
  outline-offset: -2px;
  z-index: 2;
  padding: 0;
}

.cell-content {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  width: 100%;
}

.excel-cell-input {
  width: 100%;
  height: 100%;
  border: none;
  outline: none;
  background: var(--bg);
  color: var(--text);
  font-size: 12px;
  font-family: 'JetBrains Mono', monospace;
  padding: 2px 6px;
}
</style>
