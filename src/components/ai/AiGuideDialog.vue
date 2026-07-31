<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

/** 「不再显示」勾选后写入 localStorage 的 key(SshTerminal 首次打开 AI 面板时检查) */
const GUIDE_SEEN_KEY = 'starhub.ai.guideSeen'
const TOTAL_STEPS = 5

const props = defineProps<{
  modelValue: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
}>()

const step = ref(0)
const dontShowAgain = ref(false)

// 每次打开都从第一步开始
watch(() => props.modelValue, visible => {
  if (visible) step.value = 0
})

const stepTitle = computed(() => t(`ai.guide.step${step.value + 1}Title`))
const stepBody = computed(() => t(`ai.guide.step${step.value + 1}Body`))
const isLastStep = computed(() => step.value === TOTAL_STEPS - 1)

function markSeenIfNeeded(force = false) {
  if (!force && !dontShowAgain.value) return
  try { localStorage.setItem(GUIDE_SEEN_KEY, 'true') } catch { /* ignore */ }
}

function close(force = false) {
  markSeenIfNeeded(force)
  emit('update:modelValue', false)
}

function handlePrev() {
  if (step.value > 0) step.value--
}

function handleNext() {
  if (isLastStep.value) {
    // 看完最后一步视为完成引导,不再自动弹出
    close(true)
    return
  }
  step.value++
}
</script>

<template>
  <v-dialog
    :model-value="modelValue"
    max-width="440"
    @update:model-value="close()"
    @keydown.esc="close()"
  >
    <div class="guide-dialog">
      <div class="guide-header">
        <div class="guide-title">
          <v-icon size="16" color="var(--cyan)">mdi-robot-outline</v-icon>
          <span>{{ stepTitle }}</span>
        </div>
        <span class="guide-step-counter">{{ t('ai.guide.stepOf', { current: step + 1, total: TOTAL_STEPS }) }}</span>
      </div>

      <div class="guide-body">
        <p class="guide-text">{{ stepBody }}</p>
        <div class="guide-dots">
          <span
            v-for="i in TOTAL_STEPS"
            :key="i"
            class="guide-dot"
            :class="{ active: i - 1 === step }"
          />
        </div>
      </div>

      <div class="guide-footer">
        <label class="guide-dont-show">
          <input v-model="dontShowAgain" type="checkbox" />
          <span>{{ t('ai.guide.dontShowAgain') }}</span>
        </label>
        <div class="guide-actions">
          <button type="button" class="cyber-btn-secondary" @click="close()">
            {{ t('ai.guide.skip') }}
          </button>
          <button
            v-if="step > 0"
            type="button"
            class="cyber-btn-secondary"
            @click="handlePrev"
          >
            {{ t('ai.guide.prev') }}
          </button>
          <button type="button" class="cyber-btn" @click="handleNext">
            {{ isLastStep ? t('ai.guide.done') : t('ai.guide.next') }}
          </button>
        </div>
      </div>
    </div>
  </v-dialog>
</template>

<style scoped>
.guide-dialog {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 14px;
  overflow: hidden;
  box-shadow: var(--shadow), 0 0 40px rgba(0, 240, 255, 0.08);
}

.guide-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px 12px;
  border-bottom: 1px solid var(--line);
}

.guide-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
}

.guide-step-counter {
  font-size: 11px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}

.guide-body {
  padding: 16px 20px;
}

.guide-text {
  margin: 0;
  font-size: 13px;
  line-height: 1.7;
  color: var(--text);
  min-height: 88px;
}

.guide-dots {
  display: flex;
  gap: 6px;
  margin-top: 12px;
}

.guide-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--bg-3);
  transition: background 0.2s ease;
}

.guide-dot.active {
  background: var(--accent);
}

.guide-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 20px 16px;
  border-top: 1px solid var(--line);
}

.guide-dont-show {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--muted);
  cursor: pointer;
}

.guide-actions {
  display: flex;
  gap: 8px;
}
</style>
