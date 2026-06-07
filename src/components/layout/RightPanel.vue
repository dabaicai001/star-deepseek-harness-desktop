<script setup lang="ts">
/**
 * 右侧面板通用组件
 *
 * - 顶部 tab 切换(竖向,沿右侧边)
 * - 中间是当前激活 tab 的内容
 * - 支持从 v-model 控制显隐
 * - 子组件通过 slot 注入每个 tab 的内容
 */
import { ref, computed } from 'vue'

export interface RightPanelTab {
  key: string
  label: string
  icon: string
}

const props = withDefaults(defineProps<{
  modelValue: boolean
  tabs: RightPanelTab[]
  defaultTab?: string
  width?: number
}>(), {
  width: 380
})

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  'update:activeTab': [key: string]
}>()

const activeTab = ref<string>(props.defaultTab ?? props.tabs[0]?.key ?? '')

function setActive(key: string) {
  activeTab.value = key
  emit('update:activeTab', key)
}

const currentTab = computed(() => props.tabs.find(t => t.key === activeTab.value))
</script>

<template>
  <div v-if="modelValue" class="right-panel" :style="{ width: width + 'px' }">
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
}

.right-panel-rail {
  width: 56px;
  flex-shrink: 0;
  background: rgba(10, 14, 26, 0.5);
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
  background: rgba(0, 240, 255, 0.04);
  color: var(--text-2);
}

.rail-tab.active {
  color: var(--cyan);
  border-left-color: var(--cyan);
  background: rgba(0, 240, 255, 0.08);
  text-shadow: 0 0 8px rgba(0, 240, 255, 0.4);
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
