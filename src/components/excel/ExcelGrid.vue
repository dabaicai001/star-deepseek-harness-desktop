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
const contextMenu = ref<{ x: number; y: number; row: number; col: number } | null>(null)

const emit = defineEmits<{
  'cell-change': [edits: CellEdit[]]
  'insert-row': [row: number]
  'delete-row': [row: number]
  'insert-col': [col: number]
  'delete-col': [col: number]
  sort: [col: number, descending: boolean]
  undo: []
  redo: []
}>()

const containerHeight = computed(() => containerRef.value?.clientHeight ?? 600)
const containerWidth = computed(() => containerRef.value?.clientWidth ?? 800)

const HEADER_HEIGHT = 30
const ROW_HEADER_WIDTH = 52

// 使用筛选后的数据
const displayData = computed(() => store.filteredRowData)

const dataFrozenRows = computed(() => Math.max(0, store.frozenRows - 1))
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

function frozenColLeftOffset(col: number): number {
  let x = ROW_HEADER_WIDTH
  for (let c = 0; c < col; c++) {
    x += store.getColWidth(c)
  }
  return x
}

function cellLeftOffset(col: number): number {
  if (col < store.frozenCols) {
    return scrollLeft.value + frozenColLeftOffset(col)
  }
  return colLeftOffset(col)
}

const visibleCols = computed(() => {
  const colMap = new Map<number, { index: number; name: string; width: number; left: number; frozen: boolean }>()
  for (let c = 0; c < Math.min(store.frozenCols, store.columns.length); c++) {
    colMap.set(c, {
      index: c,
      name: store.colIndexToLetter(c),
      width: store.getColWidth(c),
      left: cellLeftOffset(c),
      frozen: true,
    })
  }
  for (let c = visibleStartCol.value; c < visibleEndCol.value; c++) {
    colMap.set(c, {
      index: c,
      name: store.colIndexToLetter(c),
      width: store.getColWidth(c),
      left: cellLeftOffset(c),
      frozen: c < store.frozenCols,
    })
  }
  return Array.from(colMap.values()).sort((a, b) => a.index - b.index)
})

const visibleRows = computed(() => {
  const rows: { row: number; cells: { col: number; value: string }[]; top: number; frozen: boolean }[] = []
  const data = displayData.value
  const rowSet = new Set<number>()
  for (let r = 0; r < Math.min(dataFrozenRows.value, data.length); r++) {
    rowSet.add(r)
  }
  for (let r = visibleStartRow.value; r < visibleEndRow.value; r++) {
    rowSet.add(r)
  }
  Array.from(rowSet).sort((a, b) => a - b).forEach((r) => {
    const frozen = r < dataFrozenRows.value
    const cells = visibleCols.value.map(col => ({
      col: col.index,
      value: r < data.length ? (data[r][col.index] ?? '') : '',
    }))
    rows.push({
      row: r,
      cells,
      top: frozen ? HEADER_HEIGHT + scrollTop.value + (r * store.ROW_HEIGHT) : HEADER_HEIGHT + (r * store.ROW_HEIGHT),
      frozen,
    })
  })
  return rows
})

function visibleColByIndex(col: number) {
  return visibleCols.value.find(c => c.index === col)
}

function closeContextMenu() {
  contextMenu.value = null
}

function openContextMenu(e: MouseEvent, row: number, col: number) {
  e.preventDefault()
  store.selectCell(row, col)
  contextMenu.value = { x: e.clientX, y: e.clientY, row, col }
}

async function copySelection() {
  closeContextMenu()
  const text = store.selectionToTsv()
  if (!text) return
  await navigator.clipboard?.writeText(text)
}

async function pasteFromClipboard() {
  closeContextMenu()
  const text = await navigator.clipboard?.readText()
  const edits = store.pasteTsv(text || '')
  if (edits.length > 0) emit('cell-change', edits)
}

function deleteSelection() {
  const range = store.normalizedSelectionRange()
  if (!range) return
  const changes: { row: number; col: number; value: string }[] = []
  for (let r = range.startRow; r <= range.endRow; r++) {
    for (let c = range.startCol; c <= range.endCol; c++) {
      changes.push({ row: r, col: c, value: '' })
    }
  }
  const edits = store.commitDisplayCellEdits(changes)
  if (edits.length > 0) emit('cell-change', edits)
}

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
      const edits = store.commitDisplayCellEdits([{ row, col, value: editValue.value }])
      if (edits.length > 0) emit('cell-change', edits)
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

