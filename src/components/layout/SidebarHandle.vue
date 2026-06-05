<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '@/stores/app'

const { t } = useI18n()
const appStore = useAppStore()

const isMac = ref(false)
onMounted(() => {
  const ua = navigator.userAgent.toLowerCase()
  isMac.value = /mac|iphone|ipad|ipod/.test(ua)
})
const modKey = computed(() => isMac.value ? '⌘' : 'Ctrl')
</script>

<template>
  <button
    class="sidebar-handle"
    :data-collapsed="!appStore.sidebarOpen"
    :title="appStore.sidebarOpen ? `${t('sidebar.collapse')} (${modKey}B)` : `${t('sidebar.expand')} (${modKey}B)`"
    :aria-label="appStore.sidebarOpen ? t('sidebar.collapse') : t('sidebar.expand')"
    @click="appStore.toggleSidebar()"
  >
    <span class="grip">
      <span class="dot"></span>
      <span class="dot"></span>
    </span>
    <v-icon class="arrow" size="14">mdi-chevron-double-left</v-icon>
  </button>
</template>

<style scoped>
.sidebar-handle {
  position: absolute;
  right: -12px;
  top: 50%;
  transform: translateY(-50%);
  z-index: 20;
  width: 24px;
  height: 72px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  background: var(--panel-2);
  border: 1px solid rgba(0, 240, 255, 0.3);
  border-radius: 6px;
  color: var(--cyan);
  cursor: pointer;
  padding: 0;
  font-family: inherit;
  /* 常驻醒目:不再 opacity 0.55,常驻 + 微 glow */
  box-shadow:
    0 2px 12px rgba(0, 0, 0, 0.4),
    0 0 8px rgba(0, 240, 255, 0.15);
  transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
}

.sidebar-handle:hover {
  background: var(--panel-2);
  color: var(--cyan);
  border-color: var(--cyan);
  box-shadow:
    0 0 0 3px rgba(0, 240, 255, 0.18),
    0 0 16px rgba(0, 240, 255, 0.5),
    0 4px 16px rgba(0, 0, 0, 0.5);
  transform: translateY(-50%) scale(1.08);
}

.sidebar-handle:active {
  transform: translateY(-50%) scale(0.94);
}

/* 折叠时:把手整体往左偏一点点,提示"可展开" */
.sidebar-handle[data-collapsed="true"] {
  /* 让把手更靠左,贴合 60px 窄栏 */
  right: -12px;
}

/* 折叠时:箭头旋转 180°,变"双右" */
.sidebar-handle[data-collapsed="true"] .arrow {
  transform: rotate(180deg);
}

.sidebar-handle .arrow {
  font-size: 18px;
  color: var(--cyan);
  filter: drop-shadow(0 0 3px rgba(0, 240, 255, 0.5));
  transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

/* 装饰:小圆点像"把手" 3D 凸起 */
.sidebar-handle .grip {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: 1px;
}

.sidebar-handle .grip .dot {
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: var(--cyan);
  opacity: 0.7;
  box-shadow: 0 0 3px var(--cyan);
  transition: all 0.25s;
}

.sidebar-handle:hover .grip .dot {
  opacity: 1;
  box-shadow: 0 0 6px var(--cyan);
  transform: scaleX(1.4);
}
</style>
