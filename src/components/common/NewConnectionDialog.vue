<script setup lang="ts">
import { ref, computed, onBeforeUnmount, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import SshConnectionForm from '@/components/ssh/SshConnectionForm.vue'
import DbConnectionForm from '@/components/db/DbConnectionForm.vue'
import type { CreateAssetDto, Asset } from '@/types/asset'

const { t } = useI18n()

const props = defineProps<{
  modelValue: boolean
  asset?: Asset | null
  initialType?: 'ssh' | 'db' | 'docker' | 'excel'
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  submit: [dto: CreateAssetDto]
  update: [payload: { id: string; dto: CreateAssetDto }]
}>()

const step = ref<'type' | 'ssh' | 'db' | 'docker' | 'excel'>('type')
const dockerName = ref('')
const dockerSocket = ref('')
const excelName = ref('')
const excelFilePath = ref('')
const excelFormat = ref<'xlsx' | 'csv'>('xlsx')
const excelDropActive = ref(false)
let unlistenExcelDrop: (() => void) | null = null

const mode = computed<'create' | 'edit'>(() => (props.asset ? 'edit' : 'create'))
const canGoBackToType = computed(() => mode.value === 'create' && !props.initialType)

function selectType(type: string) {
  if (type === 'ssh') {
    step.value = 'ssh'
  } else if (type === 'db') {
    step.value = 'db'
  } else if (type === 'docker') {
    step.value = 'docker'
  } else if (type === 'excel') {
    step.value = 'excel'
  }
}

function syncDockerFromAsset() {
  if (!props.asset || props.asset.type !== 'docker') return
  dockerName.value = props.asset.name
  dockerSocket.value = props.asset.config.socketPath || ''
}

function syncExcelFromAsset() {
  if (!props.asset || props.asset.type !== 'excel') return
  excelName.value = props.asset.name
  excelFilePath.value = props.asset.config.filePath || ''
  excelFormat.value = props.asset.config.format || 'xlsx'
}

function excelFileFormat(path: string): 'xlsx' | 'csv' | null {
  const lower = path.toLowerCase()
  if (lower.endsWith('.csv')) return 'csv'
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) return 'xlsx'
  return null
}

function setExcelFilePath(path: string) {
  const format = excelFileFormat(path)
  if (!format) return false
  excelFilePath.value = path
  if (!excelName.value) {
    const fileName = path.split(/[/\\]/).pop() || ''
    excelName.value = fileName.replace(/\.(xlsx?|csv)$/i, '') || fileName
  }
  excelFormat.value = format
  return true
}

async function pickExcelFile() {
  const { open } = await import('@tauri-apps/plugin-dialog')
  const selected = await open({
    multiple: false,
    filters: [
      { name: 'Excel', extensions: ['xlsx', 'xls', 'csv'] }
    ]
  })
  if (!selected) return
  setExcelFilePath(selected as string)
}

function cleanupExcelDropListener() {
  unlistenExcelDrop?.()
  unlistenExcelDrop = null
  excelDropActive.value = false
}

async function ensureExcelDropListener() {
  if (unlistenExcelDrop || !props.modelValue || step.value !== 'excel') return
  try {
    const { getCurrentWebview } = await import('@tauri-apps/api/webview')
    unlistenExcelDrop = await getCurrentWebview().onDragDropEvent((event) => {
      if (!props.modelValue || step.value !== 'excel') return
      if (event.payload.type === 'over') {
        excelDropActive.value = true
      } else if (event.payload.type === 'leave') {
        excelDropActive.value = false
      } else if (event.payload.type === 'drop') {
        excelDropActive.value = false
        const path = event.payload.paths.find(p => excelFileFormat(p))
        if (path) setExcelFilePath(path)
      }
    })
  } catch {
    cleanupExcelDropListener()
  }
}

// 编辑模式打开 dialog 时,直接跳到对应 step 并回填 docker 字段
watch(
  () => [props.modelValue, props.asset] as const,
  ([open, asset]) => {
    if (!open) return
    if (asset && asset.type === 'ssh') {
      step.value = 'ssh'
    } else if (asset && asset.type === 'db') {
      step.value = 'db'
    } else if (asset && asset.type === 'docker') {
      step.value = 'docker'
      syncDockerFromAsset()
    } else if (asset && asset.type === 'excel') {
      step.value = 'excel'
      syncExcelFromAsset()
    } else if (props.initialType) {
      // 从顶栏菜单快捷入口进入,跳过 type 选择
      selectType(props.initialType)
    }
  },
  { immediate: true }
)

