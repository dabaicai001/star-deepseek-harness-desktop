<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useThemeStore } from '@/stores/theme'
import { useAiStore } from '@/stores/ai'
import type { AiSettings } from '@/stores/ai'
import { version as appVersion } from '~package.json'

const { t, locale } = useI18n()
const themeStore = useThemeStore()
const aiStore = useAiStore()

// 选中的 tab
type TabKey = 'general' | 'appearance' | 'ai' | 'about'
const activeTab = ref<TabKey>('general')

/** 通用设置(用 localStorage 持久化,P2 阶段先不上 store) */
const startPage = ref<'home' | 'restore'>('home')
const confirmClose = ref(true)
const maxTabs = ref(20)
const STORAGE_KEY = 'starhub.settings.general'

function loadGeneral() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return
    const v = JSON.parse(raw)
    if (v.startPage === 'home' || v.startPage === 'restore') startPage.value = v.startPage
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
  } catch {}
}
onMounted(loadGeneral)

// AI 配置本地副本(用于表单展示,保存时再写回 store)
const aiLocal = ref<AiSettings>({ ...aiStore.settings })
const newWhitelistItem = ref('')
const saved = ref(false)
const testing = ref(false)
const testResult = ref<string | null>(null)

const accentOptions = [
  { value: 'cyan' as const,   label: '青色 (Cyberpunk)',   color: '#00f0ff' },
  { value: 'purple' as const, label: '紫色 (Neon)',        color: '#b56bff' },
  { value: 'green' as const,  label: '绿色 (Matrix)',      color: '#4ade80' },
  { value: 'orange' as const, label: '橙色 (Sunset)',      color: '#ff7a3a' }
]

async function onSave() {
  // apiKey 单独处理(走加密通道),其他字段用 updateSettings
  const { apiKey, ...rest } = aiLocal.value
  aiStore.updateSettings(rest)
  await aiStore.setApiKey(apiKey)
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
      <div class="section">
        <div class="section-header">
          <span class="section-number">01</span>
          <span class="section-title">{{ t('settings.generalStartPage') }}</span>
        </div>
        <div class="form-grid">
          <label class="radio-row">
            <input type="radio" value="home" v-model="startPage" @change="saveGeneral" />
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
            <div class="field-hint">仅保存在本地浏览器,不发送到任何第三方</div>
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
            <label class="field-label">命令执行超时(秒)</label>
            <input v-model.number="aiLocal.commandTimeoutSec" class="cyber-input" type="number" min="1" max="30" />
            <div class="field-hint">AI 发命令后等多久收集输出,简单 MVP,后续可改 prompt 监听</div>
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
  color: #050810;
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

.action-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 16px;
  padding-top: 14px;
  border-top: 1px solid var(--line);
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
  color: #050810;
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
