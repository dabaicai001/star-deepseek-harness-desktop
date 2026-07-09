<script setup lang="ts">
import type { FUniver, Univer } from '@/lib/univer'
import type { ColumnInfo } from '@/types/db'
import type { ICellData, IWorkbookData, IWorksheetData } from '@univerjs/core'
import { CellValueType, LocaleType } from '@univerjs/core'
import { UniverSheetsCorePreset } from '@univerjs/preset-sheets-core'
import UniverPresetSheetsCoreZhCN from '@univerjs/preset-sheets-core/locales/zh-CN'
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { buildStarhubTheme, createUniver, mergeLocales } from '@/lib/univer'

import '@univerjs/preset-sheets-core/lib/index.css'

const props = withDefaults(defineProps<{
  columns: ColumnInfo[]
  rows: unknown[][]
  pageOffset?: number
  editable?: boolean
  dirtyCells?: string[]
}>(), {
  pageOffset: 0,
  editable: false,
  dirtyCells: () => [],
})

const emit = defineEmits<{
  'cell-change': [row: number, column: string, value: unknown]
  'sort-change': [column: string]
  'row-context': [row: number, x: number, y: number]
}>()

const containerRef = ref<HTMLElement | null>(null)
let univerInstance: Univer | null = null
let univerAPIInstance: FUniver | null = null
let resizeObserver: ResizeObserver | null = null
let commandDisposable: { dispose: () => void } | null = null
let eventDisposables: Array<{ dispose: () => void }> = []
let syncTimer: number | null = null
let syncing = false
let baselineRows: unknown[][] = []
let renderToken = 0

function cssVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback
  return window.getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
}

function serializeCell(value: unknown): string | number | boolean {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') return value
  return JSON.stringify(value)
}

function cellType(value: unknown): CellValueType {
  if (typeof value === 'number') return CellValueType.NUMBER
  if (typeof value === 'boolean') return CellValueType.BOOLEAN
  return CellValueType.FORCE_STRING
}

function buildCellData(): NonNullable<IWorksheetData['cellData']> {
  const cellData: NonNullable<IWorksheetData['cellData']> = { 0: {} }
  const dirty = new Set(props.dirtyCells)
  props.columns.forEach((column, columnIndex) => {
    cellData[0][columnIndex] = {
      v: `${column.name}  ·  ${column.type}`,
      t: CellValueType.FORCE_STRING,
      s: {
        bl: 1,
        cl: { rgb: cssVar('--excel-green', '#107c41') },
        bg: { rgb: cssVar('--excel-header-bg', '#f3f2f1') },
      },
    } as ICellData
  })
  props.rows.forEach((row, rowIndex) => {
    const sheetRow = rowIndex + 1
    row.forEach((value, columnIndex) => {
      if (!cellData[sheetRow]) cellData[sheetRow] = {}
      const isNull = value === null || value === undefined
      const isDirty = dirty.has(`${rowIndex}:${columnIndex}`)
      cellData[sheetRow][columnIndex] = {
        v: serializeCell(value),
        t: cellType(value),
        s: {
          cl: {
            rgb: isNull
              ? cssVar('--muted', '#607082')
              : cssVar('--excel-text', '#201f1e'),
          },
          bg: isDirty
            ? { rgb: cssVar('--excel-selection-fill', '#e9f5ed') }
            : undefined,
          it: isNull ? 1 : 0,
        },
      } as ICellData
    })
  })
  return cellData
}

function columnWidth(column: ColumnInfo, columnIndex: number): number {
  const samples = props.rows.slice(0, 40).map(row => serializeCell(row[columnIndex]))
  const longest = Math.max(
    `${column.name}  ·  ${column.type}`.length,
    ...samples.map(value => String(value).length),
  )
  return Math.max(88, Math.min(280, longest * 8 + 28))
}

