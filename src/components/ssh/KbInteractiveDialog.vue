<script setup lang="ts">
import { ref, computed, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import { respondKeyboardInteractive } from '@/services/ssh'
import type { KbInteractiveEvent } from '@/services/ssh'

const { t } = useI18n()

const props = defineProps<{
  sessionId: string
  host: string
}>()

const emit = defineEmits<{
  done: []
  cancelled: []
}>()

const data = ref<KbInteractiveEvent | null>(null)
const responses = ref<string[]>([])
const submitting = ref(false)
const error = ref<string | null>(null)
let countdownTimer: number | null = null
const countdown = ref(360)

function open(eventData: KbInteractiveEvent) {
  data.value = eventData
  responses.value = eventData.prompts.map((_, i) => eventData.autoFill[i] ?? '')
  error.value = null
  countdown.value = 360
  startCountdown()
}

function startCountdown() {
  stopCountdown()
  countdownTimer = window.setInterval(() => {
    countdown.value--
    if (countdown.value <= 0) {
      stopCountdown()
      handleCancel()
    }
  }, 1000)
}

function stopCountdown() {
  if (countdownTimer !== null) {
    clearInterval(countdownTimer)
    countdownTimer = null
  }
}

async function handleSubmit() {
  submitting.value = true
  error.value = null
  try {
    await respondKeyboardInteractive(props.sessionId, [...responses.value])
    stopCountdown()
    data.value = null
    emit('done')
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    submitting.value = false
  }
}

function handleCancel() {
  stopCountdown()
  data.value = null
  emit('cancelled')
}

onBeforeUnmount(() => {
  stopCountdown()
})

defineExpose({ open })

const visible = computed(() => data.value !== null)
</script>

<template>
  <v-dialog
    :model-value="visible"
    persistent
    max-width="420"
    @keydown.esc="handleCancel"
  >
    <div class="kb-dialog" v-if="data">
      <div class="kb-header">
        <div class="kb-title">
          <v-icon size="16" color="var(--cyan)">mdi-shield-key-outline</v-icon>
          <span>MFA Verification</span>
        </div>
        <div class="kb-host">{{ host }}</div>
      </div>

      <div class="kb-body">
        <div v-if="data.instructions" class="kb-instructions">
          {{ data.instructions }}
        </div>

        <div
          v-for="(prompt, i) in data.prompts"
          :key="i"
          class="kb-field"
        >
          <label class="kb-label">{{ prompt.prompt }}</label>
          <input
            v-model="responses[i]"
            :type="prompt.echo ? 'text' : 'password'"
            class="cyber-input"
            autocomplete="off"
            @keydown.enter="handleSubmit"
          />
        </div>

        <div v-if="error" class="kb-error">
          <v-icon size="12">mdi-alert-circle</v-icon>
          {{ error }}
        </div>
      </div>

      <div class="kb-footer">
        <div class="kb-countdown">
          <v-icon size="12">mdi-clock-outline</v-icon>
          {{ countdown }}s
        </div>
        <div class="kb-actions">
          <button
            type="button"
            class="cyber-btn-secondary"
            @click="handleCancel"
            :disabled="submitting"
          >
            Cancel
          </button>
          <button
            type="button"
            class="cyber-btn"
            @click="handleSubmit"
            :disabled="submitting"
          >
            <v-icon v-if="submitting" size="14" class="mdi-spin">mdi-loading</v-icon>
            OK
          </button>
        </div>
      </div>
    </div>
  </v-dialog>
</template>

<style scoped>
.kb-dialog {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 14px;
  padding: 0;
  overflow: hidden;
  box-shadow: var(--shadow), 0 0 40px rgba(0, 240, 255, 0.08);
}

.kb-header {
  padding: 16px 20px 12px;
  border-bottom: 1px solid var(--line);
  background: var(--panel-solid);
}

.kb-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
}

.kb-host {
  font-size: 11px;
  font-family: 'JetBrains Mono', monospace;
  color: var(--muted);
  margin-top: 4px;
  margin-left: 24px;
}

.kb-body {
  padding: 16px 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.kb-instructions {
  font-size: 12px;
  color: var(--text-2);
  line-height: 1.5;
  padding: 8px 12px;
  background: var(--hover-cyan-faint);
  border-radius: 8px;
  border: 1px solid var(--line);
}

.kb-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.kb-label {
  font-size: 11px;
  font-weight: 500;
  color: var(--text-2);
}

.kb-error {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--red);
  padding: 8px 12px;
  background: rgba(255, 77, 109, 0.08);
  border-radius: 6px;
  border: 1px solid rgba(255, 77, 109, 0.15);
}

.kb-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 20px;
  border-top: 1px solid var(--line);
  background: var(--panel-solid);
}

.kb-countdown {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  font-family: 'JetBrains Mono', monospace;
  color: var(--muted);
}

.kb-actions {
  display: flex;
  gap: 8px;
}
</style>
