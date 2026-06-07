<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { CreateAssetDto } from '@/types/asset'

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
}

const props = defineProps<{
  initialValues?: SshFormInitialValues
}>()

const emit = defineEmits<{
  submit: [dto: CreateAssetDto]
  cancel: []
}>()

const name = ref(props.initialValues?.name ?? '')
const host = ref(props.initialValues?.host ?? '')
const port = ref<number>(props.initialValues?.port ?? 22)
const username = ref(props.initialValues?.username ?? '')
const authType = ref<'password' | 'key'>(
  props.initialValues?.privateKey ? 'key' : 'password'
)
const password = ref(props.initialValues?.password ?? '')
const privateKey = ref(props.initialValues?.privateKey ?? '')
const privateKeyName = ref('')
const passphrase = ref(props.initialValues?.passphrase ?? '')
const showPassword = ref(false)
const showPassphrase = ref(false)
const fileInputRef = ref<HTMLInputElement | null>(null)

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
    privateKeyName.value = next.privateKey ? t('ssh.keyLoaded') : ''
    passphrase.value = next.passphrase ?? ''
    authType.value = next.privateKey ? 'key' : 'password'
    // 跳板机
    jumpHost.value = next.jumpHost ?? ''
    jumpPort.value = next.jumpPort ?? 22
    jumpUsername.value = next.jumpUsername ?? ''
    jumpPassword.value = next.jumpPassword ?? ''
    jumpPrivateKey.value = next.jumpPrivateKey ?? ''
    jumpPrivateKeyName.value = next.jumpPrivateKey ? t('ssh.keyLoaded') : ''
    jumpPassphrase.value = next.jumpPassphrase ?? ''
    jumpAuthType.value = next.jumpPrivateKey ? 'key' : 'password'
    showJumpHost.value = Boolean(next.jumpHost)
  }
)

const canSubmit = computed(() =>
  Boolean(name.value && host.value && username.value) &&
  (authType.value === 'password' ? true : privateKey.value.length > 0) &&
  (!showJumpHost.value || !jumpHost.value || (jumpAuthType.value === 'password' ? true : jumpPrivateKey.value.length > 0))
)

const canTest = computed(() =>
  Boolean(host.value && username.value) &&
  (authType.value === 'password' ? true : privateKey.value.length > 0) &&
  (!showJumpHost.value || !jumpHost.value || (jumpAuthType.value === 'password' ? true : jumpPrivateKey.value.length > 0))
)

async function onTestConnection() {
  if (!canTest.value) return
  testStatus.value = 'testing'
  testMessage.value = ''
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const auth = authType.value === 'password'
      ? { Password: password.value || '' }
      : { PrivateKey: { key: privateKey.value, passphrase: passphrase.value || null } }

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

    const result = await invoke<{ ok: boolean; message?: string; elapsed_ms?: number }>(
      'test_ssh_connection',
      { config }
    )
    testStatus.value = result.ok ? 'success' : 'fail'
    const ms = result.elapsed_ms != null ? ` (${result.elapsed_ms}ms)` : ''
    testMessage.value = (result.message ?? (result.ok ? t('ssh.testSuccess') : t('ssh.testFail'))) + ms
  } catch (err: unknown) {
    testStatus.value = 'fail'
    testMessage.value = err instanceof Error ? err.message : String(err)
  }
}

