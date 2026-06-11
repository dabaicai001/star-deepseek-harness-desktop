<script setup lang="ts">
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { CreateAssetDto } from '@/types/asset'
import type { KbInteractiveEvent } from '@/services/ssh'
import KbInteractiveDialog from './KbInteractiveDialog.vue'
import TotpAppendDialog, { type ConcatFormat } from './TotpAppendDialog.vue'

const { t } = useI18n()

export interface SshFormInitialValues {
  name?: string
  host?: string
  port?: number
  username?: string
  password?: string
  privateKey?: string
  passphrase?: string
  jumpHost?: string
  jumpPort?: number
  jumpUsername?: string
  jumpPassword?: string
  jumpPrivateKey?: string
  jumpPassphrase?: string
  /** 认证方式: 'password' | 'key' | 'both' | 'mfa' */
  authMode?: 'password' | 'key' | 'both' | 'mfa'
  /** 兼容旧字段:usePasswordAuth + useKeyAuth = both,只用 usePasswordAuth = password,以此类推 */
  usePasswordAuth?: boolean
  useKeyAuth?: boolean
  mfaEnabled?: boolean
  mfaPassword?: string
  totpSecret?: string
  appendTotpToPassword?: boolean
  totpAppendFormat?: 'none' | 'space' | 'manual'
}

const props = defineProps<{
  initialValues?: SshFormInitialValues
}>()

const emit = defineEmits<{
  submit: [dto: CreateAssetDto]
  cancel: []
}>()

onBeforeUnmount(() => {
  unlistenTestKb?.()
  unlistenTestKb = null
  unlistenTestHostkey?.()
  unlistenTestHostkey = null
})

const name = ref(props.initialValues?.name ?? '')
const host = ref(props.initialValues?.host ?? '')
const port = ref<number>(props.initialValues?.port ?? 22)
const username = ref(props.initialValues?.username ?? '')
const password = ref(props.initialValues?.password ?? '')
const privateKey = ref(props.initialValues?.privateKey ?? '')
const privateKeyName = ref('')
const passphrase = ref(props.initialValues?.passphrase ?? '')
const showPassword = ref(false)
const showPassphrase = ref(false)
const mfaPassword = ref(props.initialValues?.mfaPassword ?? '')
const totpSecret = ref(props.initialValues?.totpSecret ?? '')
const showMfaPassword = ref(false)
const isEditing = computed(() => !!props.initialValues?.name)
const changedPassword = ref(false)
const changedMfaPassword = ref(false)
const fileInputRef = ref<HTMLInputElement | null>(null)

// 测试连接时的临时 MFA / Hostkey 弹窗
const kbDialogRef = ref<InstanceType<typeof KbInteractiveDialog>>()
const testSessionId = ref('')
let unlistenTestKb: UnlistenFn | null = null
let unlistenTestHostkey: UnlistenFn | null = null
let testSessionIdCounter = 0

// 「密码 + TOTP 拼接」工作流(写入资产 config,每次连接都弹)
const totpDialogRef = ref<InstanceType<typeof TotpAppendDialog>>()
const appendTotpToPassword = ref(props.initialValues?.appendTotpToPassword ?? false)
const totpAppendFormat = ref<'none' | 'space' | 'manual'>(props.initialValues?.totpAppendFormat ?? 'none')
let pendingTotpCode: string | null = null
let pendingTotpFormat: ConcatFormat | null = null
let pendingResolve: ((v: { code: string; format: ConcatFormat } | null) => void) | null = null

// 认证方式:互斥 chip 单选 — 密码 / 私钥 / 密码+私钥 / MFA
type AuthMode = 'password' | 'key' | 'both' | 'mfa'
function resolveInitialAuthMode(): AuthMode {
  const init = props.initialValues
  if (init?.authMode) return init.authMode
  // 兼容旧字段
  if (init?.mfaEnabled) return 'mfa'
  const usePwd = init?.usePasswordAuth !== undefined ? init.usePasswordAuth : !init?.privateKey
  const useKey = init?.useKeyAuth ?? Boolean(init?.privateKey)
  if (usePwd && useKey) return 'both'
  if (useKey) return 'key'
  return 'password'
}
const authMode = ref<AuthMode>(resolveInitialAuthMode())

// 跳板机
const showJumpHost = ref(false)
const jumpHost = ref('')
const jumpPort = ref<number>(22)
const jumpUsername = ref('')
const jumpAuthType = ref<'password' | 'key'>('password')
const jumpPassword = ref('')
const jumpPrivateKey = ref('')
const jumpPrivateKeyName = ref('')
const jumpPassphrase = ref('')
const showJumpPassword = ref(false)
const showJumpPassphrase = ref(false)
const jumpFileInputRef = ref<HTMLInputElement | null>(null)

const testStatus = ref<'idle' | 'testing' | 'success' | 'fail'>('idle')
const testMessage = ref('')

