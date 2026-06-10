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

interface ZSetEntry {
  member: string
  score: number
  originalMember: string
  originalScore: number
}

const entries = ref<ZSetEntry[]>([])
const newMember = ref('')
const newScore = ref<number | string>('')
const sortAsc = ref(true)
const loading = ref(false)
const saving = ref(false)
const error = ref('')

const sortedEntries = computed(() => {
  const list = [...entries.value]
  list.sort((a, b) => sortAsc.value ? a.score - b.score : b.score - a.score)
  return list
})

const isDirty = computed(() =>
  entries.value.some(e => e.member !== e.originalMember || e.score !== e.originalScore)
  || entries.value.some(e => !e.originalMember && Boolean(e.member))
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
    let list: { member: string; score: number }[] = []
    if (Array.isArray(raw)) {
      for (const item of raw as unknown[]) {
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          const obj = item as Record<string, unknown>
          list.push({
            member: String(obj.member ?? obj.value ?? ''),
            score: Number(obj.score ?? 0),
          })
        } else if (Array.isArray(item) && item.length >= 2) {
          list.push({ member: String(item[0] ?? ''), score: Number(item[1] ?? 0) })
        }
      }
    }
    entries.value = list.map(e => ({ ...e, originalMember: e.member, originalScore: e.score }))
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

function addEntry() {
  const member = newMember.value.trim()
  const score = Number(newScore.value)
  if (!member || isNaN(score)) return
  entries.value.push({ member, score, originalMember: '', originalScore: 0 })
  newMember.value = ''
  newScore.value = ''
}

function removeEntry(idx: number) {
  entries.value.splice(idx, 1)
}

async function save() {
  saving.value = true
  error.value = ''
  try {
    const delRes = await dbService.redisExecute(props.connId, `DEL ${redisQuote(props.keyName)}`)
    if (delRes.error) throw new Error(delRes.error)
    if (entries.value.length > 0) {
      const args = entries.value
        .map(e => `${e.score} ${redisQuote(e.member)}`)
        .join(' ')
      const zaddRes = await dbService.redisExecute(props.connId, `ZADD ${redisQuote(props.keyName)} ${args}`)
      if (zaddRes.error) throw new Error(zaddRes.error)
    }
    entries.value = entries.value.map(e => ({ ...e, originalMember: e.member, originalScore: e.score }))
    emit('saved')
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    saving.value = false
  }
}

function revert() {
  entries.value = entries.value
    .map(e => ({ ...e, member: e.originalMember, score: e.originalScore }))
    .filter(e => e.originalMember || !props.isNew)
  error.value = ''
  if (entries.value.length === 0 && !props.isNew) load()
}

function formatScore(n: number): string {
  if (Number.isInteger(n)) return String(n)
  return n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')
}

load()
</script>

<template>
  <div class="zset-editor">
    <div class="editor-info-bar">
      <div class="info-left">
        <v-icon size="14" style="color: var(--pink)">mdi-sort-numeric-ascending</v-icon>
        <span class="info-key" :title="keyName">{{ keyName }}</span>
        <span class="cyber-badge">ZSET</span>
        <span class="info-count mono">{{ entries.length }} entries</span>
      </div>
      <div class="info-right">
        <button class="sort-toggle" @click="sortAsc = !sortAsc" :title="sortAsc ? 'Sorted asc' : 'Sorted desc'">
          <v-icon size="14">{{ sortAsc ? 'mdi-sort-ascending' : 'mdi-sort-descending' }}</v-icon>
          <span class="sort-label">{{ sortAsc ? 'Asc' : 'Desc' }}</span>
        </button>
      </div>
    </div>

    <div v-if="loading" class="editor-loading">
      <v-icon size="20" style="color: var(--muted); animation: pulse 1s infinite">mdi-loading</v-icon>
      <span>Loading...</span>
    </div>

    <div v-else-if="error && entries.length === 0" class="editor-error">
      <v-icon size="18" style="color: var(--red)">mdi-alert-circle</v-icon>
      <span>{{ error }}</span>
    </div>

    <template v-else>
      <div class="zset-table-header">
        <span class="col-member">Member</span>
        <span class="col-score">Score</span>
        <span class="col-action"></span>
      </div>

      <div class="zset-table-body">
        <div v-for="(e, idx) in sortedEntries" :key="idx" class="zset-row">
          <input class="input-cell member-cell" v-model="e.member" placeholder="member" spellcheck="false" />
          <input
            class="input-cell score-cell"
            v-model.number="e.score"
            type="number"
            step="any"
            placeholder="0"
          />
          <span class="score-preview mono">{{ formatScore(e.score) }}</span>
          <button class="row-del-btn" @click="removeEntry(entries.indexOf(e))" title="Delete">
            <v-icon size="13">mdi-delete-outline</v-icon>
          </button>
        </div>
      </div>

      <div class="zset-new-row">
        <input class="input-cell member-cell" v-model="newMember" placeholder="new member" spellcheck="false" @keyup.enter="addEntry" />
        <input
          class="input-cell score-cell"
          v-model="newScore"
          type="number"
          step="any"
          placeholder="0"
          @keyup.enter="addEntry"
        />
        <span class="score-preview"></span>
        <button class="row-add-btn" @click="addEntry" :disabled="!newMember.trim() || newScore === ''">
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
.zset-editor { flex: 1; display: flex; flex-direction: column; min-height: 0; overflow: hidden; }

