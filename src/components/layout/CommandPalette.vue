<script setup lang="ts">
/**
 * 全局命令面板(Ctrl/Cmd + P)
 *  - 列资产、当前 tabs、动作
 *  - 模糊匹配,键盘上下选,Enter 执行
 *  - 浮在窗口中央,带 backdrop
 */
import { ref, computed, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import { useAssetStore } from '@/stores/asset'
import { useAppStore } from '@/stores/app'
import { useThemeStore } from '@/stores/theme'
import { useI18n } from 'vue-i18n'
import { generateInstanceId } from '@/utils/tabId'
import type { Asset } from '@/types/asset'

const { t, locale } = useI18n()
const router = useRouter()
const assetStore = useAssetStore()
const appStore = useAppStore()
const themeStore = useThemeStore()

// 跨平台快捷键修饰键(Mac ⌘, Win/Linux Ctrl)
const isMac = ref(false)
const modKey = computed(() => isMac.value ? '⌘' : 'Ctrl')

const open = ref(false)
const query = ref('')
const selectedIdx = ref(0)
const inputRef = ref<HTMLInputElement | null>(null)

interface Command {
  id: string
  label: string
  group: 'asset' | 'tab' | 'action'
  icon: string
  /** 搜索关键词(中文/英文/同义词) */
  keywords?: string[]
  run: () => void
}

function routeNameForAsset(asset: Asset): string {
  if (asset.type === 'ssh') return 'ssh-terminal'
  if (asset.type === 'docker') return 'docker'
  if (asset.type === 'excel') return 'excel'

  const dbType = asset.config.dbType || 'mysql'
  if (dbType === 'redis') return 'db-redis'
  if (dbType === 'elasticsearch') return 'db-elasticsearch'
  if (dbType === 'clickhouse') return 'db-clickhouse'
  return 'db-mysql'
}

function routeNameForTab(tab: { assetId?: string; type: string }): string {
  const asset = tab.assetId ? assetStore.assets.find(a => a.id === tab.assetId) : null
  if (asset) return routeNameForAsset(asset)
  if (tab.type === 'ssh') return 'ssh-terminal'
  if (tab.type === 'docker') return 'docker'
  if (tab.type === 'excel') return 'excel'
  return 'db-mysql'
}

function openAssetTab(asset: Asset) {
  const existing = appStore.tabs.find(t => t.assetId === asset.id)
  if (existing) {
    appStore.setActiveTab(existing.id)
    router.push({ name: routeNameForAsset(asset), params: { id: existing.id } })
    assetStore.updateAsset(asset.id, { lastUsedAt: Date.now() })
    return
  }

  const instanceId = generateInstanceId(asset.id)
  appStore.addTab({ id: instanceId, assetId: asset.id, title: asset.name, type: asset.type })
  assetStore.updateAsset(asset.id, { lastUsedAt: Date.now() })
  router.push({ name: routeNameForAsset(asset), params: { id: instanceId } })
}

const commands = computed<Command[]>(() => {
  const cmds: Command[] = []

  // 资产
  for (const a of assetStore.assets) {
    const typeLabel = a.type === 'ssh' ? 'SSH'
      : a.type === 'db' ? (a.config.dbType || 'DB').toUpperCase()
      : a.type === 'excel' ? 'Excel'
      : 'Docker'
    cmds.push({
      id: `asset-${a.id}`,
      group: 'asset',
      icon: a.type === 'ssh' ? 'mdi-console' : a.type === 'db' ? 'mdi-database' : a.type === 'docker' ? 'mdi-docker' : 'mdi-file-excel-outline',
      label: a.name,
      keywords: [typeLabel, a.config.host || '', a.config.username || '', ...(a.tags || [])],
      run: () => openAssetTab(a)
    })
  }

  // 当前 tabs(切换)
  for (const t of appStore.tabs) {
    cmds.push({
      id: `tab-${t.id}`,
      group: 'tab',
      icon: t.type === 'db' ? 'mdi-database' : t.type === 'docker' ? 'mdi-docker' : t.type === 'excel' ? 'mdi-file-excel-outline' : 'mdi-console',
      label: `${t.title} · tab`,
      keywords: ['tab', 'switch', '切换'],
      run: () => {
        appStore.setActiveTab(t.id)
        router.push({ name: routeNameForTab(t), params: { id: t.id } })
      }
    })
  }

  // 动作
  cmds.push(
    {
      id: 'action-new',
      group: 'action',
      icon: 'mdi-plus-circle-outline',
      label: '新建连接',
      keywords: ['new', 'create', 'add'],
      run: () => {
        // 通过 window 自定义事件通知 CyberLayout 打开 dialog
        setTimeout(() => window.dispatchEvent(new CustomEvent('starhub:new-connection')), 50)
      }
    },
    {
      id: 'action-settings',
      group: 'action',
      icon: 'mdi-cog-outline',
      label: '打开设置',
      keywords: ['settings', 'preferences', '配置'],
      run: () => {
        setTimeout(() => window.dispatchEvent(new CustomEvent('starhub:open-settings')), 50)
      }
    },
    {
      id: 'action-theme-toggle',
      group: 'action',
      icon: themeStore.theme === 'darkTheme' ? 'mdi-weather-sunny' : 'mdi-weather-night',
      label: `切换主题 (${themeStore.theme === 'darkTheme' ? 'Dark → Light' : 'Light → Dark'})`,
      keywords: ['theme', 'dark', 'light', '主题'],
      run: () => themeStore.setTheme(themeStore.theme === 'darkTheme' ? 'lightTheme' : 'darkTheme')
    },
    {
      id: 'action-lang-toggle',
      group: 'action',
      icon: 'mdi-translate',
      label: `切换语言 (${locale.value === 'zh-CN' ? '中文 → EN' : 'EN → 中文'})`,
      keywords: ['language', 'lang', '语言'],
      run: () => locale.value = locale.value === 'zh-CN' ? 'en-US' : 'zh-CN'
    },
    {
      id: 'action-close-all-tabs',
      group: 'action',
      icon: 'mdi-close-circle-multiple-outline',
      label: '关闭所有 tab',
      keywords: ['close', 'all', 'tabs'],
      run: () => {
        for (const t of [...appStore.tabs]) appStore.removeTab(t.id)
        // tabs 清空后,workspace 自动落到欢迎页
      }
    }
  )

  return cmds
})

const filtered = computed<Command[]>(() => {
  const q = query.value.trim()
  if (!q) {
    // 无 query:历史记录优先(最近 5 个),其余按原顺序
    const historyIds = recentCommands.value
    const historyCmds = historyIds
      .map(id => commands.value.find(c => c.id === id))
      .filter((c): c is Command => Boolean(c))
    const rest = commands.value.filter(c => !historyIds.includes(c.id))
    return [...historyCmds, ...rest].slice(0, 12)
  }
  const ql = q.toLowerCase()

  // 支持前缀: type:ssh / group:tab / action:new
  let typeFilter: string | null = null
  let groupFilter: string | null = null
  let textQuery = ql
  const typeMatch = ql.match(/^type:(\w+)/)
  if (typeMatch) {
    typeFilter = typeMatch[1]
    textQuery = ql.replace(typeMatch[0], '').trim()
  }
  const groupMatch = ql.match(/^group:(\w+)/)
  if (groupMatch) {
    groupFilter = groupMatch[1]
    textQuery = ql.replace(groupMatch[0], '').trim()
  }
  // 支持 tag:xxx(从资产 tag 过滤)
  let tagFilter: string | null = null
  const tagMatch = ql.match(/^tag:(\S+)/)
  if (tagMatch) {
    tagFilter = tagMatch[1]
    textQuery = ql.replace(tagMatch[0], '').trim()
  }

  return commands.value.filter(c => {
    if (typeFilter && !c.group.startsWith(typeFilter) && !(c.keywords || []).some(k => k.includes(typeFilter))) return false
    if (groupFilter && c.group !== groupFilter) return false
    if (tagFilter) {
      // tag 过滤只对资产命令生效(资产才有 tag)
      const isAsset = c.id.startsWith('asset-')
      if (!isAsset) return false
      const a = assetStore.assets.find(x => `asset-${x.id}` === c.id)
      if (!a || !a.tags?.some(t => t.toLowerCase().includes(tagFilter))) return false
    }
    if (!textQuery) return true
    const haystack = [
      c.label.toLowerCase(),
      c.group,
      ...(c.keywords || []).map(k => k.toLowerCase())
    ].join(' ')
    return haystack.includes(textQuery)
  }).slice(0, 20)
})

/** 命令历史(localStorage 持久化,最近 20 个) */
const RECENT_KEY = 'starhub.cmd-palette.recent'
const recentCommands = ref<string[]>(loadRecent())

function loadRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

function saveRecent() {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(recentCommands.value)) } catch {}
}

