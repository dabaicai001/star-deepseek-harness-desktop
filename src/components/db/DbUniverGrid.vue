<script setup lang="ts">
import type { FUniver, Univer } from '@/lib/univer'
import type { ColumnInfo, ColumnMeta } from '@/types/db'
import type { ICellData, IWorkbookData, IWorksheetData } from '@univerjs/core'
import { BooleanNumber, BorderStyleTypes, CellValueType, HorizontalAlign, LocaleType, VerticalAlign } from '@univerjs/core'
import { UniverSheetsCorePreset } from '@univerjs/preset-sheets-core'
import UniverPresetSheetsCoreZhCN from '@univerjs/preset-sheets-core/locales/zh-CN'
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { buildStarhubTheme, createUniver, mergeLocales } from '@/lib/univer'
import { dataRowIndicesFromSheetRange } from '@/utils/dbRowSelection'

import '@univerjs/preset-sheets-core/lib/index.css'

const props = withDefaults(defineProps<{
  columns: ColumnInfo[]
  rows: unknown[][]
  pageOffset?: number
  editable?: boolean
  sortColumn?: string | null
  sortDirection?: 'ASC' | 'DESC'
  themeKey?: string
  columnMetadata?: ColumnMeta[]
}>(), {
  pageOffset: 0,
  editable: false,
  sortColumn: null,
  sortDirection: 'ASC',
  themeKey: '',
  columnMetadata: () => [],
})

const emit = defineEmits<{
  'cell-change': [row: number, column: string, value: unknown]
  'sort-change': [column: string]
  'column-selected': [column: string]
  'row-context': [rows: number[], x: number, y: number]
}>()

const containerRef = ref<HTMLElement | null>(null)
const headerTooltip = ref({ visible: false, x: 0, y: 0, column: -1 })
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

function gridlineColor(): string {
  return cssVar('--gridline', 'rgba(93, 214, 214, 0.5)')
}

function gridCellBorder() {
  const line = { s: BorderStyleTypes.THIN, cl: { rgb: gridlineColor() } }
  return {
    t: line,
    r: line,
    b: line,
    l: line,
  }
}

function serializeCell(value: unknown): string | number | boolean {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') return value
  return JSON.stringify(value)
}

function cellType(value: unknown): CellValueType {
  if (typeof value === 'number') return CellValueType.NUMBER
  if (typeof value === 'boolean') return CellValueType.BOOLEAN
  // 数据库的 VARCHAR/DECIMAL 文本不应标记为 Excel 的“强制字符串”,
  // 否则 Univer 会为数字形文本绘制绿色警告角并弹出 numfmt 告警。
  return CellValueType.STRING
}

function headerLabel(column: ColumnInfo): string {
  // 表头只展示字段名。字段类型、可空、键、默认值等元信息
  // 都已聚合在 hover tooltip (headerTooltipText) 里,不再拼进表头。
  // 当前排序方向通过单元格背景色 + 文字色 (buildHeaderCell) 表达。
  return column.name
}

function columnMeta(columnIndex: number): ColumnMeta | undefined {
  const name = props.columns[columnIndex]?.name
  return name ? props.columnMetadata.find(column => column.name === name) : undefined
}

function headerTooltipText(columnIndex: number): string {
  const column = props.columns[columnIndex]
  if (!column) return ''
  const meta = columnMeta(columnIndex)
  const details = [
    `${column.name} · ${meta?.type || column.type}`,
    meta?.comment?.trim() || '暂无字段备注',
  ]
  if (meta) {
    details.push(
      `可空: ${meta.nullable === 'YES' ? '是' : '否'}`
      + `${meta.key ? ` · 键: ${meta.key}` : ''}`
      + `${meta.defaultValue !== null ? ` · 默认值: ${String(meta.defaultValue)}` : ''}`,
    )
  }
  return details.join('\n')
}

