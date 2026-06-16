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

const route = useRoute()
const assetStore = useAssetStore()
const appStore = useAppStore()
const store = useExcelStore()
const notify = useNotifyStore()

const instanceId = computed(() => route.params.id as string)
const asset = computed(() => {
  const tab = appStore.tabs.find(t => t.id === instanceId.value)
  if (!tab?.assetId) return null
  return assetStore.assets.find(a => a.id === tab.assetId)
})

const loading = ref(false)
const error = ref<string | null>(null)
const showFilter = ref(false)
const filterInput = ref('')
const formulaInput = ref('')

type SheetPayload = { sheetName: string; columns: string[]; rows: string[][]; totalRows: number }

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
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
    }>('file.excel.open', { filePath: asset.value.config.filePath, format: asset.value.config.format || 'xlsx' })

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
    console.error('Excel open failed:', e)
  } finally {
    loading.value = false
  }
}

async function saveFile() {
  if (!store.connId) return
  store.setLoading(true)
  try {
    await sidecarRpc('file.excel.save', { connId: store.connId })
    store.setDirty(false)
    notify.notify({ message: 'Excel 文件已保存', color: 'success', timeout: 1800 })
  } catch (e) {
    notify.notify({ message: `保存失败: ${errMsg(e)}`, color: 'error', timeout: 5000 })
  } finally {
    store.setLoading(false)
  }
}

