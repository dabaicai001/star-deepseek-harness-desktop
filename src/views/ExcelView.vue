<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useAssetStore } from '@/stores/asset'
import { useAppStore } from '@/stores/app'
import { useExcelStore, type CellEdit } from '@/stores/excel'
import { useNotifyStore } from '@/stores/notify'
import ExcelGrid from '@/components/excel/ExcelGrid.vue'
import ExcelToolbar from '@/components/excel/ExcelToolbar.vue'
import ExcelSheetBar from '@/components/excel/ExcelSheetBar.vue'
import RightPanel from '@/components/layout/RightPanel.vue'
import AiChat from '@/components/ai/AiChat.vue'
import { useAiStore } from '@/stores/ai'
import { EXCEL_SYSTEM_PROMPT, excelTools } from '@/utils/aiTools'
import { usePersistentPanelState } from '@/utils/panelState'
import type { LlmToolCall } from '@/services/ai'
import { getCurrentWebview } from '@tauri-apps/api/webview'

const route = useRoute()
const assetStore = useAssetStore()
const appStore = useAppStore()
const store = useExcelStore()
const notify = useNotifyStore()
const aiStore = useAiStore()
const rightPanelOpen = usePersistentPanelState('excel', true)

const instanceId = computed(() => route.params.id as string)
const asset = computed(() => {
  const tab = appStore.tabs.find(t => t.id === instanceId.value)
  if (!tab?.assetId) return null
  return assetStore.assets.find(a => a.id === tab.assetId)
})
const fileFormat = computed<'xlsx' | 'csv'>(() => {
  const configured = asset.value?.config.format
  if (configured === 'csv') return 'csv'
  const filePath = asset.value?.config.filePath || ''
  return filePath.toLowerCase().endsWith('.csv') ? 'csv' : 'xlsx'
})
const isCsvFile = computed(() => fileFormat.value === 'csv')
const rpcPrefix = computed(() => isCsvFile.value ? 'file.csv' : 'file.excel')
const fileKindLabel = computed(() => isCsvFile.value ? 'CSV' : 'Excel')
const aiSession = computed(() => {
  if (!asset.value) return null
  return aiStore.getOrCreateSession(instanceId.value, asset.value.id, 'excel')
})

const loading = ref(false)
const error = ref<string | null>(null)
const showFilter = ref(false)
const filterInput = ref('')
const formulaInput = ref('')
const rightActiveTab = ref('ai')
const rightPanelTabs = [{ key: 'ai', label: 'AI助手', icon: 'mdi-robot-outline' }]
const showDropOverlay = ref(false)
let unlistenDragDrop: (() => void) | null = null

type SheetPayload = { sheetName: string; columns: string[]; rows: string[][]; totalRows: number }

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function droppedFileFormat(path: string): 'xlsx' | 'csv' | null {
  const lower = path.toLowerCase()
  if (lower.endsWith('.csv')) return 'csv'
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) return 'xlsx'
  return null
}

function fileBaseName(path: string): string {
  const name = path.split(/[\\/]/).pop() || path
  return name.replace(/\.(xlsx?|csv)$/i, '') || name
}

async function openDroppedFile(path: string) {
  const format = droppedFileFormat(path)
  if (!format || !asset.value) {
    notify.notify({ message: '仅支持拖入 .xlsx / .xls / .csv 文件', color: 'warning', timeout: 2500 })
    return
  }
  await assetStore.updateAsset(asset.value.id, {
    name: fileBaseName(path),
    config: { ...asset.value.config, filePath: path, format },
    lastUsedAt: Date.now(),
  })
  notify.notify({ message: `已导入 ${format.toUpperCase()} 文件`, color: 'success', timeout: 1800 })
}

async function sidecarRpc<T>(method: string, params: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>('sidecar_rpc', { method, params })
}

async function openExcel() {
  if (!asset.value?.config.filePath) return

  loading.value = true
  error.value = null

  try {
    const result = await sidecarRpc<{
      connId: string
      filePath: string
      sheetNames: string[]
      initialData?: { sheetName: string; columns: string[]; rows: string[][]; totalRows: number }
    }>(`${rpcPrefix.value}.open`, { filePath: asset.value.config.filePath, format: fileFormat.value })

    store.loadData({
      connId: result.connId,
      filePath: result.filePath,
      sheetNames: result.sheetNames,
      sheetName: result.initialData?.sheetName,
      columns: result.initialData?.columns || [],
      rows: result.initialData?.rows || [],
      totalRows: result.initialData?.totalRows || 0,
    })

    if (asset.value) {
      assetStore.updateAsset(asset.value.id, { lastUsedAt: Date.now() })
    }
  } catch (e) {
    error.value = errMsg(e)
    console.error(`${fileKindLabel.value} open failed:`, e)
  } finally {
    loading.value = false
  }
}

