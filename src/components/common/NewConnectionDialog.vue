<script setup lang="ts">
import { ref, computed, onBeforeUnmount, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAssetStore } from '@/stores/asset'
import SshConnectionForm from '@/components/ssh/SshConnectionForm.vue'
import DbConnectionForm from '@/components/db/DbConnectionForm.vue'
import type { CreateAssetDto, Asset } from '@/types/asset'

const { t } = useI18n()
const assetStore = useAssetStore()

const props = defineProps<{
  modelValue: boolean
  asset?: Asset | null
  initialType?: 'ssh' | 'db' | 'docker' | 'excel' | 'local'
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  submit: [dto: CreateAssetDto]
  update: [payload: { id: string; dto: CreateAssetDto }]
}>()

const step = ref<'type' | 'ssh' | 'db' | 'docker' | 'excel'>('type')
const dockerName = ref('')
const dockerSocket = ref('')
const dockerTransport = ref<'socket' | 'tcp' | 'ssh'>('socket')
const dockerSshAssetId = ref('')
const dockerSshProtocol = ref<'unix-over-nc' | 'unix-over-nc-sudo'>('unix-over-nc-sudo')
const excelName = ref('')
const excelFilePath = ref('')
const excelFormat = ref<'xlsx' | 'csv'>('xlsx')
const excelDropActive = ref(false)
const sshFormGeneration = ref(0)
let unlistenExcelDrop: (() => void) | null = null

const mode = computed<'create' | 'edit'>(() => (props.asset ? 'edit' : 'create'))
const canGoBackToType = computed(() => mode.value === 'create' && !props.initialType)
const sshAssets = computed(() => assetStore.assets.filter(asset => asset.type === 'ssh'))

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
  dockerTransport.value = props.asset.config.dockerTransport || 'socket'
  dockerSocket.value = props.asset.config.remoteHost
    || props.asset.config.socketPath
    || (dockerTransport.value === 'tcp' ? 'tcp://127.0.0.1:2375' : '/var/run/docker.sock')
  dockerSshAssetId.value = props.asset.config.dockerSshAssetId || ''
  dockerSshProtocol.value = props.asset.config.dockerSshProtocol || 'unix-over-nc-sudo'
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
  ([open, asset], previous) => {
    if (!open) return
    const [wasOpen, previousAsset] = previous ?? [false, undefined]
    if (!wasOpen || asset?.id !== previousAsset?.id) {
      sshFormGeneration.value += 1
    }
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
  dockerTransport.value = 'socket'
  dockerSshAssetId.value = ''
  dockerSshProtocol.value = 'unix-over-nc-sudo'
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
          <div class="type-intro">
            <span>选择要接入的工作负载</span>
            <small>创建后会出现在左侧资产树,可双击打开为标签页。</small>
          </div>
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
            :key="`${asset?.id || 'new'}-${sshFormGeneration}`"
            :initial-values="mode === 'edit' && asset ? {
              name: asset.name,
              host: asset.config.host || '',
              port: asset.config.port || 22,
              username: asset.config.username || '',
              password: asset.config.password || '',
              privateKey: asset.config.privateKey || '',
              passphrase: asset.config.passphrase || '',
              authMode: asset.config.authMode,
              usePasswordAuth: asset.config.usePasswordAuth,
              useKeyAuth: asset.config.useKeyAuth,
              mfaEnabled: asset.config.mfaEnabled,
              mfaPassword: asset.config.mfaPassword || '',
              sftpTimeoutSec: asset.config.sftpTimeoutSec ?? 30,
              sftpLaunchMode: asset.config.sftpLaunchMode ?? 'auto',
              sftpServerPath: asset.config.sftpServerPath || '',
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
          <div class="icon-box db">
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
              address: asset.config.address || '',
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
          <div class="icon-box docker">
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
            config: {
              dockerTransport,
              socketPath: dockerTransport === 'tcp' ? undefined : dockerSocket,
              remoteHost: dockerTransport === 'tcp' ? dockerSocket : undefined,
              dockerSshAssetId: dockerTransport === 'ssh' ? dockerSshAssetId : undefined,
              dockerSshProtocol: dockerTransport === 'ssh' ? dockerSshProtocol : undefined
            }
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
                <v-icon size="12">mdi-transit-connection-variant</v-icon>
                连接方式
              </label>
              <div class="docker-transport-switch">
                <button type="button" :class="{ active: dockerTransport === 'socket' }" @click="dockerTransport = 'socket'">
                  <v-icon size="13">mdi-lan-connect</v-icon>本地 Socket
                </button>
                <button type="button" :class="{ active: dockerTransport === 'tcp' }" @click="dockerTransport = 'tcp'; dockerSocket = 'tcp://127.0.0.1:2375'">
                  <v-icon size="13">mdi-network-outline</v-icon>TCP
                </button>
                <button type="button" :class="{ active: dockerTransport === 'ssh' }" @click="dockerTransport = 'ssh'; dockerSocket = '/var/run/docker.sock'">
                  <v-icon size="13">mdi-tunnel-outline</v-icon>SSH 隧道
                </button>
              </div>
            </div>
            <div v-if="dockerTransport === 'ssh'" class="form-field">
              <label class="field-label">
                <v-icon size="12">mdi-console-network-outline</v-icon>
                复用 SSH 资产
                <span class="required">*</span>
              </label>
              <select v-model="dockerSshAssetId" class="cyber-input" required>
                <option value="" disabled>选择已有 SSH 连接</option>
                <option v-for="sshAsset in sshAssets" :key="sshAsset.id" :value="sshAsset.id">
                  {{ sshAsset.name }} · {{ sshAsset.config.host }}:{{ sshAsset.config.port || 22 }}
                </option>
              </select>
              <div class="field-hint">首次使用前请打开该 SSH 连接并确认主机密钥。</div>
            </div>
            <div v-if="dockerTransport === 'ssh'" class="form-field">
              <label class="field-label">
                <v-icon size="12">mdi-shield-key-outline</v-icon>
                Unix Socket 协议
              </label>
              <div class="docker-transport-switch">
                <button type="button" :class="{ active: dockerSshProtocol === 'unix-over-nc' }" @click="dockerSshProtocol = 'unix-over-nc'">
                  Unix-Over-Nc
                </button>
                <button type="button" :class="{ active: dockerSshProtocol === 'unix-over-nc-sudo' }" @click="dockerSshProtocol = 'unix-over-nc-sudo'">
                  Unix-Over-Nc-Sudo
                </button>
              </div>
              <div class="field-hint">Sudo 模式要求远端账号可无交互执行 sudo -n nc。</div>
            </div>
            <div class="form-field">
              <label class="field-label">
                <v-icon size="12">mdi-server-network</v-icon>
                {{ dockerTransport === 'tcp' ? 'Docker TCP Endpoint' : t('asset.dockerSocket') }}
              </label>
              <input
                v-model="dockerSocket"
                type="text"
                class="cyber-input"
                :placeholder="dockerTransport === 'tcp' ? 'tcp://host:2375' : '/var/run/docker.sock'"
              />
              <div class="field-hint">
                {{ dockerTransport === 'ssh' ? '远端 Docker Unix Socket 路径' : t('asset.dockerSocketHint') }}
              </div>
            </div>
            <div class="form-footer">
              <div></div>
              <div class="footer-right">
                <button type="button" class="cyber-btn-secondary" @click="close">
                  <v-icon size="14">mdi-close</v-icon>
                  {{ t('common.cancel') }}
                </button>
                <button type="submit" class="cyber-btn" :disabled="!dockerName || (dockerTransport === 'ssh' && !dockerSshAssetId)">
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
          <div class="icon-box excel">
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
  max-height: calc(100vh - 64px);
  display: flex;
  flex-direction: column;
  box-shadow: 0 24px 64px -12px rgba(0, 0, 0, 0.7);
}

