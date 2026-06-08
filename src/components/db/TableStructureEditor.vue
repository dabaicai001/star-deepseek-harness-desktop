<script setup lang="ts">
/**
 * 可编辑表结构
 *
 * - 行内编辑列名 / 类型 / 默认值 / 注释 / 可空 / 键
 * - 每行可「应用」生成 ALTER TABLE 语句,通过 mysqlExecute 执行
 * - 可整表 DDL 预览(`SHOW CREATE TABLE` 经由 getTableDDL 拿)
 */
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import * as dbService from '@/services/db'
import type { ColumnMeta } from '@/types/db'

interface ColumnEdit extends ColumnMeta {
  // 改后状态
  newName: string
  newType: string
  newNullable: boolean
  newDefault: string
  newComment: string
  dirty: boolean
  dropped: boolean
}

const { t } = useI18n()

const props = defineProps<{
  connId: string
  db: string
  table: string
  columns: ColumnMeta[]
}>()

const emit = defineEmits<{
  reload: []
}>()

// 编辑态
const edits = ref<Map<string, ColumnEdit>>(new Map())
const executing = ref(false)
const ddlPreview = ref<string | null>(null)
const error = ref<string | null>(null)
const successMsg = ref<string | null>(null)

// 新增列(未提交到 edits,等用户填完再加入)
const addingColumn = ref(false)
const newCol = ref<ColumnEdit>({
  name: '', newName: '', type: '', newType: 'VARCHAR(255)',
  dataType: '', nullable: 'YES', newNullable: true,
  key: '', defaultValue: null, newDefault: '',
  extra: '', comment: '', newComment: '',
  ordinalPosition: 0, dirty: true, dropped: false
})

// 每次 columns 变化(切换表)都重置
watch(() => [props.db, props.table, props.columns], () => {
  edits.value = new Map(
    props.columns.map(c => [
      c.name,
      {
        ...c,
        newName: c.name,
        newType: c.type,
        newNullable: c.nullable === 'YES',
        newDefault: c.defaultValue ?? '',
        newComment: c.comment ?? '',
        dirty: false,
        dropped: false
      }
    ])
  )
  ddlPreview.value = null
  error.value = null
  successMsg.value = null
}, { immediate: true, deep: true })

const editList = computed(() => Array.from(edits.value.values()))

function markDirty(col: ColumnEdit) {
  col.dirty =
    col.newName !== col.name ||
    col.newType !== col.type ||
    col.newNullable !== (col.nullable === 'YES') ||
    col.newDefault !== (col.defaultValue ?? '') ||
    col.newComment !== (col.comment ?? '')
}

function dropColumn(col: ColumnEdit) {
  col.dropped = !col.dropped
  col.dirty = col.dropped || col.dirty
}

function resetColumn(col: ColumnEdit) {
  col.newName = col.name
  col.newType = col.type
  col.newNullable = col.nullable === 'YES'
  col.newDefault = col.defaultValue ?? ''
  col.newComment = col.comment ?? ''
  col.dropped = false
  col.dirty = false
}

function startAddColumn() {
  addingColumn.value = true
  newCol.value = {
    name: '', newName: '', type: '', newType: 'VARCHAR(255)',
    dataType: '', nullable: 'YES', newNullable: true,
    key: '', defaultValue: null, newDefault: '',
    extra: '', comment: '', newComment: '',
    ordinalPosition: 0, dirty: true, dropped: false
  }
}

function confirmAddColumn() {
  if (!newCol.value.newName.trim()) return
  const colName = newCol.value.newName.trim()
  const entry: ColumnEdit = {
    ...newCol.value,
    name: colName,
    newName: colName,
    dirty: true,
    dropped: false
  }
  edits.value.set(colName, entry)
  edits.value = new Map(edits.value)
  addingColumn.value = false
}

function cancelAddColumn() {
  addingColumn.value = false
}

