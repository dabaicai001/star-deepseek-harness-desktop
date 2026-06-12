<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useAssetStore } from '@/stores/asset'
import { useAppStore } from '@/stores/app'
import { useExcelStore, type CellEdit } from '@/stores/excel'
import ExcelGrid from '@/components/excel/ExcelGrid.vue'
import ExcelToolbar from '@/components/excel/ExcelToolbar.vue'
import ExcelSheetBar from '@/components/excel/ExcelSheetBar.vue'

const route = useRoute()
const assetStore = useAssetStore()
const appStore = useAppStore()
const store = useExcelStore()

const instanceId = computed(() => route.params.id as string)
const asset = computed(() => {
  const tab = appStore.tabs.find(t => t.id === instanceId.value)
  if (!tab?.assetId) return null
  return assetStore.assets.find(a => a.id === tab.assetId)
})

const loading = ref(false)
const error = ref<string | null>(null)

async function openExcel() {
  if (!asset.value?.config.filePath) return

  loading.value = true
  error.value = null

  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const result = await invoke<{
      connId: string
      filePath: string
      sheetNames: string[]
      initialData?: { sheetName: string; columns: string[]; rows: string[][]; totalRows: number }
    }>('sidecar:rpc', {
      method: 'file.excel.open',
      params: { filePath: asset.value.config.filePath, format: asset.value.config.format || 'xlsx' }
    })

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
    error.value = String(e)
    console.error('Excel open failed:', e)
  } finally {
    loading.value = false
  }
}

async function saveFile() {
  if (!store.connId) return
  store.setLoading(true)
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('sidecar:rpc', {
      method: 'file.excel.save',
      params: { connId: store.connId }
    })
    store.setDirty(false)
  } catch (e) {
    error.value = String(e)
  } finally {
    store.setLoading(false)
  }
}

async function switchSheet(sheetName: string) {
  if (!store.connId) return
  store.setLoading(true)
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const result = await invoke<{ sheetName: string; columns: string[]; rows: string[][]; totalRows: number }>(
      'sidecar:rpc', {
        method: 'file.excel.readSheet',
        params: { connId: store.connId, sheetName }
      }
    )
    store.loadData({
      ...result,
      sheetNames: store.sheetNames,
      connId: store.connId,
      filePath: store.filePath,
    })
  } catch (e) {
    error.value = String(e)
  } finally {
    store.setLoading(false)
  }
}

async function onCellChange(edits: CellEdit[]) {
  if (!store.connId || edits.length === 0 || !store.activeSheet) return
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('sidecar:rpc', {
      method: 'file.excel.writeCells',
      params: { connId: store.connId, sheetName: store.activeSheet, cells: edits }
    })
  } catch (e) {
    error.value = String(e)
  }
}

async function addSheet() {
  if (!store.connId) return
  const name = `Sheet${store.sheetNames.length + 1}`
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('sidecar:rpc', {
      method: 'file.excel.addSheet',
      params: { connId: store.connId, sheetName: name }
    })
    store.sheetNames.push(name)
    switchSheet(name)
  } catch (e) {
    error.value = String(e)
  }
}

async function removeDuplicates() {
  if (!store.connId || !store.activeSheet) return
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const result = await invoke<{ removed: number; ok: boolean }>('sidecar:rpc', {
      method: 'file.excel.removeDuplicates',
      params: { connId: store.connId, sheetName: store.activeSheet, columns: [] }
    })
    // Reload current sheet
    await switchSheet(store.activeSheet)
    alert(`已删除 ${result.removed} 个重复行`)
  } catch (e) {
    error.value = String(e)
  }
}

function handleAddRow() {
  store.addRow(store.rowData.length - 1)
}
function handleDeleteRow() {
  store.deleteRow(store.rowData.length - 1)
}
function handleAddCol() {
  store.addCol(store.columns.length - 1)
}
function handleDeleteCol() {
  store.deleteCol(store.columns.length - 1)
}

onMounted(() => {
  if (asset.value) {
    openExcel()
  }
})

watch(() => asset.value?.config.filePath, () => {
  if (asset.value) openExcel()
})
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
          <span class="tb-title">{{ asset.name }}</span>
          <span class="tb-path">{{ store.filePath || asset.config.filePath }}</span>
          <span v-if="store.dirty" class="tb-dirty">● 未保存</span>
        </div>
      </div>

      <ExcelToolbar
        @save="saveFile"
        @add-row="handleAddRow"
        @delete-row="handleDeleteRow"
        @add-col="handleAddCol"
        @delete-col="handleDeleteCol"
        @remove-duplicates="removeDuplicates"
      />

      <ExcelGrid
        @cell-change="onCellChange"
      />

      <ExcelSheetBar
        @switch-sheet="switchSheet"
        @add-sheet="addSheet"
      />
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
}

.tb-dirty {
  font-size: 10px;
  color: var(--yellow);
  font-family: 'JetBrains Mono', monospace;
}
</style>
