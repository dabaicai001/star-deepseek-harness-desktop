<script setup lang="ts">
import { ref, onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useThemeStore } from '@/stores/theme'
import { BUILTIN_AI_SKILLS, useAiStore } from '@/stores/ai'
import type { AiAssetType, AiSettings, McpKeyValue, McpServerConfig } from '@/stores/ai'
import { listMcpTools } from '@/services/mcp'
import { version as appVersion } from '~package.json'

const { t, locale } = useI18n()
const themeStore = useThemeStore()
const aiStore = useAiStore()
aiStore.ensureSettingsShape()

// 选中的 tab
type TabKey = 'general' | 'appearance' | 'ai' | 'about'
const props = withDefaults(defineProps<{ initialTab?: TabKey }>(), {
  initialTab: 'general'
})
const activeTab = ref<TabKey>(props.initialTab)
watch(() => props.initialTab, tab => { activeTab.value = tab })

/** 通用设置(用 localStorage 持久化,P2 阶段先不上 store) */
const startPage = ref<'welcome' | 'restore'>('welcome')
const confirmClose = ref(true)
const maxTabs = ref(20)
const STORAGE_KEY = 'starhub.settings.general'
const generalSaved = ref(false)

function loadGeneral() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return
    const v = JSON.parse(raw)
    // 兼容旧值 'home':等同于 'welcome'
    if (v.startPage === 'welcome' || v.startPage === 'home' || v.startPage === 'restore') {
      startPage.value = v.startPage === 'home' ? 'welcome' : v.startPage
    }
    if (typeof v.confirmClose === 'boolean') confirmClose.value = v.confirmClose
    if (typeof v.maxTabs === 'number' && v.maxTabs > 0) maxTabs.value = v.maxTabs
  } catch {}
}
function saveGeneral() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      startPage: startPage.value,
      confirmClose: confirmClose.value,
      maxTabs: maxTabs.value
    }))
    generalSaved.value = true
    setTimeout(() => { generalSaved.value = false }, 1600)
  } catch {}
}
onMounted(async () => {
  loadGeneral()
  aiStore.ensureSettingsShape()
  aiLocal.value = cloneAiSettings(aiStore.settings)
  try {
    aiLocal.value.apiKey = await aiStore.getApiKey()
  } catch (error) {
    // 纯浏览器预览没有 Tauri invoke;保留空值即可,桌面端仍从系统 Keyring 解锁。
    console.warn('[settings] AI API key is unavailable outside Tauri:', error)
    aiLocal.value.apiKey = ''
  }
  aiLocal.value.mcpServers = await aiStore.getMcpServers()
})

// AI 配置本地副本(用于表单展示,保存时再写回 store)
function cloneAiSettings(settings: AiSettings): AiSettings {
  return {
    ...settings,
    commandWhitelist: [...settings.commandWhitelist],
    enabledSkillIds: [...settings.enabledSkillIds],
    customSkills: settings.customSkills.map(skill => ({
      ...skill,
      assetTypes: [...skill.assetTypes]
    })),
    mcpServers: settings.mcpServers.map(server => ({
      ...server,
      args: [...server.args],
      env: server.env.map(item => ({ ...item })),
      headers: server.headers.map(item => ({ ...item }))
    }))
  }
}

const aiLocal = ref<AiSettings>(cloneAiSettings(aiStore.settings))
const newWhitelistItem = ref('')
const saved = ref(false)
const testing = ref(false)
const testResult = ref<string | null>(null)
const mcpTestResults = ref<Record<string, string>>({})
const mcpTesting = ref<Set<string>>(new Set())

const AI_ASSET_TYPES: Array<{ value: AiAssetType; label: string }> = [
  { value: 'ssh', label: 'SSH' },
  { value: 'db', label: 'DB' },
  { value: 'docker', label: 'Docker' },
  { value: 'excel', label: 'Excel' },
  { value: 'local', label: 'LOCAL' }
]

const customSkillName = ref('')
const customSkillDescription = ref('')
const customSkillPrompt = ref('')
const customSkillAssetTypes = ref<AiAssetType[]>(['ssh', 'db', 'docker', 'excel', 'local'])
const skillImportInput = ref<HTMLInputElement | null>(null)
const skillImportResult = ref<string | null>(null)

const accentOptions = [
  { value: 'cyan' as const,   label: '青色 (Cyberpunk)',   color: '#00f0ff' },
  { value: 'purple' as const, label: '紫色 (Neon)',        color: '#b56bff' },
  { value: 'green' as const,  label: '绿色 (Matrix)',      color: '#4ade80' },
  { value: 'orange' as const, label: '橙色 (Sunset)',      color: '#ff7a3a' }
]

async function onSave() {
  // apiKey 单独处理(走加密通道),其他字段用 updateSettings
  const { apiKey, mcpServers, ...rest } = aiLocal.value
  aiStore.updateSettings(rest)
  await Promise.all([
    aiStore.setApiKey(apiKey),
    aiStore.setMcpServers(mcpServers)
  ])
  saved.value = true
  setTimeout(() => { saved.value = false }, 2000)
}

async function onTestConnection() {
  if (!aiLocal.value.apiKey) {
    testResult.value = '✗ 请先填写 API Key'
    return
  }
  testing.value = true
  testResult.value = null
  try {
    // 用一个小请求测试连通性
    const res = await fetch(`${aiLocal.value.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${aiLocal.value.apiKey}`
      },
      body: JSON.stringify({
        model: aiLocal.value.model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 5
      })
    })
    if (res.ok) {
      testResult.value = `✓ 连接成功 (HTTP ${res.status})`
    } else {
      const text = await res.text().catch(() => '')
      testResult.value = `✗ HTTP ${res.status}: ${text.slice(0, 200)}`
    }
  } catch (e) {
    testResult.value = `✗ ${e instanceof Error ? e.message : String(e)}`
  } finally {
    testing.value = false
  }
}