async function saveFile() {
  if (!store.connId) return
  store.setLoading(true)
  try {
    await sidecarRpc(`${rpcPrefix.value}.save`, { connId: store.connId })
    store.setDirty(false)
    notify.notify({ message: `${fileKindLabel.value} 文件已保存`, color: 'success', timeout: 1800 })
  } catch (e) {
    notify.notify({ message: `保存失败: ${errMsg(e)}`, color: 'error', timeout: 5000 })
  } finally {
    store.setLoading(false)
  }
}

async function switchSheet(sheetName: string, options: { preserveDirty?: boolean } = {}) {
  if (!store.connId) return
  store.setLoading(true)
  try {
    const result = await sidecarRpc<SheetPayload>(`${rpcPrefix.value}.readSheet`, { connId: store.connId, sheetName })
    store.loadData({
      ...result,
      sheetNames: store.sheetNames,
      connId: store.connId,
      filePath: store.filePath,
      preserveDirty: options.preserveDirty,
    })
  } catch (e) {
    notify.notify({ message: `读取 Sheet 失败: ${errMsg(e)}`, color: 'error', timeout: 5000 })
  } finally {
    store.setLoading(false)
  }
}

async function reloadActiveSheet() {
  if (store.activeSheet) {
    await switchSheet(store.activeSheet)
  }
}

async function onCellChange(edits: CellEdit[]) {
  if (!store.connId || edits.length === 0 || !store.activeSheet) return
  try {
    await sidecarRpc(`${rpcPrefix.value}.writeCells`, { connId: store.connId, sheetName: store.activeSheet, cells: edits })
  } catch (e) {
    notify.notify({ message: `写入失败: ${errMsg(e)}`, color: 'error', timeout: 5000 })
  }
}

async function addSheet(sheetName?: string) {
  if (!store.connId) return
  if (isCsvFile.value) {
    notify.notify({ message: 'CSV 是单表文件,不能新增 Sheet', color: 'warning', timeout: 2500 })
    return
  }
  const name = makeUniqueSheetName(sheetName || `Sheet${store.sheetNames.length + 1}`)
  try {
    await sidecarRpc(`${rpcPrefix.value}.addSheet`, { connId: store.connId, sheetName: name })
    store.sheetNames.push(name)
    await switchSheet(name)
    store.setDirty(true)
    notify.notify({ message: `已添加 Sheet: ${name}`, color: 'success', timeout: 1800 })
  } catch (e) {
    notify.notify({ message: `添加 Sheet 失败: ${errMsg(e)}`, color: 'error', timeout: 5000 })
  }
}

async function removeSheet(sheetName: string) {
  if (isCsvFile.value) {
    notify.notify({ message: 'CSV 是单表文件,不能删除 Sheet', color: 'warning', timeout: 2500 })
    return
  }
  if (!store.connId || store.sheetNames.length <= 1) {
    notify.notify({ message: '至少保留一个 Sheet', color: 'warning', timeout: 2500 })
    return
  }
  try {
    await sidecarRpc(`${rpcPrefix.value}.removeSheet`, { connId: store.connId, sheetName })
    store.sheetNames = store.sheetNames.filter(name => name !== sheetName)
    await switchSheet(store.sheetNames[0])
    store.setDirty(true)
    notify.notify({ message: `已删除 Sheet: ${sheetName}`, color: 'success', timeout: 1800 })
  } catch (e) {
    notify.notify({ message: `删除 Sheet 失败: ${errMsg(e)}`, color: 'error', timeout: 5000 })
  }
}

async function renameSheet(oldName: string, newName: string) {
  if (isCsvFile.value) {
    notify.notify({ message: 'CSV 的 Sheet 名称固定为 CSV', color: 'warning', timeout: 2500 })
    return
  }
  if (!store.connId || !newName || oldName === newName) return
  const safeName = makeUniqueSheetName(newName, oldName)
  try {
    await sidecarRpc(`${rpcPrefix.value}.renameSheet`, { connId: store.connId, oldName, newName: safeName })
    store.sheetNames = store.sheetNames.map(name => name === oldName ? safeName : name)
    store.activeSheet = safeName
    store.setDirty(true)
    notify.notify({ message: `Sheet 已重命名为 ${safeName}`, color: 'success', timeout: 1800 })
  } catch (e) {
    notify.notify({ message: `重命名失败: ${errMsg(e)}`, color: 'error', timeout: 5000 })
  }
}

function makeUniqueSheetName(input: string, currentName = ''): string {
  const base = (input.trim() || 'Sheet').slice(0, 31)
  const existing = new Set(store.sheetNames.filter(name => name !== currentName))
  if (!existing.has(base)) return base
  let i = 2
  while (existing.has(`${base.slice(0, 28)}_${i}`)) i++
  return `${base.slice(0, 28)}_${i}`
}

