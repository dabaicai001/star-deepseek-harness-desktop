<script setup lang="ts">
/**
 * 全局错误边界
 *  - 捕获任意子组件的渲染错误,避免整页白屏
 *  - 显示友好的错误页 + 复制堆栈 + 重置 / 刷新选项
 */
import { ref, onErrorCaptured } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

interface CaughtError {
  message: string
  stack: string
  source: string
  time: number
}

const error = ref<CaughtError | null>(null)
const detailsOpen = ref(false)

onErrorCaptured((err: Error, instance, info) => {
  error.value = {
    message: err?.message || String(err),
    stack: err?.stack || '(no stack)',
    source: info || 'unknown',
    time: Date.now()
  }
  // 上报日志(开发期 console.error,生产期可对接 Sentry 等)
  console.error('[ErrorBoundary] Caught:', err, info)
  // 不再向上传播 — 由边界吃掉
  return false
})

function copyStack() {
  if (!error.value) return
  const text = `StarHub Error\nTime: ${new Date(error.value.time).toISOString()}\nSource: ${error.value.source}\n\n${error.value.stack}`
  navigator.clipboard.writeText(text).catch(() => {})
}

function reset() {
  error.value = null
  detailsOpen.value = false
}

function reload() {
  window.location.reload()
}
</script>

<template>
  <div v-if="error" class="error-boundary">
    <div class="error-panel">
      <div class="error-icon">
        <v-icon size="48" color="red">mdi-alert-octagon-outline</v-icon>
      </div>
      <h1 class="error-title">出现了一个未预期的错误</h1>
      <p class="error-msg">{{ error.message }}</p>

      <div class="error-actions">
        <button class="cyber-btn" @click="reset">
          <v-icon size="14">mdi-refresh</v-icon>
          <span>重置视图</span>
        </button>
        <button class="cyber-btn-secondary" @click="copyStack">
          <v-icon size="14">mdi-content-copy</v-icon>
          <span>复制堆栈</span>
        </button>
        <button class="cyber-btn-secondary" @click="reload">
          <v-icon size="14">mdi-restart</v-icon>
          <span>重新加载</span>
        </button>
      </div>

      <details class="error-details" :open="detailsOpen" @toggle="detailsOpen = ($event.target as HTMLDetailsElement).open">
        <summary>查看堆栈详情</summary>
        <pre>{{ error.stack }}</pre>
        <p class="error-source">Source: {{ error.source }}</p>
      </details>
    </div>
  </div>
  <slot v-else />
</template>

<style scoped>
.error-boundary {
  position: fixed;
  inset: 0;
  background: var(--bg);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 99999;
  padding: 24px;
  overflow: auto;
}
.error-panel {
  max-width: 560px;
  width: 100%;
  background: var(--panel);
  border: 1px solid rgba(255, 77, 109, 0.3);
  border-radius: 12px;
  padding: 32px;
  position: relative;
  overflow: hidden;
}
.error-panel::before {
  content: "";
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 1px;
  background: linear-gradient(90deg, transparent, var(--red), transparent);
}
.error-icon {
  margin-bottom: 12px;
  filter: drop-shadow(0 0 12px rgba(255, 77, 109, 0.5));
}
.error-title {
  font-family: 'Orbitron', sans-serif;
  font-size: 20px;
  font-weight: 700;
  margin: 0 0 8px;
  color: var(--text);
}
.error-msg {
  font-size: 13px;
  color: var(--red);
  font-family: 'JetBrains Mono', monospace;
  margin: 0 0 24px;
  line-height: 1.6;
  word-break: break-word;
}
.error-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 20px;
}
.error-details {
  background: var(--bg);
  border: 1px solid var(--line-2);
  border-radius: 6px;
  padding: 8px 12px;
  font-size: 12px;
}
.error-details summary {
  cursor: pointer;
  color: var(--text-2);
  padding: 4px 0;
  user-select: none;
}
.error-details pre {
  margin: 8px 0 0;
  padding: 12px;
  background: rgba(0, 0, 0, 0.3);
  border-radius: 4px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  line-height: 1.5;
  color: var(--muted);
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 240px;
  overflow-y: auto;
}
.error-source {
  margin: 8px 0 0;
  font-size: 10px;
  color: var(--muted);
  font-family: 'JetBrains Mono', monospace;
}
</style>