watch(
  () => props.initialValues,
  (next) => {
    if (!next) return
    name.value = next.name ?? ''
    host.value = next.host ?? ''
    port.value = next.port ?? 22
    username.value = next.username ?? ''
    password.value = next.password ?? ''
    privateKey.value = next.privateKey ?? ''
    privateKeyName.value = next.privateKey ? 'Loaded' : ''
    passphrase.value = next.passphrase ?? ''
    authMode.value = next.authMode
      ?? (next.mfaEnabled
        ? 'mfa'
        : ((next.usePasswordAuth !== undefined ? next.usePasswordAuth : !next.privateKey) && (next.useKeyAuth ?? Boolean(next.privateKey))
            ? 'both'
            : (next.useKeyAuth ?? Boolean(next.privateKey))
              ? 'key'
              : 'password'))
    mfaPassword.value = next.mfaPassword ?? ''
    totpSecret.value = next.totpSecret ?? ''
    appendTotpToPassword.value = next.appendTotpToPassword ?? false
    totpAppendFormat.value = next.totpAppendFormat ?? 'none'
    jumpHost.value = next.jumpHost ?? ''
    jumpPort.value = next.jumpPort ?? 22
    jumpUsername.value = next.jumpUsername ?? ''
    jumpPassword.value = next.jumpPassword ?? ''
    jumpPrivateKey.value = next.jumpPrivateKey ?? ''
    jumpPrivateKeyName.value = next.jumpPrivateKey ? 'Loaded' : ''
    jumpPassphrase.value = next.jumpPassphrase ?? ''
    jumpAuthType.value = next.jumpPrivateKey ? 'key' : 'password'
    showJumpHost.value = Boolean(next.jumpHost)
  }
)

// 派生:不同 authMode 对应的填写校验
const needPassword = computed(() => authMode.value === 'password' || authMode.value === 'both')
const needKey = computed(() => authMode.value === 'key' || authMode.value === 'both')
const needMfa = computed(() => authMode.value === 'mfa')

const canSubmit = computed(() =>
  Boolean(name.value && host.value && username.value) &&
  (!needKey.value || privateKey.value.length > 0) &&
  (!showJumpHost.value || !jumpHost.value || (jumpAuthType.value === 'password' ? true : jumpPrivateKey.value.length > 0))
)

const canTest = computed(() =>
  Boolean(host.value && username.value) &&
  (!needKey.value || privateKey.value.length > 0) &&
  (!showJumpHost.value || !jumpHost.value || (jumpAuthType.value === 'password' ? true : jumpPrivateKey.value.length > 0))
)

/**
 * 弹码输入框等用户敲码 + 选格式
 * 用户取消 → 返回 null
 */
function requestTotpAppend(): Promise<{ code: string; format: ConcatFormat } | null> {
  return new Promise((resolve) => {
    pendingResolve = resolve
    totpDialogRef.value?.open(totpAppendFormat.value)
  })
}

function onTotpSubmit(result: { code: string; format: ConcatFormat }) {
  pendingResolve?.(result)
  pendingResolve = null
}

function onTotpCancelled() {
  pendingResolve?.(null)
  pendingResolve = null
}

/**
 * 根据 format 拼接最终密码
 *  - 'manual': 用户已经拼好了,直接用 code
 *  - 'none': 密码 + 6位码
 *  - 'space': 密码 + 空格 + 6位码
 */
function concatPassword(pwd: string, code: string, format: ConcatFormat): string {
  if (format === 'manual') return code
  if (format === 'space') return `${pwd} ${code}`
  return `${pwd}${code}`
}

