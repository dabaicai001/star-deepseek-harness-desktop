<script setup lang="ts">
defineProps<{
  visible: boolean
  side: 'local' | 'remote'
}>()
</script>

<template>
  <Transition name="fade">
    <div v-if="visible" class="drag-overlay">
      <div class="drag-overlay-content">
        <span class="drag-icon">{{ side === 'remote' ? '⬆️' : '⬇️' }}</span>
        <span class="drag-text">
          {{ side === 'remote' ? 'Drop to Upload' : 'Drop to Download' }}
        </span>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.drag-overlay {
  position: absolute;
  inset: 0;
  background: rgba(0, 240, 255, 0.06);
  border: 2px dashed var(--cyan);
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
  backdrop-filter: blur(4px);
  pointer-events: none;
}

.drag-overlay-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
}

.drag-icon {
  font-size: 36px;
}

.drag-text {
  font-family: 'JetBrains Mono', monospace;
  font-size: 14px;
  font-weight: 600;
  color: var(--cyan);
  text-transform: uppercase;
  letter-spacing: 0.1em;
  text-shadow: 0 0 20px rgba(0, 240, 255, 0.5);
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
