<script setup lang="ts">
import { ref, watch, computed } from 'vue'
import * as dbService from '@/services/db'

const props = defineProps<{
  connId: string
  keyName: string
  keyType: string
  isNew: boolean
}>()

const emit = defineEmits<{
  dirty: [value: boolean]
  saved: []
}>()

interface ListItem {
  value: string
  originalValue: string
}

const items = ref<ListItem[]>([])
const newItem = ref('')
const loading = ref(false)
const saving = ref(false)
const error = ref('')

const isDirty = computed(() =>
  items.value.length !== items.value.filter(i => i.value === i.originalValue).length
  || items.value.some(i => i.value !== i.originalValue)
)
watch(isDirty, (v) => emit('dirty', v))

function redisQuote(s: string): string {
  if (/^[a-zA-Z0-9._\-:@]+$/.test(s)) return s
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const result = await dbService.redisGetValue(props.connId, props.keyName)
    const raw = result.value
    let list: string[] = []
    if (Array.isArray(raw)) {
      list = (raw as unknown[]).map(v => String(v ?? ''))
    }
    items.value = list.map(v => ({ value: v, originalValue: v }))
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

function addItem() {
  const v = newItem.value.trim()
  if (v === '' && v !== undefined) return
  items.value.push({ value: newItem.value, originalValue: '' })
  newItem.value = ''
}

function removeItem(idx: number) {
  items.value.splice(idx, 1)
}

function moveUp(idx: number) {
  if (idx <= 0) return
  const temp = items.value[idx]
  items.value[idx] = items.value[idx - 1]
  items.value[idx - 1] = temp
}

function moveDown(idx: number) {
  if (idx >= items.value.length - 1) return
  const temp = items.value[idx]
  items.value[idx] = items.value[idx + 1]
  items.value[idx + 1] = temp
}

async function save() {
  saving.value = true
  error.value = ''
  try {
    const delRes = await dbService.redisExecute(props.connId, `DEL ${redisQuote(props.keyName)}`)
    if (delRes.error) throw new Error(delRes.error)
    if (items.value.length > 0) {
      const quoted = items.value.map(i => redisQuote(i.value)).join(' ')
      const rpushRes = await dbService.redisExecute(props.connId, `RPUSH ${redisQuote(props.keyName)} ${quoted}`)
      if (rpushRes.error) throw new Error(rpushRes.error)
    }
    items.value = items.value.map(i => ({ ...i, originalValue: i.value }))
    emit('saved')
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    saving.value = false
  }
}

function revert() {
  items.value = items.value.map(i => ({ ...i, value: i.originalValue })).filter(i => i.originalValue || !props.isNew)
  error.value = ''
  if (items.value.length === 0 && !props.isNew) load()
}

load()
</script>

<template>
  <div class="list-editor">
    <div class="editor-info-bar">
      <div class="info-left">
        <v-icon size="14" style="color: var(--cyan)">mdi-format-list-bulleted</v-icon>
        <span class="info-key" :title="keyName">{{ keyName }}</span>
        <span class="cyber-badge">LIST</span>
        <span class="info-count mono">{{ items.length }} items</span>
      </div>
    </div>

    <div v-if="loading" class="editor-loading">
      <v-icon size="20" style="color: var(--muted); animation: pulse 1s infinite">mdi-loading</v-icon>
      <span>Loading...</span>
    </div>

    <div v-else-if="error && items.length === 0" class="editor-error">
      <v-icon size="18" style="color: var(--red)">mdi-alert-circle</v-icon>
      <span>{{ error }}</span>
    </div>

    <template v-else>
      <div class="list-body">
        <div v-for="(item, idx) in items" :key="idx" class="list-row">
          <span class="row-index mono">{{ idx }}</span>
          <input class="input-cell" v-model="item.value" placeholder="value" spellcheck="false" />
          <button class="row-action-btn" @click="moveUp(idx)" :disabled="idx === 0" title="Move up">
            <v-icon size="12">mdi-chevron-up</v-icon>
          </button>
          <button class="row-action-btn" @click="moveDown(idx)" :disabled="idx === items.length - 1" title="Move down">
            <v-icon size="12">mdi-chevron-down</v-icon>
          </button>
          <button class="row-del-btn" @click="removeItem(idx)" title="Delete">
            <v-icon size="13">mdi-delete-outline</v-icon>
          </button>
        </div>
      </div>

      <div class="list-new-row">
        <span class="row-index mono" style="opacity: 0.4">+</span>
        <input class="input-cell" v-model="newItem" placeholder="new item" spellcheck="false" @keyup.enter="addItem" />
        <button class="row-add-btn" @click="addItem">
          <v-icon size="14">mdi-plus</v-icon>
        </button>
      </div>
    </template>

    <div class="editor-footer">
      <span v-if="error" class="footer-error">{{ error }}</span>
      <span v-else class="footer-spacer"></span>
      <button class="cyber-btn-secondary" @click="revert" :disabled="!isDirty">Revert</button>
      <button class="cyber-btn" @click="save" :disabled="!isDirty || saving">
        <v-icon v-if="saving" size="14" style="animation: pulse 1s infinite">mdi-loading</v-icon>
        <v-icon v-else size="14">mdi-content-save</v-icon>
        Save
      </button>
    </div>
  </div>
</template>

<style scoped>
.list-editor { flex: 1; display: flex; flex-direction: column; min-height: 0; overflow: hidden; }

.editor-info-bar {
  display: flex; align-items: center; justify-content: space-between;
  padding: 6px 12px; border-bottom: 1px solid var(--line); flex-shrink: 0;
  min-height: 36px; gap: 12px;
}
.info-left { display: flex; align-items: center; gap: 8px; }
.info-key { font-family: 'JetBrains Mono', monospace; font-size: 13px; font-weight: 600; color: var(--text); max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.info-count { font-family: 'JetBrains Mono', monospace; font-size: 11px; color: var(--text-2); }

.editor-loading {
  flex: 1; display: flex; align-items: center; justify-content: center; gap: 8px;
  color: var(--muted); font-size: 13px;
}
.editor-error {
  flex: 1; display: flex; align-items: center; justify-content: center; gap: 8px;
  color: var(--red); font-size: 13px; padding: 0 24px; text-align: center;
}

.list-body { flex: 1; overflow-y: auto; overflow-x: hidden; padding: 4px 0; }

.list-row {
  display: flex; align-items: center; gap: 6px; padding: 4px 12px;
  transition: all 0.2s;
}
.list-row:hover { background: var(--hover-cyan-faint); }

.row-index {
  width: 32px; text-align: right; font-size: 11px; color: var(--muted); flex-shrink: 0;
}

.input-cell {
  flex: 1; background: var(--bg-input); border: 1px solid var(--line-2); border-radius: 4px;
  color: var(--text); font-family: 'JetBrains Mono', monospace; font-size: 12px;
  padding: 5px 8px; outline: none; min-width: 0;
  transition: border-color 0.2s;
}
.input-cell:focus { border-color: var(--cyan); }

.row-action-btn {
  width: 24px; height: 24px; border-radius: 3px; border: 1px solid transparent;
  background: transparent; color: var(--muted); cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  transition: all 0.2s; flex-shrink: 0;
}
.row-action-btn:hover:not(:disabled) { color: var(--cyan); background: var(--hover-cyan); }
.row-action-btn:disabled { opacity: 0.25; cursor: default; }

.row-del-btn {
  width: 28px; height: 28px; border-radius: 4px; border: 1px solid transparent;
  background: transparent; color: var(--muted); cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  transition: all 0.2s; flex-shrink: 0;
}
.row-del-btn:hover { color: var(--red); background: rgba(255, 77, 109, 0.1); border-color: rgba(255, 77, 109, 0.3); }

.list-new-row {
  display: flex; align-items: center; gap: 6px; padding: 4px 12px;
  border-top: 1px solid var(--line); flex-shrink: 0;
}
.row-add-btn {
  width: 28px; height: 28px; border-radius: 4px; border: 1px solid transparent;
  background: transparent; color: var(--cyan); cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  transition: all 0.2s; flex-shrink: 0;
}
.row-add-btn:hover { background: var(--hover-cyan); border-color: var(--line-2); }

.editor-footer {
  display: flex; align-items: center; justify-content: flex-end; gap: 8px;
  padding: 8px 12px; border-top: 1px solid var(--line); flex-shrink: 0;
  background: var(--panel-solid); min-height: 40px;
}
.footer-spacer { flex: 1; }
.footer-error { font-size: 11px; color: var(--red); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mono { font-family: 'JetBrains Mono', monospace; }
</style>
