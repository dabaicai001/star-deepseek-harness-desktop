<script setup lang="ts">
/**
 * AI 模型选择器(共享组件)
 *
 * StarHub AI 工作区头部与各视图内嵌的 AI 助手侧栏共用:
 * 选择立即写入 aiStore.settings.activeModelId(pinia 持久化),
 * 全局面生效;空选择表示使用默认模型配置。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAiStore } from '@/stores/ai'
import { useNotifyStore } from '@/stores/notify'

const { t } = useI18n()
const aiStore = useAiStore()
const notifyStore = useNotifyStore()

const activeModelDisplayName = computed(() => {
  if (aiStore.settings.activeModelId) {
    const active = aiStore.settings.models.find(m => m.id === aiStore.settings.activeModelId)
    if (active) return active.name
  }
  // 未选择模型或模型不存在时,显示默认模型名
  return aiStore.settings.model || t('ai.defaultModel')
})

function openGlobalAiSettings() {
  window.dispatchEvent(new CustomEvent('starhub:open-ai-settings'))
}

function selectModel(modelId: string) {
  if (!modelId) {
    // 选择默认模型:清除 activeModelId,回退到 LLM 服务的默认配置
    aiStore.settings.activeModelId = ''
    notifyStore.notify({
      message: `${t('ai.modelSwitched')}: ${aiStore.settings.model || t('ai.defaultModel')}`,
      color: 'info',
      timeout: 2500,
    })
    return
  }
  const model = aiStore.settings.models.find(m => m.id === modelId)
  if (model) {
    aiStore.settings.activeModelId = modelId
    notifyStore.notify({
      message: `${t('ai.modelSwitched')}: ${model.name} (${model.model})`,
      color: 'info',
      timeout: 2500,
    })
  }
}
</script>

<template>
  <div class="ai-model-selector">
    <v-menu :close-on-content-click="false" offset-y>
      <template #activator="{ props: menuProps }">
        <button
          v-bind="menuProps"
          class="cyber-badge ai-model-badge"
          :data-tooltip="t('ai.switchModel')"
          :title="t('ai.switchModel')"
        >
          <v-icon size="11" class="mr-1">mdi-chip</v-icon>
          {{ activeModelDisplayName }}
          <v-icon size="10" class="ml-1">mdi-chevron-down</v-icon>
        </button>
      </template>
      <v-list class="cyber-panel ai-model-list" density="compact" max-height="320" style="overflow-y:auto; min-width:260px">
        <!-- 默认模型 -->
        <v-list-item
          :active="!aiStore.settings.activeModelId"
          :title="`${t('ai.defaultModel')} (${aiStore.settings.model || '—'})`"
          :subtitle="aiStore.settings.baseUrl"
          @click="selectModel('')"
        >
          <template #prepend>
            <v-icon size="14" :color="!aiStore.settings.activeModelId ? 'var(--cyan)' : 'var(--muted)'">
              {{ !aiStore.settings.activeModelId ? 'mdi-check-circle' : 'mdi-circle-outline' }}
            </v-icon>
          </template>
          <template #append>
            <span class="ai-model-mini" style="font-size:10px; color:var(--muted)">{{ t('ai.defaultModel') }}</span>
          </template>
        </v-list-item>
        <v-divider v-if="aiStore.settings.models.length" class="my-1" />
        <v-list-item
          v-for="m in aiStore.settings.models"
          :key="m.id"
          :active="aiStore.settings.activeModelId === m.id"
          :title="m.name"
          :subtitle="m.baseUrl || aiStore.settings.baseUrl"
          @click="selectModel(m.id)"
        >
          <template #prepend>
            <v-icon size="14" :color="aiStore.settings.activeModelId === m.id ? 'var(--cyan)' : 'var(--muted)'">
              {{ aiStore.settings.activeModelId === m.id ? 'mdi-check-circle' : 'mdi-circle-outline' }}
            </v-icon>
          </template>
          <template #append>
            <span class="ai-model-mini" style="font-size:10px; color:var(--muted)">{{ m.model }}</span>
          </template>
        </v-list-item>
        <v-divider class="my-1" />
        <v-list-item @click="openGlobalAiSettings" prepend-icon="mdi-plus-circle-outline">
          <v-list-item-title style="font-size:12px; color:var(--cyan)">
            {{ t('ai.addModel') }}
          </v-list-item-title>
        </v-list-item>
      </v-list>
    </v-menu>
  </div>
</template>

<style scoped>
/* 基础样式在 cyber.css(.ai-model-badge);这里只补侧栏窄宽度下的截断 */
.ai-model-badge {
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
