<script setup lang="ts">
import type { FUniver, Univer } from '@/lib/univer'
import type { CellEdit, WorkbookSheetData } from '@/stores/excel'
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
import { buildStarhubTheme, createUniver, mergeLocales } from '@/lib/univer'
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

function cssVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback
  const value = window.getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || fallback
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

const workbookVersion = computed(() => [
  store.connId,
  store.filePath,
  store.sheetNames.join('\u001a'),
].join('\u001c'))

const activeSheetSource = computed(() =>
  store.workbookSheets[store.activeSheet] ?? null
)

function normalizeCellValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object' && 'v' in (value as Record<string, unknown>)) {
    return normalizeCellValue((value as { v?: unknown }).v)
  }
  return String(value)
}

function buildCellData(sheet: WorkbookSheetData): NonNullable<IWorksheetData['cellData']> {
  const cellData: NonNullable<IWorksheetData['cellData']> = {}

  sheet.columns.forEach((header, col) => {
    if (!cellData[0]) cellData[0] = {}
    cellData[0][col] = {
      v: header,
      s: {
        bl: 1,
        bg: { rgb: cssVar('--excel-header-bg', '#f3f2f1') },
        cl: { rgb: cssVar('--excel-green', '#107c41') },
      },
    } as ICellData
  })

  sheet.rows.forEach((row, rowIndex) => {
    const sheetRow = rowIndex + 1
    row.forEach((value, col) => {
      if (value === '') return
      if (!cellData[sheetRow]) cellData[sheetRow] = {}
      cellData[sheetRow][col] = value.startsWith('=')
        ? { f: value } as ICellData
        : { v: value } as ICellData
    })
  })

  return cellData
}

// 渲染时只给数据下方预留少量自适应尾行,避免滚到底部后出现一整屏空白网格。
// store.rowData 仍保留文件原始的全部行,save 时回写文件不会丢数据。
const VISIBLE_BUFFER_ROWS = 5
const VISIBLE_MIN_ROWS = 24
const DEFAULT_ROW_HEIGHT = 22

function computeTailRows(dataRows: number): number {
  if (dataRows <= 0) return VISIBLE_BUFFER_ROWS
  return Math.max(3, Math.min(8, Math.ceil(dataRows * 0.05)))
}

function computeRowCount(sheet: WorkbookSheetData): number {
  // 不能按“最后一个非空单元格”裁剪渲染行数:Excel 文件里真实存在的空数据行
  // 也必须显示行号和网格线,否则会在表格中部露出一整块纯白区域。
  const dataRows = Math.max(sheet.rows.length, sheet.totalRows)
  const tailRows = computeTailRows(dataRows)
  return Math.max(dataRows + 1 + tailRows, VISIBLE_MIN_ROWS)
}

function measureViewportRowCount(): number {
  if (!containerRef.value) return viewportRowCount.value || VISIBLE_MIN_ROWS
  const shellHeight = containerRef.value.parentElement?.clientHeight ?? 0
  if (shellHeight <= 0) return viewportRowCount.value || VISIBLE_MIN_ROWS
  return Math.max(VISIBLE_MIN_ROWS, Math.ceil(shellHeight / DEFAULT_ROW_HEIGHT))
}

function refreshViewportRowCount(): boolean {
  const next = measureViewportRowCount()
  if (next === viewportRowCount.value) return false
  viewportRowCount.value = next
  return true
}

let canvasMountObserver: MutationObserver | null = null
let mountPointResizeObserver: ResizeObserver | null = null
let canvasMountFallbackTimer: number | null = null
const renderedSheetSources = new Map<string, WorkbookSheetData>()

// 把"等画布挂载 + 强制引擎重测尺寸"抽出成纯函数,被初始化/ResizeObserver 复用。
function syncUniverCanvasSize(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const injector = (univerAPIInstance as any)?._injector
    if (!injector || !univerInstance) return false

    const unitId = univerAPIInstance?.getActiveWorkbook?.()?.getId?.()
    if (!unitId) return false

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const renderMgr = injector.get?.(Symbol.for('IRenderManagerService'))
    const renderUnit = renderMgr?.getRenderById?.(unitId)
    const engine = renderUnit?.engine
    if (!engine) return false

    const el = containerRef.value
    if (!el) return false

    const canvas = el.querySelector('[data-u-comp="render-canvas"]') as HTMLCanvasElement | null
    const mountPoint = el.querySelector('[data-range-selector]') as HTMLElement | null
    // 画布或挂载点尚未就绪
    if (!canvas || !mountPoint) return false

    const mountW = mountPoint.clientWidth
    const mountH = mountPoint.clientHeight
    // 布局尚未稳定
    if (mountW <= 0 || mountH <= 0) return false

    const canvasW = parseFloat(canvas.style.width) || 0
    const canvasH = parseFloat(canvas.style.height) || 0
    const sizeMatches = Math.abs(canvasW - mountW) <= 1 && Math.abs(canvasH - mountH) <= 1

    if (!sizeMatches) {
      // 重置引擎尺寸缓存,强制 resize() 重新测量
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(engine as any)._previousWidth = -1
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(engine as any)._previousHeight = -1
      engine.resize()

      // resize() 后再次检查,仍不匹配则直接调用 resizeBySize()
      const newCanvasH = parseFloat(canvas.style.height) || 0
      if (Math.abs(newCanvasH - mountH) > 1) {
        engine.resizeBySize(mountW, mountH)
      }
      return false // 本轮触发了重测,等下一轮尺寸变化再确认
    }

    return true
  } catch {
    // 忽略内部 API 变化
    return false
  }
}