function addWhitelist() {
  const cmd = newWhitelistItem.value.trim()
  if (!cmd) return
  if (!aiLocal.value.commandWhitelist.includes(cmd)) {
    aiLocal.value.commandWhitelist.push(cmd)
  }
  newWhitelistItem.value = ''
}

function removeWhitelist(cmd: string) {
  aiLocal.value.commandWhitelist = aiLocal.value.commandWhitelist.filter(c => c !== cmd)
}

function addMcpServer() {
  aiLocal.value.mcpServers.push({
    id: `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name: 'MCP Server',
    enabled: true,
    transport: 'stdio',
    command: '',
    args: [],
    cwd: '',
    url: '',
    env: [],
    headers: []
  })
}

function removeMcpServer(id: string) {
  aiLocal.value.mcpServers = aiLocal.value.mcpServers.filter(server => server.id !== id)
  delete mcpTestResults.value[id]
}

function setMcpArgs(server: McpServerConfig, event: Event) {
  server.args = (event.target as HTMLTextAreaElement).value
    .split(/\r?\n/)
    .map(value => value.trim())
    .filter(Boolean)
}

function addMcpEntry(target: McpKeyValue[]) {
  target.push({ name: '', value: '' })
}

function removeMcpEntry(target: McpKeyValue[], index: number) {
  target.splice(index, 1)
}

async function testMcpServer(server: McpServerConfig) {
  const testing = new Set(mcpTesting.value)
  testing.add(server.id)
  mcpTesting.value = testing
  mcpTestResults.value = { ...mcpTestResults.value, [server.id]: '' }
  try {
    if (typeof window !== 'undefined' && !('__TAURI_INTERNALS__' in window)) {
      throw new Error('请在 StarHub 桌面端测试 MCP Server')
    }
    const tools = await listMcpTools(server)
    mcpTestResults.value = {
      ...mcpTestResults.value,
      [server.id]: `✓ 连接成功,发现 ${tools.length} 个工具`
    }
  } catch (error) {
    mcpTestResults.value = {
      ...mcpTestResults.value,
      [server.id]: `✗ ${error instanceof Error ? error.message : String(error)}`
    }
  } finally {
    const next = new Set(mcpTesting.value)
    next.delete(server.id)
    mcpTesting.value = next
  }
}

function isSkillEnabled(id: string) {
  return aiLocal.value.enabledSkillIds.includes(id)
}

function toggleSkill(id: string, enabled: boolean) {
  const ids = new Set(aiLocal.value.enabledSkillIds)
  if (enabled) ids.add(id)
  else ids.delete(id)
  aiLocal.value.enabledSkillIds = Array.from(ids)
}

function toggleCustomSkillAssetType(type: AiAssetType, enabled: boolean) {
  const types = new Set(customSkillAssetTypes.value)
  if (enabled) types.add(type)
  else types.delete(type)
  customSkillAssetTypes.value = Array.from(types)
}

function addCustomSkill() {
  const name = customSkillName.value.trim()
  const prompt = customSkillPrompt.value.trim()
  if (!name || !prompt) return
  const assetTypes = customSkillAssetTypes.value.length > 0
    ? [...customSkillAssetTypes.value]
    : ['ssh', 'db', 'docker', 'excel', 'local'] as AiAssetType[]
  const id = `custom-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  aiLocal.value.customSkills.push({
    id,
    name,
    description: customSkillDescription.value.trim(),
    prompt,
    assetTypes
  })
  toggleSkill(id, true)
  customSkillName.value = ''
  customSkillDescription.value = ''
  customSkillPrompt.value = ''
  customSkillAssetTypes.value = ['ssh', 'db', 'docker', 'excel']
}

function removeCustomSkill(id: string) {
  aiLocal.value.customSkills = aiLocal.value.customSkills.filter(skill => skill.id !== id)
  aiLocal.value.enabledSkillIds = aiLocal.value.enabledSkillIds.filter(skillId => skillId !== id)
}

function normalizeImportedAssetTypes(value: unknown): AiAssetType[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[,/\s]+/)
      : []
  const allowed = new Set<AiAssetType>(['ssh', 'db', 'docker', 'excel', 'local'])
  const parsed = raw.map(item => String(item).toLowerCase()).filter((item): item is AiAssetType => allowed.has(item as AiAssetType))
  return parsed.length > 0 ? Array.from(new Set(parsed)) : ['ssh', 'db', 'docker', 'excel', 'local']
}

function parseSkillMarkdown(content: string, fileName: string): Record<string, unknown> {
  const frontmatter = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/)
  const metadata: Record<string, string> = {}
  if (frontmatter) {
    for (const line of frontmatter[1].split(/\r?\n/)) {
      const separator = line.indexOf(':')
      if (separator <= 0) continue
      metadata[line.slice(0, separator).trim()] = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '')
    }
  }
  const body = (frontmatter ? content.slice(frontmatter[0].length) : content).trim()
  return {
    name: metadata.name || fileName.replace(/\.(md|markdown)$/i, ''),
    description: metadata.description || '',
    assetTypes: metadata.assetTypes || metadata.scopes || '',
    prompt: body
  }
}