async function removeDuplicates() {
  if (!store.connId || !store.activeSheet) return
  try {
    const result = await sidecarRpc<{ removed: number; ok: boolean }>(`${rpcPrefix.value}.removeDuplicates`, {
      connId: store.connId,
      sheetName: store.activeSheet,
      columns: [],
    })
    await switchSheet(store.activeSheet)
    store.setDirty(true)
    notify.notify({ message: `已删除 ${result.removed} 个重复行`, color: 'success', timeout: 2500 })
  } catch (e) {
    notify.notify({ message: `删除重复项失败: ${errMsg(e)}`, color: 'error', timeout: 5000 })
  }
}

function selectedDedupColumns(override?: number[]): number[] {
  const cols = new Set<number>()
  const addCol = (col: number) => {
    if (Number.isInteger(col) && col >= 0 && col < store.columns.length) cols.add(col)
  }

  if (override?.length) {
    override.forEach(addCol)
  } else if (store.selectionMode === 'col' && store.selectedRange) {
    for (let col = store.selectedRange.startCol; col <= store.selectedRange.endCol; col++) addCol(col)
  } else if (store.selectedCells.length > 0) {
    for (const key of store.selectedCells) {
      const [, colText] = key.split(':')
      addCol(Number(colText))
    }
  } else if (store.selectedRange) {
    for (let col = store.selectedRange.startCol; col <= store.selectedRange.endCol; col++) addCol(col)
  } else if (store.selectedCell) {
    addCol(store.selectedCell.col)
  }

  return Array.from(cols).sort((a, b) => a - b)
}

function normalizeRow(row: string[], width = store.columns.length): string[] {
  return Array.from({ length: width }, (_, col) => String(row[col] ?? ''))
}

function dedupRowsByColumns(rows: string[][], columns: number[]) {
  const seen = new Set<string>()
  const result: string[][] = []
  let removed = 0

  for (const row of rows) {
    const normalized = normalizeRow(row)
    const key = columns.map(col => normalized[col] ?? '').join('\u001f')
    if (seen.has(key)) {
      removed++
      continue
    }
    seen.add(key)
    result.push(normalized)
  }

  return { rows: result, removed }
}

async function removeDuplicatesToSheet(columnsOverride?: number[]) {
  if (isCsvFile.value) {
    notify.notify({ message: 'CSV 是单表文件,无法输出到新 Sheet', color: 'warning', timeout: 2500 })
    return
  }
  if (!store.connId || !store.activeSheet) return

  const columns = selectedDedupColumns(columnsOverride)
  if (columns.length === 0) {
    notify.notify({ message: '请先选择要用于去重的列', color: 'warning', timeout: 2500 })
    return
  }

  const sourceSheet = store.activeSheet
  const headers = [...store.columns]
  const sourceRows = store.rowData.map(row => normalizeRow(row, headers.length))
  const { rows, removed } = dedupRowsByColumns(sourceRows, columns)
  const sheetName = makeUniqueSheetName(`${sourceSheet}_去重`)
  const columnLabels = columns.map(col => headers[col]?.trim() || store.colIndexToLetter(col)).join(', ')

  try {
    await sidecarRpc(`${rpcPrefix.value}.addSheet`, { connId: store.connId, sheetName })
    store.sheetNames.push(sheetName)
    await sidecarRpc(`${rpcPrefix.value}.writeHeaders`, { connId: store.connId, sheetName, headers })
    const cells = rows.flatMap((row, rowIndex) =>
      row.map((value, col) => ({ row: rowIndex, col, value }))
    )
    if (cells.length > 0) {
      await sidecarRpc(`${rpcPrefix.value}.writeCells`, { connId: store.connId, sheetName, cells })
    }
    store.setDirty(true)
    await switchSheet(sheetName, { preserveDirty: true })
    store.setDirty(true)
    notify.notify({
      message: `已按 ${columnLabels} 去重,移除 ${removed} 行,结果写入 ${sheetName}`,
      color: 'success',
      timeout: 3200,
    })
  } catch (e) {
    notify.notify({ message: `去重到新 Sheet 失败: ${errMsg(e)}`, color: 'error', timeout: 5000 })
  }
}

async function handleAddRow(row = store.selectedCell?.row ?? 0) {
  if (!store.connId || !store.activeSheet) return
  try {
    await sidecarRpc(`${rpcPrefix.value}.insertRows`, {
      connId: store.connId,
      sheetName: store.activeSheet,
      row: store.displayRowToRawRow(row),
      count: 1,
    })
    await reloadActiveSheet()
    store.setDirty(true)
  } catch (e) {
    notify.notify({ message: `插入行失败: ${errMsg(e)}`, color: 'error', timeout: 5000 })
  }
}