watch(
  () => [props.modelValue, step.value] as const,
  ([open, currentStep]) => {
    if (open && currentStep === 'excel') {
      void ensureExcelDropListener()
    } else {
      cleanupExcelDropListener()
    }
  },
  { immediate: true }
)

function handleSshSubmit(dto: CreateAssetDto) {
  if (mode.value === 'edit' && props.asset) {
    emit('update', { id: props.asset.id, dto })
  } else {
    emit('submit', dto)
  }
  close()
}

function handleDbSubmit(dto: CreateAssetDto) {
  if (mode.value === 'edit' && props.asset) {
    emit('update', { id: props.asset.id, dto })
  } else {
    emit('submit', dto)
  }
  close()
}

function handleDockerSubmit(dto: CreateAssetDto) {
  if (mode.value === 'edit' && props.asset) {
    emit('update', { id: props.asset.id, dto })
  } else {
    emit('submit', dto)
  }
  close()
}

function handleExcelSubmit(dto: CreateAssetDto) {
  if (mode.value === 'edit' && props.asset) {
    emit('update', { id: props.asset.id, dto })
  } else {
    emit('submit', dto)
  }
  close()
}

function close() {
  cleanupExcelDropListener()
  step.value = 'type'
  dockerName.value = ''
  dockerSocket.value = ''
  excelName.value = ''
  excelFilePath.value = ''
  excelFormat.value = 'xlsx'
  emit('update:modelValue', false)
}

function onDialogModelUpdate(open: boolean) {
  if (open) {
    emit('update:modelValue', true)
    return
  }
  close()
}

function goBackOrClose() {
  if (canGoBackToType.value) {
    step.value = 'type'
  } else {
    close()
  }
}

onBeforeUnmount(cleanupExcelDropListener)
</script>

