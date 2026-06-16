import { ref, computed, watch } from 'vue'
import { defineStore } from 'pinia'

export interface CellPosition {
  row: number
  col: number
}

export interface CellEdit {
  row: number
  col: number
  value: string
}

export interface DisplayCellEdit {
  row: number
  col: number
  value: string
}

export interface ColumnInfo {
  name: string
  width: number
}

export type SelectionMode = 'cell' | 'row' | 'col' | null

interface CellHistoryEntry {
  before: CellEdit[]
  after: CellEdit[]
}

export const useExcelStore = defineStore('excel', () => {
  const loading = ref(false)
  const connId = ref<string | null>(null)
  const filePath = ref('')
  const sheetNames = ref<string[]>([])
  const activeSheet = ref('')
  const columns = ref<string[]>([])
  const rowData = ref<string[][]>([])
  const totalRows = ref(0)
  const columnWidths = ref<Record<number, number>>({})
  const frozenRows = ref(0)
  const frozenCols = ref(0)
  const dirty = ref(false)

  // 筛选
  const filterText = ref('')
  const filterCol = ref<number | null>(null) // null = 全列

  // 选区
  const selectedCell = ref<{ row: number; col: number } | null>(null)
  const selectionMode = ref<SelectionMode>(null)
  const selectedRange = ref<{ startRow: number; endRow: number; startCol: number; endCol: number } | null>(null)
  const undoStack = ref<CellHistoryEntry[]>([])
  const redoStack = ref<CellHistoryEntry[]>([])

  const DEFAULT_COL_WIDTH = 120
  const ROW_HEIGHT = 28

  // 筛选后的行索引映射
  const filteredRowIndices = computed<number[]>(() => {
    const text = filterText.value.toLowerCase().trim()
    if (!text) return rowData.value.map((_, i) => i)
    const col = filterCol.value
    return rowData.value.reduce<number[]>((acc, row, i) => {
      if (col !== null) {
        if ((row[col] ?? '').toLowerCase().includes(text)) acc.push(i)
      } else {
        if (row.some(cell => (cell ?? '').toLowerCase().includes(text))) acc.push(i)
      }
      return acc
    }, [])
  })

  const filteredRowData = computed(() => {
    if (!filterText.value.trim()) return rowData.value
    return filteredRowIndices.value.map(i => rowData.value[i])
  })

  function setLoading(v: boolean) { loading.value = v }
  function setDirty(v: boolean) { dirty.value = v }

  function getCell(row: number, col: number): string {
    const data = filteredRowData.value
    if (row >= 0 && row < data.length) {
      return data[row][col] ?? ''
    }
    return ''
  }

  function getRawCell(rawRow: number, col: number): string {
    if (rawRow >= 0 && rawRow < rowData.value.length) {
      return rowData.value[rawRow][col] ?? ''
    }
    return ''
  }

  // 筛选后的行数
  const displayRowCount = computed(() => filteredRowData.value.length)
  const canUndo = computed(() => undoStack.value.length > 0)
  const canRedo = computed(() => redoStack.value.length > 0)
  const selectedCellValue = computed(() => {
    const sel = selectedCell.value
    return sel ? getCell(sel.row, sel.col) : ''
  })
  const activeCellLabel = computed(() => {
    const sel = selectedCell.value
    if (!sel) return ''
    return `${colIndexToLetter(sel.col)}${displayRowToExcelRow(sel.row)}`
  })
  const selectedStats = computed(() => {
    const range = normalizedSelectionRange()
    if (!range) {
      return { count: 0, numericCount: 0, sum: 0, average: 0, min: 0, max: 0 }
    }

    let count = 0
    let numericCount = 0
    let sum = 0
    let min = Number.POSITIVE_INFINITY
    let max = Number.NEGATIVE_INFINITY
    for (let r = range.startRow; r <= range.endRow; r++) {
      for (let c = range.startCol; c <= range.endCol; c++) {
        count++
        const value = getCell(r, c).trim()
        if (!value) continue
        const num = Number(value)
        if (Number.isFinite(num)) {
          numericCount++
          sum += num
          min = Math.min(min, num)
          max = Math.max(max, num)
        }
      }
    }

    return {
      count,
      numericCount,
      sum,
      average: numericCount ? sum / numericCount : 0,
      min: numericCount ? min : 0,
      max: numericCount ? max : 0,
    }
  })

  function setCell(row: number, col: number, value: string) {
    while (rowData.value.length <= row) {
      rowData.value.push(new Array(columns.value.length || 10).fill(''))
    }
    while (rowData.value[row].length <= col) {
      rowData.value[row].push('')
    }
    rowData.value[row][col] = value
    dirty.value = true
  }

  function updateCellValue(row: number, col: number, value: string) {
    commitDisplayCellEdits([{ row, col, value }])
  }

  function commitDisplayCellEdits(changes: DisplayCellEdit[]): CellEdit[] {
    const before: CellEdit[] = []
    const after: CellEdit[] = []

    for (const change of changes) {
      const rawRow = displayRowToRawRow(change.row)
      if (rawRow < 0 || change.col < 0) continue
      ensureCell(rawRow, change.col)
      const oldValue = rowData.value[rawRow][change.col] ?? ''
      if (oldValue === change.value) continue
      before.push({ row: rawRow, col: change.col, value: oldValue })
      after.push({ row: rawRow, col: change.col, value: change.value })
      rowData.value[rawRow][change.col] = change.value
    }

    if (after.length > 0) {
      pushHistory({ before, after })
      dirty.value = true
    }
    return after
  }

  function applyRawCellEdits(edits: CellEdit[]) {
    for (const edit of edits) {
      ensureCell(edit.row, edit.col)
      rowData.value[edit.row][edit.col] = edit.value
    }
    if (edits.length > 0) dirty.value = true
  }

  function undo(): CellEdit[] {
    const entry = undoStack.value.pop()
    if (!entry) return []
    applyRawCellEdits(entry.before)
    redoStack.value.push(entry)
    return entry.before
  }

  function redo(): CellEdit[] {
    const entry = redoStack.value.pop()
    if (!entry) return []
    applyRawCellEdits(entry.after)
    undoStack.value.push(entry)
    return entry.after
  }

  function pushHistory(entry: CellHistoryEntry) {
    undoStack.value.push(entry)
    if (undoStack.value.length > 100) undoStack.value.shift()
    redoStack.value = []
  }

  function ensureCell(row: number, col: number) {
    while (rowData.value.length <= row) {
      rowData.value.push(new Array(Math.max(columns.value.length, col + 1, 10)).fill(''))
    }
    while (columns.value.length <= col) {
      columns.value.push('')
    }
    while (rowData.value[row].length <= col) {
      rowData.value[row].push('')
    }
  }

  function displayRowToRawRow(row: number): number {
    return filterText.value.trim() ? (filteredRowIndices.value[row] ?? row) : row
  }

  function displayRowToExcelRow(row: number): number {
    return displayRowToRawRow(row) + 2
  }

  function addRow(afterRow: number) {
    const newRow: string[] = new Array(columns.value.length || 10).fill('')
    if (afterRow >= rowData.value.length - 1) {
      rowData.value.push(newRow)
    } else {
      rowData.value.splice(afterRow + 1, 0, newRow)
    }
    totalRows.value++
    dirty.value = true
  }

  function deleteRow(row: number) {
    if (row < rowData.value.length) {
      rowData.value.splice(row, 1)
      totalRows.value--
      dirty.value = true
    }
  }

  function addCol(afterCol: number) {
    const colIdx = afterCol + 1
    for (const row of rowData.value) {
      while (row.length <= colIdx) {
        row.push('')
      }
      row.splice(colIdx, 0, '')
    }
    if (columns.value.length <= colIdx) {
      columns.value.push(String.fromCharCode(64 + colIdx + 1))
    } else {
      columns.value.splice(colIdx, 0, String.fromCharCode(64 + colIdx + 1))
    }
    dirty.value = true
  }

  function deleteCol(col: number) {
    for (const row of rowData.value) {
      if (col < row.length) {
        row.splice(col, 1)
      }
    }
    if (col < columns.value.length) {
      columns.value.splice(col, 1)
    }
    dirty.value = true
  }

  function getColWidth(col: number): number {
    return columnWidths.value[col] ?? DEFAULT_COL_WIDTH
  }

  function setColWidth(col: number, width: number) {
    columnWidths.value[col] = Math.max(40, width)
  }

  function colIndexToLetter(col: number): string {
    let letter = ''
    let n = col
    while (n >= 0) {
      letter = String.fromCharCode(65 + (n % 26)) + letter
      n = Math.floor(n / 26) - 1
    }
    return letter
  }

  function loadData(data: {
    sheetName?: string
    columns: string[]
    rows: string[][]
    totalRows: number
    sheetNames?: string[]
    connId?: string
    filePath?: string
  }) {
    if (data.connId !== undefined) connId.value = data.connId
    if (data.filePath !== undefined) filePath.value = data.filePath
    if (data.sheetNames) sheetNames.value = data.sheetNames
    if (data.sheetName) activeSheet.value = data.sheetName
    columns.value = data.columns
    rowData.value = data.rows
    totalRows.value = data.totalRows
    dirty.value = false
    undoStack.value = []
    redoStack.value = []
  }

  function clear() {
    connId.value = null
    filePath.value = ''
    sheetNames.value = []
    activeSheet.value = ''
    columns.value = []
    rowData.value = []
    totalRows.value = 0
    columnWidths.value = {}
    frozenRows.value = 0
    frozenCols.value = 0
    dirty.value = false
    loading.value = false
    filterText.value = ''
    filterCol.value = null
    selectedCell.value = null
    selectionMode.value = null
    selectedRange.value = null
    undoStack.value = []
    redoStack.value = []
  }

  function setFilter(text: string, col: number | null = null) {
    filterText.value = text
    filterCol.value = col
  }

  function clearFilter() {
    filterText.value = ''
    filterCol.value = null
  }

  function selectCell(row: number, col: number) {
    selectedCell.value = { row, col }
    selectionMode.value = 'cell'
    selectedRange.value = { startRow: row, endRow: row, startCol: col, endCol: col }
  }

  function selectRow(row: number) {
    selectedCell.value = { row, col: 0 }
    selectionMode.value = 'row'
    selectedRange.value = { startRow: row, endRow: row, startCol: 0, endCol: columns.value.length - 1 }
  }

  function selectCol(col: number) {
    selectedCell.value = { row: 0, col }
    selectionMode.value = 'col'
    selectedRange.value = { startRow: 0, endRow: filteredRowData.value.length - 1, startCol: col, endCol: col }
  }

  function clearSelection() {
    selectedCell.value = null
    selectionMode.value = null
    selectedRange.value = null
  }

  function extendSelection(row: number, col: number) {
    const anchor = selectedCell.value ?? { row, col }
    selectedCell.value = anchor
    selectionMode.value = 'cell'
    selectedRange.value = {
      startRow: Math.min(anchor.row, row),
      endRow: Math.max(anchor.row, row),
      startCol: Math.min(anchor.col, col),
      endCol: Math.max(anchor.col, col),
    }
  }

  function normalizedSelectionRange() {
    const range = selectedRange.value
    if (!range) return null
    return {
      startRow: Math.min(range.startRow, range.endRow),
      endRow: Math.max(range.startRow, range.endRow),
      startCol: Math.min(range.startCol, range.endCol),
      endCol: Math.max(range.startCol, range.endCol),
    }
  }

  function selectionToTsv(): string {
    const range = normalizedSelectionRange()
    if (!range) return ''
    const rows: string[] = []
    for (let r = range.startRow; r <= range.endRow; r++) {
      const cells: string[] = []
      for (let c = range.startCol; c <= range.endCol; c++) {
        cells.push(getCell(r, c))
      }
      rows.push(cells.join('\t'))
    }
    return rows.join('\n')
  }

  function pasteTsv(text: string): CellEdit[] {
    const sel = selectedCell.value
    if (!sel || !text) return []
    const rows = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
    if (rows[rows.length - 1] === '') rows.pop()
    const changes: DisplayCellEdit[] = []
    rows.forEach((line, rowOffset) => {
      line.split('\t').forEach((value, colOffset) => {
        changes.push({ row: sel.row + rowOffset, col: sel.col + colOffset, value })
      })
    })
    return commitDisplayCellEdits(changes)
  }

  return {
    loading,
    connId,
    filePath,
    sheetNames,
    activeSheet,
    columns,
    rowData,
    totalRows,
    columnWidths,
    frozenRows,
    frozenCols,
    dirty,
    filterText,
    filterCol,
    filteredRowIndices,
    filteredRowData,
    displayRowCount,
    selectedCell,
    selectionMode,
    selectedRange,
    undoStack,
    redoStack,
    canUndo,
    canRedo,
    selectedCellValue,
    activeCellLabel,
    selectedStats,
    DEFAULT_COL_WIDTH,
    ROW_HEIGHT,
    setLoading,
    setDirty,
    getCell,
    getRawCell,
    setCell,
    updateCellValue,
    commitDisplayCellEdits,
    applyRawCellEdits,
    undo,
    redo,
    displayRowToRawRow,
    displayRowToExcelRow,
    addRow,
    deleteRow,
    addCol,
    deleteCol,
    getColWidth,
    setColWidth,
    colIndexToLetter,
    loadData,
    clear,
    setFilter,
    clearFilter,
    selectCell,
    selectRow,
    selectCol,
    clearSelection,
    extendSelection,
    normalizedSelectionRange,
    selectionToTsv,
    pasteTsv,
  }
})