function buildHeaderCell(column: ColumnInfo): ICellData {
  const isSorted = props.sortColumn === column.name
  const directionMark = isSorted
    ? props.sortDirection === 'DESC' ? '  ↓' : '  ↑'
    : ''
  return {
    v: `${headerLabel(column)}${directionMark}`,
    t: CellValueType.STRING,
    s: {
      // bl:0 取消加粗 — 等宽字符 + 颜色对比已经够清晰,
      // 加粗反而跟 data cell 字重失衡,观感更碎。
      bl: 0,
      cl: {
        rgb: cssVar(isSorted ? '--cyan' : '--text-2', isSorted ? '#5dd6d6' : '#9aa8ba'),
      },
      bg: {
        rgb: cssVar(
          isSorted ? '--active-cyan' : '--panel-solid-2',
          isSorted ? 'rgba(93, 214, 214, 0.11)' : '#152032',
        ),
      },
      bd: gridCellBorder(),
      // 表头字号比数据小一档,跟数据形成清晰层级。
      fs: 11,
      // 等宽字体,字段名 / 数字 / 排序箭头视觉统一。
      ff: "'JetBrains Mono', 'Fira Code', monospace",
      // 水平居中,避免字段名 + ↑/↓ 拼起来看着偏左。
      ht: HorizontalAlign.CENTER,
      vt: VerticalAlign.MIDDLE,
      // 上下多 2px 内边距,留出呼吸空间。
      pd: { t: 4, b: 4, l: 8, r: 8 },
    },
  } as ICellData
}

function buildValueCell(value: unknown, dirty = false): ICellData {
  const isNull = value === null || value === undefined
  const isNumber = typeof value === 'number'
  return {
    v: serializeCell(value),
    t: cellType(value),
    s: {
      cl: {
        rgb: cssVar(isNull ? '--muted' : (isNumber ? '--cyan' : '--text'), isNull ? '#607082' : (isNumber ? '#5dd6d6' : '#dce7f3')),
      },
      bg: {
        rgb: cssVar(dirty ? '--active-cyan' : '--panel-solid', dirty ? 'rgba(93, 214, 214, 0.11)' : '#101822'),
      },
      bd: gridCellBorder(),
      it: isNull ? 1 : 0,
      // 数字右对齐,文本左对齐 — 数据库网格的标准做法,方便纵向看数字位数。
      ht: isNumber ? HorizontalAlign.RIGHT : HorizontalAlign.LEFT,
      vt: VerticalAlign.MIDDLE,
      // 跟表头一致的横向内边距,让数据 cell 跟表头 cell 在网格线两侧对称。
      pd: { t: 2, b: 2, l: 8, r: 8 },
    },
  } as ICellData
}

function buildCellData(): NonNullable<IWorksheetData['cellData']> {
  const cellData: NonNullable<IWorksheetData['cellData']> = { 0: {} }
  props.columns.forEach((column, columnIndex) => {
    cellData[0][columnIndex] = buildHeaderCell(column)
  })
  props.rows.forEach((row, rowIndex) => {
    const sheetRow = rowIndex + 1
    row.forEach((value, columnIndex) => {
      if (!cellData[sheetRow]) cellData[sheetRow] = {}
      cellData[sheetRow][columnIndex] = buildValueCell(value)
    })
  })
  return cellData
}