<template>
  <v-dialog
    :model-value="modelValue"
    @update:model-value="onDialogModelUpdate"
    max-width="640"
    transition="dialog-bottom-transition"
    scrollable
  >
    <div class="new-conn-dialog">
      <!-- Type Selection -->
      <template v-if="step === 'type'">
        <div class="modal-header">
          <div class="icon-box">
            <v-icon size="14">{{ mode === 'edit' ? 'mdi-pencil-outline' : 'mdi-plus-circle-outline' }}</v-icon>
          </div>
          <h3>{{ mode === 'edit' ? t('asset.edit') : t('asset.create') }}</h3>
          <button class="action-btn" @click="close">
            <v-icon size="14">mdi-close</v-icon>
          </button>
        </div>
        <div class="modal-body">
          <div class="type-grid">
            <div
              class="type-card"
              role="button"
              tabindex="0"
              @click="selectType('ssh')"
              @keydown.enter.prevent="selectType('ssh')"
              @keydown.space.prevent="selectType('ssh')"
            >
              <div class="type-icon ssh">
                <v-icon size="26">mdi-console</v-icon>
              </div>
              <div class="type-meta">
                <span class="type-name">SSH</span>
                <span class="type-desc">{{ t('ssh.terminal') }} · {{ t('sftp.title') }}</span>
              </div>
              <v-icon class="arrow" size="14">mdi-arrow-right</v-icon>
            </div>
            <div
              class="type-card"
              role="button"
              tabindex="0"
              @click="selectType('db')"
              @keydown.enter.prevent="selectType('db')"
              @keydown.space.prevent="selectType('db')"
            >
              <div class="type-icon db">
                <v-icon size="26">mdi-database-outline</v-icon>
              </div>
              <div class="type-meta">
                <span class="type-name">{{ t('db.title') }}</span>
                <span class="type-desc">MySQL · Redis · Elasticsearch</span>
              </div>
              <v-icon class="arrow" size="14">mdi-arrow-right</v-icon>
            </div>
            <div
              class="type-card"
              role="button"
              tabindex="0"
              @click="selectType('docker')"
              @keydown.enter.prevent="selectType('docker')"
              @keydown.space.prevent="selectType('docker')"
            >
              <div class="type-icon docker">
                <v-icon size="26">mdi-docker</v-icon>
              </div>
              <div class="type-meta">
                <span class="type-name">Docker</span>
                <span class="type-desc">{{ t('docker.containers') }} / {{ t('docker.images') }}</span>
              </div>
              <v-icon class="arrow" size="14">mdi-arrow-right</v-icon>
            </div>
            <div
              class="type-card"
              role="button"
              tabindex="0"
              @click="selectType('excel')"
              @keydown.enter.prevent="selectType('excel')"
              @keydown.space.prevent="selectType('excel')"
            >
              <div class="type-icon excel">
                <v-icon size="26">mdi-file-excel-outline</v-icon>
              </div>
              <div class="type-meta">
                <span class="type-name">Excel</span>
                <span class="type-desc">.xlsx · .csv · 编辑 / 导入导出</span>
              </div>
              <v-icon class="arrow" size="14">mdi-arrow-right</v-icon>
            </div>
          </div>
        </div>
      </template>

      <!-- SSH Form -->
      <template v-else-if="step === 'ssh'">
        <div class="modal-header">
          <button class="action-btn" @click="goBackOrClose" style="margin-right: -4px;" :data-tooltip="canGoBackToType ? t('common.back') : t('common.close')">
            <v-icon size="14">{{ canGoBackToType ? 'mdi-arrow-left' : 'mdi-close' }}</v-icon>
          </button>
          <div class="icon-box">
            <v-icon size="14">mdi-console</v-icon>
          </div>
          <h3>
            {{ mode === 'edit' ? t('asset.edit') : t('asset.create') }} · SSH
            <span v-if="mode === 'edit' && asset" class="edit-hint">{{ asset.name }}</span>
          </h3>
          <button class="action-btn" @click="close">
            <v-icon size="14">mdi-close</v-icon>
          </button>
        </div>
        <div class="modal-body">
          <SshConnectionForm
            :initial-values="mode === 'edit' && asset ? {
              name: asset.name,
              host: asset.config.host || '',
              port: asset.config.port || 22,
              username: asset.config.username || '',
              password: asset.config.password || '',
              privateKey: asset.config.privateKey || '',
              passphrase: asset.config.passphrase || '',
              jumpHost: asset.config.jumpHost || '',
              jumpPort: asset.config.jumpPort || 22,
              jumpUsername: asset.config.jumpUsername || '',
              jumpPassword: asset.config.jumpPassword || '',
              jumpPrivateKey: asset.config.jumpPrivateKey || '',
              jumpPassphrase: asset.config.jumpPassphrase || ''
            } : undefined"
            @submit="handleSshSubmit"
            @cancel="close"
          />
        </div>
      </template>

      <!-- DB Form -->
      <template v-else-if="step === 'db'">
        <div class="modal-header">
          <button class="action-btn" @click="goBackOrClose" style="margin-right: -4px;" :data-tooltip="canGoBackToType ? t('common.back') : t('common.close')">
            <v-icon size="14">{{ canGoBackToType ? 'mdi-arrow-left' : 'mdi-close' }}</v-icon>
          </button>
          <div class="icon-box" style="background: rgba(181, 107, 255, 0.1); color: var(--purple); border-color: rgba(181, 107, 255, 0.2);">
            <v-icon size="14">mdi-database</v-icon>
          </div>
          <h3>
            {{ mode === 'edit' ? t('asset.edit') : t('asset.create') }} · {{ t('db.title') }}
            <span v-if="mode === 'edit' && asset" class="edit-hint">{{ asset.name }}</span>
          </h3>
          <button class="action-btn" @click="close">
            <v-icon size="14">mdi-close</v-icon>
          </button>
        </div>
        <div class="modal-body">
          <DbConnectionForm
            :initial-values="mode === 'edit' && asset ? {
              name: asset.name,
              dbType: asset.config.dbType || 'mysql',
              host: asset.config.host || '',
              port: asset.config.port || 3306,
              username: asset.config.username || '',
              password: asset.config.password || '',
              database: asset.config.database || '',
              ssl: asset.config.ssl || false
            } : undefined"
            @submit="handleDbSubmit"
            @cancel="close"
          />
        </div>
      </template>

      <!-- Docker Form -->
      <template v-else-if="step === 'docker'">
        <div class="modal-header">
          <button class="action-btn" @click="goBackOrClose" style="margin-right: -4px;" :data-tooltip="canGoBackToType ? t('common.back') : t('common.close')">
            <v-icon size="14">{{ canGoBackToType ? 'mdi-arrow-left' : 'mdi-close' }}</v-icon>
          </button>
          <div class="icon-box" style="background: rgba(74, 222, 128, 0.1); color: var(--green); border-color: rgba(74, 222, 128, 0.2);">
            <v-icon size="14">mdi-docker</v-icon>
          </div>
          <h3>
            {{ mode === 'edit' ? t('asset.edit') : t('asset.create') }} · Docker
            <span v-if="mode === 'edit' && asset" class="edit-hint">{{ asset.name }}</span>
          </h3>
          <button class="action-btn" @click="close">
            <v-icon size="14">mdi-close</v-icon>
          </button>
        </div>
        <div class="modal-body">
          <form class="docker-form" @submit.prevent="handleDockerSubmit({
            type: 'docker',
            name: dockerName,
            config: { socketPath: dockerSocket }
          })">
            <div class="form-field">
              <label class="field-label">
                <v-icon size="12">mdi-tag-outline</v-icon>
                {{ t('asset.name') }}
                <span class="required">*</span>
              </label>
              <input v-model="dockerName" type="text" class="cyber-input" :placeholder="t('asset.placeholderName')" autofocus required />
            </div>
            <div class="form-field">
              <label class="field-label">
                <v-icon size="12">mdi-server-network</v-icon>
                {{ t('asset.dockerSocket') }}
              </label>
              <input v-model="dockerSocket" type="text" class="cyber-input" placeholder="unix:///var/run/docker.sock" />
              <div class="field-hint">{{ t('asset.dockerSocketHint') }}</div>
            </div>
            <div class="form-footer">
              <div></div>
              <div class="footer-right">
                <button type="button" class="cyber-btn-secondary" @click="close">
                  <v-icon size="14">mdi-close</v-icon>
                  {{ t('common.cancel') }}
                </button>
                <button type="submit" class="cyber-btn" :disabled="!dockerName">
                  <v-icon size="14">mdi-content-save-outline</v-icon>
                  {{ t('common.save') }}
                </button>
              </div>
            </div>
          </form>
        </div>
      </template>

      <!-- Excel Form -->
      <template v-else-if="step === 'excel'">
        <div class="modal-header">
          <button class="action-btn" @click="goBackOrClose" style="margin-right: -4px;" :data-tooltip="canGoBackToType ? t('common.back') : t('common.close')">
            <v-icon size="14">{{ canGoBackToType ? 'mdi-arrow-left' : 'mdi-close' }}</v-icon>
          </button>
          <div class="icon-box" style="background: rgba(74, 222, 128, 0.1); color: var(--green); border-color: rgba(74, 222, 128, 0.2);">
            <v-icon size="14">mdi-file-excel-outline</v-icon>
          </div>
          <h3>
            {{ mode === 'edit' ? t('asset.edit') : t('asset.create') }} · Excel
            <span v-if="mode === 'edit' && asset" class="edit-hint">{{ asset.name }}</span>
          </h3>
          <button class="action-btn" @click="close">
            <v-icon size="14">mdi-close</v-icon>
          </button>
        </div>
        <div class="modal-body">
          <form
            class="excel-form"
            :class="{ dragging: excelDropActive }"
            @submit.prevent="handleExcelSubmit({
            type: 'excel',
            name: excelName,
            config: { filePath: excelFilePath, format: excelFormat }
          })"
          >
            <div class="form-field">
              <label class="field-label">
                <v-icon size="12">mdi-tag-outline</v-icon>
                {{ t('asset.name') }}
                <span class="required">*</span>
              </label>
              <input v-model="excelName" type="text" class="cyber-input" :placeholder="t('asset.placeholderName')" autofocus required />
            </div>
            <div class="form-field">
              <label class="field-label">
                <v-icon size="12">mdi-file-outline</v-icon>
                文件路径
                <span class="required">*</span>
              </label>
              <div class="file-pick-row">
                <input v-model="excelFilePath" type="text" class="cyber-input" placeholder="请选择 Excel 文件..." readonly />
                <button type="button" class="cyber-btn-secondary file-pick-btn" @click="pickExcelFile">
                  <v-icon size="14">mdi-folder-open-outline</v-icon>
                  浏览
                </button>
              </div>
              <div class="excel-drop-zone" :class="{ active: excelDropActive }" @click="pickExcelFile">
                <v-icon size="18">mdi-tray-arrow-down</v-icon>
                <span>{{ excelDropActive ? '松手导入文件' : '拖入 .xlsx / .xls / .csv 文件,或点击选择' }}</span>
              </div>
              <div class="field-hint">支持 .xlsx、.xls 和 .csv 格式</div>
            </div>
            <div class="form-footer">
              <div></div>
              <div class="footer-right">
                <button type="button" class="cyber-btn-secondary" @click="close">
                  <v-icon size="14">mdi-close</v-icon>
                  {{ t('common.cancel') }}
                </button>
                <button type="submit" class="cyber-btn" :disabled="!excelName || !excelFilePath">
                  <v-icon size="14">mdi-content-save-outline</v-icon>
                  {{ t('common.save') }}
                </button>
              </div>
            </div>
          </form>
        </div>
      </template>
    </div>
  </v-dialog>
