<script setup lang="ts">
import { watch } from 'vue'
import { useNotifyStore } from '@/stores/notify'

const notify = useNotifyStore()

watch(() => notify.show, (val) => {
  if (val) {
    setTimeout(() => { notify.show = false }, notify.timeout)
  }
})
</script>

<template>
  <Transition name="toast-slide">
    <div v-if="notify.show" class="global-toast" :class="`toast-${notify.color}`">
      <v-icon size="18" class="toast-icon">
        {{ notify.color === 'success' ? 'mdi-check-circle'
         : notify.color === 'error' ? 'mdi-alert-circle'
         : notify.color === 'warning' ? 'mdi-alert'
         : 'mdi-information' }}
      </v-icon>
      <span class="toast-msg">{{ notify.message }}</span>
    </div>
  </Transition>
</template>

<style scoped>
.global-toast {
  position: fixed;
  top: 60px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 99999;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 20px;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 500;
  backdrop-filter: blur(12px);
  pointer-events: none;
  max-width: 600px;
  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.4);
}

.toast-success {
  background: rgba(0, 230, 118, 0.15);
  border: 1px solid rgba(0, 230, 118, 0.3);
  color: #00e676;
}

.toast-error {
  background: rgba(255, 82, 82, 0.15);
  border: 1px solid rgba(255, 82, 82, 0.3);
  color: #ff5252;
}

.toast-warning {
  background: rgba(255, 214, 0, 0.15);
  border: 1px solid rgba(255, 214, 0, 0.3);
  color: #ffd600;
}

.toast-info {
  background: rgba(0, 240, 255, 0.15);
  border: 1px solid rgba(0, 240, 255, 0.3);
  color: #00f0ff;
}

.toast-icon {
  flex-shrink: 0;
}

.toast-msg {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.toast-slide-enter-active,
.toast-slide-leave-active {
  transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
}

.toast-slide-enter-from,
.toast-slide-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(-12px);
}
</style>
