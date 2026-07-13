<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { CreateAssetDto, SftpLaunchMode } from '@/types/asset'
import type { KbInteractiveEvent } from '@/services/ssh'
import KbInteractiveDialog from './KbInteractiveDialog.vue'

const { t } = useI18n()

// 跨平台快捷键修饰键(Mac ⌘, Win/Linux Ctrl)
const isMac = ref(false)
const modKey = computed(() => isMac.value ? '⌘' : 'Ctrl')
onMounted(() => {
  const ua = navigator.userAgent.toLowerCase()
  isMac.value = /mac|iphone|ipad|ipod/.test(ua)
})

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
  sftpTimeoutSec?: number
  sftpLaunchMode?: SftpLaunchMode
  sftpServerPath?: string
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
const sftpTimeoutSec = ref<number>(props.initialValues?.sftpTimeoutSec ?? 30)
const sftpLaunchMode = ref<SftpLaunchMode>(props.initialValues?.sftpLaunchMode ?? 'auto')
const sftpServerPath = ref(props.initialValues?.sftpServerPath ?? '')
const password = ref(props.initialValues?.password ?? '')
const privateKey = ref(props.initialValues?.privateKey ?? '')
const privateKeyName = ref('')
const passphrase = ref(props.initialValues?.passphrase ?? '')
const showPassword = ref(false)
const showPassphrase = ref(false)
const mfaPassword = ref(props.initialValues?.mfaPassword ?? '')
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
    sftpTimeoutSec.value = next.sftpTimeoutSec ?? 30
    sftpLaunchMode.value = next.sftpLaunchMode ?? 'auto'
    sftpServerPath.value = next.sftpServerPath ?? ''
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
    jumpHost.value = next.jumpHost ?? ''
    jumpPort.value = next.jumpPort ?? 22
    jumpUsername.value = next.jumpUsername ?? ''
    jumpPassword.value = next.jumpPassword ?? ''
    jumpPrivateKey.value = next.jumpPrivateKey ?? ''
    jumpPrivateKeyName.value = next.jumpPrivateKey ? 'Loaded' : ''
    jumpPassphrase.value = next.jumpPassphrase ?? ''
    jumpAuthType.value = next.jumpPrivateKey ? 'key' : 'password'
    showJumpHost.value = Boolean(next.jumpHost)
    changedPassword.value = false
    changedMfaPassword.value = false
    showPassword.value = false
    showPassphrase.value = false
    showMfaPassword.value = false
    testStatus.value = 'idle'
    testMessage.value = ''
  }
)

function normalizeSftpTimeout() {
  const parsed = Number.isFinite(sftpTimeoutSec.value) ? Math.round(sftpTimeoutSec.value) : 30
  sftpTimeoutSec.value = Math.min(300, Math.max(5, parsed))
}

// 用户修正任一连接字段后，旧的失败结果已经失效，不应继续挂在表单上。
watch(
  [
    host,
    port,
    username,
    sftpTimeoutSec,
    sftpLaunchMode,
    sftpServerPath,
    password,
    privateKey,
    passphrase,
    authMode,
    mfaPassword,
    showJumpHost,
    jumpHost,
    jumpPort,
    jumpUsername,
    jumpAuthType,
    jumpPassword,
    jumpPrivateKey,
    jumpPassphrase,
  ],
  () => {
    if (testStatus.value !== 'testing') {
      testStatus.value = 'idle'
      testMessage.value = ''
    }
  }
)

// 派生:不同 authMode 对应的填写校验
const needPassword = computed(() => authMode.value === 'password' || authMode.value === 'both')
const needKey = computed(() => authMode.value === 'key' || authMode.value === 'both')
const needMfa = computed(() => authMode.value === 'mfa')
const validSftpServerPath = computed(() =>
  sftpLaunchMode.value !== 'custom' || sftpServerPath.value.trim().startsWith('/')
)

const canSubmit = computed(() =>
  Boolean(name.value && host.value && username.value) &&
  validSftpServerPath.value &&
  (!needKey.value || privateKey.value.length > 0) &&
  (!showJumpHost.value || !jumpHost.value || (jumpAuthType.value === 'password' ? true : jumpPrivateKey.value.length > 0))
)

const canTest = computed(() =>
  Boolean(host.value && username.value) &&
  validSftpServerPath.value &&
  (!needKey.value || privateKey.value.length > 0) &&
  (!showJumpHost.value || !jumpHost.value || (jumpAuthType.value === 'password' ? true : jumpPrivateKey.value.length > 0))
)

/**
 * [DEBUG] 调试 helper:把 auth 对象里的密码/key 字段替换成长度,
 * 打印到 console 时不会泄漏明文。
 */
function maskAuth(auth: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(auth)) {
    if (v && typeof v === 'object') {
      const inner: Record<string, unknown> = {}
      for (const [ik, iv] of Object.entries(v as Record<string, unknown>)) {
        if (typeof iv === 'string') {
          inner[ik] = `<str len=${(iv as string).length}>`
        } else {
          inner[ik] = iv
        }
      }
      out[k] = inner
    } else {
      out[k] = v
    }
  }
  return out
}

