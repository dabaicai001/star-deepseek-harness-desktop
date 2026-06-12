<script setup lang="ts">
import { ref } from 'vue'
import { useExcelStore } from '@/stores/excel'

const store = useExcelStore()

const emit = defineEmits<{
  save: []
  'save-as': []
  'add-row': []
  'delete-row': []
  'add-col': []
  'delete-col': []
  sort: []
  filter: []
  'remove-duplicates': []
  'import-db': []
  'undo': []
  'redo': []
}>()

const showFind = ref(false)
</script>

<template>
  <div class="excel-toolbar">
    <div class="tb-group">
      <button
        class="action-btn"
        :disabled="!store.dirty"
        :data-tooltip="'保存 (Ctrl+S)'"
        @click="emit('save')"
      >
        <v-icon size="14">mdi-content-save</v-icon>
      </button>
      <button class="action-btn" :data-tooltip="'撤销'" @click="emit('undo')">
        <v-icon size="14">mdi-undo</v-icon>
      </button>
      <button class="action-btn" :data-tooltip="'重做'" @click="emit('redo')">
        <v-icon size="14">mdi-redo</v-icon>
      </button>
    </div>

    <div class="tb-divider" />

    <div class="tb-group">
      <button class="action-btn" :data-tooltip="'插入行'" @click="emit('add-row')">
        <v-icon size="14">mdi-table-row-plus-after</v-icon>
      </button>
      <button class="action-btn" :data-tooltip="'删除行'" @click="emit('delete-row')">
        <v-icon size="14">mdi-table-row-remove</v-icon>
      </button>
      <button class="action-btn" :data-tooltip="'插入列'" @click="emit('add-col')">
        <v-icon size="14">mdi-table-column-plus-after</v-icon>
      </button>
      <button class="action-btn" :data-tooltip="'删除列'" @click="emit('delete-col')">
        <v-icon size="14">mdi-table-column-remove</v-icon>
      </button>
    </div>

    <div class="tb-divider" />

    <div class="tb-group">
      <button class="action-btn" :data-tooltip="'排序'" @click="emit('sort')">
        <v-icon size="14">mdi-sort</v-icon>
      </button>
      <button class="action-btn" :data-tooltip="'筛选'" @click="emit('filter')">
        <v-icon size="14">mdi-filter-outline</v-icon>
      </button>
      <button class="action-btn" :data-tooltip="'删除重复项'" @click="emit('remove-duplicates')">
        <v-icon size="14">mdi-playlist-remove</v-icon>
      </button>
    </div>

    <div class="tb-spacer" />

    <div class="tb-group">
      <button class="action-btn" :data-tooltip="'查找替换'" @click="showFind = !showFind">
        <v-icon size="14">mdi-magnify</v-icon>
      </button>
      <button class="action-btn" :data-tooltip="'导入到数据库'" @click="emit('import-db')">
        <v-icon size="14">mdi-database-import-outline</v-icon>
      </button>
    </div>
  </div>
  <div v-if="showFind" class="find-replace-bar">
    <input class="cyber-input" placeholder="查找..." style="width: 160px;" />
    <input class="cyber-input" placeholder="替换为..." style="width: 160px;" />
    <button class="cyber-btn-secondary" style="height: 28px; font-size: 11px;">全部替换</button>
    <button class="action-btn" @click="showFind = false">
      <v-icon size="12">mdi-close</v-icon>
    </button>
  </div>
</template>

<style scoped>
.excel-toolbar {
  display: flex;
  align-items: center;
  padding: 4px 8px;
  background: var(--panel-solid);
  border-bottom: 1px solid var(--line);
  gap: 2px;
  min-height: 36px;
}

.tb-group {
  display: flex;
  align-items: center;
  gap: 1px;
}

.tb-divider {
  width: 1px;
  height: 20px;
  background: var(--line);
  margin: 0 4px;
}

.tb-spacer {
  flex: 1;
}

.action-btn {
  width: 28px;
  height: 28px;
  border-radius: 5px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-2);
  background: transparent;
  border: 1px solid transparent;
  cursor: pointer;
  transition: all 0.15s;
}

.action-btn:hover:not(:disabled) {
  background: rgba(0, 240, 255, 0.08);
  color: var(--cyan);
  border-color: var(--line-2);
}

.action-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.find-replace-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  background: var(--panel-solid);
  border-bottom: 1px solid var(--line);
}
</style>