</template>

<style scoped>
.new-conn-dialog {
  background: var(--panel-solid);
  border: 1px solid var(--line-2);
  border-radius: 16px;
  overflow: hidden;
  position: relative;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 24px 64px -12px rgba(0, 0, 0, 0.7);
}

.new-conn-dialog::before {
  content: "";
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 2px;
  background: var(--grad-primary);
  opacity: 0.6;
  pointer-events: none;
  z-index: 1;
}

.edit-hint {
  font-size: 11px;
  font-weight: 500;
  color: var(--muted);
  font-family: 'JetBrains Mono', monospace;
  background: rgba(0, 240, 255, 0.08);
  border: 1px solid var(--line-2);
  padding: 2px 8px;
  border-radius: 4px;
  margin-left: 4px;
}

.type-grid {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.type-card {
  background: var(--bg-input);
  border: 1px solid var(--line-2);
  border-radius: 10px;
  padding: 14px 16px;
  display: flex;
  align-items: center;
  gap: 14px;
  cursor: pointer;
  transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
  position: relative;
  overflow: hidden;
}

.type-card::before {
  content: "";
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 1px;
  background: var(--grad-primary);
  opacity: 0;
  transition: opacity 0.25s;
}

.type-card:hover:not(.disabled) {
  background: rgba(0, 240, 255, 0.04);
  border-color: rgba(0, 240, 255, 0.3);
  transform: translateX(2px);
  box-shadow: 0 4px 16px rgba(0, 240, 255, 0.12);
}

.type-card:hover:not(.disabled)::before {
  opacity: 0.5;
}

.type-card.disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.type-icon {
  width: 44px;
  height: 44px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.type-icon.ssh {
  background: rgba(0, 240, 255, 0.1);
  color: var(--cyan);
  border: 1px solid rgba(0, 240, 255, 0.2);
}

.type-icon.db {
  background: rgba(181, 107, 255, 0.1);
  color: var(--purple);
  border: 1px solid rgba(181, 107, 255, 0.2);
}

.type-icon.docker {
  background: rgba(74, 222, 128, 0.1);
  color: var(--green);
  border: 1px solid rgba(74, 222, 128, 0.2);
}

.type-icon.excel {
  background: rgba(74, 222, 128, 0.1);
  color: var(--green);
  border: 1px solid rgba(74, 222, 128, 0.2);
}

.type-meta {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.type-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
}

.type-desc {
  font-size: 12px;
  color: var(--muted);
  font-family: 'JetBrains Mono', monospace;
}

.type-card .arrow {
  color: var(--muted);
  opacity: 0;
  transform: translateX(-4px);
  transition: all 0.25s;
}

.type-card:hover:not(.disabled) .arrow {
  opacity: 1;
  transform: translateX(0);
  color: var(--cyan);
}

.file-pick-row {
  display: flex;
  gap: 8px;
}

.file-pick-row .cyber-input {
  flex: 1;
  cursor: pointer;
}

.file-pick-btn {
  flex-shrink: 0;
  white-space: nowrap;
}

.excel-form {
  position: relative;
}

.excel-drop-zone {
  margin-top: 8px;
  min-height: 58px;
  border: 1px dashed var(--line-2);
  border-radius: 8px;
  background: var(--panel-solid-2);
  color: var(--text-2);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.excel-drop-zone:hover,
.excel-drop-zone.active,
.excel-form.dragging .excel-drop-zone {
  color: var(--cyan);
  border-color: var(--cyan);
  background: var(--hover-cyan-faint);
  box-shadow: var(--glow-cyan);
}
</style>