async function handleKeydown(e: KeyboardEvent) {
  if (editingCell.value) return
  const sel = store.selectedCell
  if (!sel) return

  const { row, col } = sel
  const maxRow = Math.max(displayData.value.length - 1, 0)
  const maxCol = Math.max(store.columns.length - 1, 0)
  const meta = e.ctrlKey || e.metaKey

  if (meta && e.key.toLowerCase() === 'c') {
    e.preventDefault()
    await copySelection()
    return
  }
  if (meta && e.key.toLowerCase() === 'v') {
    e.preventDefault()
    await pasteFromClipboard()
    return
  }
  if (meta && e.key.toLowerCase() === 'x') {
    e.preventDefault()
    await copySelection()
    deleteSelection()
    return
  }
  if (meta && e.key.toLowerCase() === 'z') {
    e.preventDefault()
    emit('undo')
    return
  }
  if (meta && e.key.toLowerCase() === 'y') {
    e.preventDefault()
    emit('redo')
    return
  }

  const moveTo = (nextRow: number, nextCol: number) => {
    if (e.shiftKey) store.extendSelection(nextRow, nextCol)
    else store.selectCell(nextRow, nextCol)
  }

  switch (e.key) {
    case 'ArrowUp':
      e.preventDefault()
      moveTo(Math.max(0, row - 1), col)
      break
    case 'ArrowDown':
      e.preventDefault()
      moveTo(Math.min(maxRow, row + 1), col)
      break
    case 'ArrowLeft':
      e.preventDefault()
      moveTo(row, Math.max(0, col - 1))
      break
    case 'ArrowRight':
      e.preventDefault()
      moveTo(row, Math.min(maxCol, col + 1))
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
      deleteSelection()
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
  window.addEventListener('click', closeContextMenu)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleKeydown)
  window.removeEventListener('click', closeContextMenu)
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
            :class="{ selected: isColSelected(col.index), frozen: col.frozen }"
            :style="{
              left: col.left + 'px',
              width: col.width + 'px',
              height: HEADER_HEIGHT + 'px',
            }"
            @click="handleColHeaderClick(col.index)"
            @contextmenu.prevent="openContextMenu($event, 0, col.index)"
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
          :class="{ 'row-selected': isRowSelected(r.row), frozen: r.frozen }"
          :style="{
            top: r.top + 'px',
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
            @contextmenu.prevent="openContextMenu($event, r.row, 0)"
          >
            {{ r.row + 1 }}
          </div>

          <div
            v-for="cell in r.cells"
            :key="cell.col"
            class="excel-cell"
            :class="{
              selected: isSelected(r.row, cell.col),
              'in-range': isInSelectedRange(r.row, cell.col),
              'col-highlight': isColSelected(cell.col),
              'frozen-col': cell.col < store.frozenCols,
              'frozen-row': r.frozen,
              editing: editingCell?.row === r.row && editingCell?.col === cell.col,
            }"
            :style="{
              left: (visibleColByIndex(cell.col)?.left || 0) + 'px',
              width: (visibleColByIndex(cell.col)?.width || 120) + 'px',
              height: store.ROW_HEIGHT + 'px',
            }"
            @click.stop="handleCellClick(r.row, cell.col)"
            @dblclick.stop="handleCellDblClick(r.row, cell.col)"
            @contextmenu.stop="openContextMenu($event, r.row, cell.col)"
          >
            <template v-if="editingCell?.row === r.row && editingCell?.col === cell.col">
              <input
                ref="editInputRef"
                v-model="editValue"
                class="excel-cell-input"
                @keydown.stop="handleEditKeydown"
                @click.stop
              />
            </template>
            <template v-else>
              <span class="cell-content">{{ cell.value }}</span>
            </template>
          </div>
        </div>
      </div>
    </div>

    <Teleport to="body">
      <div
        v-if="contextMenu"
        class="context-menu excel-context-menu"
        :style="{ left: contextMenu.x + 'px', top: contextMenu.y + 'px' }"
        @click.stop
      >
        <div class="cm-header">
          <v-icon class="type-icon" size="12">mdi-table-large</v-icon>
          <span>{{ store.activeCellLabel || 'Cell' }}</span>
        </div>
        <div class="cm-item" @click="copySelection">
          <v-icon>mdi-content-copy</v-icon>
          <span class="label">复制</span>
          <span class="shortcut">Ctrl+C</span>
        </div>
        <div class="cm-item" @click="pasteFromClipboard">
          <v-icon>mdi-content-paste</v-icon>
          <span class="label">粘贴</span>
          <span class="shortcut">Ctrl+V</span>
        </div>
        <div class="cm-divider" />
        <div class="cm-item" @click="emit('insert-row', contextMenu.row); closeContextMenu()">
          <v-icon>mdi-table-row-plus-before</v-icon>
          <span class="label">在上方插入行</span>
        </div>
        <div class="cm-item danger" @click="emit('delete-row', contextMenu.row); closeContextMenu()">
          <v-icon>mdi-table-row-remove</v-icon>
          <span class="label">删除当前行</span>
        </div>
        <div class="cm-item" @click="emit('insert-col', contextMenu.col); closeContextMenu()">
          <v-icon>mdi-table-column-plus-before</v-icon>
          <span class="label">在左侧插入列</span>
        </div>
        <div class="cm-item danger" @click="emit('delete-col', contextMenu.col); closeContextMenu()">
          <v-icon>mdi-table-column-remove</v-icon>
          <span class="label">删除当前列</span>
        </div>
        <div class="cm-divider" />
        <div class="cm-item" @click="emit('sort', contextMenu.col, false); closeContextMenu()">
          <v-icon>mdi-sort-ascending</v-icon>
          <span class="label">按此列升序</span>
        </div>
        <div class="cm-item" @click="emit('sort', contextMenu.col, true); closeContextMenu()">
          <v-icon>mdi-sort-descending</v-icon>
          <span class="label">按此列降序</span>
        </div>
      </div>
    </Teleport>
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

.excel-col-header.frozen {
  z-index: 5;
  background: var(--panel-solid-2);
  box-shadow: 1px 0 0 var(--line-2);
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

.excel-data-row.frozen {
  z-index: 4;
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

.excel-cell.frozen-col,
.excel-cell.frozen-row {
  background: var(--panel-solid);
  z-index: 3;
}

.excel-cell.frozen-col.frozen-row {
  z-index: 4;
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
