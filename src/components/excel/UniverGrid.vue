<script setup lang="ts">
import type { FUniver, Univer } from '@/lib/univer'
import type { CellEdit } from '@/stores/excel'
import type { ICellData, IWorkbookData, IWorksheetData } from '@univerjs/core'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { LocaleType } from '@univerjs/core'
import { UniverSheetsConditionalFormattingPreset } from '@univerjs/preset-sheets-conditional-formatting'
import UniverPresetSheetsConditionalFormattingZhCN from '@univerjs/preset-sheets-conditional-formatting/locales/zh-CN'
import { UniverSheetsCorePreset } from '@univerjs/preset-sheets-core'
import UniverPresetSheetsCoreZhCN from '@univerjs/preset-sheets-core/locales/zh-CN'
import { UniverSheetsDataValidationPreset } from '@univerjs/preset-sheets-data-validation'
import UniverPresetSheetsDataValidationZhCN from '@univerjs/preset-sheets-data-validation/locales/zh-CN'
import { UniverSheetsDrawingPreset } from '@univerjs/preset-sheets-drawing'
import UniverPresetSheetsDrawingZhCN from '@univerjs/preset-sheets-drawing/locales/zh-CN'
import { UniverSheetsFilterPreset } from '@univerjs/preset-sheets-filter'
import UniverPresetSheetsFilterZhCN from '@univerjs/preset-sheets-filter/locales/zh-CN'
import { UniverSheetsFindReplacePreset } from '@univerjs/preset-sheets-find-replace'
import UniverPresetSheetsFindReplaceZhCN from '@univerjs/preset-sheets-find-replace/locales/zh-CN'
import { UniverSheetsHyperLinkPreset } from '@univerjs/preset-sheets-hyper-link'
import UniverPresetSheetsHyperLinkZhCN from '@univerjs/preset-sheets-hyper-link/locales/zh-CN'
import { UniverSheetsNotePreset } from '@univerjs/preset-sheets-note'
import UniverPresetSheetsNoteZhCN from '@univerjs/preset-sheets-note/locales/zh-CN'
import { UniverSheetsSortPreset } from '@univerjs/preset-sheets-sort'
import UniverPresetSheetsSortZhCN from '@univerjs/preset-sheets-sort/locales/zh-CN'
import { UniverSheetsTablePreset } from '@univerjs/preset-sheets-table'
import UniverPresetSheetsTableZhCN from '@univerjs/preset-sheets-table/locales/zh-CN'
import { createUniver, mergeLocales } from '@/lib/univer'
import { useExcelStore } from '@/stores/excel'

import '@univerjs/preset-sheets-conditional-formatting/lib/index.css'
import '@univerjs/preset-sheets-core/lib/index.css'
import '@univerjs/preset-sheets-data-validation/lib/index.css'
import '@univerjs/preset-sheets-drawing/lib/index.css'
import '@univerjs/preset-sheets-filter/lib/index.css'
import '@univerjs/preset-sheets-find-replace/lib/index.css'
import '@univerjs/preset-sheets-hyper-link/lib/index.css'
import '@univerjs/preset-sheets-note/lib/index.css'
import '@univerjs/preset-sheets-sort/lib/index.css'
import '@univerjs/preset-sheets-table/lib/index.css'

const store = useExcelStore()
const containerRef = ref<HTMLElement | null>(null)

const emit = defineEmits<{
  'cell-change': [edits: CellEdit[]]
}>()

let univerInstance: Univer | null = null
let univerAPIInstance: FUniver | null = null
let commandDisposable: { dispose: () => void } | null = null
let resizeObserver: ResizeObserver | null = null
let syncingFromStore = false
let updatingStoreFromUniver = false
let syncTimer: number | null = null

const sheetVersion = computed(() => [
  store.connId,
  store.activeSheet,
  store.columns.join('\u001f'),
  store.rowData.length,
  store.rowData.map(row => row.join('\u001e')).join('\u001d'),
].join('\u001c'))

function normalizeCellValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object' && 'v' in (value as Record<string, unknown>)) {
    return normalizeCellValue((value as { v?: unknown }).v)
  }
  return String(value)
}

function buildCellData(): NonNullable<IWorksheetData['cellData']> {
  const cellData: NonNullable<IWorksheetData['cellData']> = {}

  store.columns.forEach((header, col) => {
    if (!cellData[0]) cellData[0] = {}
    cellData[0][col] = {
      v: header,
      s: {
        bl: 1,
        bg: { rgb: '#1f6f43' },
        cl: { rgb: '#ffffff' },
      },
    } as ICellData
  })

  store.rowData.forEach((row, rowIndex) => {
    const sheetRow = rowIndex + 1
    row.forEach((value, col) => {
      if (value === '') return
      if (!cellData[sheetRow]) cellData[sheetRow] = {}
      cellData[sheetRow][col] = { v: value } as ICellData
    })
  })

  return cellData
}