function attachMountPointResizeObserver(mountPoint: HTMLElement) {
  mountPointResizeObserver?.disconnect()
  mountPointResizeObserver = new ResizeObserver(() => {
    syncUniverCanvasSize()
  })
  mountPointResizeObserver.observe(mountPoint)
  // 首次挂载立刻校准一次,处理引擎 _previousWidth 缓存的旧尺寸
  syncUniverCanvasSize()
}

function stopCanvasSizeTracking() {
  canvasMountObserver?.disconnect()
  canvasMountObserver = null
  mountPointResizeObserver?.disconnect()
  mountPointResizeObserver = null
  if (canvasMountFallbackTimer !== null) {
    window.clearTimeout(canvasMountFallbackTimer)
    canvasMountFallbackTimer = null
  }
}

function requestUniverResize() {
  // Univer Engine 在生命周期 Ready 后延迟 300ms 才挂载画布。
  // 挂载时 engine.resize() 用 _previousWidth/_previousHeight 缓存比对尺寸,
  // 相同则跳过 resize,导致画布尺寸不正确,下方留白。
  //
  // 修复策略:
  // - 轻量 MutationObserver 只等 [data-range-selector] 元素出现(childList 即可)
  // - mountPoint 出现后立刻切换为 ResizeObserver 监听 mountPoint 尺寸变化
  // - 任一尺寸变化触发 syncUniverCanvasSize() 强制重测 canvas 对齐
  // 比持续监听 attributes:style 更省 CPU,也避免了 style 抖动引起的多余回调。
  stopCanvasSizeTracking()

  const el = containerRef.value
  if (!el) return

  const mountPoint = el.querySelector('[data-range-selector]') as HTMLElement | null

  // 快路径:mountPoint 已挂载,直接绑定 ResizeObserver
  if (mountPoint) {
    attachMountPointResizeObserver(mountPoint)
    return
  }

  // 元素还没出现 → MutationObserver 等到 mountPoint 出现就立刻切换为 ResizeObserver
  canvasMountObserver = new MutationObserver(() => {
    const mp = el.querySelector('[data-range-selector]') as HTMLElement | null
    if (!mp) return
    canvasMountObserver?.disconnect()
    canvasMountObserver = null
    attachMountPointResizeObserver(mp)
  })
  canvasMountObserver.observe(el, { childList: true, subtree: true })

  // 兜底:1.5s 内若仍没出现,强制 disconnect 避免观察器长期挂载
  canvasMountFallbackTimer = window.setTimeout(stopCanvasSizeTracking, 1500)
}

function queueLayoutRender() {
  if (layoutRenderTimer !== null) window.clearTimeout(layoutRenderTimer)
  layoutRenderTimer = window.setTimeout(() => {
    layoutRenderTimer = null
    if (!syncingFromStore) syncDataFromUniver()
    requestUniverResize()
  }, 80)
}

function buildWorkbookData(): IWorkbookData {
  const sheetNames = store.sheetNames.length > 0
    ? store.sheetNames
    : [store.activeSheet || 'Sheet1']
  const sheets: NonNullable<IWorkbookData['sheets']> = {}
  const sheetOrder: string[] = []

  sheetNames.forEach((sheetName, index) => {
    const sheetId = `starhub-sheet-${index}`
    const sheet = store.workbookSheets[sheetName] || {
      sheetName,
      columns: sheetName === store.activeSheet ? store.columns : [],
      rows: sheetName === store.activeSheet ? store.rowData : [],
      totalRows: sheetName === store.activeSheet ? store.totalRows : 0,
    }
    sheetOrder.push(sheetId)
    sheets[sheetId] = {
      id: sheetId,
      name: sheetName,
      rowCount: computeRowCount(sheet),
      columnCount: Math.max(sheet.columns.length, 10),
      defaultColumnWidth: 96,
      defaultRowHeight: 22,
      freeze: {
        startRow: sheetName === store.activeSheet ? store.frozenRows : 0,
        startColumn: sheetName === store.activeSheet ? store.frozenCols : 0,
        ySplit: sheetName === store.activeSheet ? store.frozenRows : 0,
        xSplit: sheetName === store.activeSheet ? store.frozenCols : 0,
      },
      cellData: buildCellData(sheet),
    }
  })

  return {
    id: `starhub-${store.connId || 'workbook'}`,
    name: store.filePath || store.activeSheet || 'StarHub Workbook',
    appVersion: '3.0.0-alpha',
    locale: LocaleType.ZH_CN,
    styles: {},
    sheetOrder,
    sheets,
  } as IWorkbookData
}

