<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { useNotifyStore } from '@/stores/notify'

const notify = useNotifyStore()
const open = ref(false)
const containerRef = ref<HTMLElement>()

function toggle() {
  open.value = !open.value
  if (open.value) notify.markAllRead()
}

function onDocClick(e: MouseEvent) {
  if (!open.value) return
  if (containerRef.value && !containerRef.value.contains(e.target as Node)) {
    open.value = false
  }
}

onMounted(() => document.addEventListener('click', onDocClick))
onBeforeUnmount(() => document.removeEventListener('click', onDocClick))

function iconFor(color: string) {
  if (color === 'success') return 'mdi-check-circle-outline'
  if (color === 'error') return 'mdi-alert-circle-outline'
  if (color === 'warning') return 'mdi-alert-outline'
  return 'mdi-information-outline'
}

function timeAgo(ts: number) {
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`
  return `${Math.floor(diff / 86_400_000)}d`
}
</script>

<template>
  <div ref="containerRef" class="notification-center">
    <button class="action-btn" data-tooltip="通知中心" @click.stop="toggle">
      <v-icon size="16">mdi-bell-outline</v-icon>
      <span v-if="notify.unreadCount > 0" class="notify-dot">{{ Math.min(9, notify.unreadCount) }}</span>
    </button>

    <div v-if="open" class="notify-popover" @click.stop>
      <div class="notify-header">
        <div>
          <div class="notify-title">通知中心</div>
          <div class="notify-subtitle">最近操作、失败和后台反馈</div>
        </div>
        <button class="action-btn" :disabled="notify.history.length === 0" @click="notify.clearHistory()">
          <v-icon size="14">mdi-delete-outline</v-icon>
        </button>
      </div>

      <div v-if="notify.history.length === 0" class="notify-empty">
        <v-icon size="28">mdi-bell-sleep-outline</v-icon>
        <span>暂无通知</span>
      </div>

      <div v-else class="notify-list">
        <div v-for="item in notify.history" :key="item.id" class="notify-item" :class="item.color">
          <v-icon size="16">{{ iconFor(item.color) }}</v-icon>
          <div class="notify-body">
            <div class="notify-line">
              <span class="notify-item-title">{{ item.title }}</span>
              <span class="notify-time">{{ timeAgo(item.createdAt) }}</span>
            </div>
            <div class="notify-message">{{ item.message }}</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.notification-center {
  position: relative;
}

.notify-dot {
  position: absolute;
  right: 2px;
  top: 2px;
  min-width: 14px;
  height: 14px;
  padding: 0 4px;
  border-radius: 999px;
  background: var(--red);
  color: white;
  font-size: 9px;
  font-family: 'JetBrains Mono', monospace;
  line-height: 14px;
  text-align: center;
}

.notify-popover {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  width: 360px;
  max-width: calc(100vw - 24px);
  max-height: 520px;
  display: flex;
  flex-direction: column;
  background: var(--panel-solid);
  border: 1px solid var(--line-2);
  border-radius: 12px;
  box-shadow: var(--shadow);
  z-index: 120;
  overflow: hidden;
}

.notify-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  border-bottom: 1px solid var(--line);
  background: var(--panel-solid-2);
}

.notify-title {
  font-size: 13px;
  font-weight: 700;
  color: var(--text);
}

.notify-subtitle {
  font-size: 11px;
  color: var(--muted);
  margin-top: 2px;
}

.notify-list {
  overflow-y: auto;
  padding: 6px;
}

.notify-item {
  display: flex;
  gap: 10px;
  padding: 10px;
  border-radius: 8px;
  color: var(--text-2);
}

.notify-item:hover {
  background: var(--hover-cyan-faint);
}

.notify-item.success .v-icon { color: var(--green); }
.notify-item.error .v-icon { color: var(--red); }
.notify-item.warning .v-icon { color: var(--yellow); }
.notify-item.info .v-icon { color: var(--cyan); }

.notify-body {
  flex: 1;
  min-width: 0;
}

.notify-line {
  display: flex;
  align-items: center;
  gap: 8px;
}

.notify-item-title {
  font-size: 12px;
  font-weight: 700;
  color: var(--text);
}

.notify-time {
  margin-left: auto;
  font-size: 10px;
  color: var(--muted);
  font-family: 'JetBrains Mono', monospace;
}

.notify-message {
  margin-top: 4px;
  font-size: 12px;
  color: var(--text-2);
  line-height: 1.45;
  word-break: break-word;
}

.notify-empty {
  min-height: 160px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--muted);
  font-size: 12px;
}
</style>
