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
  'sort-asc': []
  'sort-desc': []
  filter: []
  'auto-filter': []
  'remove-duplicates': []
  'freeze-header': []
  'freeze-first-col': []
  'freeze-both': []
  'unfreeze': []
  'import-db': []
  'undo': []
  'redo': []
  'replace-all': [payload: { find: string; replace: string; matchCase: boolean; entireCell: boolean; useRegex: boolean }]
}>()

const showFind = ref(false)
const findText = ref('')
const replaceText = ref('')
const matchCase = ref(false)
const entireCell = ref(false)
const useRegex = ref(false)

function emitReplaceAll() {
  if (!findText.value) return
  emit('replace-all', {
    find: findText.value,
    replace: replaceText.value,
    matchCase: matchCase.value,
    entireCell: entireCell.value,
    useRegex: useRegex.value,
  })
}
</script>

<template>
  <div class="excel-ribbon">
    <div class="ribbon-tabs">
      <button class="ribbon-tab active">开始</button>
      <button class="ribbon-tab">数据</button>
      <button class="ribbon-tab">视图</button>
    </div>

    <div class="ribbon-body">
      <div class="ribbon-group">
        <div class="ribbon-actions">
          <button
            class="action-btn primary"
            :disabled="!store.dirty"
            :data-tooltip="'保存 (Ctrl+S)'"
            @click="emit('save')"
          >
            <v-icon size="14">mdi-content-save</v-icon>
          </button>
          <button
            class="action-btn"
            :disabled="!store.canUndo"
            :data-tooltip="'撤销 (Ctrl+Z)'"
            @click="emit('undo')"
          >
            <v-icon size="14">mdi-undo</v-icon>
          </button>
          <button
            class="action-btn"
            :disabled="!store.canRedo"
            :data-tooltip="'重做 (Ctrl+Y)'"
            @click="emit('redo')"
          >
            <v-icon size="14">mdi-redo</v-icon>
          </button>
        </div>
        <span class="ribbon-label">文件</span>
      </div>

      <div class="ribbon-divider" />

      <div class="ribbon-group">
        <div class="ribbon-actions">
          <button class="action-btn" :data-tooltip="'插入行'" @click="emit('add-row')">
            <v-icon size="14">mdi-table-row-plus-before</v-icon>
          </button>
          <button class="action-btn" :data-tooltip="'删除行'" @click="emit('delete-row')">
            <v-icon size="14">mdi-table-row-remove</v-icon>
          </button>
          <button class="action-btn" :data-tooltip="'插入列'" @click="emit('add-col')">
            <v-icon size="14">mdi-table-column-plus-before</v-icon>
          </button>
          <button class="action-btn" :data-tooltip="'删除列'" @click="emit('delete-col')">
            <v-icon size="14">mdi-table-column-remove</v-icon>
          </button>
        </div>
        <span class="ribbon-label">单元格</span>
      </div>

      <div class="ribbon-divider" />

      <div class="ribbon-group">
        <div class="ribbon-actions">
          <button class="action-btn" :data-tooltip="'升序排序'" @click="emit('sort-asc')">
            <v-icon size="14">mdi-sort-ascending</v-icon>
          </button>
          <button class="action-btn" :data-tooltip="'降序排序'" @click="emit('sort-desc')">
            <v-icon size="14">mdi-sort-descending</v-icon>
          </button>
          <button class="action-btn" :data-tooltip="'本地筛选'" @click="emit('filter')">
            <v-icon size="14">mdi-filter-outline</v-icon>
          </button>
          <button class="action-btn" :data-tooltip="'写入自动筛选'" @click="emit('auto-filter')">
            <v-icon size="14">mdi-filter-check-outline</v-icon>
          </button>
          <button class="action-btn" :data-tooltip="'删除重复项'" @click="emit('remove-duplicates')">
            <v-icon size="14">mdi-playlist-remove</v-icon>
          </button>
        </div>
        <span class="ribbon-label">数据</span>
      </div>

      <div class="ribbon-divider" />

      <div class="ribbon-group">
        <div class="ribbon-actions">
          <button class="action-btn" :data-tooltip="'冻结表头'" @click="emit('freeze-header')">
            <v-icon size="14">mdi-table-row</v-icon>
          </button>
          <button class="action-btn" :data-tooltip="'冻结首列'" @click="emit('freeze-first-col')">
            <v-icon size="14">mdi-table-column</v-icon>
          </button>
          <button class="action-btn" :data-tooltip="'冻结窗格'" @click="emit('freeze-both')">
            <v-icon size="14">mdi-table-lock</v-icon>
          </button>
          <button class="action-btn" :data-tooltip="'取消冻结'" @click="emit('unfreeze')">
            <v-icon size="14">mdi-table-off</v-icon>
          </button>
        </div>
        <span class="ribbon-label">视图</span>
      </div>

      <div class="ribbon-spacer" />

      <div class="ribbon-group compact">
        <div class="ribbon-actions">
          <button class="action-btn" :data-tooltip="'查找替换'" @click="showFind = !showFind">
            <v-icon size="14">mdi-magnify</v-icon>
          </button>
          <button class="action-btn" :data-tooltip="'导入到数据库'" @click="emit('import-db')">
            <v-icon size="14">mdi-database-import-outline</v-icon>
          </button>
        </div>
        <span class="ribbon-label">工具</span>
      </div>
    </div>
  </div>

  <div v-if="showFind" class="find-replace-bar">
    <div class="find-field">
      <v-icon size="13">mdi-magnify</v-icon>
      <input v-model="findText" class="find-input" placeholder="查找" @keydown.enter="emitReplaceAll" />
    </div>
    <div class="find-field">
      <v-icon size="13">mdi-swap-horizontal</v-icon>
      <input v-model="replaceText" class="find-input" placeholder="替换为" @keydown.enter="emitReplaceAll" />
    </div>
    <label class="find-toggle">
      <input v-model="matchCase" type="checkbox" />
      <span>区分大小写</span>
    </label>
    <label class="find-toggle">
      <input v-model="entireCell" type="checkbox" />
      <span>整格匹配</span>
    </label>
    <label class="find-toggle">
      <input v-model="useRegex" type="checkbox" />
      <span>Regex</span>
    </label>
    <button class="cyber-btn-secondary find-action" :disabled="!findText" @click="emitReplaceAll">
      全部替换
    </button>
    <button class="action-btn" @click="showFind = false">
      <v-icon size="12">mdi-close</v-icon>
    </button>
  </div>
