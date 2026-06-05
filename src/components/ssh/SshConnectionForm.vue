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
const passphrase = ref(props.initialValues?.passphrase ?? '')
const showPassword = ref(false)
const showPassphrase = ref(false)

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
    passphrase.value = next.passphrase ?? ''
    authType.value = next.privateKey ? 'key' : 'password'
  }
)

const canSubmit = computed(() =>
  Boolean(name.value && host.value && username.value) &&
  (authType.value === 'password' ? true : privateKey.value.length > 0)
)

const canTest = computed(() =>
  Boolean(host.value && username.value) &&
  (authType.value === 'password' ? true : privateKey.value.length > 0)
)

async function onTestConnection() {
  if (!canTest.value) return
  testStatus.value = 'testing'
  testMessage.value = ''
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const result = await invoke<{ ok: boolean; message?: string }>('test_ssh_connection', {
      host: host.value,
      port: port.value,
      username: username.value,
      password: authType.value === 'password' ? password.value : undefined,
      privateKey: authType.value === 'key' ? privateKey.value : undefined,
      passphrase: authType.value === 'key' ? passphrase.value : undefined
    })
    testStatus.value = result.ok ? 'success' : 'fail'
    testMessage.value = result.message ?? (result.ok ? t('ssh.testSuccess') : t('ssh.testFail'))
  } catch (err: unknown) {
    testStatus.value = 'fail'
    testMessage.value = err instanceof Error ? err.message : String(err)
  }
}

function onSubmit() {
  if (!canSubmit.value) return

  const dto: CreateAssetDto = {
    type: 'ssh',
    name: name.value,
    config: {
      host: host.value,
      port: port.value,
      username: username.value,
      password: authType.value === 'password' ? password.value : undefined,
      privateKey: authType.value === 'key' ? privateKey.value : undefined,
      passphrase: authType.value === 'key' ? passphrase.value : undefined
    }
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
</style>