.editor-info-bar {
  display: flex; align-items: center; justify-content: space-between;
  padding: 6px 12px; border-bottom: 1px solid var(--line); flex-shrink: 0;
  min-height: 36px; gap: 12px; flex-wrap: wrap;
}
.info-left { display: flex; align-items: center; gap: 8px; }
.info-key { font-family: 'JetBrains Mono', monospace; font-size: 13px; font-weight: 600; color: var(--text); max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.info-right { display: flex; align-items: center; }
.info-count { font-family: 'JetBrains Mono', monospace; font-size: 11px; color: var(--text-2); }

.sort-toggle {
  display: flex; align-items: center; gap: 4px; padding: 3px 8px;
  background: transparent; border: 1px solid var(--line-2); border-radius: 4px;
  color: var(--text-2); cursor: pointer; font-size: 11px;
  font-family: 'Outfit', sans-serif; transition: all 0.2s;
}
.sort-toggle:hover { border-color: var(--cyan); color: var(--cyan); background: var(--hover-cyan); }
.sort-label { font-size: 10px; font-weight: 600; }

.editor-loading {
  flex: 1; display: flex; align-items: center; justify-content: center; gap: 8px;
  color: var(--muted); font-size: 13px;
}
.editor-error {
  flex: 1; display: flex; align-items: center; justify-content: center; gap: 8px;
  color: var(--red); font-size: 13px; padding: 0 24px; text-align: center;
}

.zset-table-header {
  display: flex; align-items: center; gap: 6px; padding: 6px 12px;
  border-bottom: 1px solid var(--line); flex-shrink: 0;
  font-family: 'Outfit', sans-serif; font-size: 10px; font-weight: 700;
  color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em;
}
.col-member { flex: 2; min-width: 0; }
.col-score { flex: 1; min-width: 0; }
.col-action { width: 80px; flex-shrink: 0; }

.zset-table-body { flex: 1; overflow-y: auto; overflow-x: hidden; padding: 4px 0; }

.zset-row {
  display: flex; align-items: center; gap: 6px; padding: 4px 12px;
  transition: all 0.2s;
}
.zset-row:hover { background: var(--hover-cyan-faint); }

.input-cell {
  background: var(--bg-input); border: 1px solid var(--line-2); border-radius: 4px;
  color: var(--text); font-family: 'JetBrains Mono', monospace; font-size: 12px;
  padding: 5px 8px; outline: none; min-width: 0;
  transition: border-color 0.2s;
}
.input-cell:focus { border-color: var(--cyan); }
.member-cell { flex: 2; }
.score-cell { flex: 1; }

.score-preview {
  width: 60px; text-align: right; font-size: 11px; color: var(--muted); flex-shrink: 0;
}

.row-del-btn {
  width: 28px; height: 28px; border-radius: 4px; border: 1px solid transparent;
  background: transparent; color: var(--muted); cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  transition: all 0.2s; flex-shrink: 0;
}
.row-del-btn:hover { color: var(--red); background: rgba(255, 77, 109, 0.1); border-color: rgba(255, 77, 109, 0.3); }

.zset-new-row {
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