function buildWorkbookData(): IWorkbookData {
  return {
    id: 'starhub-db-result',
    name: 'Database Result',
    appVersion: '3.0.0-alpha',
    locale: LocaleType.ZH_CN,
    styles: {},
    sheetOrder: ['result'],
    sheets: {
      result: {
        id: 'result',
        name: 'Result',
        rowCount: Math.max(props.rows.length + 1, 2),
        columnCount: Math.max(props.columns.length, 1),
        defaultColumnWidth: 120,
        defaultRowHeight: 24,
        freeze: {
          startRow: 1,
          startColumn: 0,
          ySplit: 1,
          xSplit: 0,
        },
        cellData: buildCellData(),
      },
    },
  } as IWorkbookData
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (typeof left === 'object' && left !== null) {
    return JSON.stringify(left) === JSON.stringify(right)
  }
  return Object.is(left, right)
}

function coerceValue(value: unknown, original: unknown, column: ColumnInfo): unknown {
  if (value === null || value === undefined) return ''
  if (typeof value !== 'string') return value
  if (value.trim().toUpperCase() === 'NULL') return null

  const type = column.type.toLowerCase()
  if (/int|decimal|numeric|float|double|real/.test(type) && value.trim() !== '') {
    const numberValue = Number(value)
    if (!Number.isNaN(numberValue)) return numberValue
  }
  if (/bool|tinyint\(1\)/.test(type)) {
    if (value === 'true' || value === '1') return true
    if (value === 'false' || value === '0') return false
  }
  if (typeof original === 'object' && original !== null) {
    try {
      return JSON.parse(value) as unknown
    } catch {
      return value
    }
  }
  return value
}

function syncChangesFromUniver() {
  if (syncing || !univerAPIInstance || props.rows.length === 0 || props.columns.length === 0) return
  const worksheet = univerAPIInstance.getActiveWorkbook()?.getActiveSheet()
  if (!worksheet) return

  const values = worksheet
    .getRange(1, 0, props.rows.length, props.columns.length)
    .getValues()

  values.forEach((row, rowIndex) => {
    row.forEach((rawValue, columnIndex) => {
      const original = baselineRows[rowIndex]?.[columnIndex]
      const value = coerceValue(rawValue, original, props.columns[columnIndex])
      if (!valuesEqual(value, original)) {
        baselineRows[rowIndex][columnIndex] = value
        emit('cell-change', rowIndex, props.columns[columnIndex].name, value)
      }
    })
  })
}

function queueChangeSync() {
  if (syncTimer !== null) window.clearTimeout(syncTimer)
  syncTimer = window.setTimeout(() => {
    syncTimer = null
    syncChangesFromUniver()
  }, 60)
}

function syncCanvasSize() {
  const host = containerRef.value
  if (!host || !univerAPIInstance) return
  const mountPoint = host.querySelector('[data-range-selector]') as HTMLElement | null
  const canvas = host.querySelector('[data-u-comp="render-canvas"]') as HTMLCanvasElement | null
  if (!mountPoint || !canvas || mountPoint.clientWidth <= 0 || mountPoint.clientHeight <= 0) return

  try {
    // Univer 0.25.1 会缓存首次尺寸;清缓存后让引擎按当前 flex 容器重测。
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const injector = (univerAPIInstance as any)._injector
    const unitId = univerAPIInstance.getActiveWorkbook()?.getId()
    const render = unitId ? injector?.get?.(Symbol.for('IRenderManagerService'))?.getRenderById?.(unitId) : null
    const engine = render?.engine
    if (!engine) return
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(engine as any)._previousWidth = -1
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(engine as any)._previousHeight = -1
    engine.resizeBySize(mountPoint.clientWidth, mountPoint.clientHeight)
  } catch {
    // 内部尺寸 API 变更时由 ResizeObserver 的默认布局兜底。
  }
}

function disposeGrid() {
  if (syncTimer !== null) window.clearTimeout(syncTimer)
  syncTimer = null
  commandDisposable?.dispose()
  commandDisposable = null
  eventDisposables.forEach(disposable => disposable.dispose())
  eventDisposables = []
  resizeObserver?.disconnect()
  resizeObserver = null
  containerRef.value?.removeEventListener('contextmenu', onContextMenu)
  univerAPIInstance?.dispose()
  univerInstance?.dispose()
  univerAPIInstance = null
  univerInstance = null
  if (containerRef.value) containerRef.value.innerHTML = ''
}