async function importSkills(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  skillImportResult.value = null
  if (file.size > 256 * 1024) {
    skillImportResult.value = '导入失败:Skill 文件不能超过 256 KB'
    return
  }
  try {
    const content = await file.text()
    let payload: unknown
    if (/\.json$/i.test(file.name)) {
      payload = JSON.parse(content)
    } else {
      payload = parseSkillMarkdown(content, file.name)
    }
    const records = Array.isArray(payload)
      ? payload
      : payload && typeof payload === 'object' && Array.isArray((payload as { skills?: unknown }).skills)
        ? (payload as { skills: unknown[] }).skills
        : [payload]
    let imported = 0
    let skipped = 0
    for (const record of records) {
      const item = record && typeof record === 'object' ? record as Record<string, unknown> : {}
      const name = String(item.name || '').trim()
      const prompt = String(item.prompt || item.instructions || item.content || '').trim()
      if (!name || !prompt) {
        skipped++
        continue
      }
      const duplicate = aiLocal.value.customSkills.some(skill => skill.name === name && skill.prompt === prompt)
      if (duplicate) {
        skipped++
        continue
      }
      const id = `imported-${Date.now()}-${imported}-${Math.random().toString(36).slice(2, 6)}`
      aiLocal.value.customSkills.push({
        id,
        name,
        description: String(item.description || '').trim(),
        prompt,
        assetTypes: normalizeImportedAssetTypes(item.assetTypes ?? item.scopes)
      })
      toggleSkill(id, true)
      imported++
    }
    skillImportResult.value = imported > 0
      ? `已导入 ${imported} 个 Skill${skipped ? `,跳过 ${skipped} 个无效或重复项` : ''};点击“保存”后生效`
      : '没有可导入的 Skill:请检查 name 与 prompt/instructions 字段'
  } catch (error) {
    skillImportResult.value = `导入失败:${error instanceof Error ? error.message : String(error)}`
  }
}

function formatSkillScopes(types: AiAssetType[]) {
  return types.map(type => AI_ASSET_TYPES.find(item => item.value === type)?.label || type).join(' / ')
}

const PRESET_MODELS = [
  { id: 'gpt-4o-mini', label: 'GPT-4o mini (OpenAI)' },
  { id: 'gpt-4o', label: 'GPT-4o (OpenAI)' },
  { id: 'gpt-3.5-turbo', label: 'GPT-3.5 Turbo (OpenAI)' },
  { id: 'claude-3-5-sonnet-20241022', label: 'Claude 3.5 Sonnet (via 代理)' },
  { id: 'deepseek-chat', label: 'DeepSeek (deepseek-chat)' },
  { id: 'qwen-turbo', label: '通义千问 Qwen Turbo (阿里)' }
]
</script>