async function onTestConnection() {
  if (!canTest.value) return
  testStatus.value = 'testing'
  testMessage.value = ''

  // 「密码 + TOTP 拼接」分支:连接瞬间弹码输入框
  let totpResult: { code: string; format: ConcatFormat } | null = null
  if (appendTotpToPassword.value && authMode.value === 'password') {
    totpResult = await requestTotpAppend()
    if (!totpResult) {
      // 用户取消 → 退出,不算失败
      testStatus.value = 'idle'
      return
    }
  }

  // 分配临时 sessionId,让测试连接期间触发的 keyboard-interactive 弹窗能正确订阅
  testSessionIdCounter += 1
  testSessionId.value = `test-${Date.now()}-${testSessionIdCounter}`
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const { listen } = await import('@tauri-apps/api/event')

    // 订阅本次测试的 kb 事件(后端在测试连接期间会通过 ssh:kb-interactive:<testId> 弹密码)
    unlistenTestKb?.()
    unlistenTestKb = await listen<KbInteractiveEvent>(
      `ssh:kb-interactive:${testSessionId.value}`,
      (event) => kbDialogRef.value?.open(event.payload)
    )

    // 测试连接自动接受 host key (不持久化)
    unlistenTestHostkey?.()
    unlistenTestHostkey = await listen<{ hostname: string; port: number }>(
      `ssh:hostkey-confirm:${testSessionId.value}`,
      () => {
        invoke('ssh_hostkey_response', {
          id: testSessionId.value,
          allowed: true,
          persist: false
        })
      }
    )

    // 互斥 chip 单选 → 对应后端 SshAuthConfig 三个枚举
    // 「密码 + TOTP 拼接」分支:把用户填的 6 位码拼到密码末尾
    const finalPassword =
      totpResult
        ? concatPassword(password.value, totpResult.code, totpResult.format)
        : password.value

    const auth: Record<string, unknown> =
      authMode.value === 'both' && finalPassword && privateKey.value
        ? { PasswordAndKey: { password: finalPassword, key: privateKey.value, passphrase: passphrase.value || null } }
        : authMode.value === 'key' || (authMode.value === 'both' && !finalPassword)
          ? { PrivateKey: { key: privateKey.value, passphrase: passphrase.value || null } }
          : { Password: finalPassword }

    const config: Record<string, unknown> = {
      host: host.value,
      port: port.value,
      username: username.value,
      auth
    }

    if (showJumpHost.value && jumpHost.value) {
      config.jump_host = jumpHost.value
      config.jump_port = jumpPort.value || 22
      config.jump_username = jumpUsername.value || username.value
      config.jump_auth = jumpAuthType.value === 'password'
        ? { Password: jumpPassword.value || '' }
        : { PrivateKey: { key: jumpPrivateKey.value, passphrase: jumpPassphrase.value || null } }
    }

    if (authMode.value === 'mfa') {
      (config as Record<string, unknown>).kb_interactive = {
        enabled: true,
        password: mfaPassword.value || null,
        totp_secret: totpSecret.value || null,
      }
    }

    const result = await invoke<{ ok: boolean; message?: string; elapsed_ms?: number }>(
      'test_ssh_connection',
      { config, testSessionId: testSessionId.value }
    )
    testStatus.value = result.ok ? 'success' : 'fail'
    const ms = result.elapsed_ms != null ? ` (${result.elapsed_ms}ms)` : ''
    testMessage.value = (result.message ?? (result.ok ? t('ssh.testSuccess') : t('ssh.testFail'))) + ms
  } catch (err: unknown) {
    testStatus.value = 'fail'
    testMessage.value = err instanceof Error ? err.message : String(err)
  } finally {
    // 清理:关闭可能还开着的弹窗 + 解除事件订阅
    unlistenTestKb?.()
    unlistenTestKb = null
    unlistenTestHostkey?.()
    unlistenTestHostkey = null
    kbDialogRef.value?.close()
    testSessionId.value = ''
    pendingResolve = null
  }
}

function onSubmit() {
  if (!canSubmit.value) return

  const config: Record<string, unknown> = {
    host: host.value,
    port: port.value,
    username: username.value,
    authMode: authMode.value,
    // 旧字段继续写,保持后端 buildAuth 兼容(详见 src/services/ssh.ts)
    usePasswordAuth: needPassword.value,
    useKeyAuth: needKey.value,
  }
  if (needPassword.value) {
    config.password = isEditing.value && !changedPassword.value ? undefined : (password.value || undefined)
  }
  if (needKey.value) {
    config.privateKey = privateKey.value || undefined
    config.passphrase = passphrase.value || undefined
  }
  if (authMode.value === 'mfa') {
    config.mfaEnabled = true
    config.mfaPassword = isEditing.value && !changedMfaPassword.value ? undefined : (mfaPassword.value || null)
    config.totpSecret = totpSecret.value || null
  }
  if (authMode.value === 'password') {
    // 阿里云堡垒机风格:每次连接弹 6 位 TOTP 码拼到密码末尾
    config.appendTotpToPassword = appendTotpToPassword.value
    config.totpAppendFormat = totpAppendFormat.value
  }

  if (showJumpHost.value && jumpHost.value) {
    config.jumpHost = jumpHost.value
    config.jumpPort = jumpPort.value || 22
    config.jumpUsername = jumpUsername.value || username.value
    config.jumpPassword = jumpAuthType.value === 'password' ? jumpPassword.value : undefined
    config.jumpPrivateKey = jumpAuthType.value === 'key' ? jumpPrivateKey.value : undefined
    config.jumpPassphrase = jumpAuthType.value === 'key' ? jumpPassphrase.value : undefined
  }

  const dto: CreateAssetDto = {
    type: 'ssh',
    name: name.value,
    config
  }
  emit('submit', dto)
}

function onCancel() {
  emit('cancel')
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault()
    onSubmit()
  } else if (e.key === 'Escape') {
    e.preventDefault()
    onCancel()
  }
}

// ====== 私钥文件选择(web input + FileReader) ======
// 2MB 私钥文件足够大了(常见 PEM/OPENSSH 都是 1-3KB)
const MAX_KEY_SIZE = 2 * 1024 * 1024

function pickKeyFile() {
  fileInputRef.value?.click()
}

async function onKeyFilePicked(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return

  if (file.size > MAX_KEY_SIZE) {
    testStatus.value = 'fail'
    testMessage.value = t('ssh.keyTooLarge')
    input.value = ''
    return
  }

  try {
    const text = await file.text()
    privateKey.value = text
    privateKeyName.value = file.name
  } catch (err) {
    testStatus.value = 'fail'
    testMessage.value = err instanceof Error ? err.message : String(err)
  } finally {
    // 清空 input.value,允许用户重复选同一文件
    input.value = ''
  }
}

