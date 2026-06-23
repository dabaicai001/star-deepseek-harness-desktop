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
const headerFilter = ref<{ x: number; y: number; col: number; text: string; selectedValues: Set<string> } | null>(null)
const draggingSelection = ref(false)
const fillDrag = ref<{ sourceRow: number; sourceCol: number; targetRow: number; targetCol: number } | null>(null)

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
  const colMap = new Map<number, { index: number; letter: string; label: string; width: number; left: number; frozen: boolean }>()
  for (let c = 0; c < Math.min(store.frozenCols, store.columns.length); c++) {
    const letter = store.colIndexToLetter(c)
    colMap.set(c, {
      index: c,
      letter,
      label: store.columns[c]?.trim() || letter,
      width: store.getColWidth(c),
      left: cellLeftOffset(c),
      frozen: true,
    })
  }
  for (let c = visibleStartCol.value; c < visibleEndCol.value; c++) {
    const letter = store.colIndexToLetter(c)
    colMap.set(c, {
      index: c,
      letter,
      label: store.columns[c]?.trim() || letter,
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

function closeHeaderFilter() {
  headerFilter.value = null
}

function openContextMenu(e: MouseEvent, row: number, col: number) {
  e.preventDefault()
  closeHeaderFilter()
  if (e.ctrlKey || e.metaKey) {
    store.toggleCell(row, col)
  } else if (!store.isCellSelected(row, col)) {
    store.selectCell(row, col)
  }
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
  if (store.selectedCells.length > 0) {
    const changes = store.selectedCells
      .map((key) => {
        const [rowText, colText] = key.split(':')
        return { row: Number(rowText), col: Number(colText), value: '' }
      })
      .filter(change => Number.isInteger(change.row) && Number.isInteger(change.col))
    const edits = store.commitDisplayCellEdits(changes)
    if (edits.length > 0) emit('cell-change', edits)
    return
  }

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

function fillPreviewRange() {
  const drag = fillDrag.value
  if (!drag) return null
  return {
    startRow: Math.min(drag.sourceRow, drag.targetRow),
    endRow: Math.max(drag.sourceRow, drag.targetRow),
    startCol: Math.min(drag.sourceCol, drag.targetCol),
    endCol: Math.max(drag.sourceCol, drag.targetCol),
  }
}

function isSelected(row: number, col: number): boolean {
  if (store.selectedCells.length > 0) return store.selectedCells.includes(`${row}:${col}`)
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
  return store.isCellSelected(row, col)
}

function isInFillPreview(row: number, col: number): boolean {
  const range = fillPreviewRange()
  if (!range) return false
  return row >= range.startRow && row <= range.endRow && col >= range.startCol && col <= range.endCol
}

function handleContainerScroll() {
  if (!containerRef.value) return
  scrollLeft.value = containerRef.value.scrollLeft
  scrollTop.value = containerRef.value.scrollTop
  closeEditor()
  closeHeaderFilter()
}

function handleCellMouseDown(e: MouseEvent, row: number, col: number) {
  if (e.button !== 0) return
  e.preventDefault()
  closeContextMenu()
  closeHeaderFilter()
  if (e.detail >= 2 && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
    draggingSelection.value = false
    store.selectCell(row, col)
    handleCellDblClick(row, col)
    return
  }
  if (e.ctrlKey || e.metaKey) {
    store.toggleCell(row, col)
    draggingSelection.value = false
  } else if (e.shiftKey && store.selectedCell) {
    store.extendSelection(row, col)
    draggingSelection.value = false
  } else {
    store.selectCell(row, col)
    draggingSelection.value = true
  }
}

function handleCellMouseEnter(row: number, col: number) {
  if (fillDrag.value) {
    fillDrag.value.targetRow = row
    fillDrag.value.targetCol = col
    return
  }
  if (!draggingSelection.value) return
  store.extendSelection(row, col)
}

function startFillDrag(e: MouseEvent, row: number, col: number) {
  if (!(e.ctrlKey || e.metaKey) || e.button !== 0) return
  e.preventDefault()
  e.stopPropagation()
  draggingSelection.value = false
  fillDrag.value = { sourceRow: row, sourceCol: col, targetRow: row, targetCol: col }
}

function commitFillDrag() {
  const drag = fillDrag.value
  if (!drag) return
  fillDrag.value = null
  if (drag.sourceRow === drag.targetRow && drag.sourceCol === drag.targetCol) return

  const value = store.getCell(drag.sourceRow, drag.sourceCol)
  const startRow = Math.min(drag.sourceRow, drag.targetRow)
  const endRow = Math.max(drag.sourceRow, drag.targetRow)
  const startCol = Math.min(drag.sourceCol, drag.targetCol)
  const endCol = Math.max(drag.sourceCol, drag.targetCol)
  const changes: { row: number; col: number; value: string }[] = []
  for (let row = startRow; row <= endRow; row++) {
    for (let col = startCol; col <= endCol; col++) {
      if (row === drag.sourceRow && col === drag.sourceCol) continue
      changes.push({ row, col, value })
    }
  }
  const edits = store.commitDisplayCellEdits(changes)
  if (edits.length > 0) emit('cell-change', edits)
}

function handleRowHeaderClick(row: number) {
  store.selectRow(row)
}

function handleColHeaderClick(col: number) {
  store.selectCol(col)
}

function openHeaderFilter(e: MouseEvent, col: number) {
  e.preventDefault()
  e.stopPropagation()
  closeContextMenu()
  headerFilter.value = {
    x: e.clientX,
    y: e.clientY,
    col,
    text: store.filterCol === col ? store.filterText : '',
    selectedValues: store.filterCol === col ? new Set(store.filterValues) : new Set(),
  }
}

function headerFilterStats(col: number) {
  const values = store.rowData.map(row => String(row[col] ?? '').trim())
  const nonEmpty = values.filter(Boolean).length
  const blank = values.length - nonEmpty
  const distinct = new Set(values.filter(Boolean)).size
  return {
    total: values.length,
    nonEmpty,
    blank,
    distinct,
  }
}

function headerFilterValueCounts(col: number) {
  const counts = new Map<string, number>()
  for (const row of store.rowData) {
    const value = String(row[col] ?? '').trim()
    const key = value || '(空白)'
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return Array.from(counts.entries())
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
    .slice(0, 100)
}

function applyHeaderFilter() {
  if (!headerFilter.value) return
  store.setFilter(headerFilter.value.text, headerFilter.value.col, [...headerFilter.value.selectedValues])
  closeHeaderFilter()
}

function clearHeaderFilter() {
  store.clearFilter()
  closeHeaderFilter()
}

function toggleHeaderFilterValue(value: string) {
  if (!headerFilter.value) return
  const selectedValues = new Set(headerFilter.value.selectedValues)
  if (selectedValues.has(value)) {
    selectedValues.delete(value)
  } else {
    selectedValues.add(value)
  }
  headerFilter.value = { ...headerFilter.value, selectedValues }
}

function selectAllHeaderFilterValues() {
  if (!headerFilter.value) return
  headerFilter.value = {
    ...headerFilter.value,
    selectedValues: new Set(headerFilterValueCounts(headerFilter.value.col).map(item => item.value)),
  }
}

function clearHeaderFilterValues() {
  if (!headerFilter.value) return
  headerFilter.value = { ...headerFilter.value, selectedValues: new Set() }
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
  draggingSelection.value = false
  document.removeEventListener('mousemove', handleColResizeMousemove)
  document.removeEventListener('mouseup', handleColResizeMouseup)
}

function handleSelectionMouseup() {
  commitFillDrag()
  draggingSelection.value = false
}

onMounted(() => {
  window.addEventListener('keydown', handleKeydown)
  window.addEventListener('click', closeContextMenu)
  window.addEventListener('click', closeHeaderFilter)
  document.addEventListener('mouseup', handleSelectionMouseup)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleKeydown)
  window.removeEventListener('click', closeContextMenu)
  window.removeEventListener('click', closeHeaderFilter)
  document.removeEventListener('mouseup', handleSelectionMouseup)
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
            <span class="col-letter">{{ col.letter }}</span>
            <span class="col-title" :title="col.label">{{ col.label }}</span>
            <button
              class="col-filter-btn"
              :class="{ active: store.filterCol === col.index && (!!store.filterText || store.filterValues.length > 0) }"
              :title="`筛选 ${col.label}`"
              @click="openHeaderFilter($event, col.index)"
            >
              <v-icon size="10">mdi-filter-outline</v-icon>
            </button>
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
              'fill-preview': isInFillPreview(r.row, cell.col),
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
            @mousedown.stop="handleCellMouseDown($event, r.row, cell.col)"
            @mouseenter="handleCellMouseEnter(r.row, cell.col)"
            @dblclick.stop="handleCellDblClick(r.row, cell.col)"
            @contextmenu.stop="openContextMenu($event, r.row, cell.col)"
          >
            <template v-if="editingCell?.row === r.row && editingCell?.col === cell.col">
              <input
                ref="editInputRef"
                v-model="editValue"
                class="excel-cell-input"
                @keydown.stop="handleEditKeydown"
                @blur="closeEditor"
                @mousedown.stop
                @click.stop
              />
            </template>
            <template v-else>
              <span class="cell-content">{{ cell.value }}</span>
              <span
                v-if="isSelected(r.row, cell.col) && store.selectedCells.length === 0"
                class="fill-handle"
                title="Ctrl + 拖拽批量填充"
                @mousedown.stop="startFillDrag($event, r.row, cell.col)"
              />
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

    <Teleport to="body">
      <div
        v-if="headerFilter"
        class="header-filter-menu"
        :style="{ left: headerFilter.x + 'px', top: headerFilter.y + 'px' }"
        @click.stop
      >
        <div class="filter-title">
          <v-icon size="12">mdi-filter-outline</v-icon>
          <span>{{ store.columns[headerFilter.col] || store.colIndexToLetter(headerFilter.col) }}</span>
        </div>
        <div class="filter-stats">
          <div class="filter-stat">
            <span>总行</span>
            <strong>{{ headerFilterStats(headerFilter.col).total }}</strong>
          </div>
          <div class="filter-stat">
            <span>非空</span>
            <strong>{{ headerFilterStats(headerFilter.col).nonEmpty }}</strong>
          </div>
          <div class="filter-stat">
            <span>空白</span>
            <strong>{{ headerFilterStats(headerFilter.col).blank }}</strong>
          </div>
          <div class="filter-stat">
            <span>Distinct Count</span>
            <strong>{{ headerFilterStats(headerFilter.col).distinct }}</strong>
          </div>
        </div>
        <div class="filter-value-counts">
          <button
            v-for="item in headerFilterValueCounts(headerFilter.col)"
            :key="item.value"
            class="filter-value-count"
            :class="{ selected: headerFilter.selectedValues.has(item.value) }"
            :title="`${item.value}: ${item.count}`"
            @click="toggleHeaderFilterValue(item.value)"
          >
            <v-icon size="11">{{ headerFilter.selectedValues.has(item.value) ? 'mdi-checkbox-marked' : 'mdi-checkbox-blank-outline' }}</v-icon>
            <span>{{ item.value }}</span>
            <strong>{{ item.count }}</strong>
          </button>
        </div>
        <div class="filter-pick-actions">
          <button class="action-btn-sm" @click="selectAllHeaderFilterValues">全选</button>
          <button class="action-btn-sm" @click="clearHeaderFilterValues">清空选择</button>
          <span>{{ headerFilter.selectedValues.size }} 项</span>
        </div>
        <input
          v-model="headerFilter.text"
          class="cyber-input filter-input"
          placeholder="关键词包含..."
          autofocus
          @keydown.enter.prevent="applyHeaderFilter"
          @keydown.esc.prevent="closeHeaderFilter"
        />
        <div class="filter-actions">
          <button class="cyber-btn-secondary" @click="clearHeaderFilter">清除</button>
          <button class="cyber-btn" :disabled="!headerFilter.text.trim() && headerFilter.selectedValues.size === 0" @click="applyHeaderFilter">筛选</button>
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
  justify-content: flex-start;
  gap: 4px;
  padding: 0 24px 0 6px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-2);
  font-family: 'JetBrains Mono', monospace;
  border-right: 1px solid var(--line);
  user-select: none;
  overflow: hidden;
  cursor: pointer;
}

.col-letter {
  flex: 0 0 auto;
  color: var(--muted);
  font-size: 10px;
}

.col-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-2);
}

.col-filter-btn {
  position: absolute;
  right: 4px;
  top: 5px;
  width: 18px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid transparent;
  border-radius: 4px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
}

.col-filter-btn:hover,
.col-filter-btn.active {
  color: var(--cyan);
  background: var(--hover-cyan);
  border-color: var(--line-2);
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

.excel-cell.fill-preview {
  background: rgba(0, 240, 255, 0.1);
  outline: 1px dashed var(--cyan);
  outline-offset: -2px;
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

.fill-handle {
  position: absolute;
  right: 0;
  bottom: 0;
  width: 8px;
  height: 8px;
  border: 1px solid var(--bg);
  background: var(--cyan);
  cursor: crosshair;
  box-shadow: 0 0 8px var(--glow-soft);
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

.header-filter-menu {
  position: fixed;
  z-index: 1000;
  width: 220px;
  padding: 10px;
  border: 1px solid var(--line-2);
  border-radius: 8px;
  background: var(--panel-solid-2);
  box-shadow: var(--shadow), var(--glow-soft);
}

.filter-title {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
}

.filter-stats {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
  margin-bottom: 8px;
}

.filter-stat {
  min-width: 0;
  padding: 6px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--panel-solid);
}

.filter-stat span {
  display: block;
  margin-bottom: 2px;
  color: var(--muted);
  font-size: 10px;
}

.filter-stat strong {
  display: block;
  overflow: hidden;
  color: var(--cyan);
  font-family: 'JetBrains Mono', monospace;
  font-size: 12px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.filter-value-counts {
  max-height: 148px;
  margin-bottom: 8px;
  overflow: auto;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--panel-solid);
}

.filter-value-count {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 26px;
  padding: 4px 6px;
  border: 0;
  border-bottom: 1px solid var(--line);
  background: transparent;
  color: var(--text-2);
  font-size: 11px;
  text-align: left;
  cursor: pointer;
}

.filter-value-count:hover,
.filter-value-count.selected {
  color: var(--cyan);
  background: var(--hover-cyan-faint);
}

.filter-value-count:last-child {
  border-bottom: 0;
}

.filter-value-count span {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.filter-value-count.selected span {
  color: var(--cyan);
}

.filter-value-count strong {
  min-width: 24px;
  color: var(--cyan);
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  font-weight: 600;
  text-align: right;
}

.filter-pick-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
  color: var(--muted);
  font-size: 10px;
}

.filter-pick-actions .action-btn-sm {
  min-width: 42px;
  height: 22px;
  border-radius: 4px;
  border: 1px solid var(--line-2);
  background: transparent;
  color: var(--text-2);
  font-size: 10px;
  cursor: pointer;
}

.filter-pick-actions .action-btn-sm:hover {
  color: var(--cyan);
  border-color: var(--cyan);
  background: var(--hover-cyan-faint);
}

.filter-input {
  width: 100%;
  height: 30px;
  font-size: 12px;
}

.filter-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 10px;
}
</style>