// 生成 ALTER TABLE 语句(仅 dirty 的列)
function generateDDL(): string[] {
  const parts: string[] = []
  // ADD COLUMN (新增的列,不在 props.columns 中)
  const originalNames = new Set(props.columns.map(c => c.name))
  for (const col of editList.value) {
    if (!originalNames.has(col.name) && !col.dropped) {
      const typeStr = col.newType.trim()
      const nullStr = col.newNullable ? 'NULL' : 'NOT NULL'
      let defStr = ''
      if (col.newDefault !== '') {
        const isNum = /^-?\d+(\.\d+)?$/.test(col.newDefault)
        defStr = ` DEFAULT ${isNum ? col.newDefault : `'${col.newDefault.replace(/'/g, "''")}'`}`
      }
      const commentStr = col.newComment ? ` COMMENT '${col.newComment.replace(/'/g, "''")}'` : ''
      parts.push(`ADD COLUMN \`${col.newName}\` ${typeStr} ${nullStr}${defStr}${commentStr}`)
      continue
    }
  }
  // MODIFY / CHANGE / DROP
  for (const col of editList.value) {
    if (!originalNames.has(col.name)) continue // 已在上面处理
    if (col.dropped) {
      parts.push(`DROP COLUMN \`${col.name}\``)
      continue
    }
    if (!col.dirty) continue
    const typeStr = col.newType.trim()
    const nullStr = col.newNullable ? 'NULL' : 'NOT NULL'
    let defStr = ''
    if (col.newDefault !== '') {
      // 数字直接用,字符串加引号
      const isNum = /^-?\d+(\.\d+)?$/.test(col.newDefault)
      defStr = ` DEFAULT ${isNum ? col.newDefault : `'${col.newDefault.replace(/'/g, "''")}'`}`
    }
    const commentStr = col.newComment ? ` COMMENT '${col.newComment.replace(/'/g, "''")}'` : ''
    if (col.newName !== col.name) {
      parts.push(`CHANGE COLUMN \`${col.name}\` \`${col.newName}\` ${typeStr} ${nullStr}${defStr}${commentStr}`)
    } else {
      parts.push(`MODIFY COLUMN \`${col.name}\` ${typeStr} ${nullStr}${defStr}${commentStr}`)
    }
  }
  if (parts.length === 0) return []
  return [`ALTER TABLE \`${props.db}\`.\`${props.table}\`\n  ${parts.join(',\n  ')}`]
}

const pendingDDL = computed(() => generateDDL())

async function applyChanges() {
  if (!props.connId || pendingDDL.value.length === 0) return
  executing.value = true
  error.value = null
  successMsg.value = null
  try {
    for (const ddl of pendingDDL.value) {
      const r = await dbService.mysqlExecute(props.connId, ddl)
      if (r.error) throw new Error(r.error)
    }
    successMsg.value = `✓ 已应用 ${pendingDDL.value.length} 条 DDL`
    // 通知父组件重新拉表数据 + 列
    emit('reload')
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    executing.value = false
  }
}

async function loadDDLPreview() {
  if (!props.connId) return
  try {
    const r = await dbService.mysqlGetTableDDL(props.connId, props.table, props.db)
    ddlPreview.value = r.ddl
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : String(err)
  }
}
</script>

