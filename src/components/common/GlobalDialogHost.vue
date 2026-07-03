<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useDialogStore } from '@/stores/dialog'

const { t } = useI18n()
const dlg = useDialogStore()

const inputValue = ref('')
const typedValue = ref('')
const visible = computed({
  get: () => dlg.visible,
  set: (v) => { if (!v) dlg.resolveWith(null) },
})

const isPrompt = computed(() => dlg.kind === 'prompt')
const isConfirm = computed(() => dlg.kind === 'confirm')
const isAlert = computed(() => dlg.kind === 'alert')

const canConfirm = computed(() => {
  if (isConfirm.value) {
    if (dlg.confirmRequireTyping && typedValue.value !== dlg.confirmRequireTyping) return false
    return true
  }
  if (isPrompt.value) {
    if (dlg.promptRequireNonEmpty && !inputValue.value.trim()) return false
    return true
  }
  return true
})

const headerIcon = computed(() => {
  if (isAlert.value) {
    return dlg.alertColor === 'error' ? 'mdi-alert-circle-outline'
      : dlg.alertColor === 'warning' ? 'mdi-alert-outline'
      : dlg.alertColor === 'success' ? 'mdi-check-circle-outline'
      : 'mdi-information-outline'
  }
  if (isConfirm.value) {
    return dlg.confirmDanger ? 'mdi-alert-outline' : 'mdi-help-circle-outline'
  }
  return 'mdi-pencil-box-outline'
})

const iconBoxClass = computed(() => {
  if (isAlert.value) {
    return `alert-${dlg.alertColor}`
  }
  if (isConfirm.value && dlg.confirmDanger) return 'danger'
  return ''
})

watch(visible, async (v) => {
  if (!v) {
    inputValue.value = ''
    typedValue.value = ''
    return
  }
  // 进入时初始化值
  if (isPrompt.value) {
    inputValue.value = dlg.promptSelectOptions
      ? (dlg.promptSelectDefault ?? dlg.promptSelectOptions[0] ?? '')
      : dlg.promptDefault
  }
  await nextTick()
})

function onConfirm() {
  if (!canConfirm.value) return
  if (isPrompt.value) {
    dlg.resolveWith(inputValue.value)
  } else if (isConfirm.value) {
    dlg.resolveWith(true)
  } else {
    dlg.resolveWith(true)
  }
}

function onCancel() {
  dlg.resolveWith(isConfirm.value ? false : null)
}

function onKeyEnter() {
  if (canConfirm.value) onConfirm()
}
</script>

