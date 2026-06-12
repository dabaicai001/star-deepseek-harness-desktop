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

export interface ColumnInfo {
  name: string
  width: number
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

  const DEFAULT_COL_WIDTH = 120
  const ROW_HEIGHT = 28

  function setLoading(v: boolean) { loading.value = v }
  function setDirty(v: boolean) { dirty.value = v }

  function getCell(row: number, col: number): string {
    if (row >= 0 && row < rowData.value.length) {
      return rowData.value[row][col] ?? ''
    }
    return ''
  }

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
    if (row < rowData.value.length && col < (rowData.value[row]?.length || 0)) {
      rowData.value[row][col] = value
      dirty.value = true
    }
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
    DEFAULT_COL_WIDTH,
    ROW_HEIGHT,
    setLoading,
    setDirty,
    getCell,
    setCell,
    updateCellValue,
    addRow,
    deleteRow,
    addCol,
    deleteCol,
    getColWidth,
    setColWidth,
    colIndexToLetter,
    loadData,
    clear,
  }
})