async function handleDeleteRow(row = store.selectedCell?.row ?? 0) {
  if (!store.connId || !store.activeSheet) return
  try {
    await sidecarRpc(`${rpcPrefix.value}.deleteRows`, {
      connId: store.connId,
      sheetName: store.activeSheet,
      row: store.displayRowToRawRow(row),
      count: 1,
    })
    await reloadActiveSheet()
    store.setDirty(true)
  } catch (e) {
    notify.notify({ message: `删除行失败: ${errMsg(e)}`, color: 'error', timeout: 5000 })
  }
}

async function handleAddCol(col = store.selectedCell?.col ?? 0) {
  if (!store.connId || !store.activeSheet) return
  try {
    await sidecarRpc(`${rpcPrefix.value}.insertCols`, { connId: store.connId, sheetName: store.activeSheet, col, count: 1 })
    await reloadActiveSheet()
    store.setDirty(true)
  } catch (e) {
    notify.notify({ message: `插入列失败: ${errMsg(e)}`, color: 'error', timeout: 5000 })
  }
}

async function handleDeleteCol(col = store.selectedCell?.col ?? 0) {
  if (!store.connId || !store.activeSheet) return
  try {
    await sidecarRpc(`${rpcPrefix.value}.deleteCols`, { connId: store.connId, sheetName: store.activeSheet, col, count: 1 })
    await reloadActiveSheet()
    store.setDirty(true)
  } catch (e) {
    notify.notify({ message: `删除列失败: ${errMsg(e)}`, color: 'error', timeout: 5000 })
  }
}

async function sortRows(descending: boolean, col = store.selectedCell?.col ?? 0) {
  if (!store.connId || !store.activeSheet) return
  try {
    await sidecarRpc(`${rpcPrefix.value}.sortRows`, { connId: store.connId, sheetName: store.activeSheet, col, descending })
    await reloadActiveSheet()
    store.setDirty(true)
  } catch (e) {
    notify.notify({ message: `排序失败: ${errMsg(e)}`, color: 'error', timeout: 5000 })
  }
}

async function autoFilter() {
  if (!store.connId || !store.activeSheet) return
  if (isCsvFile.value) {
    showFilter.value = true
    notify.notify({ message: 'CSV 不保存自动筛选,已打开本地筛选栏', color: 'info', timeout: 2600 })
    return
  }
  try {
    await sidecarRpc(`${rpcPrefix.value}.autoFilter`, { connId: store.connId, sheetName: store.activeSheet })
    store.setDirty(true)
    notify.notify({ message: '已为当前区域写入自动筛选', color: 'success', timeout: 2200 })
  } catch (e) {
    notify.notify({ message: `自动筛选失败: ${errMsg(e)}`, color: 'error', timeout: 5000 })
  }
}

async function setFreeze(rows: number, cols: number) {
  if (!store.connId || !store.activeSheet) return
  if (isCsvFile.value) {
    store.frozenRows = rows
    store.frozenCols = cols
    notify.notify({ message: rows || cols ? 'CSV 冻结仅在当前视图生效' : '已取消当前视图冻结', color: 'info', timeout: 2200 })
    return
  }
  try {
    await sidecarRpc(`${rpcPrefix.value}.freezePanes`, { connId: store.connId, sheetName: store.activeSheet, rows, cols })
    store.frozenRows = rows
    store.frozenCols = cols
    store.setDirty(true)
    notify.notify({ message: rows || cols ? '冻结窗格已更新' : '已取消冻结窗格', color: 'success', timeout: 1800 })
  } catch (e) {
    notify.notify({ message: `冻结窗格失败: ${errMsg(e)}`, color: 'error', timeout: 5000 })
  }
}

async function replaceAll(payload: { find: string; replace: string; matchCase: boolean; entireCell: boolean; useRegex: boolean }) {
  if (!store.connId || !store.activeSheet) return
  try {
    const result = await sidecarRpc<{ replaced: number; ok: boolean }>(`${rpcPrefix.value}.findReplace`, {
      connId: store.connId,
      sheetName: store.activeSheet,
      options: payload,
    })
    await reloadActiveSheet()
    store.setDirty(true)
    notify.notify({ message: `已替换 ${result.replaced} 处`, color: 'success', timeout: 2200 })
  } catch (e) {
    notify.notify({ message: `查找替换失败: ${errMsg(e)}`, color: 'error', timeout: 5000 })
  }
}

async function undo() {
  const edits = store.undo()
  if (edits.length > 0) await onCellChange(edits)
}

async function redo() {
  const edits = store.redo()
  if (edits.length > 0) await onCellChange(edits)
}

async function applyFormulaInput() {
  const sel = store.selectedCell
  if (!sel) return
  const edits = store.commitDisplayCellEdits([{ row: sel.row, col: sel.col, value: formulaInput.value }])
  if (edits.length > 0) await onCellChange(edits)
}