</template>

<style scoped>
.excel-ribbon {
  background: var(--panel-solid);
  border-bottom: 1px solid var(--line);
}

.ribbon-tabs {
  display: flex;
  align-items: center;
  gap: 2px;
  height: 28px;
  padding: 0 8px;
  border-bottom: 1px solid var(--line);
}

.ribbon-tab {
  height: 24px;
  padding: 0 12px;
  border: 0;
  border-radius: 6px 6px 0 0;
  color: var(--text-2);
  background: transparent;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
}

.ribbon-tab.active {
  color: var(--cyan);
  background: var(--hover-cyan);
  box-shadow: inset 0 -1px 0 var(--cyan);
}

.ribbon-body {
  min-height: 54px;
  display: flex;
  align-items: stretch;
  gap: 8px;
  padding: 6px 8px;
}

.ribbon-group {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
}

.ribbon-group.compact {
  align-items: flex-end;
}

.ribbon-actions {
  display: flex;
  align-items: center;
  gap: 2px;
}

.ribbon-label {
  font-size: 10px;
  color: var(--muted);
  line-height: 1;
}

.ribbon-divider {
  width: 1px;
  background: var(--line);
  margin: 4px 0;
}

.ribbon-spacer {
  flex: 1;
}

.find-replace-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  background: var(--panel-solid-2);
  border-bottom: 1px solid var(--line);
}

.find-field {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 180px;
  height: 30px;
  padding: 0 8px;
  border-radius: 8px;
  border: 1px solid var(--line-2);
  background: var(--bg-input);
  color: var(--muted);
}

.find-input {
  min-width: 0;
  flex: 1;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--text);
  font-size: 12px;
}

.find-toggle {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--text-2);
  font-size: 11px;
  white-space: nowrap;
}

.find-toggle input {
  accent-color: var(--cyan);
}

.find-action {
  height: 30px;
  padding: 0 12px;
  border-radius: 6px;
  font-size: 11px;
}

.action-btn:disabled,
.find-action:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
</style>