function clearKey() {
  privateKey.value = ''
  privateKeyName.value = ''
}

async function pasteKeyFromClipboard() {
  try {
    const text = await navigator.clipboard.readText()
    if (text && text.includes('PRIVATE KEY')) {
      privateKey.value = text
      privateKeyName.value = t('ssh.pastedFromClipboard')
    }
  } catch {
    testStatus.value = 'fail'
    testMessage.value = t('ssh.clipboardReadFailed')
  }
}

// 跳板机密钥文件选择
function pickJumpKeyFile() {
  jumpFileInputRef.value?.click()
}

async function onJumpKeyFilePicked(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return

  if (file.size > MAX_KEY_SIZE) {
    testStatus.value = 'fail'
    testMessage.value = t('ssh.keyTooLarge')
    input.value = ''
    return
  }

  try {
    const text = await file.text()
    jumpPrivateKey.value = text
    jumpPrivateKeyName.value = file.name
  } catch (err) {
    testStatus.value = 'fail'
    testMessage.value = err instanceof Error ? err.message : String(err)
  } finally {
    input.value = ''
  }
}

function clearJumpKey() {
  jumpPrivateKey.value = ''
  jumpPrivateKeyName.value = ''
}

async function pasteJumpKeyFromClipboard() {
  try {
    const text = await navigator.clipboard.readText()
    if (text && text.includes('PRIVATE KEY')) {
      jumpPrivateKey.value = text
      jumpPrivateKeyName.value = t('ssh.pastedFromClipboard')
    }
  } catch {
    testStatus.value = 'fail'
    testMessage.value = t('ssh.clipboardReadFailed')
  }
}
</script>