function toggleFilter() {
  showFilter.value = !showFilter.value
  if (!showFilter.value) {
    filterInput.value = ''
    store.clearFilter()
  }
}

function applyFilter() {
  store.setFilter(filterInput.value)
}

function asNumber(value: unknown, fallback = 0): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function asStringMatrix(value: unknown): string[][] {
  if (!Array.isArray(value)) return []
  return value.map(row => {
    if (!Array.isArray(row)) return [String(row ?? '')]
    return row.map(cell => String(cell ?? ''))
  })
}

function renderFormulaTemplate(template: string, row: number, col: number): string {
  const excelRow = store.displayRowToExcelRow(row)
  return template
    .replaceAll('{excelRow}', String(excelRow))
    .replaceAll('{row}', String(row))
    .replaceAll('{col}', String(col))
    .replaceAll('{colLetter}', store.colIndexToLetter(col))
}

function excelContextJson(): string {
  return JSON.stringify({
    file: store.filePath,
    kind: fileKindLabel.value,
    activeSheet: store.activeSheet,
    sheets: store.sheetNames,
    columns: store.columns.map((name, index) => ({ index, letter: store.colIndexToLetter(index), name })),
    totalRows: store.totalRows,
    displayRows: store.displayRowCount,
    selectedCell: store.selectedCell
      ? { ...store.selectedCell, label: store.activeCellLabel, value: store.selectedCellValue }
      : null,
    filter: store.filterText ? { text: store.filterText, col: store.filterCol } : null,
    dirty: store.dirty,
  }, null, 2)
}

async function executeExcelTool(call: LlmToolCall): Promise<string> {
  const args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>
  switch (call.function.name) {
    case 'excel_get_context':
      return excelContextJson()
    case 'excel_read_range': {
      const startRow = Math.max(0, asNumber(args.startRow, 0))
      const rowCount = Math.min(Math.max(1, asNumber(args.rowCount, 20)), 100)
      const rows = store.filteredRowData.slice(startRow, startRow + rowCount)
      return JSON.stringify({ columns: store.columns, startRow, rows }, null, 2)
    }
    case 'excel_write_cell': {
      const row = asNumber(args.row)
      const col = asNumber(args.col)
      const value = String(args.value ?? '')
      const edits = store.commitDisplayCellEdits([{ row, col, value }])
      if (edits.length > 0) await onCellChange(edits)
      return `已写入 ${store.colIndexToLetter(col)}${store.displayRowToExcelRow(row)}`
    }
    case 'excel_write_range': {
      const startRow = asNumber(args.row)
      const startCol = asNumber(args.col)
      const values = asStringMatrix(args.values)
      const changes = values.flatMap((row, rowOffset) =>
        row.map((value, colOffset) => ({ row: startRow + rowOffset, col: startCol + colOffset, value }))
      )
      const edits = store.commitDisplayCellEdits(changes)
      if (edits.length > 0) await onCellChange(edits)
      return `已写入区域 ${store.colIndexToLetter(startCol)}${store.displayRowToExcelRow(startRow)} 起 ${values.length} 行`
    }
    case 'excel_fill_formula': {
      const startRow = asNumber(args.startRow)
      const col = asNumber(args.col)
      const rowCount = Math.max(1, Math.min(asNumber(args.rowCount, 1), 1000))
      const formula = String(args.formula ?? '')
      const changes = Array.from({ length: rowCount }, (_, i) => {
        const row = startRow + i
        return { row, col, value: renderFormulaTemplate(formula, row, col) }
      })
      const edits = store.commitDisplayCellEdits(changes)
      if (edits.length > 0) await onCellChange(edits)
      return `已填充 ${rowCount} 行公式到 ${store.colIndexToLetter(col)} 列`
    }
    case 'excel_insert_rows':
      await handleAddRow(asNumber(args.row))
      return '已插入行'
    case 'excel_delete_rows':
      for (let i = 0; i < Math.max(1, asNumber(args.count, 1)); i++) {
        await handleDeleteRow(asNumber(args.row))
      }
      return '已删除行'
    case 'excel_insert_cols':
      await handleAddCol(asNumber(args.col))
      return '已插入列'
    case 'excel_delete_cols':
      for (let i = 0; i < Math.max(1, asNumber(args.count, 1)); i++) {
        await handleDeleteCol(asNumber(args.col))
      }
      return '已删除列'
    case 'excel_sort':
      await sortRows(Boolean(args.descending), asNumber(args.col))
      return '已排序'
    case 'excel_filter':
      showFilter.value = true
      filterInput.value = String(args.text ?? '')
      store.setFilter(filterInput.value, args.col === undefined ? null : asNumber(args.col))
      return `已筛选,当前显示 ${store.displayRowCount} / ${store.rowData.length} 行`
    case 'excel_clear_filter':
      filterInput.value = ''
      store.clearFilter()
      return '已清除筛选'
    case 'excel_set_headers': {
      const headers = Array.isArray(args.headers) ? args.headers.map(item => String(item ?? '')) : []
      if (!store.connId || !store.activeSheet || headers.length === 0) return '[Error] headers cannot be empty'
      await sidecarRpc(`${rpcPrefix.value}.writeHeaders`, { connId: store.connId, sheetName: store.activeSheet, headers })
      await reloadActiveSheet()
      store.setDirty(true)
      return `已更新 ${headers.length} 个表头`
    }
    case 'excel_find_replace':
      await replaceAll({
        find: String(args.find ?? ''),
        replace: String(args.replace ?? ''),
        matchCase: Boolean(args.matchCase),
        entireCell: Boolean(args.entireCell),
        useRegex: Boolean(args.useRegex),
      })
      return '已完成查找替换'
    case 'excel_add_sheet':
      await addSheet(String(args.sheetName ?? 'Sheet'))
      return '已新增 Sheet'
    case 'excel_remove_sheet':
      await removeSheet(String(args.sheetName ?? store.activeSheet))
      return '已删除 Sheet'
    case 'excel_rename_sheet':
      await renameSheet(String(args.oldName ?? store.activeSheet), String(args.newName ?? 'Sheet'))
      return '已重命名 Sheet'
    case 'excel_switch_sheet':
      await switchSheet(String(args.sheetName ?? store.activeSheet))
      return `已切换到 ${store.activeSheet}`
    case 'excel_style_header':
      if (!store.connId || !store.activeSheet) return '[Error] Excel not open'
      await sidecarRpc(`${rpcPrefix.value}.styleHeader`, { connId: store.connId, sheetName: store.activeSheet })
      store.setDirty(true)
      return isCsvFile.value ? 'CSV 不保存样式,已跳过' : '已应用表头样式'
    case 'excel_auto_filter':
      await autoFilter()
      return '已写入自动筛选'
    case 'excel_freeze':
      await setFreeze(asNumber(args.rows, 0), asNumber(args.cols, 0))
      return '冻结窗格已更新'
    case 'excel_remove_duplicates':
      await removeDuplicates()
      return '已执行删除重复项'
    case 'excel_dedup_to_sheet': {
      const columns = Array.isArray(args.columns)
        ? args.columns.map(item => asNumber(item, -1)).filter(item => item >= 0)
        : undefined
      await removeDuplicatesToSheet(columns)
      return '已按指定列去重并输出到新 Sheet'
    }
    case 'excel_save':
      await saveFile()
      return '已保存文件'
    default:
      return `[Error] Unknown Excel tool: ${call.function.name}`
  }
}

