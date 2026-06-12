<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { useAssetStore } from '@/stores/asset'

const route = useRoute()
const assetStore = useAssetStore()

const instanceId = computed(() => route.params.id as string)
const assetId = computed(() => {
  const tab = appStore.tabs.find(t => t.id === instanceId.value)
  return tab?.assetId
})
const asset = computed(() => assetStore.assets.find(a => a.id === assetId.value))

import { computed } from 'vue'
import { useAppStore } from '@/stores/app'

const appStore = useAppStore()

const loading = ref(false)
const error = ref<string | null>(null)

onMounted(() => {
  if (asset.value) {
    assetStore.updateAsset(asset.value.id, { lastUsedAt: Date.now() })
  }
})
</script>

<template>
  <div class="excel-view">
    <div v-if="!asset" class="excel-empty">
      <p>Excel 文件未找到</p>
    </div>
    <div v-else class="excel-container">
      <div class="excel-toolbar">
        <div class="tb-left">
          <span class="tb-title">{{ asset.name }}</span>
          <span class="tb-path">{{ asset.config.filePath }}</span>
        </div>
        <div class="tb-right">
          <button class="action-btn" :data-tooltip="'保存'">
            <v-icon size="14">mdi-content-save</v-icon>
          </button>
        </div>
      </div>
      <div class="excel-content">
        <div class="excel-placeholder">
          <v-icon size="48" color="green">mdi-file-excel-outline</v-icon>
          <h3>Excel Editor</h3>
          <p>Canvas 虚拟表格将在此实现</p>
          <p class="hint">Phase 2: ExcelGrid + ExcelToolbar + ExcelSheetBar</p>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.excel-view {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg);
}

.excel-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--muted);
  font-size: 14px;
}

.excel-container {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.excel-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 16px;
  background: var(--panel-solid);
  border-bottom: 1px solid var(--line);
  min-height: 40px;
}

.tb-left {
  display: flex;
  align-items: center;
  gap: 12px;
}

.tb-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}

.tb-path {
  font-size: 11px;
  color: var(--muted);
  font-family: 'JetBrains Mono', monospace;
}

.tb-right {
  display: flex;
  gap: 4px;
}

.excel-content {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}

.excel-placeholder {
  text-align: center;
  color: var(--text-2);
}

.excel-placeholder h3 {
  margin: 12px 0 4px;
  font-size: 16px;
  color: var(--text);
}

.excel-placeholder p {
  margin: 0;
  font-size: 12px;
  color: var(--muted);
}

.excel-placeholder .hint {
  margin-top: 8px;
  font-size: 11px;
  color: var(--cyan);
  font-family: 'JetBrains Mono', monospace;
}
</style>