<template>
  <form class="ssh-form" @submit.prevent="onSubmit" @keydown="onKeydown">
    <div class="form-body">
      <!-- 左列: 连接信息 -->
      <div class="form-column">
        <div class="column-label">{{ t('asset.server') }}</div>

        <!-- 名称 -->
        <div class="form-field">
          <label class="field-label">
            <v-icon size="12">mdi-tag-outline</v-icon>
            {{ t('asset.name') }}
            <span class="required">*</span>
          </label>
          <input
            v-model="name"
            type="text"
            class="cyber-input"
            :placeholder="t('asset.placeholderName')"
            autofocus
            required
          />
        </div>

        <!-- 主机:端口 -->
        <div class="form-field">
          <label class="field-label">
            <v-icon size="12">mdi-server-network</v-icon>
            {{ t('asset.host') }} : {{ t('asset.port') }}
            <span class="required">*</span>
          </label>
          <div class="form-row host-port">
            <input
              v-model="host"
              type="text"
              class="cyber-input"
              :placeholder="t('asset.placeholderHost')"
              required
            />
            <input
              v-model.number="port"
              type="number"
              class="cyber-input mono"
              :placeholder="'22'"
            />
          </div>
        </div>

        <!-- 用户名 -->
        <div class="form-field">
          <label class="field-label">
            <v-icon size="12">mdi-account-outline</v-icon>
            {{ t('asset.username') }}
            <span class="required">*</span>
          </label>
          <div class="input-group">
            <span class="input-prefix">@</span>
            <input
              v-model="username"
              type="text"
              class="cyber-input"
              :placeholder="t('asset.placeholderUser')"
              required
            />
          </div>
        </div>
      </div>

      <!-- 右列: 认证 -->
      <div class="form-column">
        <div class="column-label">{{ t('ssh.authMethod') }}</div>

        <!-- 互斥 chip 单选组:密码 / 私钥 / 密码+私钥 / MFA -->
        <div class="auth-chip-group" role="radiogroup" :aria-label="t('ssh.authMethod')">
          <button
            type="button"
            class="auth-chip"
            :class="{ active: authMode === 'password' }"
            role="radio"
            :aria-checked="authMode === 'password'"
            @click="authMode = 'password'"
          >
            <v-icon size="14">mdi-key-outline</v-icon>
            <span>{{ t('asset.password') }}</span>
          </button>
          <button
            type="button"
            class="auth-chip"
            :class="{ active: authMode === 'key' }"
            role="radio"
            :aria-checked="authMode === 'key'"
            @click="authMode = 'key'"
          >
            <v-icon size="14">mdi-key-variant</v-icon>
            <span>{{ t('asset.privateKey') }}</span>
          </button>
          <button
            type="button"
            class="auth-chip"
            :class="{ active: authMode === 'both' }"
            role="radio"
            :aria-checked="authMode === 'both'"
            @click="authMode = 'both'"
          >
            <v-icon size="14">mdi-shield-key-outline</v-icon>
            <span>{{ t('ssh.authBoth') }}</span>
          </button>
          <button
            type="button"
            class="auth-chip"
            :class="{ active: authMode === 'mfa' }"
            role="radio"
            :aria-checked="authMode === 'mfa'"
            @click="authMode = 'mfa'"
          >
            <v-icon size="14">mdi-two-factor-authentication</v-icon>
            <span>{{ t('ssh.mfa2fa') }}</span>
          </button>
        </div>

        <!-- 详情区:仅展示当前 chip 对应的字段 -->
        <template v-if="authMode === 'password' || authMode === 'both'">
          <div class="form-field auth-detail">
            <label class="field-label">
              <v-icon size="12">mdi-lock-outline</v-icon>
              {{ t('asset.password') }}
            </label>
            <div class="input-group">
              <v-icon class="input-prefix" size="13">mdi-lock-outline</v-icon>
              <input
                :model-value="isEditing && !changedPassword ? '' : password"
                @update:model-value="(v: string) => { password = v; changedPassword = true }"
                :type="showPassword ? 'text' : 'password'"
                class="cyber-input"
                :placeholder="isEditing && !changedPassword ? '*'.repeat(8) : '••••••••'"
                autocomplete="off"
              />
              <button
                type="button"
                class="input-suffix-btn"
                @click="showPassword = !showPassword"
              >
                <v-icon size="14">{{ showPassword ? 'mdi-eye-off' : 'mdi-eye' }}</v-icon>
              </button>
            </div>
            <!-- 阿里云堡垒机风格:每次连接都弹 6 位 TOTP 码,自动拼到密码末尾 -->
            <div v-if="authMode === 'password'" class="totp-append-block">
              <label class="totp-append-toggle">
                <input
                  type="checkbox"
                  v-model="appendTotpToPassword"
                />
                <v-icon size="13">mdi-two-factor-authentication</v-icon>
                <span>{{ t('ssh.mfaAppendAtConnect') }}</span>
              </label>
              <div v-if="appendTotpToPassword" class="totp-append-format">
                <div class="auth-chip-group" role="radiogroup">
                  <button
                    type="button"
                    class="auth-chip"
                    :class="{ active: totpAppendFormat === 'none' }"
                    role="radio"
                    :aria-checked="totpAppendFormat === 'none'"
                    @click="totpAppendFormat = 'none'"
                  >
                    <v-icon size="12">mdi-format-letter-case</v-icon>
                    <span>密码123456</span>
                  </button>
                  <button
                    type="button"
                    class="auth-chip"
                    :class="{ active: totpAppendFormat === 'space' }"
                    role="radio"
                    :aria-checked="totpAppendFormat === 'space'"
                    @click="totpAppendFormat = 'space'"
                  >
                    <v-icon size="12">mdi-keyboard-space</v-icon>
                    <span>密码<span class="sep">␣</span>123456</span>
                  </button>
                  <button
                    type="button"
                    class="auth-chip"
                    :class="{ active: totpAppendFormat === 'manual' }"
                    role="radio"
                    :aria-checked="totpAppendFormat === 'manual'"
                    @click="totpAppendFormat = 'manual'"
                  >
                    <v-icon size="12">mdi-pencil-outline</v-icon>
                    <span>{{ t('ssh.mfaAppendManual') }}</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </template>

        <template v-if="authMode === 'key' || authMode === 'both'">
          <div class="form-field auth-detail">
            <label class="field-label">
              <v-icon size="12">mdi-code-tags</v-icon>
              {{ t('asset.privateKey') }}
            </label>
            <input
              ref="fileInputRef"
              type="file"
              class="hidden-file-input"
              accept=".pem,.key,id_rsa,id_ed25519,id_ecdsa,id_dsa,application/x-pem-file,application/x-ssh-key,text/plain"
              @change="onKeyFilePicked"
            />
            <div class="key-file-row">
              <button type="button" class="cyber-btn-secondary key-file-btn" @click="pickKeyFile">
                <v-icon size="13">mdi-file-key-outline</v-icon>
                Select Key
              </button>
              <button type="button" class="cyber-btn-secondary key-file-btn" @click="pasteKeyFromClipboard">
                <v-icon size="13">mdi-clipboard-text-outline</v-icon>
                Paste
              </button>
              <span v-if="privateKeyName" class="key-file-chip">
                <v-icon size="11">mdi-file-document-outline</v-icon>
                <span class="chip-name">{{ privateKeyName }}</span>
                <button type="button" class="chip-clear" @click="clearKey">
                  <v-icon size="11">mdi-close</v-icon>
                </button>
              </span>
            </div>
            <textarea
              v-model="privateKey"
              class="cyber-input code"
              :rows="authMode === 'both' ? 3 : 5"
              placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
            />
          </div>
          <div class="form-field auth-detail">
            <label class="field-label">
              <v-icon size="12">mdi-key-alert</v-icon>
              {{ t('ssh.passphrase') }}
              <span class="optional">{{ t('ssh.passphraseOptional') }}</span>
            </label>
            <div class="input-group">
              <v-icon class="input-prefix" size="13">mdi-key-alert</v-icon>
              <input
                v-model="passphrase"
                :type="showPassphrase ? 'text' : 'password'"
                class="cyber-input"
                :placeholder="t('ssh.passphraseEmpty')"
                autocomplete="off"
              />
              <button type="button" class="input-suffix-btn" @click="showPassphrase = !showPassphrase">
                <v-icon size="14">{{ showPassphrase ? 'mdi-eye-off' : 'mdi-eye' }}</v-icon>
              </button>
            </div>
          </div>
        </template>

        <template v-if="authMode === 'mfa'">
          <div class="form-field auth-detail">
            <label class="field-label">
              <v-icon size="12">mdi-lock-outline</v-icon>
              {{ t('ssh.mfaPrefilled') }}
            </label>
            <div class="input-group">
              <v-icon class="input-prefix" size="13">mdi-lock-outline</v-icon>
              <input
                :model-value="isEditing && !changedMfaPassword ? '' : mfaPassword"
                @update:model-value="(v: string) => { mfaPassword = v; changedMfaPassword = true }"
                :type="showMfaPassword ? 'text' : 'password'"
                class="cyber-input"
                :placeholder="isEditing && !changedMfaPassword ? '*'.repeat(8) : '••••••••'"
                autocomplete="off"
              />
              <button type="button" class="input-suffix-btn" @click="showMfaPassword = !showMfaPassword">
                <v-icon size="14">{{ showMfaPassword ? 'mdi-eye-off' : 'mdi-eye' }}</v-icon>
              </button>
            </div>
          </div>
          <div class="form-field auth-detail">
            <label class="field-label">
              <v-icon size="12">mdi-clock-digital</v-icon>
              TOTP Secret
            </label>
            <input
              v-model="totpSecret"
              type="text"
              class="cyber-input mono"
              placeholder="base32 format, auto-generates 6-digit code"
              autocomplete="off"
            />
          </div>
        </template>
      </div>
    </div>

    <!-- 跳板机 (可折叠) -->
    <div class="jump-host-section">
      <button
        type="button"
        class="jump-toggle"
        :class="{ active: showJumpHost }"
        @click="showJumpHost = !showJumpHost"
      >
        <v-icon size="14">{{ showJumpHost ? 'mdi-chevron-down' : 'mdi-chevron-right' }}</v-icon>
        {{ t('ssh.jumpHost') }}
        <span v-if="showJumpHost && jumpHost" class="jump-badge">{{ jumpHost }}</span>
      </button>

      <div v-if="showJumpHost" class="jump-host-body">
        <div class="form-body">
          <div class="form-column">
            <div class="column-label">{{ t('ssh.jumpServer') }}</div>

            <div class="form-field">
              <label class="field-label">
                <v-icon size="12">mdi-server-network</v-icon>
                {{ t('asset.host') }} : {{ t('asset.port') }}
              </label>
              <div class="form-row host-port">
                <input v-model="jumpHost" type="text" class="cyber-input" :placeholder="t('asset.placeholderHost')" />
                <input v-model.number="jumpPort" type="number" class="cyber-input mono" :placeholder="'22'" />
              </div>
            </div>

            <div class="form-field">
              <label class="field-label">
                <v-icon size="12">mdi-account-outline</v-icon>
                {{ t('asset.username') }}
              </label>
              <div class="input-group">
                <span class="input-prefix">@</span>
                <input v-model="jumpUsername" type="text" class="cyber-input" :placeholder="t('asset.placeholderUser')" />
              </div>
            </div>
          </div>

          <div class="form-column">
            <div class="column-label">{{ t('ssh.jumpAuth') }}</div>

            <div class="form-field">
              <div class="switcher" role="tablist">
                <div class="switcher-item" :class="{ active: jumpAuthType === 'password' }" @click="jumpAuthType = 'password'" role="tab">
                  <v-icon size="14">mdi-key-outline</v-icon>
                  {{ t('asset.password') }}
                </div>
                <div class="switcher-item" :class="{ active: jumpAuthType === 'key' }" @click="jumpAuthType = 'key'" role="tab">
                  <v-icon size="14">mdi-key-variant</v-icon>
                  {{ t('asset.privateKey') }}
                </div>
              </div>
            </div>

            <div v-if="jumpAuthType === 'password'" class="form-field">
              <label class="field-label">
                <v-icon size="12">mdi-lock-outline</v-icon>
                {{ t('asset.password') }}
              </label>
              <div class="input-group">
                <v-icon class="input-prefix" size="13">mdi-lock-outline</v-icon>
                <input v-model="jumpPassword" :type="showJumpPassword ? 'text' : 'password'" class="cyber-input" placeholder="••••••••" autocomplete="off" />
                <button type="button" class="input-suffix-btn" @click="showJumpPassword = !showJumpPassword">
                  <v-icon size="14">{{ showJumpPassword ? 'mdi-eye-off' : 'mdi-eye' }}</v-icon>
                </button>
              </div>
            </div>

            <template v-else>
              <div class="form-field">
                <label class="field-label">
                  <v-icon size="12">mdi-code-tags</v-icon>
                  {{ t('asset.privateKey') }}
                </label>
                <input ref="jumpFileInputRef" type="file" class="hidden-file-input" accept=".pem,.key,id_rsa,id_ed25519,id_ecdsa,id_dsa,text/plain" @change="onJumpKeyFilePicked" />
                <div class="key-file-row">
                  <button type="button" class="cyber-btn-secondary key-file-btn" @click="pickJumpKeyFile">
                    <v-icon size="13">mdi-file-key-outline</v-icon>
                    {{ t('ssh.selectKey') }}
                  </button>
                  <button type="button" class="cyber-btn-secondary key-file-btn" @click="pasteJumpKeyFromClipboard">
                    <v-icon size="13">mdi-clipboard-text-outline</v-icon>
                    {{ t('ssh.pasteFromClipboard') }}
                  </button>
                  <span v-if="jumpPrivateKeyName" class="key-file-chip">
                    <v-icon size="11">mdi-file-document-outline</v-icon>
                    <span class="chip-name">{{ jumpPrivateKeyName }}</span>
                    <button type="button" class="chip-clear" @click="clearJumpKey">
                      <v-icon size="11">mdi-close</v-icon>
                    </button>
                  </span>
                </div>
                <textarea v-model="jumpPrivateKey" class="cyber-input code" rows="3" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" />
              </div>
              <div class="form-field">
                <label class="field-label">
                  <v-icon size="12">mdi-key-alert</v-icon>
                  {{ t('ssh.passphrase') }}
                  <span class="optional">{{ t('ssh.passphraseOptional') }}</span>
                </label>
                <div class="input-group">
                  <v-icon class="input-prefix" size="13">mdi-key-alert</v-icon>
                  <input v-model="jumpPassphrase" :type="showJumpPassphrase ? 'text' : 'password'" class="cyber-input" :placeholder="t('ssh.passphraseEmpty')" autocomplete="off" />
                  <button type="button" class="input-suffix-btn" @click="showJumpPassphrase = !showJumpPassphrase">
                    <v-icon size="14">{{ showJumpPassphrase ? 'mdi-eye-off' : 'mdi-eye' }}</v-icon>
                  </button>
                </div>
              </div>
            </template>
          </div>
        </div>
      </div>
    </div>

    <!-- 测试连接状态 -->
    <div v-if="testStatus !== 'idle'" class="test-status" :class="testStatus">
      <v-icon size="14">
        {{ testStatus === 'testing' ? 'mdi-loading mdi-spin' : testStatus === 'success' ? 'mdi-check-circle' : 'mdi-alert-circle' }}
      </v-icon>
      <span>{{ testMessage }}</span>
    </div>

    <!-- Footer -->
    <div class="form-footer">
      <div class="footer-left">
        <button
          type="button"
          class="cyber-btn-test"
          :disabled="!canTest || testStatus === 'testing'"
          :class="{ testing: testStatus === 'testing' }"
          @click="onTestConnection"
        >
          <v-icon size="14">
            {{ testStatus === 'testing' ? 'mdi-loading mdi-spin' : 'mdi-connection' }}
          </v-icon>
          {{ testStatus === 'testing' ? t('ssh.testing') : t('ssh.testConnection') }}
        </button>
      </div>
      <div class="footer-right">
        <div class="shortcut-hint">
          <kbd>⌘</kbd>+<kbd>Enter</kbd> {{ t('common.save') }} · <kbd>Esc</kbd> {{ t('common.cancel') }}
        </div>
        <button type="button" class="cyber-btn-secondary" @click="onCancel">
          <v-icon size="14">mdi-close</v-icon>
          {{ t('common.cancel') }}
        </button>
        <button
          type="submit"
          class="cyber-btn"
          :disabled="!canSubmit"
          :style="{ opacity: canSubmit ? 1 : 0.4, cursor: canSubmit ? 'pointer' : 'not-allowed' }"
        >
          <v-icon size="14">mdi-content-save-outline</v-icon>
          {{ t('common.save') }}
        </button>
      </div>
    </div>

    <!-- 测试连接触发的 MFA 弹窗(临时 sessionId) -->
    <KbInteractiveDialog
      v-if="testSessionId"
      ref="kbDialogRef"
      :session-id="testSessionId"
      :host="host"
      @done="() => {}"
      @cancelled="() => {}"
    />

    <!-- 「密码 + TOTP 拼接」弹窗(写入资产 config,每次连接都弹) -->
    <TotpAppendDialog
      ref="totpDialogRef"
      :host="host"
      :username="username"
      :default-format="totpAppendFormat"
      @submit="onTotpSubmit"
      @cancelled="onTotpCancelled"
    />
  </form>