<template>
  <div class="settings-view">
    <div class="settings-header">
      <v-icon size="20" color="cyan">mdi-cog-outline</v-icon>
      <h2>{{ t('settings.title') }}</h2>
    </div>

    <!-- Tab 切换 -->
    <div class="settings-tabs">
      <button class="tab" :class="{ active: activeTab === 'general' }" @click="activeTab = 'general'">
        <v-icon size="13">mdi-tune-variant</v-icon>
        <span>{{ t('settings.general') }}</span>
      </button>
      <button class="tab" :class="{ active: activeTab === 'appearance' }" @click="activeTab = 'appearance'">
        <v-icon size="13">mdi-palette-outline</v-icon>
        <span>{{ t('settings.appearance') }}</span>
      </button>
      <button class="tab" :class="{ active: activeTab === 'ai' }" @click="activeTab = 'ai'">
        <v-icon size="13">mdi-robot-outline</v-icon>
        <span>AI 助手</span>
        <span class="tab-hint">Function Calling · 命令执行</span>
      </button>
      <button class="tab" :class="{ active: activeTab === 'about' }" @click="activeTab = 'about'">
        <v-icon size="13">mdi-information-outline</v-icon>
        <span>{{ t('settings.about') }}</span>
      </button>
    </div>

    <!-- 通用设置 -->
    <div v-if="activeTab === 'general'" class="settings-panel">
      <div v-if="generalSaved" class="settings-save-banner">
        <v-icon size="14">mdi-check-circle-outline</v-icon>
        通用设置已自动保存
      </div>

      <div class="section">
        <div class="section-header">
          <span class="section-number">01</span>
          <span class="section-title">{{ t('settings.generalStartPage') }}</span>
        </div>
        <div class="form-grid">
          <label class="radio-row">
            <input type="radio" value="welcome" v-model="startPage" @change="saveGeneral" />
            <span>{{ t('settings.generalStartPageHome') }}</span>
          </label>
          <label class="radio-row">
            <input type="radio" value="restore" v-model="startPage" @change="saveGeneral" />
            <span>{{ t('settings.generalStartPageRestore') }}</span>
          </label>
        </div>
      </div>

      <div class="section">
        <div class="section-header">
          <span class="section-number">02</span>
          <span class="section-title">{{ t('settings.generalMaxTabs') }}</span>
        </div>
        <div class="form-grid">
          <div class="form-field">
            <input
              v-model.number="maxTabs"
              type="number"
              min="1"
              max="100"
              class="cyber-input"
              @change="saveGeneral"
            />
            <div class="field-hint">{{ t('settings.generalMaxTabsHint') }}</div>
          </div>
        </div>
      </div>

      <div class="section">
        <div class="section-header">
          <span class="section-number">03</span>
          <span class="section-title">{{ t('settings.generalConfirmClose') }}</span>
        </div>
        <label class="checkbox-row">
          <input type="checkbox" v-model="confirmClose" @change="saveGeneral" />
          <span>{{ t('settings.generalConfirmClose') }}</span>
        </label>
      </div>

      <div class="section">
        <div class="section-header">
          <span class="section-number">04</span>
          <span class="section-title">{{ t('settings.fontSize') }}</span>
        </div>
        <div class="form-grid">
          <div class="form-field">
            <label class="field-label">
              {{ t('settings.fontSize') }}
              <span class="font-size-value">{{ themeStore.fontSize }}px</span>
            </label>
            <input
              type="range"
              min="10"
              max="24"
              step="1"
              :value="themeStore.fontSize"
              class="cyber-range"
              @input="themeStore.setFontSize(Number(($event.target as HTMLInputElement).value))"
            />
            <div class="field-hint">{{ t('settings.fontSizeHint') }}</div>
          </div>
        </div>
      </div>
    </div>

    <!-- 外观设置 -->
    <div v-if="activeTab === 'appearance'" class="settings-panel">
      <div class="section">
        <div class="section-header">
          <span class="section-number">01</span>
          <span class="section-title">{{ t('settings.theme') }}</span>
        </div>
        <div class="theme-grid">
          <div class="theme-card" :class="{ active: themeStore.theme === 'darkTheme' }" @click="themeStore.setTheme('darkTheme')">
            <div class="theme-preview dark"><div class="bar" /><div class="dot" /></div>
            <span>Dark</span>
          </div>
          <div class="theme-card" :class="{ active: themeStore.theme === 'lightTheme' }" @click="themeStore.setTheme('lightTheme')">
            <div class="theme-preview light"><div class="bar" /><div class="dot" /></div>
            <span>Light</span>
          </div>
        </div>

        <!-- 主色主题(accent color) -->
        <div class="accent-section">
          <div class="accent-label">主色</div>
          <div class="accent-row">
            <div
              v-for="opt in accentOptions"
              :key="opt.value"
              class="accent-dot"
              :class="{ active: themeStore.accent === opt.value, [opt.value]: true }"
              :data-tooltip="opt.label"
              :style="{ background: opt.color }"
              @click="themeStore.setAccent(opt.value)"
            />
          </div>
          <p class="accent-hint">主色影响所有强调色元素(连接状态、按钮、链接、装饰线)</p>
        </div>
      </div>

      <div class="section">
        <div class="section-header">
          <span class="section-number">02</span>
          <span class="section-title">{{ t('settings.language') }}</span>
        </div>
        <div class="theme-grid">
          <div class="theme-card" :class="{ active: locale === 'zh-CN' }" @click="locale = 'zh-CN'">
            <span class="lang">中</span>
            <span>中文</span>
          </div>
          <div class="theme-card" :class="{ active: locale === 'en-US' }" @click="locale = 'en-US'">
            <span class="lang">EN</span>
            <span>English</span>
          </div>
        </div>
      </div>
    </div>

    <!-- AI 配置 -->
    <div v-if="activeTab === 'ai'" class="settings-panel">
      <div class="section">
        <div class="section-header">
          <span class="section-number">01</span>
          <span class="section-title">LLM 服务</span>
        </div>
        <p class="section-desc">支持任何 OpenAI 兼容 /chat/completions 协议的 API(GPT、Claude 代理、DeepSeek、Qwen 等)。</p>

        <div class="form-grid">
          <div class="form-field">
            <label class="field-label">Provider</label>
            <select v-model="aiLocal.provider" class="cyber-input">
              <option value="openai-compatible">OpenAI 兼容协议</option>
            </select>
          </div>

          <div class="form-field">
            <label class="field-label">Base URL</label>
            <input v-model="aiLocal.baseUrl" class="cyber-input" placeholder="https://api.openai.com/v1" />
            <div class="field-hint">只填到 /v1 即可,后面的 /chat/completions 会自动拼接</div>
          </div>

          <div class="form-field">
            <label class="field-label">API Key</label>
            <input v-model="aiLocal.apiKey" class="cyber-input" type="password" placeholder="sk-..." />
            <div class="field-hint">密钥保存在系统 Keyring,仅在请求所配置的 LLM 服务时使用</div>
          </div>

          <div class="form-field">
            <label class="field-label">模型</label>
            <input v-model="aiLocal.model" class="cyber-input" placeholder="gpt-4o-mini" />
            <div class="field-hint">
              常用:
              <a v-for="m in PRESET_MODELS" :key="m.id" class="preset-link" @click.prevent="aiLocal.model = m.id">{{ m.label }}</a>
            </div>
          </div>

          <div class="form-field">
            <label class="field-label">温度 ({{ aiLocal.temperature }})</label>
            <input v-model.number="aiLocal.temperature" type="range" min="0" max="1" step="0.1" class="cyber-range" />
            <div class="field-hint">运维场景建议 0.2-0.4,创意场景 0.7+</div>
          </div>

          <div class="form-field">
            <label class="field-label">单次最大 tokens</label>
            <input v-model.number="aiLocal.maxTokens" class="cyber-input" type="number" min="256" max="32000" />
          </div>

          <div class="form-field">
            <label class="field-label">命令完成检测</label>
            <div class="prompt-listener-card">
              <v-icon size="15">mdi-console-line</v-icon>
              <div>
                <strong>Prompt 监听</strong>
                <span>SSH 命令输出会等 shell prompt 返回后收集完成</span>
              </div>
            </div>
          </div>
        </div>

        <div class="action-row">
          <button class="cyber-btn-secondary" :disabled="testing" @click="onTestConnection">
            <v-icon size="14">{{ testing ? 'mdi-loading mdi-spin' : 'mdi-lan-pending' }}</v-icon>
            {{ testing ? '测试中…' : '测试连接' }}
          </button>
          <button class="cyber-btn" @click="onSave">
            <v-icon size="14">mdi-content-save-outline</v-icon>
            保存
          </button>
          <span v-if="testResult" class="test-result" :class="{ ok: testResult.startsWith('✓') }">{{ testResult }}</span>
          <span v-if="saved" class="save-hint">✓ 已保存</span>
        </div>
      </div>

      <div class="section">
        <div class="section-header">
          <span class="section-number">02</span>
          <span class="section-title">SKILLS</span>
        </div>
        <p class="section-desc">
          启用的技能会注入到对应目标 AI 的系统提示中;自定义技能可限定到 LOCAL、SSH、DB、Docker 或 Excel。
        </p>

        <div class="skills-grid">
          <label
            v-for="skill in BUILTIN_AI_SKILLS"
            :key="skill.id"
            class="skill-card"
            :class="{ active: isSkillEnabled(skill.id) }"
          >
            <input
              type="checkbox"
              :checked="isSkillEnabled(skill.id)"
              @change="toggleSkill(skill.id, ($event.target as HTMLInputElement).checked)"
            />
            <span class="skill-toggle" />
            <span class="skill-body">
              <span class="skill-title">{{ skill.name }}</span>
              <span class="skill-desc">{{ skill.description }}</span>
              <span class="skill-scope">{{ formatSkillScopes(skill.assetTypes) }}</span>
            </span>
          </label>
        </div>

        <div class="custom-skill-form">
          <div class="form-grid">
            <div class="form-field">
              <label class="field-label">自定义 Skill 名称</label>
              <input v-model="customSkillName" class="cyber-input" placeholder="例如: Nginx 排障" />
            </div>
            <div class="form-field">
              <label class="field-label">说明</label>
              <input v-model="customSkillDescription" class="cyber-input" placeholder="一句话说明用途" />
            </div>
          </div>
          <div class="asset-type-row">
            <label
              v-for="type in AI_ASSET_TYPES"
              :key="type.value"
              class="asset-toggle"
              :class="{ active: customSkillAssetTypes.includes(type.value) }"
            >
              <input
                type="checkbox"
                :checked="customSkillAssetTypes.includes(type.value)"
                @change="toggleCustomSkillAssetType(type.value, ($event.target as HTMLInputElement).checked)"
              />
              <span>{{ type.label }}</span>
            </label>
          </div>
          <textarea
            v-model="customSkillPrompt"
            class="cyber-input skill-textarea"
            rows="4"
            placeholder="写入希望 AI 遵循的步骤、约束或领域经验..."
          />
          <div class="action-row compact">
            <button class="cyber-btn-secondary" :disabled="!customSkillName.trim() || !customSkillPrompt.trim()" @click="addCustomSkill">
              <v-icon size="14">mdi-plus</v-icon>
              添加 Skill
            </button>
            <button class="cyber-btn-secondary" @click="skillImportInput?.click()">
              <v-icon size="14">mdi-import</v-icon>
              外部导入
            </button>
            <input
              ref="skillImportInput"
              hidden
              type="file"
              accept=".json,.md,.markdown,application/json,text/markdown,text/plain"
              @change="importSkills"
            />
            <span v-if="skillImportResult" class="field-hint">{{ skillImportResult }}</span>
          </div>
        </div>

        <div v-if="aiLocal.customSkills.length" class="custom-skill-list">
          <div v-for="skill in aiLocal.customSkills" :key="skill.id" class="custom-skill-item">
            <label class="checkbox-row">
              <input
                type="checkbox"
                :checked="isSkillEnabled(skill.id)"
                @change="toggleSkill(skill.id, ($event.target as HTMLInputElement).checked)"
              />
              <span>{{ skill.name }}</span>
              <code>{{ formatSkillScopes(skill.assetTypes) }}</code>
            </label>
            <button class="chip-remove" @click="removeCustomSkill(skill.id)">
              <v-icon size="12">mdi-delete-outline</v-icon>
            </button>
          </div>
        </div>
      </div>

      <div class="section">
        <div class="section-header">
          <span class="section-number">03</span>
          <span class="section-title">MCP Servers</span>
        </div>
        <p class="section-desc">
          支持 stdio、Streamable HTTP 与兼容 SSE。启用后会动态发现 tools,每次 MCP 工具调用仍需人工确认;环境变量和请求头值保存在系统 Keyring。
        </p>

        <div class="ai-mcp-toolbar">
          <button class="cyber-btn-secondary" @click="addMcpServer">
            <v-icon size="14">mdi-plus</v-icon>
            添加 MCP Server
          </button>
          <span class="field-hint">stdio 参数一行一个,不会经过 Shell 二次解析</span>
        </div>

        <div v-if="aiLocal.mcpServers.length === 0" class="ai-mcp-empty">
          <v-icon size="20">mdi-connection</v-icon>
          <span>尚未配置 MCP Server</span>
        </div>

        <div class="ai-mcp-list">
          <div v-for="server in aiLocal.mcpServers" :key="server.id" class="ai-mcp-card">
            <div class="ai-mcp-card-head">
              <label class="checkbox-row">
                <input v-model="server.enabled" type="checkbox" />
                <span>启用</span>
              </label>
              <input v-model="server.name" class="cyber-input ai-mcp-name" aria-label="MCP Server 名称" placeholder="MCP Server 名称" />
              <span class="cyber-badge">{{ server.transport }}</span>
              <button
                class="action-btn"
                :disabled="mcpTesting.has(server.id)"
                :aria-label="`测试 ${server.name}`"
                data-tooltip="测试连接与工具发现"
                @click="testMcpServer(server)"
              >
                <v-icon size="14">{{ mcpTesting.has(server.id) ? 'mdi-loading mdi-spin' : 'mdi-lan-check' }}</v-icon>
              </button>
              <button class="action-btn ai-mcp-delete" :aria-label="`删除 ${server.name}`" data-tooltip="删除 MCP Server" @click="removeMcpServer(server.id)">
                <v-icon size="14">mdi-delete-outline</v-icon>
              </button>
            </div>

            <div class="form-grid ai-mcp-grid">
              <div class="form-field">
                <label class="field-label">传输类型</label>
                <select v-model="server.transport" class="cyber-input">
                  <option value="stdio">stdio</option>
                  <option value="streamable-http">Streamable HTTP</option>
                  <option value="sse">SSE (兼容旧服务)</option>
                </select>
              </div>

              <template v-if="server.transport === 'stdio'">
                <div class="form-field">
                  <label class="field-label">Command</label>
                  <input v-model="server.command" class="cyber-input" placeholder="npx / uvx / 可执行文件路径" />
                </div>
                <div class="form-field">
                  <label class="field-label">工作目录 (可选)</label>
                  <input v-model="server.cwd" class="cyber-input" placeholder="D:\\workspace 或 /home/user/project" />
                </div>
                <div class="form-field ai-mcp-span">
                  <label class="field-label">Arguments (每行一个)</label>
                  <textarea
                    class="cyber-input ai-mcp-textarea"
                    rows="3"
                    :value="server.args.join('\n')"
                    placeholder="-y&#10;@modelcontextprotocol/server-filesystem&#10;D:\\workspace"
                    @input="setMcpArgs(server, $event)"
                  />
                </div>
              </template>

              <div v-else class="form-field ai-mcp-span">
                <label class="field-label">Server URL</label>
                <input v-model="server.url" class="cyber-input" placeholder="https://example.com/mcp" />
              </div>
            </div>

            <div v-if="server.transport === 'stdio'" class="ai-mcp-secret-block">
              <div class="ai-mcp-secret-head">
                <span>Environment</span>
                <button class="action-btn" aria-label="添加环境变量" data-tooltip="添加环境变量" @click="addMcpEntry(server.env)">
                  <v-icon size="12">mdi-plus</v-icon>
                </button>
              </div>
              <div v-for="(item, index) in server.env" :key="`env-${index}`" class="ai-mcp-key-value">
                <input v-model="item.name" class="cyber-input" aria-label="环境变量名" placeholder="API_TOKEN" />
                <input v-model="item.value" class="cyber-input" type="password" aria-label="环境变量值" placeholder="value" />
                <button class="action-btn" aria-label="删除环境变量" @click="removeMcpEntry(server.env, index)"><v-icon size="12">mdi-close</v-icon></button>
              </div>
            </div>

            <div v-else class="ai-mcp-secret-block">
              <div class="ai-mcp-secret-head">
                <span>HTTP Headers</span>
                <button class="action-btn" aria-label="添加请求头" data-tooltip="添加请求头" @click="addMcpEntry(server.headers)">
                  <v-icon size="12">mdi-plus</v-icon>
                </button>
              </div>
              <div v-for="(item, index) in server.headers" :key="`header-${index}`" class="ai-mcp-key-value">
                <input v-model="item.name" class="cyber-input" aria-label="请求头名" placeholder="Authorization" />
                <input v-model="item.value" class="cyber-input" type="password" aria-label="请求头值" placeholder="Bearer ..." />
                <button class="action-btn" aria-label="删除请求头" @click="removeMcpEntry(server.headers, index)"><v-icon size="12">mdi-close</v-icon></button>
              </div>
            </div>

            <div v-if="mcpTestResults[server.id]" class="ai-mcp-test-result" :class="{ ok: mcpTestResults[server.id].startsWith('✓') }">
              {{ mcpTestResults[server.id] }}
            </div>
          </div>
        </div>
      </div>

      <div class="section">
        <div class="section-header">
          <span class="section-number">04</span>
          <span class="section-title">命令白名单</span>
        </div>
        <p class="section-desc">
          在白名单内的命令前缀,AI 执行时不再弹确认。风险词(rm -rf / DROP / 关机 / 防火墙等)无法加入白名单,系统强制确认。
        </p>

        <div class="whitelist-input">
          <input v-model="newWhitelistItem" class="cyber-input" placeholder="例如: ls -la" @keydown.enter="addWhitelist" />
          <button class="cyber-btn-secondary" @click="addWhitelist">
            <v-icon size="14">mdi-plus</v-icon>
            添加
          </button>
        </div>

        <div class="whitelist-grid">
          <div v-for="cmd in aiLocal.commandWhitelist" :key="cmd" class="whitelist-chip">
            <v-icon size="11">mdi-check-circle-outline</v-icon>
            <code>{{ cmd }}</code>
            <button class="chip-remove" @click="removeWhitelist(cmd)">
              <v-icon size="11">mdi-close</v-icon>
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- 关于 -->
    <div v-if="activeTab === 'about'" class="settings-panel">
      <div class="section about-hero">
        <div class="about-logo">
          <div class="about-logo-icon">S</div>
        </div>
        <h2 class="about-name">StarHub</h2>
        <div class="about-version">
          <kbd>v{{ appVersion }}</kbd>
          <span class="about-version-label">{{ t('settings.aboutVersion') }}</span>
        </div>
        <p class="about-desc">{{ t('settings.aboutDesc') }}</p>
        <p class="about-slogan">{{ t('home.slogan') }}</p>
        <div class="about-links">
          <a class="about-link" href="https://github.com/dabaicai001/starhub" target="_blank" rel="noopener">
            <v-icon size="14">mdi-github</v-icon>
            <span>{{ t('settings.aboutGithub') }}</span>
          </a>
          <button class="about-link" disabled>
            <v-icon size="14">mdi-update</v-icon>
            <span>{{ t('settings.aboutCheckUpdate') }}</span>
            <span class="about-soon">{{ t('common.soon') }}</span>
          </button>
        </div>
        <p class="about-license">{{ t('settings.aboutLicense') }}</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.settings-view {
  padding: 24px;
  max-width: 900px;
  margin: 0 auto;
  height: 100%;
  overflow-y: auto;
}