async function onAiSend(text: string) {
  if (!aiSession.value) return
  aiSession.value.messages.push({ role: 'user', content: text })
  await aiStore.runAgent(instanceId.value, excelTools, executeExcelTool, EXCEL_SYSTEM_PROMPT)
}

async function onAiRetry() {
  if (!aiSession.value) return
  const msgs = aiSession.value.messages
  while (msgs.length && msgs[msgs.length - 1].role !== 'user') {
    msgs.pop()
  }
  if (msgs.length) await aiStore.runAgent(instanceId.value, excelTools, executeExcelTool, EXCEL_SYSTEM_PROMPT)
}

function onAiNewChat() {
  aiStore.resetSession(instanceId.value)
}

function onAiStop() {
  aiStore.stopAgent(instanceId.value)
}

function onAiConfirmTool() {
  // Excel 工具直接作用于当前工作簿,暂不需要命令白名单确认。
}

function formatNumber(n: number) {
  if (!Number.isFinite(n)) return '0'
  return Math.abs(n) >= 1000 ? n.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) : n.toFixed(2).replace(/\.00$/, '')
}

function handleGlobalKeydown(e: KeyboardEvent) {
  const meta = e.ctrlKey || e.metaKey
  if (meta && e.key.toLowerCase() === 's') {
    e.preventDefault()
    saveFile()
  }
}

onMounted(() => {
  if (asset.value) {
    openExcel()
  }
  window.addEventListener('keydown', handleGlobalKeydown)
  getCurrentWebview().onDragDropEvent((event) => {
    if (event.payload.type === 'over') {
      showDropOverlay.value = true
    } else if (event.payload.type === 'leave') {
      showDropOverlay.value = false
    } else if (event.payload.type === 'drop') {
      showDropOverlay.value = false
      const path = event.payload.paths.find(p => droppedFileFormat(p))
      if (path) {
        openDroppedFile(path).catch((e) => {
          notify.notify({ message: `导入失败: ${errMsg(e)}`, color: 'error', timeout: 5000 })
        })
      } else {
        notify.notify({ message: '仅支持拖入 .xlsx / .xls / .csv 文件', color: 'warning', timeout: 2500 })
      }
    }
  }).then((unlisten) => {
    unlistenDragDrop = unlisten
  })
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleGlobalKeydown)
  unlistenDragDrop?.()
  unlistenDragDrop = null
})