function onSubmit() {
  if (!canSubmit.value) return

  const config: Record<string, unknown> = {
    host: host.value,
    port: port.value,
    username: username.value,
    password: authType.value === 'password' ? password.value : undefined,
    privateKey: authType.value === 'key' ? privateKey.value : undefined,
    passphrase: authType.value === 'key' ? passphrase.value : undefined
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

        <!-- 认证方式切换 -->
        <div class="form-field">
          <div class="switcher" role="tablist">
            <div
              class="switcher-item"
              :class="{ active: authType === 'password' }"
              @click="authType = 'password'"
              role="tab"
            >
              <v-icon size="14">mdi-key-outline</v-icon>
              {{ t('asset.password') }}
            </div>
            <div
              class="switcher-item"
              :class="{ active: authType === 'key' }"
              @click="authType = 'key'"
              role="tab"
            >
              <v-icon size="14">mdi-key-variant</v-icon>
              {{ t('asset.privateKey') }}
            </div>
          </div>
        </div>

        <!-- 密码模式 -->
        <div v-if="authType === 'password'" class="form-field">
          <label class="field-label">
            <v-icon size="12">mdi-lock-outline</v-icon>
            {{ t('asset.password') }}
            <span class="optional">{{ t('ssh.passwordOptional') }}</span>
          </label>
          <div class="input-group">
            <v-icon class="input-prefix" size="13">mdi-lock-outline</v-icon>
            <input
              v-model="password"
              :type="showPassword ? 'text' : 'password'"
              class="cyber-input"
              :placeholder="'••••••••'"
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
          <div class="field-hint">{{ t('ssh.passwordHint') }}</div>
        </div>

        <!-- 私钥模式 -->
        <template v-else>
          <div class="form-field">
            <label class="field-label">
              <v-icon size="12">mdi-code-tags</v-icon>
              {{ t('asset.privateKey') }}
              <span class="required">*</span>
              <span class="optional">{{ t('ssh.pemFormat') }}</span>
            </label>
            <!-- 隐藏 file input,由按钮触发 -->
            <input
              ref="fileInputRef"
              type="file"
              class="hidden-file-input"
              accept=".pem,.key,id_rsa,id_ed25519,id_ecdsa,id_dsa,application/x-pem-file,application/x-ssh-key,text/plain"
              @change="onKeyFilePicked"
            />
            <div class="key-file-row">
              <button
                type="button"
                class="cyber-btn-secondary key-file-btn"
                @click="pickKeyFile"
              >
                <v-icon size="13">mdi-file-key-outline</v-icon>
                {{ t('ssh.selectKey') }}
              </button>
              <button
                type="button"
                class="cyber-btn-secondary key-file-btn"
                @click="pasteKeyFromClipboard"
              >
                <v-icon size="13">mdi-clipboard-text-outline</v-icon>
                {{ t('ssh.pasteFromClipboard') }}
              </button>
              <span v-if="privateKeyName" class="key-file-chip">
                <v-icon size="11">mdi-file-document-outline</v-icon>
                <span class="chip-name">{{ privateKeyName }}</span>
                <button
                  type="button"
                  class="chip-clear"
                  :title="t('ssh.clearKey')"
                  @click="clearKey"
                >
                  <v-icon size="11">mdi-close</v-icon>
                </button>
              </span>
            </div>
            <textarea
              v-model="privateKey"
              class="cyber-input code"
              rows="5"
              :placeholder="'-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ...\n-----END OPENSSH PRIVATE KEY-----'"
            />
          </div>
          <div class="form-field">
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
              <button
                type="button"
                class="input-suffix-btn"
                @click="showPassphrase = !showPassphrase"
              >
                <v-icon size="14">{{ showPassphrase ? 'mdi-eye-off' : 'mdi-eye' }}</v-icon>
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
  background: rgba(0, 240, 255, 0.08);
  border: 1px solid rgba(0, 240, 255, 0.2);
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
  background: rgba(0, 240, 255, 0.08);
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
  background: rgba(0, 240, 255, 0.06);
  border: 1px solid rgba(0, 240, 255, 0.15);
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
  background: rgba(0, 240, 255, 0.06);
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
  background: rgba(0, 240, 255, 0.06);
  border: 1px solid rgba(0, 240, 255, 0.2);
  cursor: pointer;
  transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
}

.cyber-btn-test:hover:not(:disabled) {
  background: rgba(0, 240, 255, 0.12);
  border-color: rgba(0, 240, 255, 0.35);
  box-shadow: 0 0 12px rgba(0, 240, 255, 0.15);
}

.cyber-btn-test:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.cyber-btn-test.testing {
  color: var(--cyan);
  border-color: rgba(0, 240, 255, 0.3);
  animation: testPulse 1.5s infinite;
}

@keyframes testPulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(0, 240, 255, 0.2); }
  50% { box-shadow: 0 0 0 6px rgba(0, 240, 255, 0); }
}

:deep(.mdi-spin) {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
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
  border-color: rgba(0, 240, 255, 0.2);
  background: rgba(0, 240, 255, 0.04);
}

.jump-toggle.active {
  color: var(--cyan);
  border-color: rgba(0, 240, 255, 0.3);
  background: rgba(0, 240, 255, 0.06);
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
</style>
