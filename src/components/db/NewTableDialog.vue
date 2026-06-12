<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import * as dbService from '@/services/db'

const { t } = useI18n()

interface ColumnDef {
  name: string
  type: string
  nullable: boolean
  primaryKey: boolean
  defaultValue: string
  comment: string
}

const props = defineProps<{
  connId: string
  db: string
  dbType: string
  modelValue: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [v: boolean]
  created: [tableName: string]
}>()

const tableName = ref('')
const columns = ref<ColumnDef[]>([
  { name: 'id', type: 'BIGINT', nullable: false, primaryKey: true, defaultValue: '', comment: '' },
])
const engine = ref('InnoDB')
const charset = ref('utf8mb4')
const tableComment = ref('')
const creating = ref(false)
const error = ref<string | null>(null)

const canCreate = computed(() => {
  return tableName.value.trim() && columns.value.length > 0 && columns.value.every(c => c.name.trim() && c.type.trim())
})

const commonTypes = [
  'BIGINT', 'INT', 'SMALLINT', 'TINYINT',
  'VARCHAR', 'TEXT', 'LONGTEXT', 'MEDIUMTEXT',
  'DECIMAL', 'DOUBLE', 'FLOAT',
  'DATE', 'DATETIME', 'TIMESTAMP',
  'BOOLEAN', 'JSON', 'BLOB',
]

function addColumn() {
  columns.value.push({ name: '', type: 'VARCHAR', nullable: true, primaryKey: false, defaultValue: '', comment: '' })
}

function removeColumn(idx: number) {
  if (columns.value.length > 1) {
    columns.value.splice(idx, 1)
  }
}

function moveColumn(idx: number, dir: -1 | 1) {
  const newIdx = idx + dir
  if (newIdx < 0 || newIdx >= columns.value.length) return
  const tmp = columns.value[idx]
  columns.value[idx] = columns.value[newIdx]
  columns.value[newIdx] = tmp
}

async function onCreate() {
  if (!canCreate.value) return
  creating.value = true
  error.value = null

  try {
    const cols = columns.value.map(c => {
      let col = `\`${c.name}\` ${c.type}`
      if (!c.nullable) col += ' NOT NULL'
      if (c.defaultValue) col += ` DEFAULT ${c.defaultValue}`
      if (c.comment) col += ` COMMENT '${c.comment.replace(/'/g, "\\'")}'`
      return col
    })

    const pkCols = columns.value.filter(c => c.primaryKey).map(c => `\`${c.name}\``)
    if (pkCols.length > 0) {
      cols.push(`PRIMARY KEY (${pkCols.join(', ')})`)
    }

    let ddl = `CREATE TABLE \`${props.db}\`.\`${tableName.value}\` (\n  ${cols.join(',\n  ')}\n)`

    if (props.dbType === 'mysql') {
      ddl += ` ENGINE=${engine.value}`
      ddl += ` DEFAULT CHARSET=${charset.value}`
    }
    if (tableComment.value) {
      ddl += ` COMMENT='${tableComment.value.replace(/'/g, "\\'")}'`
    }

    await dbService.mysqlExecute(props.connId, ddl, props.db)
    emit('created', tableName.value)
    emit('update:modelValue', false)
    resetForm()
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    creating.value = false
  }
}

function resetForm() {
  tableName.value = ''
  columns.value = [{ name: 'id', type: 'BIGINT', nullable: false, primaryKey: true, defaultValue: '', comment: '' }]
  engine.value = 'InnoDB'
  charset.value = 'utf8mb4'
  tableComment.value = ''
  error.value = null
}

function onCancel() {
  emit('update:modelValue', false)
  resetForm()
}
</script>