.new-conn-dialog > .modal-header {
  flex: 0 0 auto;
}

.new-conn-dialog > .modal-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
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
  background: var(--hover-cyan);
  border: 1px solid var(--line-2);
  padding: 2px 8px;
  border-radius: 4px;
  margin-left: 4px;
}

.type-intro {
  margin-bottom: 14px;
  padding: 12px;
  border-radius: 10px;
  border: 1px solid var(--line);
  background: var(--bg-input);
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.type-intro span {
  color: var(--text);
  font-size: 13px;
  font-weight: 700;
}

.type-intro small {
  color: var(--muted);
  font-size: 11px;
  line-height: 1.5;
}

.type-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.type-card {
  min-width: 0;
  min-height: 116px;
  background: var(--bg-input);
  border: 1px solid var(--line-2);
  border-radius: 12px;
  padding: 14px;
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 12px;
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

.type-card:hover:not(.disabled),
.type-card:focus-visible {
  outline: none;
  background: var(--hover-cyan-soft);
  border-color: var(--status-connecting-border);
  transform: translateY(-2px);
  box-shadow: var(--glow-soft);
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
  background: var(--icon-bg-cyan);
  color: var(--cyan);
  border: 1px solid var(--status-connecting-border);
}

.type-icon.db {
  background: var(--db-mysql-bg);
  color: var(--db-mysql);
  border: 1px solid var(--line-2);
}

.type-icon.docker {
  background: var(--icon-bg-green);
  color: var(--green);
  border: 1px solid var(--status-online-border);
}

.type-icon.excel {
  background: var(--icon-bg-green);
  color: var(--green);
  border: 1px solid var(--status-online-border);
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

@media (max-width: 640px) {
  .type-grid {
    grid-template-columns: 1fr;
  }

  .file-pick-row {
    flex-direction: column;
  }
}
</style>
