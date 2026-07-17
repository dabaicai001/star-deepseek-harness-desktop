<script setup lang="ts">
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import * as dbService from '@/services/db'
import { generateAddColumnDDL, generateModifyColumnDDL } from '@/utils/ddlGenerator'
import type { ColumnMeta } from '@/types/db'

const { t } = useI18n()

const props = defineProps<{
  connId: string
  db: string
  table: string
  mode: 'create' | 'modify'
  column?: ColumnMeta
  existingColumns?: ColumnMeta[]
  modelValue: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [v: boolean]
  reload: []
}>()

const name = ref('')
const type = ref('VARCHAR(255)')
const typeOptions = ['VARCHAR(255)', 'INT', 'BIGINT', 'TINYINT', 'DECIMAL(10,2)', 'TEXT', 'LONGTEXT', 'DATETIME', 'DATE', 'BOOLEAN', 'FLOAT', 'DOUBLE', 'JSON']
const typeSearch = ref('')
const typeDropdown = ref(false)
const filteredTypes = ref([...typeOptions])

function filterTypeOptions() {
  const q = typeSearch.value.toLowerCase()
  filteredTypes.value = q ? typeOptions.filter(t => t.toLowerCase().includes(q)) : [...typeOptions]
}

function selectType(t: string) {
  type.value = t
  typeSearch.value = ''
  typeDropdown.value = false
}

function closeTypeDropdown() {
  setTimeout(() => { typeDropdown.value = false }, 150)
}

const nullable = ref(true)
const defaultValue = ref('')
const comment = ref('')
const position = ref<'LAST' | 'FIRST' | 'AFTER'>('LAST')
const afterCol = ref('')
const executing = ref(false)
const error = ref<string | null>(null)

watch(() => props.modelValue, (v) => {
  if (!v) return
  error.value = null
  typeSearch.value = ''
  typeDropdown.value = false
  if (props.mode === 'modify' && props.column) {
    name.value = props.column.name
    type.value = props.column.type
    nullable.value = props.column.nullable === 'YES'
    defaultValue.value = props.column.defaultValue ?? ''
    comment.value = props.column.comment ?? ''
  } else {
    name.value = ''
    type.value = 'VARCHAR(255)'
    nullable.value = true
    defaultValue.value = ''
    comment.value = ''
    position.value = 'LAST'
    afterCol.value = ''
  }
})

async function submit() {
  if (!name.value.trim()) return
  executing.value = true
  error.value = null
  try {
    let ddl: string
    if (props.mode === 'create') {
      ddl = generateAddColumnDDL(props.db, props.table, name.value.trim(), type.value, nullable.value, defaultValue.value, comment.value,
        position.value === 'AFTER' ? afterCol.value : undefined)
    } else {
      ddl = generateModifyColumnDDL(props.db, props.table, name.value.trim(), type.value, nullable.value, defaultValue.value, comment.value)
    }
    const r = await dbService.mysqlExecute(props.connId, ddl)
    if (r.error) throw new Error(r.error)
    emit('reload')
    emit('update:modelValue', false)
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    executing.value = false
  }
}
</script>