watch(
  [() => asset.value?.id, () => asset.value?.config.filePath, () => fileFormat.value],
  ([assetId, filePath]) => {
    if (assetId && filePath) openExcel()
  }
)

watch(() => store.selectedCellValue, (value) => {
  formulaInput.value = value
}, { immediate: true })
</script>

<template>
  <div class="excel-view">
    <div v-if="showDropOverlay" class="excel-drop-overlay">
      <v-icon size="42" color="cyan">mdi-file-import-outline</v-icon>
      <span>释放以导入 Excel / CSV 文件</span>
    </div>

    <div v-if="!asset" class="excel-empty">
      <v-icon size="48" color="muted">mdi-file-alert-outline</v-icon>
      <p>文件未找到</p>
    </div>

    <div v-else-if="loading" class="excel-loading">
      <v-icon size="32" color="cyan" class="spin">mdi-loading</v-icon>
      <p>正在加载...</p>
    </div>

    <div v-else-if="error" class="excel-error">
      <v-icon size="32" color="red">mdi-alert-circle-outline</v-icon>
      <p>{{ error }}</p>
      <button class="cyber-btn" @click="openExcel">重试</button>
    </div>

    <template v-else>
      <div class="excel-topbar">
        <div class="tb-left">
          <v-icon size="15" color="green">{{ isCsvFile ? 'mdi-file-delimited-outline' : 'mdi-file-excel-outline' }}</v-icon>
          <span class="tb-title">{{ asset.name }}</span>
          <span class="tb-path">{{ store.filePath || asset.config.filePath }}</span>
          <span v-if="store.dirty" class="tb-dirty">● 未保存</span>
        </div>
        <div class="tb-right">
          <span class="cyber-badge">{{ store.activeSheet || 'Sheet' }}</span>
          <button
            class="action-btn"
            :class="{ active: rightPanelOpen }"
            title="Toggle Panel"
            @click="rightPanelOpen = !rightPanelOpen"
          >
            <v-icon size="16">mdi-panel-right</v-icon>
          </button>
        </div>
      </div>

      <div class="formula-bar">
        <div class="name-box">{{ store.activeCellLabel || 'A2' }}</div>
        <div class="formula-icon">
          <v-icon size="13">mdi-function-variant</v-icon>
        </div>
        <input
          v-model="formulaInput"
          class="formula-input"
          :placeholder="isCsvFile ? '输入 CSV 单元格文本' : '输入值或公式,例如 =SUM(B2:C2)'"
          @keydown.enter.prevent="applyFormulaInput"
          @blur="applyFormulaInput"
        />
      </div>

      <ExcelToolbar
        @save="saveFile"
        @add-row="handleAddRow"
        @delete-row="handleDeleteRow"
        @add-col="handleAddCol"
        @delete-col="handleDeleteCol"
        @sort-asc="sortRows(false)"
        @sort-desc="sortRows(true)"
        @filter="toggleFilter"
        @auto-filter="autoFilter"
        @remove-duplicates="removeDuplicates"
        @remove-duplicates-to-sheet="removeDuplicatesToSheet"
        @freeze-header="setFreeze(1, 0)"
        @freeze-first-col="setFreeze(0, 1)"
        @freeze-both="setFreeze(1, 1)"
        @unfreeze="setFreeze(0, 0)"
        @replace-all="replaceAll"
        @undo="undo"
        @redo="redo"
      />

      <div class="excel-workspace">
        <div class="excel-main">
          <div v-if="showFilter" class="filter-bar">
            <v-icon size="14" color="cyan">mdi-filter-outline</v-icon>
            <input
              v-model="filterInput"
              class="cyber-input filter-input"
              placeholder="输入关键词筛选..."
              @input="applyFilter"
              @keydown.escape="toggleFilter"
            />
            <span class="filter-count">{{ store.displayRowCount }} / {{ store.rowData.length }} 行</span>
            <button class="action-btn" @click="toggleFilter">
              <v-icon size="12">mdi-close</v-icon>
            </button>
          </div>

          <ExcelGrid
            @cell-change="onCellChange"
            @insert-row="handleAddRow"
            @delete-row="handleDeleteRow"
            @insert-col="handleAddCol"
            @delete-col="handleDeleteCol"
            @sort="(col, descending) => sortRows(descending, col)"
            @undo="undo"
            @redo="redo"
          />

          <ExcelSheetBar
            :single-sheet="isCsvFile"
            @switch-sheet="switchSheet"
            @add-sheet="addSheet"
            @remove-sheet="removeSheet"
            @rename-sheet="renameSheet"
          />

          <div class="excel-statusbar">
            <span>{{ store.displayRowCount }} / {{ store.totalRows }} 行</span>
            <span>{{ store.columns.length }} 列</span>
            <span v-if="store.filterText">筛选: {{ store.filterText }}</span>
            <span v-if="store.selectedStats.count">选区 {{ store.selectedStats.count }} 格</span>
            <span v-if="store.selectedStats.numericCount">求和 {{ formatNumber(store.selectedStats.sum) }}</span>
            <span v-if="store.selectedStats.numericCount">平均 {{ formatNumber(store.selectedStats.average) }}</span>
            <span v-if="store.frozenRows || store.frozenCols">冻结 {{ store.frozenRows }}R {{ store.frozenCols }}C</span>
          </div>
        </div>

        <RightPanel
          v-model="rightPanelOpen"
          v-model:active-tab="rightActiveTab"
          :tabs="rightPanelTabs"
        >
          <template #tab-ai>
            <AiChat
              v-if="aiSession"
              :session="aiSession"
              :sending="aiSession.loading"
              placeholder="让 AI 操作当前表格,例如: 按金额降序、筛选状态为成功、把 B2 改成 100"
              @send="onAiSend"
              @retry="onAiRetry"
              @confirm-tool="onAiConfirmTool"
              @new-chat="onAiNewChat"
              @stop="onAiStop"
            />
          </template>
        </RightPanel>
      </div>
    </template>
  </div>