.settings-header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 24px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--line-2);
}

.settings-header h2 {
  font-size: 20px;
  font-weight: 600;
  color: var(--text);
  margin: 0;
}

.settings-tabs {
  display: flex;
  gap: 4px;
  margin-bottom: 20px;
  border-bottom: 1px solid var(--line);
}

.settings-tabs .tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--text-2);
  font-size: 13px;
  cursor: pointer;
  transition: all 0.2s;
}

.settings-tabs .tab:hover {
  color: var(--text);
  background: rgba(0, 240, 255, 0.04);
}

.settings-tabs .tab.active {
  color: var(--cyan);
  border-bottom-color: var(--cyan);
  background: rgba(0, 240, 255, 0.06);
}

.settings-tabs .tab-hint {
  font-size: 10px;
  color: var(--muted);
  margin-left: 4px;
  font-family: 'JetBrains Mono', monospace;
}

.settings-panel {
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.settings-save-banner {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  align-self: flex-start;
  padding: 8px 12px;
  border-radius: 8px;
  border: 1px solid var(--status-online-border);
  background: var(--status-online-bg);
  color: var(--green);
  font-size: 12px;
  font-weight: 600;
}

.section {
  background: var(--panel);
  border: 1px solid var(--line-2);
  border-radius: 12px;
  padding: 18px 20px;
}

.section-header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 14px;
}