function disposeWorkbook() {
  stopCanvasSizeTracking()
  commandDisposable?.dispose()
  commandDisposable = null
  resizeObserver?.disconnect()
  resizeObserver = null
  univerAPIInstance?.dispose()
  univerInstance?.dispose()
  univerAPIInstance = null
  univerInstance = null
  renderedSheetSources.clear()
  // 清理容器内残留的 Univer DOM,防止下次创建时残留元素干扰布局
  if (containerRef.value) {
    containerRef.value.innerHTML = ''
  }
}

async function renderWorkbook() {
  await nextTick()
  if (!containerRef.value) return

  // 等待容器有非零高度再创建 Univer 实例。
  // 如果容器高度为 0(flex 布局尚未稳定),Univer 画布会以 0 高度挂载,
  // 后续即使容器变大,引擎的 resize 也可能因尺寸缓存而跳过。
  const shell = containerRef.value.parentElement
  if (shell && shell.clientHeight === 0) {
    await new Promise<void>((resolve) => {
      let resolved = false
      const finish = () => {
        if (resolved) return
        resolved = true
        observer?.disconnect()
        resolve()
      }
      const observer = new ResizeObserver((entries) => {
        if (entries[0]?.contentRect.height > 0) finish()
      })
      observer.observe(shell)
      setTimeout(finish, 500) // 超时兜底
    })
  }

  syncingFromStore = true
  refreshViewportRowCount()
  disposeWorkbook()

  const { univer, univerAPI } = createUniver({
    locale: LocaleType.ZH_CN,
    theme: buildStarhubTheme(),
    darkMode: false,
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
        // 关掉所有 hover 弹出的"数字以文本形式存储"类错误提示(用户不需要)
        disableTextFormatAlert: true,
        disableTextFormatMark: true,
        sheets: {
          disableForceStringAlert: true,
          disableForceStringMark: true,
        },
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
  const workbook = univerAPI.createWorkbook(buildWorkbookData())
  store.sheetNames.forEach(sheetName => {
    const source = store.workbookSheets[sheetName]
    if (source) renderedSheetSources.set(sheetName, source)
  })
  const activeSheet = workbook.getSheetByName(store.activeSheet)
  if (activeSheet) workbook.setActiveSheet(activeSheet)
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
    if (
      command.id.includes('set-range')
      || command.id === 'sheet.command.auto-fill'
      || command.id === 'sheet.command.copy-down'
      || command.id === 'sheet.command.copy-right'
    ) {
      queueSnapshotSync()
    }
  })

  window.setTimeout(() => {
    syncingFromStore = false
    syncSelectionFromUniver()
    requestUniverResize()
  }, 0)
}

function buildSheetValues(sheet: WorkbookSheetData): string[][] {
  const columnCount = Math.max(sheet.columns.length, 1)
  const values = [
    Array.from({ length: columnCount }, (_, col) => sheet.columns[col] ?? ''),
    ...sheet.rows.map(row =>
      Array.from({ length: columnCount }, (_, col) => row[col] ?? '')
    ),
  ]
  if (values.length === 1) values.push(Array.from({ length: columnCount }, () => ''))
  return values
}

/**
 * Sheet 切换快路径:保留同一个 Univer/Workbook/Canvas 实例,只激活目标
 * Worksheet。仅当后端重新读取导致缓存对象真正替换时,才原地写回数据。
 */
function syncActiveSheetInPlace() {
  if (!univerAPIInstance || !store.activeSheet) return
  const workbook = univerAPIInstance.getActiveWorkbook()
  const worksheet = workbook?.getSheetByName(store.activeSheet)
  if (!workbook || !worksheet) {
    void renderWorkbook()
    return
  }

  syncingFromStore = true
  workbook.setActiveSheet(worksheet)
  const source = activeSheetSource.value
  if (source && renderedSheetSources.get(store.activeSheet) !== source) {
    const rowCount = Math.max(computeRowCount(source), 2)
    const columnCount = Math.max(source.columns.length, 10)
    worksheet.setRowCount(rowCount)
    worksheet.setColumnCount(columnCount)
    worksheet
      .getRange(0, 0, Math.max(source.rows.length + 1, 2), Math.max(source.columns.length, 1))
      .setValues(buildSheetValues(source))
    renderedSheetSources.set(store.activeSheet, source)
  }

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
  const sheetId = workbook?.getActiveSheet()?.getSheetId()
  return sheetId ? snapshot.sheets?.[sheetId] ?? null : null
}