<template>
  <v-dialog
    v-model="visible"
    max-width="480"
    transition="dialog-bottom-transition"
    @keydown.esc="onCancel"
  >
    <div class="global-dialog">
      <div class="modal-header">
        <div class="icon-box" :class="iconBoxClass">
          <v-icon size="16">{{ headerIcon }}</v-icon>
        </div>
        <h3>
          <template v-if="isPrompt">{{ dlg.promptTitle || t('common.input') }}</template>
          <template v-else-if="isConfirm">{{ dlg.confirmTitle || t('common.confirm') }}</template>
          <template v-else>{{ dlg.alertTitle || t('common.notice') }}</template>
        </h3>
        <button class="action-btn" @click="onCancel">
          <v-icon size="14">mdi-close</v-icon>
        </button>
      </div>

      <div class="modal-body">
        <p class="dialog-message">
          <template v-if="isPrompt">{{ dlg.promptMessage }}</template>
          <template v-else-if="isConfirm">{{ dlg.confirmMessage }}</template>
          <template v-else>{{ dlg.alertMessage }}</template>
        </p>

        <!-- prompt: select (下拉选择) -->
        <template v-if="isPrompt && dlg.promptSelectOptions">
          <div class="typing-zone">
            <select
              v-model="inputValue"
              class="cyber-input mono"
              @keydown.enter="onKeyEnter"
            >
              <option v-for="opt in dlg.promptSelectOptions" :key="opt" :value="opt">{{ opt }}</option>
            </select>
          </div>
        </template>

        <!-- prompt: text input -->
        <template v-else-if="isPrompt">
          <div class="typing-zone">
            <input
              v-model="inputValue"
              type="text"
              class="cyber-input mono"
              :placeholder="dlg.promptPlaceholder"
              autocomplete="off"
              autofocus
              @keydown.enter="onKeyEnter"
            />
          </div>
        </template>

        <!-- confirm: require typing 校验 -->
        <template v-else-if="isConfirm && dlg.confirmRequireTyping">
          <div class="typing-zone">
            <label class="field-hint" style="margin-bottom: 6px;">
              输入 <code style="font-family: 'JetBrains Mono', monospace; color: var(--red);">{{ dlg.confirmRequireTyping }}</code> 以确认:
            </label>
            <input
              v-model="typedValue"
              type="text"
              class="cyber-input mono"
              :placeholder="dlg.confirmRequireTyping"
              autocomplete="off"
              autofocus
              @keydown.enter="onKeyEnter"
            />
          </div>
        </template>
      </div>

      <div class="modal-footer">
        <template v-if="isAlert">
          <button class="cyber-btn" @click="onConfirm">
            <v-icon size="14">mdi-check</v-icon>
            {{ dlg.alertConfirmText || t('common.ok') }}
          </button>
        </template>
        <template v-else>
          <button class="cyber-btn-secondary" @click="onCancel">
            <v-icon size="14">mdi-close</v-icon>
            <template v-if="isPrompt">{{ dlg.promptCancelText || t('common.cancel') }}</template>
            <template v-else>{{ dlg.confirmCancelText || t('common.cancel') }}</template>
          </button>
          <button
            class="cyber-btn"
            :class="{ danger: isConfirm && dlg.confirmDanger }"
            :disabled="!canConfirm"
            @click="onConfirm"
          >
            <v-icon size="14">
              <template v-if="isConfirm && dlg.confirmDanger">mdi-delete-outline</template>
              <template v-else-if="isPrompt">mdi-check</template>
              <template v-else>mdi-check</template>
            </v-icon>
            <template v-if="isPrompt">{{ dlg.promptConfirmText || t('common.confirm') }}</template>
            <template v-else>{{ dlg.confirmConfirmText || t('common.confirm') }}</template>
          </button>
        </template>
      </div>
    </div>
  </v-dialog>
</template>

<style scoped>
.global-dialog {
  background: var(--panel-solid);
  border: 1px solid var(--line-2);
  border-radius: 16px;
  overflow: hidden;
  position: relative;
  box-shadow: var(--shadow);
}

.global-dialog::before {
  content: "";
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 2px;
  background: var(--grad-primary);
  opacity: 0.6;
}

.icon-box.danger,
.icon-box.alert-error {
  background: var(--status-error-bg);
  border-color: var(--status-error-border);
  color: var(--red);
}
.icon-box.alert-warning {
  background: rgba(226, 191, 90, 0.12);
  border-color: rgba(226, 191, 90, 0.28);
  color: var(--yellow);
}
.icon-box.alert-success {
  background: var(--status-online-bg);
  border-color: var(--status-online-border);
  color: var(--green);
}

.dialog-message {
  font-size: 13px;
  color: var(--text-2);
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}

.typing-zone {
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid var(--line);
}

.typing-zone select.cyber-input {
  appearance: none;
  -webkit-appearance: none;
  background-image: linear-gradient(45deg, transparent 50%, var(--cyan) 50%),
                    linear-gradient(135deg, var(--cyan) 50%, transparent 50%);
  background-position: calc(100% - 16px) 50%, calc(100% - 11px) 50%;
  background-size: 5px 5px, 5px 5px;
  background-repeat: no-repeat;
  padding-right: 32px;
  cursor: pointer;
}

.typing-zone select.cyber-input option {
  background: var(--panel-solid);
  color: var(--text);
}

.cyber-btn.danger {
  background: linear-gradient(135deg, var(--red) 0%, var(--pink) 100%);
  color: white;
  box-shadow: var(--glow-pink);
}
.cyber-btn.danger:hover:not([disabled]) {
  box-shadow: var(--glow-pink);
}
.cyber-btn[disabled] {
  opacity: 0.4;
  cursor: not-allowed;
}
</style>
