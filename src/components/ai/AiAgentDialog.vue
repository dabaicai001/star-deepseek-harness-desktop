<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  BUILTIN_AI_SKILLS,
  useAiStore,
  type AiAgent,
  type AiAgentDraft,
  type AiAssetType
} from '@/stores/ai'

const props = defineProps<{
  modelValue: boolean
  agent?: AiAgent | null
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  save: [draft: AiAgentDraft]
}>()

const { t } = useI18n()
const aiStore = useAiStore()
const name = ref('')
const description = ref('')
const systemPrompt = ref('')
const skillIds = ref<string[]>([])

const allSkills = computed(() => [
  ...BUILTIN_AI_SKILLS,
  ...aiStore.settings.customSkills
])

const presets: Array<{
  id: string
  name: string
  description: string
  systemPrompt: string
  skillIds: string[]
}> = [
  {
    id: 'ops',
    name: 'Ops Agent',
    description: '面向故障定位、日志与性能分析。',
    systemPrompt: '你是一名资深 SRE。先收集证据和影响面,再形成假设;每次只建议一个最有信息增益的验证动作。',
    skillIds: ['ops-triage', 'performance', 'log-analysis', 'safe-change']
  },
  {
    id: 'data',
    name: 'Data Agent',
    description: '面向数据库、SQL 与表格数据洞察。',
    systemPrompt: '你是一名数据工程师。先确认字段、口径、时间范围和样本边界,再给出可复现的查询与结论。',
    skillIds: ['data-insight', 'performance', 'safe-change']
  },
  {
    id: 'security',
    name: 'Change Guard',
    description: '审查变更风险、影响范围和回滚方案。',
    systemPrompt: '你是一名变更审查员。明确区分只读检查与写操作;任何变更都要列出影响范围、前置检查、回滚点和验证标准。',
    skillIds: ['safe-change', 'ops-triage']
  }
]

watch(
  [() => props.modelValue, () => props.agent],
  ([open, agent]) => {
    if (!open) return
    name.value = agent?.name ?? ''
    description.value = agent?.description ?? ''
    systemPrompt.value = agent?.systemPrompt ?? ''
    skillIds.value = agent ? [...agent.skillIds] : [...aiStore.settings.enabledSkillIds]
  },
  { immediate: true }
)

function close() {
  emit('update:modelValue', false)
}

function applyPreset(preset: typeof presets[number]) {
  name.value = preset.name
  description.value = preset.description
  systemPrompt.value = preset.systemPrompt
  skillIds.value = [...preset.skillIds]
}

function toggleSkill(id: string, enabled: boolean) {
  const selected = new Set(skillIds.value)
  if (enabled) selected.add(id)
  else selected.delete(id)
  skillIds.value = Array.from(selected)
}

function formatScopes(types: AiAssetType[]) {
  return types.map(type => type.toUpperCase()).join(' / ')
}

function save() {
  if (!name.value.trim() || !systemPrompt.value.trim()) return
  emit('save', {
    name: name.value,
    description: description.value,
    systemPrompt: systemPrompt.value,
    skillIds: [...skillIds.value]
  })
  close()
}
</script>

<template>
  <v-dialog
    :model-value="modelValue"
    max-width="760"
    scrollable
    transition="cyber-dialog"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div class="ai-agent-dialog cyber-panel">
      <div class="ai-agent-dialog-header">
        <div>
          <span class="section-number">AI</span>
          <span class="section-title">{{ agent ? t('ai.editAgent') : t('ai.newAgent') }}</span>
        </div>
        <button class="action-btn" :data-tooltip="t('common.close')" :aria-label="t('common.close')" @click="close">
          <v-icon size="16">mdi-close</v-icon>
        </button>
      </div>

      <div class="ai-agent-dialog-body">
        <div v-if="!agent" class="ai-agent-presets">
          <button
            v-for="preset in presets"
            :key="preset.id"
            class="cyber-card ai-agent-preset"
            @click="applyPreset(preset)"
          >
            <v-icon size="16">mdi-robot-outline</v-icon>
            <span>
              <strong>{{ preset.name }}</strong>
              <small>{{ preset.description }}</small>
            </span>
          </button>
        </div>

        <div class="form-grid">
          <div class="form-field">
            <label class="field-label">{{ t('ai.agentName') }}</label>
            <input v-model="name" class="cyber-input" :placeholder="t('ai.agentNamePlaceholder')" />
          </div>
          <div class="form-field">
            <label class="field-label">{{ t('ai.agentDescription') }}</label>
            <input v-model="description" class="cyber-input" :placeholder="t('ai.agentDescriptionPlaceholder')" />
          </div>
        </div>

        <div class="form-field">
          <label class="field-label">{{ t('ai.agentPrompt') }}</label>
          <textarea
            v-model="systemPrompt"
            class="cyber-input ai-agent-prompt"
            rows="6"
            :placeholder="t('ai.agentPromptPlaceholder')"
          />
        </div>

        <div class="form-field">
          <label class="field-label">{{ t('ai.boundSkills') }}</label>
          <div class="ai-agent-skill-grid">
            <label
              v-for="skill in allSkills"
              :key="skill.id"
              class="ai-agent-skill"
              :class="{ active: skillIds.includes(skill.id) }"
            >
              <input
                type="checkbox"
                :checked="skillIds.includes(skill.id)"
                @change="toggleSkill(skill.id, ($event.target as HTMLInputElement).checked)"
              />
              <span>
                <strong>{{ skill.name }}</strong>
                <small>{{ skill.description }}</small>
                <code>{{ formatScopes(skill.assetTypes) }}</code>
              </span>
            </label>
          </div>
        </div>
      </div>

      <div class="ai-agent-dialog-footer">
        <span>{{ t('ai.sharedSettingsHint') }}</span>
        <div>
          <button class="cyber-btn-secondary" @click="close">{{ t('common.cancel') }}</button>
          <button class="cyber-btn" :disabled="!name.trim() || !systemPrompt.trim()" @click="save">
            <v-icon size="14">mdi-content-save-outline</v-icon>
            {{ t('common.save') }}
          </button>
        </div>
      </div>
    </div>
  </v-dialog>
</template>