function normalizeSnapshotCell(cell: ICellData | null | undefined): string {
  if (typeof cell?.f === 'string' && cell.f) return cell.f
  return normalizeCellValue(cell?.v ?? '')
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
      normalizeSnapshotCell(cellData[sheetRow]?.[col])
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
  store.syncActiveSheetCache()
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
  stopCanvasSizeTracking()
  disposeWorkbook()
})

watch(workbookVersion, () => {
  if (updatingStoreFromUniver) return
  void renderWorkbook()
})

watch(
  [() => store.activeSheet, activeSheetSource],
  () => {
    if (updatingStoreFromUniver) return
    void nextTick(syncActiveSheetInPlace)
  },
  { flush: 'post' },
)
</script>

<template>
  <div class="univer-grid-shell">
    <!-- 避免使用 .univer-grid:它是 Univer 的全局 display:grid 工具类,会把挂载根拆成两行。 -->
    <div ref="containerRef" class="univer-host" />
  </div>
</template>

<style scoped>
.univer-grid-shell {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  background: var(--excel-grid-bg);
}

.univer-host {
  width: 100%;
  height: 100%;
  min-height: 0;
  background: var(--excel-grid-bg);
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
  height: 100% !important;
}

/* 内容区 section(有 univer-bg-white 但无 dark 覆盖,是留白的主要来源) */
:deep([data-u-comp="workbench-layout"] .univer-bg-white) {
  background-color: var(--excel-grid-bg) !important;
}

/* ------------------------------------------------------------
   Univer 0.25.1 Workbench 布局兜底
   v0.14.13 用了 grid 模板兜底,效果有限(canvas 还是按内容高度算,
   下方留白依旧)。这次改用 flexbox 强制撑开,绕过 grid 模板失效的
   问题:
   - workbench-layout(根)→ flex column,占满父容器
   - 里面 3 个区域(header / content / footer)→ header/footer auto,
     content flex:1
   - content 里的 .univer-grid → flex row,3 列
   - 3 列中间那个 section(包含列头 + data-range-selector)
     → flex column,header auto,data-range-selector flex:1
   - data-range-selector → 直接 flex:1 占满父级
   这样不依赖 Tailwind 任意值 grid 模板,直接走标准 flex 链路。
   ------------------------------------------------------------ */
:deep([data-u-comp="workbench-layout"]) {
  display: flex !important;
  flex-direction: column !important;
  height: 100% !important;
  min-height: 0 !important;
  position: relative !important;
}

/* workbench-layout 内的"content"section(直接子)需要 flex:1 */
:deep([data-u-comp="workbench-layout"] > section) {
  display: flex !important;
  flex: 1 1 0 !important;
  flex-direction: column !important;
  min-height: 0 !important;
}

/* content section 里的 .univer-grid:横向 flex 3 列 */
:deep([data-u-comp="workbench-layout"] > section > .univer-grid) {
  display: flex !important;
  flex: 1 1 0 !important;
  min-height: 0 !important;
}

/* 左右侧栏:固定 auto 宽度,占满高度 */
:deep([data-u-comp="left-sidebar"]),
:deep([data-u-comp="right-sidebar"]) {
  flex: 0 0 auto !important;
  height: 100% !important;
}

/* 中间列(flex 1):纵向 flex,列头 auto + data-range-selector 撑满 */
:deep([data-u-comp="workbench-layout"] > section > .univer-grid > section) {
  display: flex !important;
  flex: 1 1 0 !important;
  flex-direction: column !important;
  min-height: 0 !important;
  min-width: 0 !important;
}

/* 列头(header):高度 auto */
:deep([data-u-comp="workbench-layout"] > section > .univer-grid > section > header) {
  flex: 0 0 auto !important;
}

/* 数据区挂载点:撑满父级剩余高度 */
:deep([data-range-selector]) {
  flex: 1 1 0 !important;
  min-height: 0 !important;
  display: block !important;
  position: relative !important;
  background-color: var(--excel-grid-bg) !important;
  overflow: hidden !important;
}

/* 右侧栏 z-index 兜底 */
:deep([data-u-comp="right-sidebar"]) {
  z-index: 100 !important;
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
