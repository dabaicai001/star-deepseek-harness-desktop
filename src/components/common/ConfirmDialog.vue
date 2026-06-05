<script setup lang="ts">
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

const props = defineProps<{
  modelValue: boolean
  title?: string
  message: string
  confirmText?: string
  cancelText?: string
  danger?: boolean
  requireTyping?: string  // 需要用户输入指定文字才能点确认
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  confirm: []
  cancel: []
}>()

const typed = defineModel<string>('typed', { default: '' })

function close() {
  typed.value = ''
  emit('update:modelValue', false)
  emit('cancel')
}

function confirm() {
  if (props.requireTyping && typed.value !== props.requireTyping) return
  typed.value = ''
  emit('confirm')
  emit('update:modelValue', false)
}
</script>

<template>
  <v-dialog
    :model-value="modelValue"
    @update:model-value="emit('update:modelValue', $event)"
    max-width="440"
    transition="dialog-bottom-transition"
  >
    <div class="confirm-dialog">
      <div class="modal-header">
        <div class="icon-box" :class="{ danger }">
          <v-icon size="14">{{ danger ? 'mdi-alert-outline' : 'mdi-help-circle-outline' }}</v-icon>
        </div>
        <h3>{{ title || t('common.confirm') }}</h3>
        <button class="action-btn" @click="close">
          <v-icon size="14">mdi-close</v-icon>
        </button>
      </div>
      <div class="modal-body">
        <p class="confirm-message">{{ message }}</p>
        <div v-if="requireTyping" class="typing-zone">
          <label class="field-hint" style="margin-bottom: 6px;">
            输入 <code style="font-family: 'JetBrains Mono', monospace; color: var(--red);">{{ requireTyping }}</code> 以确认:
          </label>
          <input
            v-model="typed"
            type="text"
            class="cyber-input mono"
            :placeholder="requireTyping"
            autocomplete="off"
            @keydown.enter="confirm"
          />
        </div>
      </div>
      <div class="modal-footer">
        <button class="cyber-btn-secondary" @click="close">
          <v-icon size="14">mdi-close</v-icon>
          {{ cancelText || t('common.cancel') }}
        </button>
        <button
          class="cyber-btn"
          :class="{ danger }"
          :disabled="Boolean(requireTyping) && typed !== requireTyping"
          @click="confirm"
        >
          <v-icon size="14">{{ danger ? 'mdi-delete-outline' : 'mdi-check' }}</v-icon>
          {{ confirmText || t('common.confirm') }}
        </button>
      </div>
    </div>
  </v-dialog>
</template>

<style scoped>
.confirm-dialog {
  background: var(--panel-solid);
  border: 1px solid var(--line-2);
  border-radius: 14px;
  overflow: hidden;
  position: relative;
  box-shadow: 0 24px 64px -12px rgba(0, 0, 0, 0.7);
}

.confirm-dialog::before {
  content: "";
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 2px;
  background: var(--grad-primary);
  opacity: 0.6;
}

.icon-box.danger {
  background: rgba(255, 77, 109, 0.1);
  border-color: rgba(255, 77, 109, 0.3);
  color: var(--red);
}

.confirm-message {
  font-size: 13px;
  color: var(--text-2);
  line-height: 1.6;
}

.typing-zone {
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid var(--line);
}

.cyber-btn.danger {
  background: linear-gradient(135deg, #ff4d6d 0%, #ff3d9a 100%);
  color: white;
  box-shadow: 0 4px 16px rgba(255, 77, 109, 0.3);
}

.cyber-btn.danger:hover:not([disabled]) {
  box-shadow: 0 6px 24px rgba(255, 77, 109, 0.5);
}

.cyber-btn.danger[disabled] {
  opacity: 0.4;
  cursor: not-allowed;
}
</style>
