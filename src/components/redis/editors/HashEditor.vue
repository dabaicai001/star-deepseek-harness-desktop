<script setup lang="ts">
import { ref, watch, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import * as dbService from '@/services/db'

const { t } = useI18n()

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

interface HashField {
  field: string
  value: string
  originalField: string
  originalValue: string
  deleted?: boolean
}

const fields = ref<HashField[]>([])
const newFieldName = ref('')
const newFieldValue = ref('')
const loading = ref(false)
const saving = ref(false)
const ttl = ref(-1)
const ttlInput = ref('')
const error = ref('')
const fieldCount = ref(0)

const isDirty = computed(() => {
  return fields.value.some(f =>
    f.deleted || f.field !== f.originalField || f.value !== f.originalValue
  )
})
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
    let entries: [string, string][] = []
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      entries = Object.entries(raw as Record<string, unknown>).map(
        ([k, v]) => [k, String(v ?? '')] as [string, string]
      )
    } else if (Array.isArray(raw)) {
      entries = (raw as Array<[string, unknown]>)
        .filter(item => Array.isArray(item) && item.length >= 2)
        .map(item => [String(item[0] ?? ''), String(item[1] ?? '')] as [string, string])
    }
    fields.value = entries.map(([field, val]) => ({
      field, value: val, originalField: field, originalValue: val
    }))
    fieldCount.value = fields.value.length
    ttl.value = result.ttl ?? -1
    ttlInput.value = ttl.value === -1 ? '' : String(ttl.value)
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

function addField() {
  const name = newFieldName.value.trim()
  if (!name) return
  fields.value.push({ field: name, value: newFieldValue.value, originalField: '', originalValue: '' })
  newFieldName.value = ''
  newFieldValue.value = ''
  fieldCount.value = fields.value.filter(f => !f.deleted).length
}

function removeField(idx: number) {
  if (fields.value[idx].originalField) {
    fields.value[idx].deleted = true
  } else {
    fields.value.splice(idx, 1)
  }
  fieldCount.value = fields.value.filter(f => !f.deleted).length
}

async function save() {
  saving.value = true
  error.value = ''
  try {
    const toDelete = fields.value.filter(f => f.deleted && f.originalField)
    const toSet = fields.value.filter(f => !f.deleted && (f.field !== f.originalField || f.value !== f.originalValue || !f.originalField))
    const toDeleteOriginal = fields.value.filter(f => f.deleted && !f.originalField)

    if (toDelete.length > 0) {
      const hdelCmd = `HDEL ${redisQuote(props.keyName)} ${toDelete.map(f => redisQuote(f.originalField)).join(' ')}`
      const res = await dbService.redisExecute(props.connId, hdelCmd)
      if (res.error) throw new Error(res.error)
    }
    if (toDeleteOriginal.length > 0) {
      fields.value = fields.value.filter(f => !(f.deleted && !f.originalField))
    }
    if (toSet.length > 0) {
      const args = toSet.flatMap(f => [redisQuote(f.field), redisQuote(f.value)]).join(' ')
      const hsetCmd = `HSET ${redisQuote(props.keyName)} ${args}`
      const res = await dbService.redisExecute(props.connId, hsetCmd)
      if (res.error) throw new Error(res.error)
    }

    fields.value = fields.value.filter(f => !f.deleted).map(f => ({
      ...f, originalField: f.field, originalValue: f.value
    }))
    fieldCount.value = fields.value.length
    if (ttlInput.value) ttl.value = Number(ttlInput.value)
    emit('saved')
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    saving.value = false
  }
}

function revert() {
  fields.value = fields.value
    .filter(f => f.originalField || !f.deleted)
    .map(f => ({
      ...f,
      field: f.originalField || f.field,
      value: f.originalValue || f.value,
      deleted: false,
    }))
  if (fields.value.length === 0 && !props.isNew) load()
  error.value = ''
  fieldCount.value = fields.value.filter(f => !f.deleted).length
}

load()
</script>

