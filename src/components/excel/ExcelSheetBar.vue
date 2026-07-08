<script setup lang="ts">
import { ref } from 'vue'
import { useExcelStore } from '@/stores/excel'

const store = useExcelStore()

const props = defineProps<{
  singleSheet?: boolean
}>()

const emit = defineEmits<{
  'switch-sheet': [name: string]
  'add-sheet': [name?: string]
  'remove-sheet': [name: string]
  'rename-sheet': [oldName: string, newName: string]
}>()

const editingSheet = ref<string | null>(null)
const editSheetName = ref('')
const addSheetName = ref('')
const showAddSheet = ref(false)

function switchTo(name: string) {
  if (name !== store.activeSheet) {
    emit('switch-sheet', name)
  }
}

function startRename(name: string) {
  if (props.singleSheet) return
  editingSheet.value = name
  editSheetName.value = name
}

function confirmRename(oldName: string) {
  if (editSheetName.value && editSheetName.value !== oldName) {
    emit('rename-sheet', oldName, editSheetName.value)
  }
  editingSheet.value = null
}

function confirmAddSheet() {
  emit('add-sheet', addSheetName.value || undefined)
  addSheetName.value = ''
  showAddSheet.value = false
}
</script>

<template>
  <div class="sheet-bar">
    <div class="sheet-tabs">
      <button
        v-for="name in store.sheetNames"
        :key="name"
        class="sheet-tab"
        :class="{ active: name === store.activeSheet }"
        @click="switchTo(name)"
        @dblclick="startRename(name)"
      >
        <template v-if="editingSheet === name">
          <input
            v-model="editSheetName"
            class="sheet-rename-input"
            @keydown.enter="confirmRename(name)"
            @keydown.escape="editingSheet = null"
            @blur="confirmRename(name)"
            @click.stop
          />
        </template>
        <template v-else>
          <span>{{ name }}</span>
          <button
            v-if="!props.singleSheet && store.sheetNames.length > 1"
            class="sheet-close-btn"
            :data-tooltip="'删除 Sheet'"
            @click.stop="emit('remove-sheet', name)"
          >
            <v-icon size="10">mdi-close</v-icon>
          </button>
        </template>
      </button>
      <button
        v-if="!props.singleSheet"
        class="sheet-add-btn"
        @click="showAddSheet = !showAddSheet"
        :data-tooltip="'添加 Sheet'"
      >
        <v-icon size="14">mdi-plus</v-icon>
      </button>
    </div>
    <div v-if="showAddSheet && !props.singleSheet" class="sheet-add-popup">
      <input
        v-model="addSheetName"
        class="cyber-input"
        placeholder="Sheet 名称"
        @keydown.enter="confirmAddSheet"
        @keydown.escape="showAddSheet = false"
      />
    </div>
  </div>
</template>

<style scoped>
.sheet-bar {
  height: 34px;
  background: var(--excel-ribbon-bg);
  border-top: 1px solid var(--excel-ribbon-line);
  display: flex;
  align-items: center;
  padding: 0 8px 0 34px;
  position: relative;
}

.sheet-tabs {
  display: flex;
  align-items: center;
  gap: 2px;
  overflow-x: auto;
  flex: 1;
}

.sheet-tab {
  min-height: 28px;
  padding: 3px 18px;
  font-size: 12px;
  color: var(--excel-title-tab-fg);
  background: transparent;
  border: 0;
  border-radius: 0;
  cursor: pointer;
  white-space: nowrap;
  font-family: 'Outfit', sans-serif;
  transition: all 0.15s;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.sheet-tab:hover {
  background: var(--excel-sheet-hover);
  color: var(--excel-green);
}

.sheet-tab.active {
  background: var(--excel-ribbon-tab-bg);
  color: var(--excel-green);
  box-shadow: inset 0 -2px 0 var(--excel-green);
  text-shadow: 0 0 8px rgba(93, 214, 214, 0.4);
}

.sheet-add-btn {
  width: 24px;
  height: 24px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--excel-muted);
  background: transparent;
  border: 1px solid transparent;
  cursor: pointer;
  flex-shrink: 0;
}

.sheet-add-btn:hover {
  background: var(--excel-green-soft);
  color: var(--excel-green);
  border-color: var(--excel-green-border);
}

.sheet-close-btn {
  width: 14px;
  height: 14px;
  border: 0;
  border-radius: 3px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--excel-muted);
  background: transparent;
  cursor: pointer;
}

.sheet-close-btn:hover {
  color: var(--red);
  background: rgba(239, 68, 68, 0.12);
}

.sheet-rename-input {
  width: 80px;
  background: var(--excel-grid-bg);
  border: 1px solid var(--excel-green);
  border-radius: 0;
  color: var(--excel-text);
  font-size: 11px;
  font-family: 'JetBrains Mono', monospace;
  padding: 1px 4px;
  outline: none;
}

.sheet-add-popup {
  position: absolute;
  bottom: 34px;
  left: 8px;
  background: var(--excel-ribbon-tab-bg);
  border: 1px solid var(--excel-ribbon-line);
  border-radius: 6px;
  box-shadow: var(--shadow);
  padding: 8px;
  z-index: 10;
}

.sheet-add-popup input {
  width: 160px;
}
</style>