async function onTestConnection() {
  if (!canTest.value) return
  normalizeSftpTimeout()
  testStatus.value = 'testing'
  testMessage.value = ''

  // 编辑态 + 密码认证 + 用户没改过密码框 → password.value 可能是空(密码框默认不回显),
  // 此时不能直接发空密码,服务端会 reject。提示用户先输密码。
  if (
    isEditing.value &&
    !changedPassword.value &&
    (authMode.value === 'password' || authMode.value === 'both') &&
    !password.value
  ) {
    testStatus.value = 'fail'
    testMessage.value = t('ssh.testNeedPassword')
    return
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
    // MFA 模式:用 mfaPassword 做主认证密码
    const basePassword = authMode.value === 'mfa' ? mfaPassword.value : password.value
    const finalPassword = basePassword

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
      sftp_timeout_sec: sftpTimeoutSec.value,
      sftp_launch_mode: sftpLaunchMode.value,
      sftp_server_path: sftpLaunchMode.value === 'custom' ? sftpServerPath.value.trim() : null,
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
      }
    }

    const result = await invoke<{ ok: boolean; message?: string; elapsed_ms?: number }>(
      'test_ssh_connection',
      { config, testSessionId: testSessionId.value }
    )
    // [DEBUG] 调试:打印测试连接时实际发出去的 auth 形状(密码长度而非明文),
    // 便于定位 "密码丢失/被覆盖" 类问题。诊断完可删。
    // eslint-disable-next-line no-console
    console.log('[ssh:test] sending config =', {
      host: config.host,
      port: config.port,
      username: config.username,
      auth: maskAuth(config.auth as Record<string, unknown>),
      kb_interactive: config.kb_interactive,
      authMode: authMode.value,
      mfaPassword: mfaPassword.value ? `<len=${mfaPassword.value.length}>` : 'empty',
      isEditing: isEditing.value,
      changedPassword: changedPassword.value,
    })
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
  }
}

function onSubmit() {
  if (!canSubmit.value) return
  normalizeSftpTimeout()

  const config: Record<string, unknown> = {
    host: host.value,
    port: port.value,
    username: username.value,
    authMode: authMode.value,
    // 旧字段继续写,保持后端 buildAuth 兼容(详见 src/services/ssh.ts)
    usePasswordAuth: needPassword.value,
    useKeyAuth: needKey.value,
    sftpTimeoutSec: sftpTimeoutSec.value,
    sftpLaunchMode: sftpLaunchMode.value,
    sftpServerPath: sftpLaunchMode.value === 'custom' ? sftpServerPath.value.trim() : undefined,
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
    config.password = isEditing.value && !changedMfaPassword.value ? undefined : (mfaPassword.value || undefined)
    config.usePasswordAuth = true
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
const LAST_KEY_DIRECTORY = 'starhub:ssh-key-directory'

interface LoadedPrivateKey {
  name: string
  content: string
}

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

function looksLikePrivateKey(content: string): boolean {
  const value = content.trimStart()
  return value.startsWith('PuTTY-User-Key-File-') || [
    '-----BEGIN OPENSSH PRIVATE KEY-----',
    '-----BEGIN RSA PRIVATE KEY-----',
    '-----BEGIN EC PRIVATE KEY-----',
    '-----BEGIN PRIVATE KEY-----',
    '-----BEGIN ENCRYPTED PRIVATE KEY-----',
  ].some((header) => value.startsWith(header))
}

async function readBrowserPrivateKey(file: File): Promise<string> {
  if (file.size > MAX_KEY_SIZE) {
    throw new Error(t('ssh.keyTooLarge'))
  }

  const bytes = new Uint8Array(await file.arrayBuffer())
  let content: string
  try {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) {
      content = new TextDecoder('utf-16le', { fatal: true }).decode(bytes.subarray(2))
    } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      content = new TextDecoder('utf-16be', { fatal: true }).decode(bytes.subarray(2))
    } else {
      content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    }
  } catch {
    throw new Error(t('ssh.keyInvalidEncoding'))
  }

  if (!looksLikePrivateKey(content)) {
    throw new Error(t('ssh.keyInvalidFormat'))
  }
  return content
}

/**
 * 使用 Tauri 原生对话框直接打开 ~/.ssh 或本次会话上次选择的目录。
 * 返回 null 表示用户取消；浏览器预览由隐藏的 file input 降级处理。
 */