<template>
  <div class="structure-editor">
    <!-- Toolbar -->
    <div class="struct-toolbar">
      <div class="toolbar-left">
        <v-icon size="14" color="purple">mdi-table-column</v-icon>
        <span class="struct-title">{{ db }}.{{ table }}</span>
        <span class="col-count">{{ editList.length }} {{ t('db.column') }}</span>
      </div>
      <div class="toolbar-right">
        <button class="cyber-btn-secondary" @click="startAddColumn">
          <v-icon size="14">mdi-plus</v-icon>
          {{ t('db.addColumn') }}
        </button>
        <button class="cyber-btn-secondary" @click="loadDDLPreview" :title="t('db.viewDDL')">
          <v-icon size="14">mdi-code-tags</v-icon>
          {{ t('db.viewDDL') }}
        </button>
        <button
          class="cyber-btn"
          :disabled="pendingDDL.length === 0 || executing"
          @click="applyChanges"
        >
          <v-icon size="14" :class="{ spin: executing }">{{ executing ? 'mdi-loading' : 'mdi-content-save' }}</v-icon>
          {{ t('db.applyDDL') }} <span v-if="pendingDDL.length > 0" class="badge">{{ pendingDDL.length }}</span>
        </button>
      </div>
    </div>

    <div v-if="error" class="struct-message error">
      <v-icon size="14">mdi-alert-circle</v-icon>
      <span>{{ error }}</span>
    </div>
    <div v-if="successMsg" class="struct-message success">
      <v-icon size="14">mdi-check-circle</v-icon>
      <span>{{ successMsg }}</span>
    </div>

    <!-- Editable table -->
    <div class="struct-scroll">
      <!-- Inline add-column row -->
      <div v-if="addingColumn" class="add-col-form">
        <input v-model="newCol.newName" class="cell-input" placeholder="列名" autofocus />
        <input v-model="newCol.newType" class="cell-input type" placeholder="类型" />
        <label class="add-col-check"><input type="checkbox" v-model="newCol.newNullable" /> NULL</label>
        <input v-model="newCol.newDefault" class="cell-input" placeholder="默认值" />
        <input v-model="newCol.newComment" class="cell-input" placeholder="注释" />
        <div class="add-col-actions">
          <button class="action-btn-sm" :title="t('common.confirm')" @click="confirmAddColumn">
            <v-icon size="12" color="green">mdi-check</v-icon>
          </button>
          <button class="action-btn-sm" :title="t('common.cancel')" @click="cancelAddColumn">
            <v-icon size="12" color="red">mdi-close</v-icon>
          </button>
        </div>
      </div>
      <table class="struct-table">
        <thead>
          <tr>
            <th class="col-idx">#</th>
            <th>{{ t('asset.name') }}</th>
            <th>{{ t('db.column') }}</th>
            <th style="width: 70px;">NULL</th>
            <th>Key</th>
            <th>Default</th>
            <th>Comment</th>
            <th style="width: 100px;">{{ t('common.actions') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="(col, idx) in editList"
            :key="col.name"
            :class="{ dirty: col.dirty, dropped: col.dropped }"
          >
            <td class="col-idx">{{ idx + 1 }}</td>
            <td>
              <input v-model="col.newName" class="cell-input" :class="{ dirty: col.newName !== col.name }" @input="markDirty(col)" />
            </td>
            <td>
              <input v-model="col.newType" class="cell-input type" :class="{ dirty: col.newType !== col.type }" @input="markDirty(col)" />
            </td>
            <td class="col-center">
              <input type="checkbox" v-model="col.newNullable" :class="{ dirty: col.newNullable !== (col.nullable === 'YES') }" @change="markDirty(col)" />
            </td>
            <td>
              <span v-if="col.key" class="key-badge" :class="col.key.toLowerCase()">{{ col.key }}</span>
              <span v-else class="muted">-</span>
            </td>
            <td>
              <input v-model="col.newDefault" class="cell-input" :class="{ dirty: col.newDefault !== (col.defaultValue ?? '') }" @input="markDirty(col)" placeholder="NULL" />
            </td>
            <td>
              <input v-model="col.newComment" class="cell-input" :class="{ dirty: col.newComment !== (col.comment ?? '') }" @input="markDirty(col)" />
            </td>
            <td class="col-actions">
              <button
                class="action-btn-sm"
                :title="t('common.reset')"
                :disabled="!col.dirty"
                @click="resetColumn(col)"
              >
                <v-icon size="12">mdi-restore</v-icon>
              </button>
              <button
                class="action-btn-sm danger"
                :title="t('db.dropColumn')"
                :class="{ active: col.dropped }"
                @click="dropColumn(col)"
              >
                <v-icon size="12">mdi-delete-outline</v-icon>
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- DDL Preview -->
    <div v-if="ddlPreview || pendingDDL.length > 0" class="ddl-preview">
      <div class="ddl-label">
        <v-icon size="12">mdi-code-braces</v-icon>
        {{ t('db.generatedDDL') }}
      </div>
      <pre v-if="pendingDDL.length > 0">{{ pendingDDL.join(';\n') }};</pre>
      <pre v-else>{{ ddlPreview }}</pre>
    </div>
  </div>
</template>

<style scoped>
.structure-editor {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}

.struct-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-bottom: 1px solid var(--line);
  background: var(--panel-solid);
  flex-shrink: 0;
  gap: 8px;
}

.toolbar-left {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--text-2);
  min-width: 0;
}

