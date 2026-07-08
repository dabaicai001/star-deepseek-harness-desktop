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
import { defaultTheme } from '@univerjs/themes'
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

// StarHub 深色主题色,用于覆盖 Univer 默认主题中的背景色,
// 使工作区背景与 --excel-grid-bg 一致,消除"大面积留白"。
// 注意:不能覆盖 white,否则 univer-text-white 会变成深色导致文字不可见。
// univer-bg-white 的问题通过 CSS :deep 覆盖解决。
const starhubTheme = {
  ...defaultTheme,
  gray: {
    ...defaultTheme.gray,
    800: '#0d1420', // dark:!univer-bg-gray-800 用此值 -> --excel-grid-bg
    900: '#080d14', // --bg
  },
}

let univerInstance: Univer | null = null
let univerAPIInstance: FUniver | null = null
let commandDisposable: { dispose: () => void } | null = null
let resizeObserver: ResizeObserver | null = null
let syncingFromStore = false
let updatingStoreFromUniver = false
let syncTimer: number | null = null
let layoutRenderTimer: number | null = null
const viewportRowCount = ref(0)

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
        bg: { rgb: '#152032' },
        cl: { rgb: '#5dd6d6' },
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

// 渲染时给数据下方预留少量 buffer(用于直接键入新数据);最少保底几行避免空表格太小。
// store.rowData 仍保留文件原始的全部行,save 时回写文件不会丢数据。
const VISIBLE_BUFFER_ROWS = 5
const VISIBLE_MIN_ROWS = 40
const DEFAULT_ROW_HEIGHT = 22

function computeRowCount(): number {
  // 不能按“最后一个非空单元格”裁剪渲染行数:Excel 文件里真实存在的空数据行
  // 也必须显示行号和网格线,否则会在表格中部露出一整块纯白区域。
  const rowDataHeight = store.rowData.length + 1 + VISIBLE_BUFFER_ROWS
  return Math.max(
    rowDataHeight,
    viewportRowCount.value,
    VISIBLE_MIN_ROWS,
  )
}

function measureViewportRowCount(): number {
  if (!containerRef.value) return viewportRowCount.value || VISIBLE_MIN_ROWS
  const shellHeight = containerRef.value.parentElement?.clientHeight ?? 0
  if (shellHeight <= 0) return viewportRowCount.value || VISIBLE_MIN_ROWS
  return Math.max(VISIBLE_MIN_ROWS, Math.ceil(shellHeight / DEFAULT_ROW_HEIGHT) + VISIBLE_BUFFER_ROWS)
}

function refreshViewportRowCount(): boolean {
  const next = measureViewportRowCount()
  if (next === viewportRowCount.value) return false
  viewportRowCount.value = next
  return true
}

function requestUniverResize() {
  // Univer 的 Engine 不监听 window resize,而是用自己的 ResizeObserver 监听容器。
  // 通过短暂修改容器尺寸来触发 ResizeObserver,让引擎重新测量并 resize 画布。
  const el = containerRef.value
  if (!el) return
  const oldHeight = el.style.height
  el.style.height = '99.9%'
  window.requestAnimationFrame(() => {
    el.style.height = oldHeight || '100%'
  })
}

function queueLayoutRender() {
  if (layoutRenderTimer !== null) window.clearTimeout(layoutRenderTimer)
  layoutRenderTimer = window.setTimeout(() => {
    layoutRenderTimer = null
    if (!syncingFromStore) syncDataFromUniver()
    void renderWorkbook()
  }, 80)
}

function buildWorkbookData(): IWorkbookData {
  const sheetId = 'starhub-active-sheet'
  const columnCount = Math.max(store.columns.length, 10)
  const rowCount = computeRowCount()
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
  refreshViewportRowCount()
  disposeWorkbook()

  const { univer, univerAPI } = createUniver({
    locale: LocaleType.ZH_CN,
    theme: starhubTheme,
    darkMode: true,
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
    if (refreshViewportRowCount()) {
      queueLayoutRender()
    } else {
      requestUniverResize()
    }
  })
  // 监听父容器(shell)尺寸变化,而非 containerRef 本身(避免 height 由 JS 设置时循环触发)
  if (containerRef.value?.parentElement) {
    resizeObserver.observe(containerRef.value.parentElement)
  }
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
    requestUniverResize()
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

onMounted(() => {
  void renderWorkbook()
})
onBeforeUnmount(() => {
  if (syncTimer !== null) window.clearTimeout(syncTimer)
  if (layoutRenderTimer !== null) window.clearTimeout(layoutRenderTimer)
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
  min-height: 0;
}

/* ============================================================
   Univer DOM 深色覆盖 - cyber 主题
   Univer 0.25.1 使用 Tailwind 工具类 + data-u-comp 属性,
   不再有 .univer-workbench / .univer-sheet-canvas 等语义类名。
   画布渲染的元素(行/列头、单元格、选区、网格线)无法用 CSS 覆盖,
   它们的颜色通过 starhubTheme 主题对象注入。
   ============================================================ */

/* 工作区根元素:覆盖 univer-bg-white / dark:!univer-bg-gray-800 */
:deep([data-u-comp="workbench-layout"]) {
  background-color: var(--excel-grid-bg) !important;
}

/* 内容区 section(有 univer-bg-white 但无 dark 覆盖,是留白的主要来源) */
:deep([data-u-comp="workbench-layout"] .univer-bg-white) {
  background-color: var(--excel-grid-bg) !important;
}

/* 画布挂载点:网格线未覆盖的区域会显示此背景 */
:deep([data-range-selector]) {
  background-color: var(--excel-grid-bg) !important;
}

/* 画布元素本身(透明,但兜底设背景) */
:deep([data-u-comp="render-canvas"]) {
  background-color: var(--excel-grid-bg) !important;
}

/* 工具栏(headerbar) */
:deep([data-u-comp="headerbar"]) {
  background-color: var(--excel-ribbon-bg) !important;
  border-color: var(--excel-ribbon-line) !important;
}

/* 工具栏按钮 */
:deep([data-u-comp="headerbar"] button) {
  color: var(--excel-title-tab-fg) !important;
}

:deep([data-u-comp="headerbar"] button:hover) {
  background-color: var(--excel-sheet-hover) !important;
  color: var(--excel-green) !important;
}

/* 通用输入框(工具栏内) */
:deep([data-u-comp="workbench-layout"] input) {
  background-color: var(--excel-grid-bg) !important;
  color: var(--excel-text) !important;
  border-color: var(--excel-grid-line) !important;
}

:deep([data-u-comp="workbench-layout"] input:focus) {
  border-color: var(--excel-green) !important;
}

/* 滚动条 */
:deep([data-u-comp="workbench-layout"] ::-webkit-scrollbar-thumb) {
  background-color: var(--excel-ribbon-line) !important;
}

:deep([data-u-comp="workbench-layout"] ::-webkit-scrollbar-thumb:hover) {
  background-color: var(--excel-title-tab-fg) !important;
}
</style>
