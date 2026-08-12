<script setup lang="ts">
/**
 * AI 模型选择器(共享组件)
 *
 * StarHub AI 工作区头部与各视图内嵌的 AI 助手侧栏共用。
 * - 传 sessionId:读写该会话的模型覆盖(session.modelId),各窗口/标签页互不影响;
 *   空覆盖表示「跟随全局」。
 * - 不传 sessionId:写全局 aiStore.settings.activeModelId(pinia 持久化)。
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAiStore } from '@/stores/ai'
import { useNotifyStore } from '@/stores/notify'
import type { AiModelConfig } from '@/stores/ai'

const props = defineProps<{
  /** 会话 instanceId;传入后按会话独立选模型,不传则操作全局默认 */
  sessionId?: string
}>()

const { t } = useI18n()
const aiStore = useAiStore()
const notifyStore = useNotifyStore()

const keyword = ref('')

/** 当前生效的模型 id:会话覆盖优先,否则全局 */
const activeModelId = computed(() => {
  if (props.sessionId) {
    return aiStore.getSession(props.sessionId)?.modelId || ''
  }
  return aiStore.settings.activeModelId
})

/** 是否为会话级覆盖(而非跟随全局) */
const isOverride = computed(() => Boolean(props.sessionId && activeModelId.value))

/** 全局默认模型的展示名(「跟随全局」行用) */
const globalDisplayName = computed(() => {
  if (aiStore.settings.activeModelId) {
    const active = aiStore.settings.models.find(m => m.id === aiStore.settings.activeModelId)
    if (active) return active.name
  }
  return aiStore.settings.model || t('ai.defaultModel')
})

const activeModelDisplayName = computed(() => {
  if (activeModelId.value) {
    const active = aiStore.settings.models.find(m => m.id === activeModelId.value)
    if (active) return active.name
  }
  return globalDisplayName.value
})

/** 默认模型行(全局默认 LLM 配置) */
const defaultEntry = computed(() => ({
  name: `${t('ai.defaultModel')} (${aiStore.settings.model || '—'})`,
  url: aiStore.settings.baseUrl,
}))

const filteredModels = computed<AiModelConfig[]>(() => {
  const kw = keyword.value.trim().toLowerCase()
  if (!kw) return aiStore.settings.models
  return aiStore.settings.models.filter(m =>
    m.name.toLowerCase().includes(kw)
    || m.model.toLowerCase().includes(kw)
    || (m.baseUrl || '').toLowerCase().includes(kw)
  )
})

function openGlobalAiSettings() {
  window.dispatchEvent(new CustomEvent('starhub:open-ai-settings'))
}

function notifySwitched(name: string) {
  notifyStore.notify({
    message: `${t('ai.modelSwitched')}: ${name}`,
    color: 'info',
    timeout: 2500,
  })
}

function selectModel(modelId: string) {
  if (props.sessionId) {
    // 会话级:空串 = 清除覆盖,跟随全局
    aiStore.setSessionModel(props.sessionId, modelId)
    if (!modelId) {
      notifySwitched(`${t('ai.followGlobal')} (${globalDisplayName.value})`)
      return
    }
    const model = aiStore.settings.models.find(m => m.id === modelId)
    if (model) notifySwitched(`${model.name} (${model.model})`)
    return
  }
  if (!modelId) {
    // 选择默认模型:清除 activeModelId,回退到 LLM 服务的默认配置
    aiStore.settings.activeModelId = ''
    notifySwitched(aiStore.settings.model || t('ai.defaultModel'))
    return
  }
  const model = aiStore.settings.models.find(m => m.id === modelId)
  if (model) {
    aiStore.settings.activeModelId = modelId
    notifySwitched(`${model.name} (${model.model})`)
  }
}
</script>

<template>
  <div class="ai-model-selector">
    <v-menu :close-on-content-click="false" offset-y @update:model-value="keyword = ''">
      <template #activator="{ props: menuProps }">
        <button
          v-bind="menuProps"
          class="ai-model-badge"
          :class="{ 'is-override': isOverride }"
          :data-tooltip="t('ai.switchModel')"
          :title="t('ai.switchModel')"
        >
          <v-icon size="12">mdi-chip</v-icon>
          <span class="ai-model-name">{{ activeModelDisplayName }}</span>
          <v-icon size="10">mdi-chevron-down</v-icon>
        </button>
      </template>

      <div class="cyber-panel ai-model-menu">
        <!-- 搜索 -->
        <div v-if="aiStore.settings.models.length > 3" class="ai-model-menu-search">
          <v-icon size="13">mdi-magnify</v-icon>
          <input
            v-model="keyword"
            type="text"
            :placeholder="t('ai.searchModels')"
            @click.stop
          >
        </div>

        <div class="ai-model-menu-body">
          <!-- 会话模式:跟随全局 -->
          <button
            v-if="sessionId"
            class="ai-model-option"
            :class="{ 'is-active': !activeModelId }"
            @click="selectModel('')"
          >
            <v-icon size="14" class="ai-model-option-check">
              {{ !activeModelId ? 'mdi-check-circle' : 'mdi-circle-outline' }}
            </v-icon>
            <span class="ai-model-option-main">
              <span class="ai-model-option-name">{{ t('ai.followGlobal') }}</span>
              <span class="ai-model-option-url">{{ globalDisplayName }}</span>
            </span>
            <v-icon size="12" class="ai-model-option-mark">mdi-link-variant</v-icon>
          </button>

          <!-- 默认模型 -->
          <div class="ai-model-menu-section">{{ t('ai.defaultModel') }}</div>
          <button
            class="ai-model-option"
            :class="{ 'is-active': !sessionId && !activeModelId }"
            @click="selectModel('')"
          >
            <v-icon size="14" class="ai-model-option-check">
              {{ !sessionId && !activeModelId ? 'mdi-check-circle' : 'mdi-circle-outline' }}
            </v-icon>
            <span class="ai-model-option-main">
              <span class="ai-model-option-name">{{ defaultEntry.name }}</span>
              <span class="ai-model-option-url">{{ defaultEntry.url || '—' }}</span>
            </span>
          </button>

          <!-- 已配置模型 -->
          <template v-if="filteredModels.length">
            <div class="ai-model-menu-section">{{ t('ai.configuredModels') }}</div>
            <button
              v-for="m in filteredModels"
              :key="m.id"
              class="ai-model-option"
              :class="{ 'is-active': activeModelId === m.id }"
              @click="selectModel(m.id)"
            >
              <v-icon size="14" class="ai-model-option-check">
                {{ activeModelId === m.id ? 'mdi-check-circle' : 'mdi-circle-outline' }}
              </v-icon>
              <span class="ai-model-option-main">
                <span class="ai-model-option-name">
                  {{ m.name }}
                  <span class="ai-model-option-tag">{{ m.model }}</span>
                </span>
                <span class="ai-model-option-url">{{ m.baseUrl || aiStore.settings.baseUrl || '—' }}</span>
              </span>
            </button>
          </template>
          <div v-else-if="keyword" class="ai-model-menu-empty">{{ t('ai.noModelMatch') }}</div>
        </div>

        <!-- 底部:管理模型 -->
        <button class="ai-model-menu-footer" @click="openGlobalAiSettings">
          <v-icon size="13">mdi-plus-circle-outline</v-icon>
          <span>{{ t('ai.addModel') }}</span>
        </button>
      </div>
    </v-menu>
  </div>
</template>