function recordRun(id: string) {
  // 把 id 移到最前,去重,保留 20 个
  const next = [id, ...recentCommands.value.filter(x => x !== id)].slice(0, 20)
  recentCommands.value = next
  saveRecent()
}

function show() {
  open.value = true
  query.value = ''
  selectedIdx.value = 0
  nextTick(() => inputRef.value?.focus())
}

function hide() {
  open.value = false
}

function runCommand(cmd: Command) {
  cmd.run()
  recordRun(cmd.id)
  hide()
}

function onKeydown(e: KeyboardEvent) {
  // Ctrl/Cmd + P 触发
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'p') {
    e.preventDefault()
    if (open.value) hide()
    else show()
    return
  }
  // 面板打开时
  if (open.value) {
    if (e.key === 'Escape') {
      e.preventDefault()
      hide()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      selectedIdx.value = Math.min(filtered.value.length - 1, selectedIdx.value + 1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      selectedIdx.value = Math.max(0, selectedIdx.value - 1)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const cmd = filtered.value[selectedIdx.value]
      if (cmd) runCommand(cmd)
    }
  }
}

function onOpenCommandPaletteEvent() {
  show()
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  window.addEventListener('starhub:open-command-palette', onOpenCommandPaletteEvent)
  const ua = navigator.userAgent.toLowerCase()
  isMac.value = /mac|iphone|ipad|ipod/.test(ua)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('starhub:open-command-palette', onOpenCommandPaletteEvent)
})

