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

interface SetMember {
  value: string
  originalValue: string
}

const members = ref<SetMember[]>([])
const newMember = ref('')
const searchFilter = ref('')
const loading = ref(false)
const saving = ref(false)
const error = ref('')

const filteredMembers = computed(() => {
  if (!searchFilter.value) return members.value
  const filter = searchFilter.value.toLowerCase()
  return members.value.filter(m => m.value.toLowerCase().includes(filter))
})

const isDirty = computed(() =>
  members.value.some(m => m.value !== m.originalValue)
  || members.value.filter(m => m.originalValue).length !== members.value.length
  || members.value.filter(m => m.originalValue).length !== (filteredMembers.value.length > 0
    ? members.value.filter(m => !m.originalValue).length + members.value.filter(m => m.originalValue).length
    : members.value.filter(m => m.originalValue).length)
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
    members.value = list.map(v => ({ value: v, originalValue: v }))
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

function addMember() {
  const v = newMember.value.trim()
  if (!v) return
  if (members.value.some(m => m.value === v)) return
  members.value.push({ value: v, originalValue: '' })
  newMember.value = ''
}

function removeMember(idx: number) {
  members.value.splice(idx, 1)
}

async function save() {
  saving.value = true
  error.value = ''
  try {
    const delRes = await dbService.redisExecute(props.connId, `DEL ${redisQuote(props.keyName)}`)
    if (delRes.error) throw new Error(delRes.error)
    if (members.value.length > 0) {
      const quoted = members.value.map(m => redisQuote(m.value)).join(' ')
      const saddRes = await dbService.redisExecute(props.connId, `SADD ${redisQuote(props.keyName)} ${quoted}`)
      if (saddRes.error) throw new Error(saddRes.error)
    }
    members.value = members.value.map(m => ({ ...m, originalValue: m.value }))
    emit('saved')
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    saving.value = false
  }
}

function revert() {
  members.value = members.value.map(m => ({ ...m, value: m.originalValue })).filter(m => m.originalValue || !props.isNew)
  error.value = ''
  if (members.value.length === 0 && !props.isNew) load()
}

load()
</script>

<template>
  <div class="set-editor">
    <div class="editor-info-bar">
      <div class="info-left">
        <v-icon size="14" style="color: var(--yellow)">mdi-set-center</v-icon>
        <span class="info-key" :title="keyName">{{ keyName }}</span>
        <span class="cyber-badge">SET</span>
        <span class="info-count mono">{{ members.length }} members</span>
      </div>
    </div>

    <div v-if="loading" class="editor-loading">
      <v-icon size="20" style="color: var(--muted); animation: pulse 1s infinite">mdi-loading</v-icon>
      <span>Loading...</span>
    </div>

    <div v-else-if="error && members.length === 0" class="editor-error">
      <v-icon size="18" style="color: var(--red)">mdi-alert-circle</v-icon>
      <span>{{ error }}</span>
    </div>

    <template v-else>
      <div class="set-search">
        <v-icon size="14" style="color: var(--muted)">mdi-magnify</v-icon>
        <input
          class="filter-input"
          v-model="searchFilter"
          placeholder="Filter members..."
          spellcheck="false"
        />
        <span v-if="searchFilter" class="filter-count mono">{{ filteredMembers.length }}/{{ members.length }}</span>
      </div>

      <div class="set-body">
        <div v-for="(m, idx) in filteredMembers" :key="idx" class="set-row">
          <v-icon size="12" style="color: var(--muted); flex-shrink: 0">mdi-circle-small</v-icon>
          <input class="input-cell" v-model="m.value" placeholder="member" spellcheck="false" />
          <button class="row-del-btn" @click="removeMember(members.indexOf(m))" title="Delete">
            <v-icon size="13">mdi-delete-outline</v-icon>
          </button>
        </div>
      </div>

      <div class="set-new-row">
        <v-icon size="12" style="color: var(--muted); flex-shrink: 0; opacity: 0.4">mdi-plus-circle</v-icon>
        <input class="input-cell" v-model="newMember" placeholder="new member" spellcheck="false" @keyup.enter="addMember" />
        <button class="row-add-btn" @click="addMember" :disabled="!newMember.trim()">
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
.set-editor { flex: 1; display: flex; flex-direction: column; min-height: 0; overflow: hidden; }

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

.set-search {
  display: flex; align-items: center; gap: 8px; padding: 6px 12px;
  border-bottom: 1px solid var(--line); flex-shrink: 0;
}
.filter-input {
  flex: 1; background: transparent; border: none; outline: none;
  color: var(--text); font-size: 12px; font-family: 'JetBrains Mono', monospace;
}
.filter-input::placeholder { color: var(--muted); }
.filter-count { font-size: 10px; color: var(--cyan); flex-shrink: 0; }

.set-body { flex: 1; overflow-y: auto; overflow-x: hidden; padding: 4px 0; }

.set-row {
  display: flex; align-items: center; gap: 6px; padding: 4px 12px;
  transition: all 0.2s;
}
.set-row:hover { background: var(--hover-cyan-faint); }

.input-cell {
  flex: 1; background: var(--bg-input); border: 1px solid var(--line-2); border-radius: 4px;
  color: var(--text); font-family: 'JetBrains Mono', monospace; font-size: 12px;
  padding: 5px 8px; outline: none; min-width: 0;
  transition: border-color 0.2s;
}
.input-cell:focus { border-color: var(--cyan); }

.row-del-btn {
  width: 28px; height: 28px; border-radius: 4px; border: 1px solid transparent;
  background: transparent; color: var(--muted); cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  transition: all 0.2s; flex-shrink: 0;
}
.row-del-btn:hover { color: var(--red); background: rgba(255, 77, 109, 0.1); border-color: rgba(255, 77, 109, 0.3); }

.set-new-row {
  display: flex; align-items: center; gap: 6px; padding: 4px 12px;
  border-top: 1px solid var(--line); flex-shrink: 0;
}
.row-add-btn {
  width: 28px; height: 28px; border-radius: 4px; border: 1px solid transparent;
  background: transparent; color: var(--cyan); cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  transition: all 0.2s; flex-shrink: 0;
}
.row-add-btn:hover:not(:disabled) { background: var(--hover-cyan); border-color: var(--line-2); }
.row-add-btn:disabled { opacity: 0.3; cursor: default; }

.editor-footer {
  display: flex; align-items: center; justify-content: flex-end; gap: 8px;
  padding: 8px 12px; border-top: 1px solid var(--line); flex-shrink: 0;
  background: var(--panel-solid); min-height: 40px;
}
.footer-spacer { flex: 1; }
.footer-error { font-size: 11px; color: var(--red); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mono { font-family: 'JetBrains Mono', monospace; }
</style>