// 渲染时给数据下方预留 20 行 buffer(用于直接键入新数据);小于 30 时保底 30 行。
// store.rowData 仍保留文件原始的全部行,save 时回写文件不会丢数据。
const VISIBLE_BUFFER_ROWS = 20
const VISIBLE_MIN_ROWS = 30

function lastNonEmptyDataIndex(): number {
  const data = store.rowData
  for (let i = data.length - 1; i >= 0; i--) {
    const row = data[i]
    if (row && row.some(cell => String(cell ?? '').trim() !== '')) return i
  }
  return -1
}

function buildWorkbookData(): IWorkbookData {
  const sheetId = 'starhub-active-sheet'
  const columnCount = Math.max(store.columns.length, 10)
  const lastDataIndex = lastNonEmptyDataIndex()
  // cellData 还要写 1 行表头,所以可见高度 = (lastDataIndex + 1) + 1 + buffer
  const lastDataRowNumber = lastDataIndex + 2 // 1-indexed,且包含表头行
  // 容器实际高度可容纳的行数(每行 22px),加 5 行 buffer 让底部不出现纯空白
  const containerHeight = containerRef.value?.clientHeight ?? 0
  const containerRows = containerHeight > 0 ? Math.ceil(containerHeight / 22) + 5 : 0
  const rowCount = Math.max(lastDataRowNumber + VISIBLE_BUFFER_ROWS, VISIBLE_MIN_ROWS, containerRows)
  return {
    id: `starhub-${store.connId || 'workbook'}`,
    name: store.filePath || store.activeSheet || 'StarHub Workbook',
    appVersion: '3.0.0-alpha',
    locale: LocaleType.ZH_CN,
    styles: {},
    sheetOrder: [sheetId],
    sheets: {
      [sheetId]: {
        id: sheetId,
        name: store.activeSheet || 'Sheet1',
        rowCount,
        columnCount,
        defaultColumnWidth: 96,
        defaultRowHeight: 22,
        freeze: {
          startRow: store.frozenRows,
          startColumn: store.frozenCols,
          ySplit: store.frozenRows,
          xSplit: store.frozenCols,
        },
        cellData: buildCellData(),
      },
    },
  } as IWorkbookData
}

function disposeWorkbook() {
  commandDisposable?.dispose()
  commandDisposable = null
  resizeObserver?.disconnect()
  resizeObserver = null
  univerAPIInstance?.dispose()
  univerInstance?.dispose()
  univerAPIInstance = null
  univerInstance = null
}

async function renderWorkbook() {
  await nextTick()
  if (!containerRef.value) return

  syncingFromStore = true
  disposeWorkbook()

  const { univer, univerAPI } = createUniver({
    locale: LocaleType.ZH_CN,
    locales: {
      [LocaleType.ZH_CN]: mergeLocales(
        UniverPresetSheetsCoreZhCN,
        UniverPresetSheetsDrawingZhCN,
        UniverPresetSheetsFilterZhCN,
        UniverPresetSheetsSortZhCN,
        UniverPresetSheetsDataValidationZhCN,
        UniverPresetSheetsConditionalFormattingZhCN,
        UniverPresetSheetsHyperLinkZhCN,
        UniverPresetSheetsFindReplaceZhCN,
        UniverPresetSheetsNoteZhCN,
        UniverPresetSheetsTableZhCN,
      ),
    },
    presets: [
      UniverSheetsCorePreset({
        container: containerRef.value,
        toolbar: true,
        header: true,
        contextMenu: true,
        footer: false,
        statusBarStatistic: false,
      }),
      UniverSheetsDrawingPreset(),
      UniverSheetsFilterPreset(),
      UniverSheetsSortPreset(),
      UniverSheetsDataValidationPreset(),
      UniverSheetsConditionalFormattingPreset(),
      UniverSheetsHyperLinkPreset(),
      UniverSheetsFindReplacePreset(),
      UniverSheetsNotePreset(),
      UniverSheetsTablePreset(),
    ],
  })

  univerInstance = univer
  univerAPIInstance = univerAPI
  univerAPI.createWorkbook(buildWorkbookData())
  resizeObserver = new ResizeObserver(() => {
    window.dispatchEvent(new Event('resize'))
  })
  resizeObserver.observe(containerRef.value)
  commandDisposable = univerAPI.onCommandExecuted((command) => {
    if (syncingFromStore) return
    window.setTimeout(syncSelectionFromUniver, 0)
    if (command.id.includes('selection')) {
      syncSelectionFromUniver()
      return
    }
    if (command.id === 'sheet.command.set-range-values' || command.id.includes('set-range')) {
      queueSnapshotSync()
    }
  })

  window.setTimeout(() => {
    syncingFromStore = false
    syncSelectionFromUniver()
  }, 0)
}