.section-number {
  font-family: 'Orbitron', sans-serif;
  font-size: 11px;
  font-weight: 700;
  background: var(--grad-primary);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  letter-spacing: 0.1em;
}

.section-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
}

.section-desc {
  font-size: 12px;
  color: var(--muted);
  margin: 0 0 14px;
  line-height: 1.6;
}

.theme-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 10px;
}

.theme-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  background: var(--panel-solid);
  border: 1px solid var(--line-2);
  border-radius: 8px;
  cursor: pointer;
  font-size: 12px;
  color: var(--text-2);
  transition: all 0.2s;
}

.theme-card:hover {
  border-color: var(--cyan);
  color: var(--text);
}

.theme-card.active {
  border-color: var(--cyan);
  background: rgba(0, 240, 255, 0.06);
  color: var(--cyan);
}

.theme-preview {
  width: 24px;
  height: 24px;
  border-radius: 4px;
  border: 1px solid var(--line-2);
  position: relative;
  flex-shrink: 0;
}

.theme-preview.dark { background: #050810; }
.theme-preview.light { background: #f0f2f5; }
.theme-preview .bar { position: absolute; top: 4px; left: 4px; right: 4px; height: 3px; background: var(--cyan); border-radius: 1px; }
.theme-preview .dot { position: absolute; bottom: 5px; right: 5px; width: 4px; height: 4px; border-radius: 50%; background: var(--cyan); }

.theme-card .lang {
  width: 24px;
  height: 24px;
  border-radius: 4px;
  background: var(--grad-primary);
  color: var(--bg);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 700;
  font-family: 'JetBrains Mono', monospace;
}

.accent-section {
  margin-top: 16px;
  padding-top: 14px;
  border-top: 1px solid var(--line);
}
.accent-label {
  font-size: 11px;
  color: var(--text-2);
  margin-bottom: 8px;
  font-weight: 500;
}
.accent-row {
  display: flex;
  gap: 8px;
}
.accent-dot {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  cursor: pointer;
  border: 2px solid transparent;
  transition: all 0.2s;
  position: relative;
}
.accent-dot:hover {
  transform: scale(1.1);
  box-shadow: 0 0 12px currentColor;
}
.accent-dot.active {
  border-color: var(--text);
  box-shadow: 0 0 12px currentColor;
}
.accent-hint {
  margin: 10px 0 0;
  font-size: 10px;
  color: var(--muted);
  line-height: 1.5;
}

.form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

@media (max-width: 720px) {
  .form-grid { grid-template-columns: 1fr; }
}

.form-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.prompt-listener-card {
  min-height: 50px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--line-2);
  border-radius: 8px;
  background: var(--panel-solid);
  color: var(--text-2);
}

.prompt-listener-card strong,
.prompt-listener-card span {
  display: block;
}

.prompt-listener-card strong {
  color: var(--cyan);
  font-size: 12px;
  margin-bottom: 2px;
}

.prompt-listener-card span {
  font-size: 10px;
  line-height: 1.4;
  color: var(--muted);
}

.field-label {
  font-size: 11px;
  color: var(--text-2);
  font-weight: 500;
  display: flex;
  align-items: center;
  gap: 4px;
}

.field-hint {
  font-size: 10px;
  color: var(--muted);
  line-height: 1.5;
}

.field-hint .preset-link {
  display: inline-block;
  margin: 0 4px 2px 0;
  padding: 1px 6px;
  background: rgba(0, 240, 255, 0.06);
  border: 1px solid var(--line-2);
  border-radius: 3px;
  color: var(--cyan);
  font-size: 10px;
  cursor: pointer;
  font-family: 'JetBrains Mono', monospace;
}
.field-hint .preset-link:hover {
  background: rgba(0, 240, 255, 0.12);
  border-color: var(--cyan);
}

.cyber-range {
  width: 100%;
  accent-color: var(--cyan);
}

.font-size-value {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  color: var(--cyan);
  margin-left: 8px;
}

.action-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 16px;
  padding-top: 14px;
  border-top: 1px solid var(--line);
}