<template>
  <div class="hash-editor">
    <div class="editor-info-bar">
      <div class="info-left">
        <v-icon size="14" style="color: var(--purple)">mdi-pound</v-icon>
        <span class="info-key" :title="keyName">{{ keyName }}</span>
        <span class="cyber-badge">HASH</span>
        <span class="info-count mono">{{ t('redis.fieldsCount', { count: fieldCount }) }}</span>
      </div>
      <div class="info-right">
        <span class="info-item">
          <span class="info-label">TTL</span>
          <input class="ttl-input" v-model="ttlInput" :placeholder="ttl === -1 ? t('redis.ttlPersist') : String(ttl)" type="number" style="width: 80px" />
        </span>
      </div>
    </div>

    <div v-if="loading" class="editor-loading">
      <v-icon size="20" style="color: var(--muted); animation: pulse 1s infinite">mdi-loading</v-icon>
      <span>{{ t('redis.loading') }}</span>
    </div>

    <div v-else-if="error && fields.length === 0" class="editor-error">
      <v-icon size="18" style="color: var(--red)">mdi-alert-circle</v-icon>
      <span>{{ error }}</span>
    </div>

    <template v-else>
      <div class="hash-table-header">
        <span class="col-field">{{ t('redis.colField') }}</span>
        <span class="col-value">{{ t('redis.colValue') }}</span>
        <span class="col-action"></span>
      </div>

      <div class="hash-table-body">
        <div
          v-for="(f, idx) in fields"
          :key="idx"
          class="hash-row"
          :class="{ deleted: f.deleted }"
        >
          <input
            class="input-cell field-cell"
            v-model="f.field"
            :disabled="f.deleted"
            :placeholder="t('redis.fieldPlaceholder')"
            spellcheck="false"
          />
          <input
            class="input-cell value-cell"
            v-model="f.value"
            :disabled="f.deleted"
            :placeholder="t('redis.valueCellPlaceholder')"
            spellcheck="false"
          />
          <button class="row-del-btn" @click="removeField(idx)" :title="f.deleted ? t('redis.undoDelete') : t('redis.delete')">
            <v-icon size="13">{{ f.deleted ? 'mdi-undo' : 'mdi-delete-outline' }}</v-icon>
          </button>
        </div>
      </div>

      <div class="hash-new-row">
        <input class="input-cell field-cell" v-model="newFieldName" :placeholder="t('redis.newField')" spellcheck="false" @keyup.enter="addField" />
        <input class="input-cell value-cell" v-model="newFieldValue" :placeholder="t('redis.valueCellPlaceholder')" spellcheck="false" @keyup.enter="addField" />
        <button class="row-add-btn" @click="addField" :disabled="!newFieldName.trim()">
          <v-icon size="14">mdi-plus</v-icon>
        </button>
      </div>
    </template>

    <div class="editor-footer">
      <span v-if="error" class="footer-error">{{ error }}</span>
      <span v-else class="footer-spacer"></span>
      <button class="cyber-btn-secondary" @click="revert" :disabled="!isDirty">{{ t('redis.revert') }}</button>
      <button class="cyber-btn" @click="save" :disabled="!isDirty || saving">
        <v-icon v-if="saving" size="14" style="animation: pulse 1s infinite">mdi-loading</v-icon>
        <v-icon v-else size="14">mdi-content-save</v-icon>
        {{ t('common.save') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.hash-editor { flex: 1; display: flex; flex-direction: column; min-height: 0; overflow: hidden; }

.editor-info-bar {
  display: flex; align-items: center; justify-content: space-between;
  padding: 6px 12px; border-bottom: 1px solid var(--line); flex-shrink: 0;
  min-height: 36px; gap: 12px; flex-wrap: wrap;
}
.info-left { display: flex; align-items: center; gap: 8px; }
.info-key { font-family: 'JetBrains Mono', monospace; font-size: 13px; font-weight: 600; color: var(--text); max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.info-right { display: flex; align-items: center; gap: 16px; font-size: 11px; color: var(--text-2); }
.info-item { display: flex; align-items: center; gap: 6px; }
.info-label { font-family: 'Outfit', sans-serif; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
.info-count { font-family: 'JetBrains Mono', monospace; font-size: 11px; color: var(--text-2); }
.ttl-input {
  background: var(--bg-input); border: 1px solid var(--line-2); border-radius: 4px;
  color: var(--text); font-family: 'JetBrains Mono', monospace; font-size: 11px;
  padding: 2px 6px; width: 80px; outline: none;
}
.ttl-input:focus { border-color: var(--cyan); }

.editor-loading {
  flex: 1; display: flex; align-items: center; justify-content: center; gap: 8px;
  color: var(--muted); font-size: 13px;
}
.editor-error {
  flex: 1; display: flex; align-items: center; justify-content: center; gap: 8px;
  color: var(--red); font-size: 13px; padding: 0 24px; text-align: center;
}

.hash-table-header {
  display: flex; align-items: center; padding: 6px 12px;
  border-bottom: 1px solid var(--line); flex-shrink: 0;
  font-family: 'Outfit', sans-serif; font-size: 10px; font-weight: 700;
  color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em;
}
.col-field { flex: 1; min-width: 0; }
.col-value { flex: 2; min-width: 0; }
.col-action { width: 32px; flex-shrink: 0; }

.hash-table-body { flex: 1; overflow-y: auto; overflow-x: hidden; padding: 4px 0; }

.hash-row {
  display: flex; align-items: center; gap: 6px; padding: 4px 12px;
  transition: all 0.2s;
}
.hash-row:hover { background: var(--hover-cyan-faint); }
.hash-row.deleted { opacity: 0.35; }
.hash-row.deleted .input-cell { text-decoration: line-through; }

.input-cell {
  background: var(--bg-input); border: 1px solid var(--line-2); border-radius: 4px;
  color: var(--text); font-family: 'JetBrains Mono', monospace; font-size: 12px;
  padding: 5px 8px; outline: none; min-width: 0;
  transition: border-color 0.2s;
}
.input-cell:focus { border-color: var(--cyan); }
.field-cell { flex: 1; }
.value-cell { flex: 2; }

.hash-new-row {
  display: flex; align-items: center; gap: 6px; padding: 4px 12px;
  border-top: 1px solid var(--line); flex-shrink: 0;
}

.row-del-btn, .row-add-btn {
  width: 28px; height: 28px; border-radius: 4px; border: 1px solid transparent;
  background: transparent; color: var(--muted); cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  transition: all 0.2s; flex-shrink: 0;
}
.row-del-btn:hover { color: var(--red); background: rgba(255, 77, 109, 0.1); border-color: rgba(255, 77, 109, 0.3); }
.row-add-btn { color: var(--cyan); }
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