function queueSnapshotSync() {
  if (syncTimer !== null) window.clearTimeout(syncTimer)
  syncTimer = window.setTimeout(() => {
    syncTimer = null
    syncDataFromUniver()
    syncSelectionFromUniver()
  }, 80)
}

function activeSheetSnapshot(): Partial<IWorksheetData> | null {
  const workbook = univerAPIInstance?.getActiveWorkbook()
  const snapshot = workbook?.save() as IWorkbookData | undefined
  if (!snapshot) return null
  const sheetId = snapshot.sheetOrder?.[0]
  return sheetId ? snapshot.sheets?.[sheetId] ?? null : null
}

function extractGridFromSnapshot(sheet: Partial<IWorksheetData>) {
  const cellData = sheet.cellData || {}
  const columnCount = Math.max(store.columns.length, sheet.columnCount || 0)
  const rowCount = Math.max(0, (sheet.rowCount || 1) - 1)
  const columns = Array.from({ length: columnCount }, (_, col) =>
    normalizeCellValue(cellData[0]?.[col]?.v ?? store.columns[col] ?? '')
  )
  const rows = Array.from({ length: rowCount }, (_, rowIndex) => {
    const sheetRow = rowIndex + 1
    return Array.from({ length: columnCount }, (_, col) =>
      normalizeCellValue(cellData[sheetRow]?.[col]?.v ?? '')
    )
  })

  while (columns.length > 0 && !columns[columns.length - 1] && rows.every(row => !row[columns.length - 1])) {
    columns.pop()
    rows.forEach(row => row.pop())
  }

  return { columns, rows }
}

function syncDataFromUniver() {
  if (!univerAPIInstance || syncingFromStore) return
  const sheet = activeSheetSnapshot()
  if (!sheet) return
  const { columns, rows } = extractGridFromSnapshot(sheet)
  const edits: CellEdit[] = []
  updatingStoreFromUniver = true

  rows.forEach((row, rowIndex) => {
    row.forEach((value, col) => {
      if ((store.rowData[rowIndex]?.[col] ?? '') !== value) {
        edits.push({ row: rowIndex, col, value })
      }
    })
  })

  if (edits.length > 0) {
    store.applyRawCellEdits(edits)
    emit('cell-change', edits)
  }
  if (columns.some((value, col) => value !== (store.columns[col] ?? ''))) {
    store.columns = columns
    store.setDirty(true)
  }
  window.setTimeout(() => {
    updatingStoreFromUniver = false
  }, 0)
}

function syncSelectionFromUniver() {
  const workbook = univerAPIInstance?.getActiveWorkbook()
  const worksheet = workbook?.getActiveSheet()
  const range = worksheet?.getSelection()?.getActiveRange()?.getRange()
  if (!range) return

  const startRow = Math.max(0, range.startRow - 1)
  const endRow = Math.max(0, range.endRow - 1)
  const startCol = Math.max(0, range.startColumn)
  const endCol = Math.max(0, range.endColumn)

  if (range.startRow === 0 && range.endRow === 0) {
    store.selectCol(startCol)
    if (endCol > startCol) store.extendSelection(0, endCol)
    store.selectionMode = 'col'
    store.selectedRange = {
      startRow: 0,
      endRow: Math.max(store.filteredRowData.length - 1, 0),
      startCol,
      endCol,
    }
    return
  }

  store.selectCell(startRow, startCol)
  if (startRow !== endRow || startCol !== endCol) {
    store.extendSelection(endRow, endCol)
  }
}

onMounted(renderWorkbook)
onBeforeUnmount(() => {
  if (syncTimer !== null) window.clearTimeout(syncTimer)
  disposeWorkbook()
})

watch(sheetVersion, () => {
  if (updatingStoreFromUniver) return
  void renderWorkbook()
})
</script>

<template>
  <div class="univer-grid-shell">
    <div ref="containerRef" class="univer-grid" />
  </div>
</template>

<style scoped>
.univer-grid-shell {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  background: var(--excel-grid-bg);
}

.univer-grid {
  width: 100%;
  height: 100%;
}
</style>