.action-row.compact {
  margin-top: 10px;
  padding-top: 0;
  border-top: 0;
}

.test-result {
  font-size: 11px;
  color: var(--red);
  font-family: 'JetBrains Mono', monospace;
}
.test-result.ok { color: var(--green); }

.save-hint {
  font-size: 11px;
  color: var(--green);
  font-family: 'JetBrains Mono', monospace;
}

.whitelist-input {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}

.whitelist-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  max-height: 280px;
  overflow-y: auto;
  padding: 4px;
}

.whitelist-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 4px 4px 10px;
  background: rgba(0, 240, 255, 0.06);
  border: 1px solid rgba(0, 240, 255, 0.2);
  border-radius: 6px;
  font-size: 11px;
  color: var(--cyan);
  font-family: 'JetBrains Mono', monospace;
}

.whitelist-chip code {
  font-family: inherit;
  font-size: inherit;
}

.chip-remove {
  width: 18px;
  height: 18px;
  border-radius: 4px;
  background: transparent;
  border: 0;
  color: var(--muted);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}

.chip-remove:hover {
  color: var(--red);
  background: rgba(255, 77, 109, 0.12);
}

.skills-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 10px;
}

.skill-card {
  position: relative;
  display: flex;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--line-2);
  border-radius: 8px;
  background: var(--panel-solid);
  cursor: pointer;
  transition: all 0.2s;
}

