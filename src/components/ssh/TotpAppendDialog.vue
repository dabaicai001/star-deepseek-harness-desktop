<script setup lang="ts">
import { ref, computed, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

/**
 * 拼接格式:
 *  - 'none': 密码 + 6位码(无分隔),阿里云常见
 *  - 'space': 密码 + 空格 + 6位码
 *  - 'manual': 用户自己拼好了(完整密码在 code 字段直接提交)
 */
export type ConcatFormat = 'none' | 'space' | 'manual'

const props = defineProps<{
  host: string
  username: string
  /** 默认拼接格式(由父组件传入,如 'none' | 'space' | 'manual') */
  defaultFormat?: ConcatFormat
}>()

const emit = defineEmits<{
  /** 拼接完成,返回最终密码 */
  submit: [result: { code: string; format: ConcatFormat }]
  cancelled: []
}>()

const code = ref('')
const format = ref<ConcatFormat>('none')
const submitting = ref(false)
let countdownTimer: number | null = null
const countdown = ref(30)

const visible = ref(false)

function open(_defaultFormat?: ConcatFormat) {
  code.value = ''
  format.value = _defaultFormat ?? props.defaultFormat ?? 'none'
  submitting.value = false
  countdown.value = 30
  visible.value = true
  startCountdown()
}

function close() {
  stopCountdown()
  visible.value = false
}

function startCountdown() {
  stopCountdown()
  countdownTimer = window.setInterval(() => {
    countdown.value--
    if (countdown.value <= 0) countdown.value = 30 // 30s 自动续,提示用户新码可能已生成
  }, 1000)
}

function stopCountdown() {
  if (countdownTimer !== null) {
    clearInterval(countdownTimer)
    countdownTimer = null
  }
}

function handleSubmit() {
  if (submitting.value) return
  const trimmed = code.value.trim()
  if (format.value !== 'manual' && !/^\d{6}$/.test(trimmed)) {
    return
  }
  submitting.value = true
  emit('submit', { code: trimmed, format: format.value })
  submitting.value = false
  close()
}

function handleCancel() {
  stopCountdown()
  visible.value = false
  emit('cancelled')
}

onBeforeUnmount(() => {
  stopCountdown()
})

defineExpose({ open, close })

const submitDisabled = computed(() => {
  if (format.value === 'manual') return code.value.length === 0
  return !/^\d{6}$/.test(code.value.trim())
})
</script>

<template>
  <v-dialog :model-value="visible" persistent max-width="420" @keydown.esc="handleCancel">
    <div class="totp-dialog" v-if="visible">
      <div class="totp-header">
        <div class="totp-title">
          <v-icon size="16" color="var(--cyan)">mdi-two-factor-authentication</v-icon>
          <span>{{ t('ssh.mfaAppendTitle') }}</span>
        </div>
        <div class="totp-host">{{ username }}@{{ host }}</div>
      </div>

      <div class="totp-body">
        <div class="totp-hint">
          {{ t('ssh.mfaAppendHint') }}
        </div>

        <div class="totp-field">
          <label class="totp-label">{{ t('ssh.mfa6digit') }}</label>
          <input
            v-model="code"
            type="text"
            inputmode="numeric"
            maxlength="6"
            class="cyber-input mono totp-input"
            :placeholder="t('ssh.mfa6digitPlaceholder')"
            autocomplete="off"
            @keydown.enter="handleSubmit"
          />
        </div>

        <div class="totp-format">
          <label class="totp-label">{{ t('ssh.mfaAppendFormat') }}</label>
          <div class="totp-format-group">
            <button
              type="button"
              class="auth-chip"
              :class="{ active: format === 'none' }"
              @click="format = 'none'"
            >
              <v-icon size="13">mdi-format-letter-case</v-icon>
              <span>密码123456</span>
            </button>
            <button
              type="button"
              class="auth-chip"
              :class="{ active: format === 'space' }"
              @click="format = 'space'"
            >
              <v-icon size="13">mdi-keyboard-space</v-icon>
              <span>密码<span class="sep">␣</span>123456</span>
            </button>
            <button
              type="button"
              class="auth-chip"
              :class="{ active: format === 'manual' }"
              @click="format = 'manual'"
            >
              <v-icon size="13">mdi-pencil-outline</v-icon>
              <span>{{ t('ssh.mfaAppendManual') }}</span>
            </button>
          </div>
        </div>
      </div>

      <div class="totp-footer">
        <div class="totp-countdown">
          <v-icon size="12">mdi-clock-outline</v-icon>
          {{ t('ssh.mfa30sRefresh', { sec: countdown }) }}
        </div>
        <div class="totp-actions">
          <button
            type="button"
            class="cyber-btn-secondary"
            @click="handleCancel"
            :disabled="submitting"
          >
            {{ t('common.cancel') }}
          </button>
          <button
            type="button"
            class="cyber-btn"
            @click="handleSubmit"
            :disabled="submitDisabled || submitting"
          >
            <v-icon v-if="submitting" size="14" class="mdi-spin">mdi-loading</v-icon>
            {{ t('common.ok') }}
          </button>
        </div>
      </div>
    </div>
  </v-dialog>
</template>

<style scoped>
.totp-dialog {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 14px;
  padding: 0;
  overflow: hidden;
  box-shadow: var(--shadow), 0 0 40px rgba(0, 240, 255, 0.08);
}

.totp-header {
  padding: 16px 20px 12px;
  border-bottom: 1px solid var(--line);
  background: var(--panel-solid);
}

.totp-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
}

.totp-host {
  font-size: 11px;
  font-family: 'JetBrains Mono', monospace;
  color: var(--muted);
  margin-top: 4px;
  margin-left: 24px;
}

.totp-body {
  padding: 16px 20px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.totp-hint {
  font-size: 12px;
  color: var(--text-2);
  line-height: 1.5;
  padding: 8px 12px;
  background: var(--hover-cyan-faint);
  border-radius: 8px;
  border: 1px solid var(--line);
}

.totp-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.totp-label {
  font-size: 11px;
  font-weight: 500;
  color: var(--text-2);
}

.totp-input {
  font-size: 18px;
  letter-spacing: 0.4em;
  text-align: center;
  height: 40px;
  font-family: 'JetBrains Mono', monospace;
}

.totp-format {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.totp-format-group {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.totp-format-group .auth-chip {
  font-family: 'JetBrains Mono', monospace;
  font-size: 12px;
}

.totp-format-group .sep {
  color: var(--muted);
  margin: 0 1px;
}

.totp-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 20px;
  border-top: 1px solid var(--line);
  background: var(--panel-solid);
}

.totp-countdown {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  font-family: 'JetBrains Mono', monospace;
  color: var(--muted);
}

.totp-actions {
  display: flex;
  gap: 8px;
}
</style>