<template>
  <v-dialog :model-value="modelValue" @update:model-value="emit('update:modelValue', $event)" max-width="480">
    <div class="cyber-panel" style="padding: 0;">
      <div class="dialog-header">
        <v-icon size="16" color="purple">{{ mode === 'create' ? 'mdi-plus-circle' : 'mdi-pencil-circle' }}</v-icon>
        <span class="dialog-title">{{ mode === 'create' ? t('db.addColumnTitle') : t('db.modifyColumnTitle') }}</span>
        <span class="dialog-subtitle">{{ db }}.{{ table }}</span>
        <v-spacer />
        <button class="action-btn" @click="emit('update:modelValue', false)">
            <v-icon size="16">mdi-close</v-icon>
          </button>
      </div>

      <div class="dialog-body" style="padding: 16px; display: flex; flex-direction: column; gap: 12px;">
        <div v-if="error" class="dialog-error">{{ error }}</div>

        <div class="form-row">
          <label class="form-label">{{ t('db.name') }}</label>
          <input v-model="name" class="cyber-input" style="flex: 1;" placeholder="column_name" :disabled="mode === 'modify'" />
        </div>

        <div class="form-row">
          <label class="form-label">{{ t('db.type') }}</label>
          <div class="type-combobox" style="flex: 1; position: relative;">
            <input
              v-model="typeSearch"
              class="cyber-input"
              style="width: 100%;"
              :placeholder="type || 'VARCHAR(255)'"
              @focus="typeDropdown = true"
              @blur="closeTypeDropdown"
              @input="filterTypeOptions"
            />
            <div v-if="typeDropdown && filteredTypes.length > 0" class="type-dropdown">
              <div
                v-for="t in filteredTypes"
                :key="t"
                class="type-option"
                @mousedown.prevent="selectType(t)"
              >{{ t }}</div>
            </div>
          </div>
        </div>

        <div class="form-row">
          <label class="form-label">{{ t('db.nullable') }}</label>
          <input type="checkbox" v-model="nullable" />
        </div>

        <div class="form-row">
          <label class="form-label">{{ t('db.default') }}</label>
          <input v-model="defaultValue" class="cyber-input" style="flex: 1;" placeholder="NULL" />
        </div>

        <div class="form-row">
          <label class="form-label">{{ t('db.comment') }}</label>
          <input v-model="comment" class="cyber-input" style="flex: 1;" placeholder="column comment" />
        </div>

        <div v-if="mode === 'create'" class="form-row">
          <label class="form-label">{{ t('db.position') }}</label>
          <select v-model="position" class="cyber-select" style="flex: 1;">
            <option value="LAST">{{ t('db.lastDefault') }}</option>
            <option value="FIRST">{{ t('db.first') }}</option>
            <option value="AFTER">{{ t('db.after') }}</option>
          </select>
        </div>

        <div v-if="mode === 'create' && position === 'AFTER'" class="form-row">
          <label class="form-label">{{ t('db.afterColumn') }}</label>
          <select v-model="afterCol" class="cyber-select" style="flex: 1;">
            <option v-for="c in (existingColumns || [])" :key="c.name" :value="c.name">{{ c.name }}</option>
          </select>
        </div>
      </div>

      <div class="dialog-footer">
        <button class="cyber-btn-secondary" @click="emit('update:modelValue', false)">{{ t('common.cancel') }}</button>
        <button class="cyber-btn" :disabled="executing || !name.trim()" @click="submit">
          <v-icon size="14" :class="{ spin: executing }">{{ executing ? 'mdi-loading' : 'mdi-check' }}</v-icon>
          {{ mode === 'create' ? t('db.addColumnTitle') : t('db.saveChanges') }}
        </button>
      </div>
    </div>
  </v-dialog>
</template>

<style scoped>
.dialog-header {
  display: flex; align-items: center; gap: 8px;
  padding: 12px 16px; border-bottom: 1px solid var(--line); flex-shrink: 0;
}
.dialog-title { font-weight: 600; font-size: 14px; color: var(--text); }
.dialog-subtitle { font-size: 11px; color: var(--muted); font-family: 'JetBrains Mono', monospace; }
.dialog-error { padding: 8px 12px; font-size: 11px; color: var(--red); background: rgba(255,77,109,.08); border-radius: 6px; }
.dialog-footer {
  display: flex; justify-content: flex-end; gap: 8px;
  padding: 10px 16px; border-top: 1px solid var(--line); flex-shrink: 0;
}
.form-row { display: flex; align-items: center; gap: 12px; }
.form-label { width: 80px; font-size: 11px; color: var(--muted); text-align: right; text-transform: uppercase; letter-spacing: 0.06em; }
.spin { animation: spin 1s linear infinite; }
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

.type-combobox { position: relative; }
.type-dropdown {
  position: absolute; top: 100%; left: 0; right: 0; z-index: 10;
  max-height: 180px; overflow: auto;
  background: var(--panel-solid); border: 1px solid var(--line-2);
  border-radius: 4px; padding: 2px;
}
.type-option {
  padding: 4px 8px; font-size: 11px; font-family: 'JetBrains Mono', monospace;
  color: var(--text); cursor: pointer; border-radius: 2px;
}
.type-option:hover { background: var(--hover-cyan); color: var(--cyan); }
</style>