.skill-card:hover,
.skill-card.active {
  border-color: var(--cyan);
  background: rgba(0, 240, 255, 0.06);
}

.skill-card input,
.asset-toggle input {
  position: absolute;
  opacity: 0;
  pointer-events: none;
}

.skill-toggle {
  width: 16px;
  height: 16px;
  margin-top: 1px;
  border-radius: 4px;
  border: 1px solid var(--line-2);
  background: var(--panel-solid-2);
  flex-shrink: 0;
}

.skill-card.active .skill-toggle {
  border-color: var(--cyan);
  background: var(--cyan);
  box-shadow: var(--glow-cyan);
}

.skill-body {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.skill-title {
  color: var(--text);
  font-size: 13px;
  font-weight: 600;
}

.skill-desc {
  color: var(--text-2);
  font-size: 11px;
  line-height: 1.5;
}

.skill-scope {
  align-self: flex-start;
  padding: 1px 6px;
  border-radius: 4px;
  border: 1px solid var(--line-2);
  color: var(--cyan);
  font-size: 10px;
  font-family: 'JetBrains Mono', monospace;
}

.custom-skill-form {
  margin-top: 14px;
  padding-top: 14px;
  border-top: 1px solid var(--line);
}

.asset-type-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 10px 0;
}

.asset-toggle {
  position: relative;
  display: inline-flex;
  align-items: center;
  padding: 5px 10px;
  border: 1px solid var(--line-2);
  border-radius: 6px;
  background: var(--panel-solid);
  color: var(--text-2);
  font-size: 11px;
  cursor: pointer;
}

.asset-toggle.active {
  color: var(--cyan);
  border-color: var(--cyan);
  background: rgba(0, 240, 255, 0.06);
}

.skill-textarea {
  width: 100%;
  resize: vertical;
  min-height: 94px;
  line-height: 1.6;
}

.custom-skill-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 12px;
}

.custom-skill-item {
  display: flex;
  align-items: center;
  gap: 8px;
}

.custom-skill-item .checkbox-row {
  flex: 1;
  min-width: 0;
}

.custom-skill-item code {
  margin-left: auto;
  color: var(--cyan);
  font-size: 10px;
  font-family: 'JetBrains Mono', monospace;
}

/* ====== Radio / Checkbox(单/复选) ====== */
.radio-row,
.checkbox-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--panel-solid);
  border: 1px solid var(--line-2);
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
  color: var(--text-2);
  transition: all 0.15s;
}
.radio-row:hover,
.checkbox-row:hover {
  border-color: var(--cyan);
  color: var(--text);
}
.radio-row input,
.checkbox-row input {
  accent-color: var(--cyan);
  cursor: pointer;
}

/* ====== About ====== */
.about-hero {
  text-align: center;
  padding: 40px 24px;
  position: relative;
  overflow: hidden;
}
.about-hero::before {
  content: "";
  position: absolute;
  inset: 0;
  background:
    radial-gradient(circle at 30% 30%, rgba(0, 240, 255, 0.08) 0%, transparent 50%),
    radial-gradient(circle at 70% 70%, rgba(181, 107, 255, 0.06) 0%, transparent 50%);
  pointer-events: none;
}
.about-logo {
  display: flex;
  justify-content: center;
  margin-bottom: 16px;
  position: relative;
}
.about-logo-icon {
  width: 72px;
  height: 72px;
  border-radius: 16px;
  background: var(--grad-primary);
  color: var(--bg);
  font-size: 36px;
  font-weight: 900;
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: 'Orbitron', sans-serif;
  box-shadow: 0 0 24px rgba(0, 240, 255, 0.4);
  position: relative;
}
.about-name {
  font-family: 'Orbitron', sans-serif;
  font-size: 28px;
  font-weight: 700;
  margin: 0 0 12px;
  background: var(--grad-primary);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  position: relative;
}
.about-version {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 16px;
  position: relative;
}
.about-version kbd {
  font-family: 'JetBrains Mono', monospace;
  font-size: 12px;
  padding: 2px 10px;
  background: rgba(0, 240, 255, 0.1);
  border: 1px solid rgba(0, 240, 255, 0.3);
  border-radius: 4px;
  color: var(--cyan);
}
.about-version-label {
  font-size: 11px;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.1em;
}
.about-desc {
  font-size: 13px;
  color: var(--text-2);
  line-height: 1.6;
  max-width: 480px;
  margin: 0 auto 20px;
  position: relative;
}
.about-slogan {
  font-family: 'Orbitron', 'JetBrains Mono', monospace;
  font-style: italic;
  font-weight: 500;
  font-size: 12px;
  letter-spacing: 0.15em;
  color: var(--cyan);
  opacity: 0.75;
  text-shadow: 0 0 10px rgba(0, 240, 255, 0.3);
  margin: -8px auto 24px;
}
.about-links {
  display: flex;
  gap: 10px;
  justify-content: center;
  flex-wrap: wrap;
  margin-bottom: 16px;
  position: relative;
}
.about-link {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  background: var(--panel-solid);
  border: 1px solid var(--line-2);
  border-radius: 6px;
  color: var(--text-2);
  font-size: 12px;
  text-decoration: none;
  cursor: pointer;
  font-family: inherit;
  transition: all 0.15s;
}
.about-link:hover:not(:disabled) {
  border-color: var(--cyan);
  color: var(--cyan);
  text-decoration: none;
}
.about-link:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.about-soon {
  font-size: 9px;
  font-family: 'JetBrains Mono', monospace;
  padding: 1px 4px;
  background: rgba(255, 122, 58, 0.15);
  border: 1px solid rgba(255, 122, 58, 0.3);
  border-radius: 3px;
  color: var(--orange);
  margin-left: 4px;
}
.about-license {
  font-size: 10px;
  color: var(--muted);
  font-family: 'JetBrains Mono', monospace;
  letter-spacing: 0.05em;
  position: relative;
}
</style>
