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
  height: 32px;
  background: var(--panel-solid);
  border-top: 1px solid var(--line);
  display: flex;
  align-items: center;
  padding: 0 8px;
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
  padding: 2px 14px;
  font-size: 11px;
  color: var(--text-2);
  background: transparent;
  border: 1px solid var(--line);
  border-bottom: none;
  border-radius: 4px 4px 0 0;
  cursor: pointer;
  white-space: nowrap;
  font-family: 'JetBrains Mono', monospace;
  transition: all 0.15s;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.sheet-tab:hover {
  background: rgba(0, 240, 255, 0.05);
  color: var(--text);
}

.sheet-tab.active {
  background: var(--bg);
  color: var(--cyan);
  border-color: var(--cyan);
  border-bottom: 2px solid var(--cyan);
}

.sheet-add-btn {
  width: 24px;
  height: 24px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--muted);
  background: transparent;
  border: 1px solid transparent;
  cursor: pointer;
  flex-shrink: 0;
}

.sheet-add-btn:hover {
  background: rgba(0, 240, 255, 0.08);
  color: var(--cyan);
  border-color: var(--line-2);
}

.sheet-close-btn {
  width: 14px;
  height: 14px;
  border: 0;
  border-radius: 3px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--muted);
  background: transparent;
  cursor: pointer;
}

.sheet-close-btn:hover {
  color: var(--red);
  background: var(--danger-hover-bg);
}

.sheet-rename-input {
  width: 80px;
  background: var(--bg-input);
  border: 1px solid var(--cyan);
  border-radius: 3px;
  color: var(--text);
  font-size: 11px;
  font-family: 'JetBrains Mono', monospace;
  padding: 1px 4px;
  outline: none;
}

.sheet-add-popup {
  position: absolute;
  bottom: 34px;
  left: 8px;
  background: var(--panel-solid);
  border: 1px solid var(--line-2);
  border-radius: 6px;
  padding: 8px;
  z-index: 10;
}

.sheet-add-popup input {
  width: 160px;
}
</style>