</template>

<style scoped>
.ssh-form {
  display: flex;
  flex-direction: column;
  gap: 0;
}

.host-port .cyber-input {
  padding: 5px 8px;
  font-size: 12px;
  height: 30px;
  min-height: auto;
}

.form-body {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}

@media (max-width: 520px) {
  .form-body {
    grid-template-columns: 1fr;
  }
}

.form-column {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.column-label {
  font-size: 10px;
  font-weight: 700;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.12em;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--line);
  display: flex;
  align-items: center;
  gap: 6px;
}

.column-label::after {
  content: "";
  flex: 1;
  height: 1px;
  background: linear-gradient(90deg, var(--line-2), transparent);
}

.form-field {
  display: flex;
  flex-direction: column;
}

/* 私钥文件选择 */
.hidden-file-input {
  position: absolute;
  width: 0;
  height: 0;
  opacity: 0;
  pointer-events: none;
}

.key-file-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  flex-wrap: wrap;
}

.key-file-btn {
  padding: 6px 12px;
  font-size: 12px;
}

.key-file-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 4px 4px 10px;
  font-size: 11px;
  color: var(--cyan);
  background: var(--hover-cyan);
  border: 1px solid var(--focus-cyan);
  border-radius: 6px;
  font-family: 'JetBrains Mono', monospace;
  max-width: 100%;
}