<template>
  <v-dialog :model-value="modelValue" @update:model-value="emit('update:modelValue', $event)" max-width="780" persistent>
    <div class="cyber-panel" style="padding: 0;">
      <div class="dialog-header">
        <v-icon size="16" color="var(--cyan)">mdi-table-plus</v-icon>
        <span class="dialog-title">{{ t('db.newTable', '新建表') }}</span>
        <span class="dialog-subtitle">{{ db }}</span>
        <v-spacer />
        <v-btn variant="text" size="small" icon="mdi-close" @click="onCancel" />
      </div>

      <div class="dialog-body">
        <div v-if="error" class="dialog-error">{{ error }}</div>

        <div class="form-row">
          <label class="form-label">{{ t('db.tableName', '表名') }} <span class="required">*</span></label>
          <input v-model="tableName" class="cyber-input" :placeholder="t('db.tableNamePlaceholder', '请输入表名')" autofocus />
        </div>

        <div v-if="dbType === 'mysql'" class="form-row-group">
          <div class="form-row half">
            <label class="form-label">Engine</label>
            <select v-model="engine" class="cyber-input">
              <option value="InnoDB">InnoDB</option>
              <option value="MyISAM">MyISAM</option>
              <option value="Memory">Memory</option>
            </select>
          </div>
          <div class="form-row half">
            <label class="form-label">Charset</label>
            <select v-model="charset" class="cyber-input">
              <option value="utf8mb4">utf8mb4</option>
              <option value="utf8">utf8</option>
              <option value="latin1">latin1</option>
            </select>
          </div>
        </div>

        <div class="form-row">
          <label class="form-label">{{ t('db.tableComment', '表注释') }}</label>
          <input v-model="tableComment" class="cyber-input" :placeholder="t('db.tableCommentPlaceholder', '可选')" />
        </div>

        <div class="columns-section">
          <div class="columns-header">
            <span class="columns-title">{{ t('db.columns', '列定义') }}</span>
            <button class="action-btn-sm" @click="addColumn" :title="t('db.addColumnToTable', '添加列')">
              <v-icon size="12">mdi-plus</v-icon>
            </button>
          </div>

          <div class="columns-table">
            <div class="columns-row header-row">
              <span class="col-name">{{ t('db.colName', '列名') }}</span>
              <span class="col-type">{{ t('db.colType', '类型') }}</span>
              <span class="col-null">NULL</span>
              <span class="col-pk">PK</span>
              <span class="col-default">{{ t('db.colDefault', '默认值') }}</span>
              <span class="col-comment">{{ t('db.colComment', '注释') }}</span>
              <span class="col-actions"></span>
            </div>

            <div v-for="(col, idx) in columns" :key="idx" class="columns-row">
              <input v-model="col.name" class="cyber-input cell" :placeholder="t('db.colName', '列名')" />
              <select v-model="col.type" class="cyber-input cell type-select">
                <option v-for="tp in commonTypes" :key="tp" :value="tp">{{ tp }}</option>
              </select>
              <span class="cell-check">
                <input type="checkbox" v-model="col.nullable" />
              </span>
              <span class="cell-check">
                <input type="checkbox" v-model="col.primaryKey" />
              </span>
              <input v-model="col.defaultValue" class="cyber-input cell default-input" placeholder="" />
              <input v-model="col.comment" class="cyber-input cell comment-input" placeholder="" />
              <span class="cell-actions">
                <button class="action-btn-xs" @click="moveColumn(idx, -1)" :disabled="idx === 0" title="↑">
                  <v-icon size="10">mdi-chevron-up</v-icon>
                </button>
                <button class="action-btn-xs" @click="moveColumn(idx, 1)" :disabled="idx === columns.length - 1" title="↓">
                  <v-icon size="10">mdi-chevron-down</v-icon>
                </button>
                <button class="action-btn-xs danger" @click="removeColumn(idx)" :disabled="columns.length <= 1" :title="t('common.delete')">
                  <v-icon size="10">mdi-delete-outline</v-icon>
                </button>
              </span>
            </div>
          </div>
        </div>
      </div>

      <div class="dialog-footer">
        <button class="cyber-btn-secondary" @click="onCancel">{{ t('common.cancel') }}</button>
        <button class="cyber-btn" :disabled="!canCreate || creating" @click="onCreate">
          <v-icon v-if="creating" size="14" class="spin">mdi-loading</v-icon>
          <v-icon v-else size="14">mdi-check</v-icon>
          {{ t('db.create', '创建') }}
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
.dialog-body {
  padding: 16px; max-height: 65vh; overflow: auto;
}
.dialog-error {
  padding: 8px 12px; margin-bottom: 12px;
  background: rgba(255, 80, 80, 0.1); border: 1px solid rgba(255, 80, 80, 0.3);
  border-radius: 6px; color: var(--red); font-size: 12px;
}
.dialog-footer {
  display: flex; justify-content: flex-end; gap: 8px;
  padding: 10px 16px; border-top: 1px solid var(--line); flex-shrink: 0;
}

.form-row { margin-bottom: 12px; }
.form-label {
  display: block; font-size: 11px; color: var(--text-2);
  margin-bottom: 4px; font-weight: 500;
}
.required { color: var(--red); }
.form-row-group { display: flex; gap: 12px; margin-bottom: 12px; }
.form-row.half { flex: 1; margin-bottom: 0; }

.columns-section { margin-top: 16px; }
.columns-header {
  display: flex; align-items: center; justify-content: space-between;
  margin-bottom: 8px;
}
.columns-title { font-size: 12px; font-weight: 600; color: var(--text); }

.columns-table {
  border: 1px solid var(--line-2); border-radius: 8px; overflow: hidden;
}
.columns-row {
  display: grid;
  grid-template-columns: 120px 100px 40px 40px 100px 1fr 70px;
  gap: 4px; padding: 6px 8px; align-items: center;
  border-bottom: 1px solid var(--line);
}
.columns-row:last-child { border-bottom: none; }
.header-row {
  background: var(--panel-solid-2);
  font-size: 10px; color: var(--muted); font-weight: 600; text-transform: uppercase;
}
.cell {
  padding: 4px 6px !important; font-size: 11px !important;
  min-height: 28px !important; height: 28px !important;
}
.cell-check {
  display: flex; justify-content: center;
}
.cell-check input[type="checkbox"] {
  accent-color: var(--cyan);
}
.cell-actions {
  display: flex; gap: 2px; justify-content: center;
}
.action-btn-xs {
  width: 20px; height: 20px; border-radius: 4px;
  border: 1px solid var(--line); background: transparent;
  color: var(--text-2); cursor: pointer;
  display: flex; align-items: center; justify-content: center;
}
.action-btn-xs:hover { border-color: var(--cyan); color: var(--cyan); }
.action-btn-xs.danger:hover { border-color: var(--red); color: var(--red); }
.action-btn-xs:disabled { opacity: 0.3; cursor: default; }

.spin { animation: spin 1s linear infinite; }
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
</style>