const groupLabel: Record<Command['group'], string> = {
  asset: '资产',
  tab: 'Tab',
  action: '动作'
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="cmd-palette-backdrop" @click="hide">
      <div class="cmd-palette" @click.stop>
        <div class="cmd-input-wrap">
          <v-icon size="16" color="cyan">mdi-magnify</v-icon>
          <input
            ref="inputRef"
            v-model="query"
            type="text"
            class="cmd-input"
            placeholder="搜索资产、tab 或动作…试试 type:ssh / group:tab / tag:prod"
            @input="selectedIdx = 0"
          />
          <kbd>Esc</kbd>
        </div>

        <div v-if="filtered.length === 0" class="cmd-empty">
          <v-icon size="20" color="muted">mdi-magnify-close</v-icon>
          <span>没有匹配项</span>
        </div>

        <div v-else class="cmd-list">
          <template v-for="(cmd, idx) in filtered" :key="cmd.id">
            <div v-if="idx === 0 || filtered[idx - 1].group !== cmd.group" class="cmd-group-label">
              {{ groupLabel[cmd.group] }}
            </div>
            <div
              class="cmd-item"
              :class="{ selected: idx === selectedIdx }"
              @click="runCommand(cmd)"
              @mouseenter="selectedIdx = idx"
            >
              <v-icon size="14" :class="cmd.group">{{ cmd.icon }}</v-icon>
              <span class="cmd-label">{{ cmd.label }}</span>
              <kbd v-if="idx === selectedIdx" class="cmd-kbd">↵</kbd>
            </div>
          </template>
        </div>

        <div class="cmd-footer">
          <span><kbd>↑</kbd><kbd>↓</kbd> 切换</span>
          <span><kbd>↵</kbd> 执行</span>
          <span><kbd>Esc</kbd> 关闭</span>
          <span class="cmd-shortcut">{{ modKey }}P</span>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.cmd-palette-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(8, 13, 20, 0.68);
  backdrop-filter: blur(4px);
  z-index: 9999;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 12vh;
  animation: cmdFadeIn 0.12s ease;
}
@keyframes cmdFadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

.cmd-palette {
  width: 600px;
  max-width: 90vw;
  max-height: 70vh;
  background: var(--panel-solid);
  border: 1px solid var(--status-connecting-border);
  border-radius: 12px;
  box-shadow: var(--shadow);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  animation: cmdSlideDown 0.15s cubic-bezier(0.4, 0, 0.2, 1);
}
@keyframes cmdSlideDown {
  from { opacity: 0; transform: translateY(-8px); }
  to { opacity: 1; transform: translateY(0); }
}

.cmd-input-wrap {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--line-2);
}
.cmd-input {
  flex: 1;
  background: transparent;
  border: 0;
  outline: none;
  color: var(--text);
  font-size: 15px;
  font-family: inherit;
}
.cmd-input::placeholder { color: var(--muted); }
.cmd-input-wrap kbd {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  padding: 2px 6px;
  background: var(--kbd-bg);
  border: 1px solid var(--line-2);
  border-radius: 4px;
  color: var(--muted);
}

.cmd-list {
  overflow-y: auto;
  max-height: 50vh;
  padding: 6px;
}

.cmd-group-label {
  font-size: 10px;
  font-weight: 700;
  font-family: 'Orbitron', sans-serif;
  color: var(--muted);
  letter-spacing: 0.12em;
  padding: 8px 10px 4px;
  text-transform: uppercase;
}

.cmd-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 6px;
  cursor: pointer;
  color: var(--text-2);
  font-size: 13px;
  transition: all 0.1s;
}
.cmd-item.selected {
  background: var(--active-cyan);
  color: var(--cyan);
}
.cmd-item .v-icon.asset { color: var(--cyan); }
.cmd-item .v-icon.tab { color: var(--purple); }
.cmd-item .v-icon.action { color: var(--muted); }
.cmd-item.selected .v-icon { color: var(--cyan); }
.cmd-label { flex: 1; }
.cmd-kbd {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  padding: 1px 6px;
  background: var(--cyan);
  color: var(--bg);
  border-radius: 4px;
  font-weight: 700;
}

.cmd-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 40px 20px;
  color: var(--muted);
  font-size: 13px;
}

.cmd-footer {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 8px 14px;
  border-top: 1px solid var(--line-2);
  font-size: 10px;
  color: var(--muted);
  font-family: 'JetBrains Mono', monospace;
}
.cmd-footer kbd {
  font-size: 10px;
  padding: 1px 4px;
  background: var(--kbd-bg);
  border: 1px solid var(--line-2);
  border-radius: 3px;
  color: var(--text-2);
  margin: 0 2px;
}
.cmd-shortcut {
  margin-left: auto;
  color: var(--cyan);
  font-weight: 700;
}
</style>
