<script setup lang="ts">
/**
 * 右侧面板通用组件
 *
 * - 顶部 tab 切换(竖向,沿右侧边)
 * - 中间是当前激活 tab 的内容
 * - 支持从 v-model 控制显隐
 * - 子组件通过 slot 注入每个 tab 的内容
 * - 支持拖拽调整宽度
 */
import { ref, computed } from 'vue'
import { useAppStore } from '@/stores/app'
import RightPanelHandle from './RightPanelHandle.vue'

export interface RightPanelTab {
  key: string
  label: string
  icon: string
}

const props = withDefaults(defineProps<{
  modelValue: boolean
  tabs: RightPanelTab[]
  defaultTab?: string
}>(), {})

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  'update:activeTab': [key: string]
}>()

const appStore = useAppStore()
const activeTab = ref<string>(props.defaultTab ?? props.tabs[0]?.key ?? '')

function setActive(key: string) {
  activeTab.value = key
  emit('update:activeTab', key)
}

const currentTab = computed(() => props.tabs.find(t => t.key === activeTab.value))
</script>

<template>
  <div
    class="right-panel"
    :class="{ collapsed: !modelValue, dragging: appStore.rightPanelDragging && modelValue }"
    :style="{ width: modelValue ? appStore.rightPanelWidth + 'px' : '6px' }"
  >
    <!-- 折叠态:只保留一个 thin handle 作为"开门把手" -->
    <RightPanelHandle v-if="!modelValue" :collapsed-only="true" @expand="emit('update:modelValue', true)" />
    <template v-else>
      <!-- 左侧拖拽手柄 -->
      <RightPanelHandle @collapse="emit('update:modelValue', false)" />

      <!-- 左侧 tab 切换条 -->
      <div class="right-panel-rail">
        <button
          v-for="tab in tabs"
          :key="tab.key"
          class="rail-tab"
          :class="{ active: activeTab === tab.key }"
          :title="tab.label"
          @click="setActive(tab.key)"
        >
          <v-icon size="18">{{ tab.icon }}</v-icon>
          <span class="rail-label">{{ tab.label }}</span>
        </button>
      </div>

      <!-- 内容区 -->
      <div class="right-panel-body">
        <div v-if="currentTab" class="panel-tab-pane" :key="currentTab.key">
          <slot :name="`tab-${currentTab.key}`" :tab="currentTab" />
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.right-panel {
  display: flex;
  flex-shrink: 0;
  border-left: 1px solid var(--line);
  background: var(--panel);
  height: 100%;
  overflow: hidden;
  position: relative;
  transition: width 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.right-panel.dragging {
  transition: none !important;
}

.right-panel.collapsed {
  border-left-color: var(--line-2);
  background: transparent;
}

.right-panel-rail {
  width: 56px;
  flex-shrink: 0;
  background: var(--chrome-glass-soft);
  border-right: 1px solid var(--line-2);
  padding: 8px 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.rail-tab {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 12px 4px;
  background: transparent;
  border: none;
  border-left: 2px solid transparent;
  color: var(--muted);
  cursor: pointer;
  font-size: 10px;
  font-family: inherit;
  transition: all 0.2s;
  width: 100%;
}

.rail-tab:hover {
  background: var(--hover-cyan-faint);
  color: var(--text-2);
}

.rail-tab.active {
  color: var(--cyan);
  border-left-color: var(--cyan);
  background: var(--active-cyan);
}

.rail-label {
  font-size: 10px;
  letter-spacing: 0.04em;
  text-align: center;
  line-height: 1.2;
}

.right-panel-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.panel-tab-pane {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-height: 0;
}
</style>