.struct-title {
  font-family: 'JetBrains Mono', monospace;
  color: var(--text);
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.col-count {
  font-size: 11px;
  color: var(--muted);
  font-family: 'JetBrains Mono', monospace;
}

.toolbar-right {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.badge {
  display: inline-block;
  min-width: 18px;
  height: 16px;
  line-height: 16px;
  padding: 0 5px;
  margin-left: 4px;
  background: var(--cyan);
  color: var(--bg);
  border-radius: 8px;
  font-size: 10px;
  font-weight: 700;
}

.struct-message {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  font-size: 12px;
  border-bottom: 1px solid var(--line);
}

.struct-message.error {
  background: rgba(255, 77, 109, 0.08);
  color: var(--red);
}

.struct-message.success {
  background: rgba(0, 255, 136, 0.08);
  color: var(--green);
}

.struct-scroll {
  flex: 1;
  overflow: auto;
  min-height: 0;
}

.struct-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  font-family: 'JetBrains Mono', monospace;
}

.struct-table thead {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--panel-solid-2);
}

.struct-table th {
  text-align: left;
  padding: 6px 10px;
  font-size: 10px;
  font-weight: 700;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  border-bottom: 1px solid var(--line-2);
}

.col-idx {
  width: 40px;
  text-align: right;
  color: var(--muted);
  font-size: 10px;
}

.col-center {
  text-align: center;
}

.col-actions {
  display: flex;
  gap: 4px;
  justify-content: center;
}

.struct-table td {
  padding: 4px 6px;
  border-bottom: 1px solid var(--line);
  vertical-align: middle;
}

.struct-table tr:hover td {
  background: rgba(0, 240, 255, 0.03);
}

.struct-table tr.dirty td {
  background: rgba(255, 213, 79, 0.04);
}

.struct-table tr.dropped td {
  opacity: 0.4;
  text-decoration: line-through;
}

.cell-input {
  width: 100%;
  padding: 4px 6px;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 3px;
  color: var(--text);
  font-family: 'JetBrains Mono', monospace;
  font-size: 12px;
  outline: none;
  transition: all 0.15s;
}

.cell-input:hover {
  border-color: var(--line-2);
}

.cell-input:focus {
  border-color: var(--cyan);
  background: rgba(0, 240, 255, 0.05);
}

.cell-input.dirty {
  border-color: rgba(255, 213, 79, 0.4);
  background: rgba(255, 213, 79, 0.06);
}

.cell-input.type {
  color: var(--purple);
}

input[type="checkbox"] {
  cursor: pointer;
  accent-color: var(--cyan);
}

input[type="checkbox"].dirty {
  outline: 1px solid rgba(255, 213, 79, 0.4);
  outline-offset: 1px;
}

.action-btn-sm {
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--line-2);
  background: transparent;
  color: var(--text-2);
  cursor: pointer;
  border-radius: 4px;
  transition: all 0.15s;
}

.action-btn-sm:hover:not(:disabled) {
  border-color: var(--cyan);
  color: var(--cyan);
}

.action-btn-sm.danger:hover {
  border-color: var(--red);
  color: var(--red);
}

.action-btn-sm.danger.active {
  background: rgba(255, 77, 109, 0.15);
  border-color: var(--red);
  color: var(--red);
}

.action-btn-sm:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.muted {
  color: var(--muted);
}

.ddl-preview {
  border-top: 1px solid var(--line-2);
  background: rgba(5, 8, 16, 0.6);
  flex-shrink: 0;
  max-height: 35%;
  overflow: auto;
}

.ddl-label {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 12px;
  font-size: 10px;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-weight: 600;
  border-bottom: 1px solid var(--line);
  position: sticky;
  top: 0;
  background: var(--panel-solid);
}

.ddl-preview pre {
  margin: 0;
  padding: 10px 14px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  color: var(--cyan);
  white-space: pre-wrap;
  word-break: break-all;
  line-height: 1.5;
}

.spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.add-col-form {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  background: rgba(0, 240, 255, 0.04);
  border-bottom: 1px solid var(--line-2);
}

.add-col-form .cell-input {
  flex: 1;
  min-width: 0;
}

.add-col-form .cell-input.type {
  max-width: 140px;
}

.add-col-check {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--text-2);
  white-space: nowrap;
  cursor: pointer;
}

.add-col-actions {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}
</style>