async function renderGrid() {
  const token = ++renderToken
  await nextTick()
  if (!containerRef.value || token !== renderToken) return
  syncing = true
  disposeGrid()
  baselineRows = props.rows.map(row => [...row])

  const { univer, univerAPI } = createUniver({
    locale: LocaleType.ZH_CN,
    theme: buildStarhubTheme(),
    darkMode: false,
    locales: {
      [LocaleType.ZH_CN]: mergeLocales(UniverPresetSheetsCoreZhCN),
    },
    presets: [
      UniverSheetsCorePreset({
        container: containerRef.value,
        header: false,
        toolbar: false,
        formulaBar: true,
        contextMenu: false,
        footer: false,
        statusBarStatistic: false,
      }),
    ],
  })

  univerInstance = univer
  univerAPIInstance = univerAPI
  const workbook = univerAPI.createWorkbook(buildWorkbookData())
  workbook.setEditable(props.editable)
  const worksheet = workbook.getActiveSheet()
  props.columns.forEach((column, index) => {
    worksheet.setColumnWidth(index, columnWidth(column, index))
  })

  eventDisposables.push(
    univerAPI.addEvent(univerAPI.Event.BeforeSheetEditStart, params => {
      if (!props.editable || params.row === 0 || params.row > props.rows.length) params.cancel = true
    }),
    univerAPI.addEvent(univerAPI.Event.BeforeClipboardPaste, params => {
      const range = params.worksheet.getSelection()?.getActiveRange()?.getRange()
      if (
        !props.editable
        || !range
        || range.startRow === 0
        || range.endRow > props.rows.length
      ) {
        params.cancel = true
      }
    }),
    univerAPI.addEvent(univerAPI.Event.ColumnHeaderClick, params => {
      const column = props.columns[params.column]
      if (column) emit('sort-change', column.name)
    }),
    univerAPI.addEvent(univerAPI.Event.CellClicked, params => {
      if (params.row !== 0) return
      const column = props.columns[params.column]
      if (column) emit('sort-change', column.name)
    }),
  )

  commandDisposable = univerAPI.onCommandExecuted(command => {
    if (syncing || !props.editable) return
    if (
      command.id.includes('set-range')
      || command.id.includes('clear-selection')
      || command.id === 'sheet.command.auto-fill'
      || command.id === 'sheet.command.copy-down'
      || command.id === 'sheet.command.copy-right'
    ) {
      queueChangeSync()
    }
  })

  containerRef.value.addEventListener('contextmenu', onContextMenu)
  resizeObserver = new ResizeObserver(() => syncCanvasSize())
  resizeObserver.observe(containerRef.value)
  window.setTimeout(() => {
    syncing = false
    syncCanvasSize()
  }, 0)
}

function onContextMenu(event: MouseEvent) {
  event.preventDefault()
  const range = univerAPIInstance
    ?.getActiveWorkbook()
    ?.getActiveSheet()
    ?.getSelection()
    ?.getActiveRange()
    ?.getRange()
  const sheetRow = range?.startRow ?? -1
  const row = sheetRow - 1
  if (row >= 0 && row < props.rows.length) emit('row-context', row, event.clientX, event.clientY)
}

onMounted(() => void renderGrid())
onBeforeUnmount(() => {
  containerRef.value?.removeEventListener('contextmenu', onContextMenu)
  disposeGrid()
})
watch(
  [
    () => props.columns,
    () => props.rows,
    () => props.pageOffset,
    () => props.editable,
    () => props.dirtyCells,
  ],
  () => void renderGrid(),
)
</script>

<template>
  <div class="db-univer-shell">
    <div ref="containerRef" class="univer-host db-univer-host" />
  </div>
</template>