function columnWidth(column: ColumnInfo, columnIndex: number): number {
  const samples = props.rows.slice(0, 40).map(row => serializeCell(row[columnIndex]))
  const longest = Math.max(
    // 只按字段名 + 数据样本算宽度,不再包含已被 tooltip 取代的类型/排序字符。
    column.name.length,
    ...samples.map(value => String(value).length),
  )
  // 下限 88 容纳 "field_name  ↑" + 留白;上限 240 防止长文本列炸开。
  return Math.max(96, Math.min(240, longest * 8 + 32))
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
        showGridlines: BooleanNumber.TRUE,
        gridlinesColor: gridlineColor(),
        defaultStyle: {
          bg: {
            rgb: cssVar('--panel-solid', '#101822'),
          },
          bd: gridCellBorder(),
        },
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

function buildGridMatrix(): ICellData[][] {
  const header = props.columns.map(column => buildHeaderCell(column))
  const rows = props.rows.map(row =>
    props.columns.map((_, columnIndex) => buildValueCell(row[columnIndex]))
  )
  if (rows.length === 0) {
    rows.push(props.columns.map(() => buildValueCell('')))
  }
  return [header, ...rows]
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
    const trimmed = value.trim()
    const numberValue = Number(trimmed)
    if (!Number.isNaN(numberValue) && String(numberValue) === trimmed) return numberValue
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

  // 编辑态下用户改单元格,我们回写脏标记颜色。
  runProgrammaticUpdate(() => {
    values.forEach((row, rowIndex) => {
      row.forEach((rawValue, columnIndex) => {
        const original = baselineRows[rowIndex]?.[columnIndex]
        const value = coerceValue(rawValue, original, props.columns[columnIndex])
        if (!valuesEqual(value, original)) {
          baselineRows[rowIndex][columnIndex] = value
          const isDirty = !valuesEqual(value, props.rows[rowIndex]?.[columnIndex])
          worksheet
            .getRange(rowIndex + 1, columnIndex, 1, 1)
            .setBackground(cssVar(isDirty ? '--active-cyan' : '--panel-solid', isDirty ? 'rgba(93, 214, 214, 0.11)' : '#101822'))
            .setFontColor(cssVar(value === null ? '--muted' : '--text', value === null ? '#607082' : '#dce7f3'))
            .setFontStyle(value === null ? 'italic' : 'normal')
          emit('cell-change', rowIndex, props.columns[columnIndex].name, value)
        }
      })
    })
  })
}

function syncRowsInPlace() {
  const worksheet = univerAPIInstance?.getActiveWorkbook()?.getActiveSheet()
  if (!worksheet || props.columns.length === 0) return

  syncing = true
  runProgrammaticUpdate(() => {
    const rowCount = Math.max(props.rows.length + 1, 2)
    const columnCount = Math.max(props.columns.length, 1)
    worksheet.setRowCount(rowCount)
    worksheet.setColumnCount(columnCount)
    worksheet
      .getRange(0, 0, rowCount, columnCount)
      .setValues(buildGridMatrix())
    baselineRows = props.rows.map(row => [...row])
  })
  window.setTimeout(() => {
    syncing = false
  }, 0)
}

function syncHeaderInPlace() {
  const worksheet = univerAPIInstance?.getActiveWorkbook()?.getActiveSheet()
  if (!worksheet || props.columns.length === 0) return
  syncing = true
  runProgrammaticUpdate(() => {
    worksheet
      .getRange(0, 0, 1, props.columns.length)
      .setValues([props.columns.map(column => buildHeaderCell(column))])
  })
  window.setTimeout(() => {
    syncing = false
  }, 0)
}

/**
 * 标记 setValues / setRangeValues 等由 StarHub 发起的程序化写入。
 *
 * `workbook.setEditable(false)` 会注册 WorkbookEdit permission point,
 * 之后的程序化刷新也会被 SheetPermissionCheckUIController 拦截并弹出权限
 * 对话框。数据库结果工作簿因此始终保持 Univer 内部 editable,只在 UI 事件和
 * 命令入口拦截用户修改；程序化刷新用 syncing 标记放行。
 */
function runProgrammaticUpdate(fn: () => void) {
  const wasSyncing = syncing
  syncing = true
  try {
    fn()
  } finally {
    syncing = wasSyncing
  }
}

const READ_ONLY_MUTATION_COMMANDS = new Set([
  'sheet.command.auto-clear-content',
  'sheet.command.auto-fill',
  'sheet.command.clear-selection-all',
  'sheet.command.clear-selection-content',
  'sheet.command.clear-selection-format',
  'sheet.command.copy-down',
  'sheet.command.copy-right',
  'sheet.command.delete-range-move-left',
  'sheet.command.delete-range-move-up',
  'sheet.command.insert-col-by-range',
  'sheet.command.insert-range-move-down',
  'sheet.command.insert-range-move-right',
  'sheet.command.insert-row-by-range',
  'sheet.command.move-range',
  'sheet.command.paste-by-short-key',
  'sheet.command.refill',
  'sheet.command.remove-col-by-range',
  'sheet.command.remove-row-by-range',
  'sheet.command.set-range-values',
])

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
  containerRef.value?.removeEventListener('pointermove', onPointerMove)
  containerRef.value?.removeEventListener('pointerleave', hideHeaderTooltip)
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
    theme: buildStarhubTheme('system'),
    darkMode: document.documentElement.classList.contains('v-theme--darkTheme'),
    locales: {
      [LocaleType.ZH_CN]: mergeLocales(
        UniverPresetSheetsCoreZhCN,
        {
          // Univer 0.25.1 的数字文本提示错误地读取 sheets-ui.info,
          // 上游 zh-CN 仅放在 sheets-numfmt-ui.info,这里补兼容映射。
          'sheets-ui': {
            info: {
              error: '错误',
              forceStringInfo: '此数字以文本形式存储',
            },
          },
        },
      ),
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
        sheets: {
          // 数据库结果里 VARCHAR/TEXT 列经常装 '1111' / '2025-01-01' 这种
          // 长得像数字的字符串 — Univer 默认会把它们识别成 FORCE_STRING 候选,
          // 画绿色警告角 + hover 弹"此数字以文本形式存储"。
          // 数据库语义下这就是普通字符串,不需要 Excel 式的强类型警告。
          disableForceStringAlert: true,
          disableForceStringMark: true,
        },
      }),
    ],
  })

  univerInstance = univer
  univerAPIInstance = univerAPI
  const workbook = univerAPI.createWorkbook(buildWorkbookData())
  const worksheet = workbook.getActiveSheet()
  runProgrammaticUpdate(() => {
    props.columns.forEach((column, index) => {
      worksheet.setColumnWidth(index, columnWidth(column, index))
    })
    // 数据库结果区需要看到行/列分割线 — Univer 默认会把它们关掉以模拟
    // "无格线 Excel" 视图。这里强制开,颜色用 StarHub 专门的 --gridline token,
    // 比 --line-2 明显一档并带主青色调,既能在深色背景上识别单元格边界,
    // 又跟面板分隔线形成层次。
    worksheet.setHiddenGridlines(false)
    worksheet.setGridLinesColor(gridlineColor())
  })
  // 不调用 workbook.setEditable(false):它会安装全局权限点并误伤刷新。
  // 只读由下面的 BeforeSheetEditStart / BeforeCommandExecute 精确实现。
  workbook.setEditable(true)

  eventDisposables.push(
    univerAPI.addEvent(univerAPI.Event.BeforeCommandExecute, command => {
      if (!props.editable && !syncing && READ_ONLY_MUTATION_COMMANDS.has(command.id)) {
        command.cancel = true
      }
    }),
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
      if (column) emit('column-selected', column.name)
    }),
    univerAPI.addEvent(univerAPI.Event.CellClicked, params => {
      if (params.row !== 0) return
      const column = props.columns[params.column]
      if (column) emit('sort-change', column.name)
    }),
    univerAPI.addEvent(univerAPI.Event.CellHover, params => {
      headerTooltip.value.visible = params.row === 0 && Boolean(props.columns[params.column])
      headerTooltip.value.column = params.column
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
  containerRef.value.addEventListener('pointermove', onPointerMove)
  containerRef.value.addEventListener('pointerleave', hideHeaderTooltip)
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
  const rows = dataRowIndicesFromSheetRange(range, props.rows.length)
  if (rows.length > 0) emit('row-context', rows, event.clientX, event.clientY)
}

function onPointerMove(event: PointerEvent) {
  if (!headerTooltip.value.visible) return
  headerTooltip.value.x = Math.max(8, Math.min(window.innerWidth - 328, event.clientX + 14))
  headerTooltip.value.y = Math.max(8, Math.min(window.innerHeight - 112, event.clientY + 14))
}

function hideHeaderTooltip() {
  headerTooltip.value.visible = false
}

onMounted(() => void renderGrid())
onBeforeUnmount(() => {
  containerRef.value?.removeEventListener('contextmenu', onContextMenu)
  disposeGrid()
})
watch(
  () => props.columns.map(column => `${column.name}:${column.type}:${column.nullable}`).join('|'),
  () => void renderGrid(),
)
watch(
  () => props.rows,
  () => syncRowsInPlace(),
)
watch(
  [() => props.sortColumn, () => props.sortDirection],
  () => syncHeaderInPlace(),
)
watch(
  () => props.themeKey,
  () => void renderGrid(),
)

/**
 * Force-commit any active cell edit and sync changes from Univer.
 *
 * When the user presses Ctrl+S while a cell editor is still open,
 * the typed value lives only in the editor overlay — Univer's model
 * still holds the old value.  Blurring the active element triggers
 * the editor's commit path; we then wait for the commit to land and
 * read the model synchronously (bypassing the 60 ms debounce).
 */
async function flushPendingEdit(): Promise<void> {
  const active = document.activeElement as HTMLElement | null
  if (active && containerRef.value?.contains(active)) {
    active.blur()
    // Allow the blur → commit → onCommandExecuted chain to finish.
    await new Promise<void>(r => setTimeout(r, 80))
  }
  // Cancel any pending debounced sync and read values now.
  if (syncTimer !== null) {
    window.clearTimeout(syncTimer)
    syncTimer = null
  }
  syncChangesFromUniver()
}

defineExpose({ flushPendingEdit })
</script>

<template>
  <div class="db-univer-shell">
    <div ref="containerRef" class="univer-host db-univer-host" />
    <Transition name="db-column-tip">
      <div
        v-if="headerTooltip.visible"
        class="db-column-tooltip"
        :style="{ left: `${headerTooltip.x}px`, top: `${headerTooltip.y}px` }"
      >
        {{ headerTooltipText(headerTooltip.column) }}
      </div>
    </Transition>
  </div>
</template>