async function switchSheet(sheetName: string) {
  if (!store.connId) return
  store.setLoading(true)
  try {
    const result = await sidecarRpc<SheetPayload>('file.excel.readSheet', { connId: store.connId, sheetName })
    store.loadData({
      ...result,
      sheetNames: store.sheetNames,
      connId: store.connId,
      filePath: store.filePath,
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
    await sidecarRpc('file.excel.writeCells', { connId: store.connId, sheetName: store.activeSheet, cells: edits })
  } catch (e) {
    notify.notify({ message: `写入失败: ${errMsg(e)}`, color: 'error', timeout: 5000 })
  }
}

async function addSheet(sheetName?: string) {
  if (!store.connId) return
  const name = makeUniqueSheetName(sheetName || `Sheet${store.sheetNames.length + 1}`)
  try {
    await sidecarRpc('file.excel.addSheet', { connId: store.connId, sheetName: name })
    store.sheetNames.push(name)
    await switchSheet(name)
    store.setDirty(true)
    notify.notify({ message: `已添加 Sheet: ${name}`, color: 'success', timeout: 1800 })
  } catch (e) {
    notify.notify({ message: `添加 Sheet 失败: ${errMsg(e)}`, color: 'error', timeout: 5000 })
  }
}

async function removeSheet(sheetName: string) {
  if (!store.connId || store.sheetNames.length <= 1) {
    notify.notify({ message: '至少保留一个 Sheet', color: 'warning', timeout: 2500 })
    return
  }
  try {
    await sidecarRpc('file.excel.removeSheet', { connId: store.connId, sheetName })
    store.sheetNames = store.sheetNames.filter(name => name !== sheetName)
    await switchSheet(store.sheetNames[0])
    store.setDirty(true)
    notify.notify({ message: `已删除 Sheet: ${sheetName}`, color: 'success', timeout: 1800 })
  } catch (e) {
    notify.notify({ message: `删除 Sheet 失败: ${errMsg(e)}`, color: 'error', timeout: 5000 })
  }
}

async function renameSheet(oldName: string, newName: string) {
  if (!store.connId || !newName || oldName === newName) return
  const safeName = makeUniqueSheetName(newName, oldName)
  try {
    await sidecarRpc('file.excel.renameSheet', { connId: store.connId, oldName, newName: safeName })
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
    const result = await sidecarRpc<{ removed: number; ok: boolean }>('file.excel.removeDuplicates', {
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

async function handleAddRow(row = store.selectedCell?.row ?? 0) {
  if (!store.connId || !store.activeSheet) return
  try {
    await sidecarRpc('file.excel.insertRows', {
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
    await sidecarRpc('file.excel.deleteRows', {
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
    await sidecarRpc('file.excel.insertCols', { connId: store.connId, sheetName: store.activeSheet, col, count: 1 })
    await reloadActiveSheet()
    store.setDirty(true)
  } catch (e) {
    notify.notify({ message: `插入列失败: ${errMsg(e)}`, color: 'error', timeout: 5000 })
  }
}

async function handleDeleteCol(col = store.selectedCell?.col ?? 0) {
  if (!store.connId || !store.activeSheet) return
  try {
    await sidecarRpc('file.excel.deleteCols', { connId: store.connId, sheetName: store.activeSheet, col, count: 1 })
    await reloadActiveSheet()
    store.setDirty(true)
  } catch (e) {
    notify.notify({ message: `删除列失败: ${errMsg(e)}`, color: 'error', timeout: 5000 })
  }
}

async function sortRows(descending: boolean, col = store.selectedCell?.col ?? 0) {
  if (!store.connId || !store.activeSheet) return
  try {
    await sidecarRpc('file.excel.sortRows', { connId: store.connId, sheetName: store.activeSheet, col, descending })
    await reloadActiveSheet()
    store.setDirty(true)
  } catch (e) {
    notify.notify({ message: `排序失败: ${errMsg(e)}`, color: 'error', timeout: 5000 })
  }
}

async function autoFilter() {
  if (!store.connId || !store.activeSheet) return
  try {
    await sidecarRpc('file.excel.autoFilter', { connId: store.connId, sheetName: store.activeSheet })
    store.setDirty(true)
    notify.notify({ message: '已为当前区域写入自动筛选', color: 'success', timeout: 2200 })
  } catch (e) {
    notify.notify({ message: `自动筛选失败: ${errMsg(e)}`, color: 'error', timeout: 5000 })
  }
}

async function setFreeze(rows: number, cols: number) {
  if (!store.connId || !store.activeSheet) return
  try {
    await sidecarRpc('file.excel.freezePanes', { connId: store.connId, sheetName: store.activeSheet, rows, cols })
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
    const result = await sidecarRpc<{ replaced: number; ok: boolean }>('file.excel.findReplace', {
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
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleGlobalKeydown)
})

watch(() => asset.value?.config.filePath, () => {
  if (asset.value) openExcel()
})

watch(() => store.selectedCellValue, (value) => {
  formulaInput.value = value
}, { immediate: true })
</script>

<template>
  <div class="excel-view">
    <div v-if="!asset" class="excel-empty">
      <v-icon size="48" color="muted">mdi-file-alert-outline</v-icon>
      <p>Excel 文件未找到</p>
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
          <v-icon size="15" color="green">mdi-file-excel-outline</v-icon>
          <span class="tb-title">{{ asset.name }}</span>
          <span class="tb-path">{{ store.filePath || asset.config.filePath }}</span>
          <span v-if="store.dirty" class="tb-dirty">● 未保存</span>
        </div>
        <div class="tb-right">
          <span class="cyber-badge">{{ store.activeSheet || 'Sheet' }}</span>
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
          placeholder="输入值或公式,例如 =SUM(B2:C2)"
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
        @freeze-header="setFreeze(1, 0)"
        @freeze-first-col="setFreeze(0, 1)"
        @freeze-both="setFreeze(1, 1)"
        @unfreeze="setFreeze(0, 0)"
        @replace-all="replaceAll"
        @undo="undo"
        @redo="redo"
      />

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
        @switch-sheet="switchSheet"
        @add-sheet="addSheet"
        @remove-sheet="removeSheet"
        @rename-sheet="renameSheet"
      />

      <div class="excel-statusbar">
        <span>{{ store.displayRowCount }} / {{ store.totalRows }} 行</span>
        <span>{{ store.columns.length }} 列</span>
        <span v-if="store.selectedStats.count">选区 {{ store.selectedStats.count }} 格</span>
        <span v-if="store.selectedStats.numericCount">求和 {{ formatNumber(store.selectedStats.sum) }}</span>
        <span v-if="store.selectedStats.numericCount">平均 {{ formatNumber(store.selectedStats.average) }}</span>
        <span v-if="store.frozenRows || store.frozenCols">冻结 {{ store.frozenRows }}R {{ store.frozenCols }}C</span>
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