.chip-name {
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chip-clear {
  width: 18px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: 0;
  color: var(--muted);
  cursor: pointer;
  border-radius: 4px;
  padding: 0;
  flex-shrink: 0;
  transition: all 0.2s;
}

.chip-clear:hover {
  color: var(--red);
  background: rgba(255, 77, 109, 0.12);
}

/* Input suffix button (eye icon etc.) */
.input-suffix-btn {
  position: absolute;
  right: 6px;
  width: 28px;
  height: 28px;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--muted);
  background: transparent;
  border: 1px solid transparent;
  cursor: pointer;
  transition: all 0.2s;
}

.input-suffix-btn:hover {
  color: var(--cyan);
  background: var(--hover-cyan);
}

/* Test status feedback */
.test-status {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-radius: 8px;
  font-size: 12px;
  margin-top: 4px;
  animation: fadeIn 0.2s ease;
}

.test-status.testing {
  background: var(--hover-cyan);
  border: 1px solid var(--focus-cyan);
  color: var(--cyan);
}

.test-status.success {
  background: rgba(74, 222, 128, 0.08);
  border: 1px solid rgba(74, 222, 128, 0.2);
  color: var(--green);
}

.test-status.fail {
  background: rgba(255, 77, 109, 0.08);
  border: 1px solid rgba(255, 77, 109, 0.2);
  color: var(--red);
}