async function pickNativePrivateKey(): Promise<LoadedPrivateKey | null> {
  const { open } = await import('@tauri-apps/plugin-dialog')
  const { dirname, homeDir, join } = await import('@tauri-apps/api/path')
  const { invoke } = await import('@tauri-apps/api/core')

  let defaultPath = sessionStorage.getItem(LAST_KEY_DIRECTORY) ?? undefined
  if (!defaultPath) {
    defaultPath = await join(await homeDir(), '.ssh')
  }
  const selected = await open({
    title: t('ssh.selectKey'),
    multiple: false,
    directory: false,
    defaultPath,
  })
  if (!selected) return null

  const path = selected as string
  const content = await invoke<string>('read_ssh_private_key_file', { path })
  sessionStorage.setItem(LAST_KEY_DIRECTORY, await dirname(path))
  return {
    name: path.split(/[/\\]/).pop() || path,
    content,
  }
}

async function pickKeyFile() {
  if (!isTauriRuntime()) {
    fileInputRef.value?.click()
    return
  }
  try {
    const loaded = await pickNativePrivateKey()
    if (!loaded) return
    privateKey.value = loaded.content
    privateKeyName.value = loaded.name
  } catch (err) {
    testStatus.value = 'fail'
    testMessage.value = err instanceof Error ? err.message : String(err)
  }
}

async function onKeyFilePicked(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return

  try {
    privateKey.value = await readBrowserPrivateKey(file)
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
async function pickJumpKeyFile() {
  if (!isTauriRuntime()) {
    jumpFileInputRef.value?.click()
    return
  }
  try {
    const loaded = await pickNativePrivateKey()
    if (!loaded) return
    jumpPrivateKey.value = loaded.content
    jumpPrivateKeyName.value = loaded.name
  } catch (err) {
    testStatus.value = 'fail'
    testMessage.value = err instanceof Error ? err.message : String(err)
  }
}

async function onJumpKeyFilePicked(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return

  try {
    jumpPrivateKey.value = await readBrowserPrivateKey(file)
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

        <div class="form-field">
          <label class="field-label" for="ssh-sftp-timeout">
            <v-icon size="12">mdi-timer-sand</v-icon>
            {{ t('ssh.sftpTimeout') }}
          </label>
          <input
            id="ssh-sftp-timeout"
            v-model.number="sftpTimeoutSec"
            type="number"
            class="cyber-input cyber-number-input"
            min="5"
            max="300"
            step="1"
            :aria-label="t('ssh.sftpTimeout')"
            @blur="normalizeSftpTimeout"
          />
          <span class="field-hint">{{ t('ssh.sftpTimeoutHint') }}</span>
        </div>

        <div class="form-field">
          <label class="field-label" for="ssh-sftp-launch-mode">
            <v-icon size="12">mdi-cog-transfer-outline</v-icon>
            {{ t('ssh.sftpLaunchMode') }}
          </label>
          <select
            id="ssh-sftp-launch-mode"
            v-model="sftpLaunchMode"
            class="cyber-select"
            :aria-label="t('ssh.sftpLaunchMode')"
          >
            <option value="auto">{{ t('ssh.sftpLaunchAuto') }}</option>
            <option value="subsystem">{{ t('ssh.sftpLaunchSubsystem') }}</option>
            <option value="custom">{{ t('ssh.sftpLaunchCustom') }}</option>
          </select>
          <span class="field-hint">{{ t(`ssh.sftpLaunchHint.${sftpLaunchMode}`) }}</span>
        </div>

        <div v-if="sftpLaunchMode === 'custom'" class="form-field">
          <label class="field-label" for="ssh-sftp-server-path">
            <v-icon size="12">mdi-file-code-outline</v-icon>
            {{ t('ssh.sftpServerPath') }}
            <span class="required">*</span>
          </label>
          <input
            id="ssh-sftp-server-path"
            v-model="sftpServerPath"
            type="text"
            class="cyber-input mono"
            placeholder="/usr/libexec/openssh/sftp-server"
            :aria-label="t('ssh.sftpServerPath')"
            :aria-invalid="!validSftpServerPath"
            required
          />
          <span class="field-hint" :class="{ error: !validSftpServerPath }">
            {{ validSftpServerPath ? t('ssh.sftpServerPathHint') : t('ssh.sftpServerPathInvalid') }}
          </span>
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
                v-model="password"
                @input="changedPassword = true"
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
              accept=".pem,.key,.ppk"
              @change="onKeyFilePicked"
            />
            <div class="key-file-row">
              <button type="button" class="cyber-btn-secondary key-file-btn" @click="pickKeyFile">
                <v-icon size="13">mdi-file-key-outline</v-icon>
                {{ t('ssh.selectKey') }}
              </button>
              <button type="button" class="cyber-btn-secondary key-file-btn" @click="pasteKeyFromClipboard">
                <v-icon size="13">mdi-clipboard-text-outline</v-icon>
                {{ t('ssh.pasteFromClipboard') }}
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
                v-model="mfaPassword"
                @input="changedMfaPassword = true"
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
                <input ref="jumpFileInputRef" type="file" class="hidden-file-input" accept=".pem,.key,.ppk" @change="onJumpKeyFilePicked" />
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
          <kbd>{{ modKey }}</kbd>+<kbd>Enter</kbd> {{ t('common.save') }} · <kbd>Esc</kbd> {{ t('common.cancel') }}
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