</template>

<style scoped>
.excel-view {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  position: relative;
}

.excel-drop-overlay {
  position: absolute;
  inset: 8px;
  z-index: 20;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  border: 1px dashed var(--cyan);
  border-radius: 12px;
  background: rgba(5, 8, 16, 0.84);
  color: var(--cyan);
  font-size: 13px;
  font-weight: 600;
  box-shadow: var(--glow-cyan);
  pointer-events: none;
}

.excel-empty,
.excel-loading,
.excel-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  gap: 12px;
  color: var(--muted);
  font-size: 14px;
}

.excel-error {
  color: var(--red);
}

.spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.excel-topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 12px;
  background: var(--bg-2);
  border-bottom: 1px solid var(--line);
  min-height: 32px;
}

.tb-left {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.tb-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
}

.tb-path {
  font-size: 10px;
  color: var(--muted);
  font-family: 'JetBrains Mono', monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tb-dirty {
  font-size: 10px;
  color: var(--yellow);
  font-family: 'JetBrains Mono', monospace;
}

.tb-right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.formula-bar {
  display: grid;
  grid-template-columns: 92px 32px minmax(0, 1fr);
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  background: var(--panel-solid);
  border-bottom: 1px solid var(--line);
}

.name-box {
  height: 30px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--line-2);
  border-radius: 6px;
  background: var(--bg-input);
  color: var(--cyan);
  font-family: 'JetBrains Mono', monospace;
  font-size: 12px;
  font-weight: 600;
}

.formula-icon {
  height: 30px;
  border: 1px solid var(--line);
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--muted);
}

.formula-input {
  height: 30px;
  border: 1px solid var(--line-2);
  border-radius: 6px;
  outline: none;
  background: var(--bg-input);
  color: var(--text);
  padding: 0 10px;
  font-size: 12px;
  font-family: 'JetBrains Mono', monospace;
}

.formula-input:focus {
  border-color: var(--cyan);
  box-shadow: 0 0 0 3px var(--focus-cyan);
}

.filter-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 12px;
  background: var(--panel-solid);
  border-bottom: 1px solid var(--line);
}

.filter-input {
  flex: 1;
  max-width: 300px;
  height: 28px;
  font-size: 12px;
}

.filter-count {
  font-size: 11px;
  color: var(--muted);
  font-family: 'JetBrains Mono', monospace;
}

.filter-bar .action-btn {
  width: 24px;
  height: 24px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-2);
  background: transparent;
  border: 1px solid transparent;
  cursor: pointer;
}

.filter-bar .action-btn:hover {
  background: rgba(0, 240, 255, 0.08);
  color: var(--cyan);
}

.excel-workspace {
  flex: 1;
  min-height: 0;
  display: flex;
  overflow: hidden;
}

.excel-main {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.excel-statusbar {
  min-height: 26px;
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 0 10px;
  background: var(--bg-2);
  border-top: 1px solid var(--line);
  color: var(--muted);
  font-size: 10px;
  font-family: 'JetBrains Mono', monospace;
  white-space: nowrap;
}

.excel-statusbar span {
  display: inline-flex;
  align-items: center;
}
</style>