@keyframes fadeIn {
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: translateY(0); }
}

/* Footer layout */
.form-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-top: 16px;
  margin-top: 20px;
  border-top: 1px solid var(--line);
}

.footer-left {
  display: flex;
  align-items: center;
}

.footer-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.shortcut-hint {
  font-size: 10px;
  color: var(--muted);
  margin-right: 8px;
  white-space: nowrap;
}

.shortcut-hint kbd {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  padding: 2px 5px;
  background: var(--kbd-bg);
  border: 1px solid var(--line-2);
  border-radius: 3px;
  color: var(--cyan);
}

/* Test connection button */
.cyber-btn-test {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 14px;
  border-radius: 8px;
  font-size: 12px;
  font-weight: 500;
  font-family: inherit;
  color: var(--cyan);
  background: var(--hover-cyan);
  border: 1px solid var(--focus-cyan);
  cursor: pointer;
  transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
}

.cyber-btn-test:hover:not(:disabled) {
  background: var(--active-cyan);
  border-color: var(--focus-cyan);
  box-shadow: var(--glow-soft);
}

.cyber-btn-test:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.cyber-btn-test.testing {
  color: var(--cyan);
  border-color: var(--focus-cyan);
  animation: testPulse 1.5s infinite;
}

@keyframes testPulse {
  0%, 100% { box-shadow: 0 0 0 0 var(--focus-cyan); }
  50% { box-shadow: 0 0 0 6px transparent; }
}

:deep(.mdi-spin) {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

/* 字段标签里的「可选」灰字 */
.optional {
  font-size: 10px;
  color: var(--muted);
  font-weight: 400;
  margin-left: 4px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

/* 「密码 + TOTP 拼接」开关 */
.totp-append-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
  font-size: 11px;
  color: var(--text-2);
  cursor: pointer;
  user-select: none;
}

.totp-append-toggle input[type="checkbox"] {
  width: 14px;
  height: 14px;
  accent-color: var(--cyan);
  cursor: pointer;
}

.totp-append-toggle:hover {
  color: var(--cyan);
}

/* Jump host section */
.jump-host-section {
  margin-top: 16px;
  border-top: 1px solid var(--line);
  padding-top: 12px;
}

.jump-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border: 1px solid var(--line-2);
  border-radius: 8px;
  background: transparent;
  color: var(--text-2);
  font-size: 12px;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
  transition: all 0.2s;
}

.jump-toggle:hover {
  color: var(--cyan);
  border-color: var(--focus-cyan);
  background: var(--hover-cyan-faint);
}

.jump-toggle.active {
  color: var(--cyan);
  border-color: var(--focus-cyan);
  background: var(--hover-cyan);
}

.jump-badge {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  color: var(--muted);
  margin-left: 4px;
}

.jump-host-body {
  margin-top: 12px;
  animation: fadeIn 0.2s ease;
}

/* MFA 详情区已并入右列 authMode 联动,旧 .mfa-section 样式废弃 */

.auth-detail {
  margin-left: 24px;
  padding-left: 12px;
  border-left: 1px solid var(--line-2);
}
</style>
