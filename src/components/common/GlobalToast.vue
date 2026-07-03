<script setup lang="ts">
import { computed, watch } from 'vue'
import { useNotifyStore } from '@/stores/notify'

const notify = useNotifyStore()
let timer: number | null = null

const toastIcon = computed(() => notify.color === 'success' ? 'mdi-check-circle-outline'
  : notify.color === 'error' ? 'mdi-alert-circle-outline'
  : notify.color === 'warning' ? 'mdi-alert-outline'
  : 'mdi-information-outline')

const toastTitle = computed(() => notify.history[0]?.title || '')

function closeToast() {
  if (timer !== null) {
    window.clearTimeout(timer)
    timer = null
  }
  notify.show = false
}

watch(() => notify.show, (val) => {
  if (timer !== null) {
    window.clearTimeout(timer)
    timer = null
  }
  if (val) {
    timer = window.setTimeout(closeToast, notify.timeout)
  }
})
</script>

<template>
  <Transition name="toast-slide">
    <div v-if="notify.show" class="global-toast" :class="`toast-${notify.color}`" role="status">
      <div class="toast-mark">
        <v-icon size="18" class="toast-icon">{{ toastIcon }}</v-icon>
      </div>
      <div class="toast-copy">
        <strong v-if="toastTitle" class="toast-title">{{ toastTitle }}</strong>
        <span class="toast-msg">{{ notify.message }}</span>
      </div>
      <button class="toast-close" @click="closeToast" aria-label="关闭提示">
        <v-icon size="14">mdi-close</v-icon>
      </button>
    </div>
  </Transition>
</template>

<style scoped>
.global-toast {
  position: fixed;
  top: 64px;
  right: 18px;
  z-index: 99999;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  width: min(420px, calc(100vw - 32px));
  padding: 12px;
  border-radius: 12px;
  background: var(--panel-solid);
  border: 1px solid var(--line-2);
  box-shadow: var(--shadow);
  backdrop-filter: blur(18px);
  pointer-events: auto;
}

.global-toast::before {
  content: "";
  position: absolute;
  inset: 0 auto 0 0;
  width: 3px;
  border-radius: 12px 0 0 12px;
  background: var(--cyan);
}

.toast-success::before { background: var(--green); }
.toast-error::before { background: var(--red); }
.toast-warning::before { background: var(--yellow); }
.toast-info::before { background: var(--cyan); }

.toast-mark {
  width: 34px;
  height: 34px;
  border-radius: 10px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--icon-bg-cyan);
  color: var(--cyan);
}

.toast-success .toast-mark {
  background: var(--status-online-bg);
  color: var(--green);
}

.toast-error .toast-mark {
  background: var(--status-error-bg);
  color: var(--red);
}

.toast-warning .toast-mark {
  background: rgba(226, 191, 90, 0.12);
  color: var(--yellow);
}

.toast-copy {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.toast-title {
  color: var(--text);
  font-size: 12px;
  line-height: 1.2;
}

.toast-msg {
  color: var(--text-2);
  font-size: 12px;
  line-height: 1.45;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.toast-close {
  width: 26px;
  height: 26px;
  border: 0;
  border-radius: 7px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  transition: all 0.2s;
}

.toast-close:hover {
  color: var(--red);
  background: var(--close-hover-bg);
}

.toast-slide-enter-active,
.toast-slide-leave-active {
  transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
}

.toast-slide-enter-from,
.toast-slide-leave-to {
  opacity: 0;
  transform: translateX(16px);
}
</style>
