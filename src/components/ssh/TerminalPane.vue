<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { SearchAddon } from '@xterm/addon-search'
import { useThemeStore } from '@/stores/theme'
import ContextMenu from '@/components/common/ContextMenu.vue'
import type { MenuItem } from '@/components/common/ContextMenu.vue'
import '@xterm/xterm/css/xterm.css'

const props = defineProps<{
  sessionId: string
  fontSize?: number
  reconnectMode?: boolean
  /** 让 FitAddon 在行数计算中扣除终端底部安全区。 */
  bottomSafeArea?: boolean
}>()

const emit = defineEmits<{
  data: [data: string]
  reconnect: []
  resize: [cols: number, rows: number]
  copy: [text: string]   // 复制成功(让父级弹 toast)
  paste: [text: string]  // 粘贴成功(让父级弹 toast)
}>()

const themeStore = useThemeStore()
const { t } = useI18n()

const terminalRef = ref<HTMLDivElement>()
let terminal: Terminal
let fitAddon: FitAddon
let searchAddon: SearchAddon
let resizeObserver: ResizeObserver | null = null
let pasteInFlight = false

function getCssVar(name: string): string {
  if (typeof document === 'undefined') return ''
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

function buildTerminalTheme() {
  return {
    background: getCssVar('--bg-terminal') || '#03060d',
    foreground: getCssVar('--terminal-fg') || '#e8efff',
    cursor: getCssVar('--cyan') || '#00f0ff',
    cursorAccent: getCssVar('--bg-terminal') || '#03060d',
    selectionBackground: getCssVar('--hover-cyan') || 'rgba(0, 240, 255, 0.3)',
    black: getCssVar('--term-black') || '#000000',
    red: getCssVar('--term-red') || '#ff4d6d',
    green: getCssVar('--term-green') || '#4ade80',
    yellow: getCssVar('--term-yellow') || '#facc15',
    blue: getCssVar('--term-blue') || '#4d6bff',
    magenta: getCssVar('--term-magenta') || '#b56bff',
    cyan: getCssVar('--term-cyan') || '#00f0ff',
    white: getCssVar('--term-white') || '#e8efff',
    brightBlack: getCssVar('--term-bright-black') || '#5a6a96',
    brightRed: getCssVar('--term-bright-red') || '#ff7a92',
    brightGreen: getCssVar('--term-bright-green') || '#7fffaa',
    brightYellow: getCssVar('--term-bright-yellow') || '#ffe066',
    brightBlue: getCssVar('--term-bright-blue') || '#7d95ff',
    brightMagenta: getCssVar('--term-bright-magenta') || '#d49aff',
    brightCyan: getCssVar('--term-bright-cyan') || '#4dd9ff',
    brightWhite: getCssVar('--term-bright-white') || '#ffffff'
  }
}

// 右键菜单状态
const termCtxMenu = ref<{ x: number; y: number; hasSelection: boolean } | null>(null)
const termCtxItems = computed<MenuItem[]>(() => {
  if (!termCtxMenu.value) return []
  const hasSelection = termCtxMenu.value.hasSelection
  return [
    {
      type: 'item',
      icon: 'mdi-content-copy',
      label: t('ssh.copy'),
      shortcut: t('ssh.copyShortcut'),
      disabled: !hasSelection,
      onClick: () => {
        const sel = terminal.getSelection()
        if (sel) doCopy(sel)
      }
    },
    {
      type: 'item',
      icon: 'mdi-content-paste',
      label: t('ssh.paste'),
      shortcut: t('ssh.pasteShortcut'),
      onClick: doPaste
    },
    { type: 'divider' },
    {
      type: 'item',
      icon: 'mdi-selection-multiple',
      label: t('ssh.selectAll'),
      onClick: () => terminal.selectAll()
    },
    {
      type: 'item',
      icon: 'mdi-eraser',
      label: t('ssh.clear'),
      onClick: () => terminal.clear()
    }
  ]
})

onMounted(() => {
  if (!terminalRef.value) return

  terminal = new Terminal({
    cursorBlink: true,
    fontSize: props.fontSize ?? 14,
    fontFamily: '"JetBrains Mono", "Fira Code", Menlo, Monaco, Consolas, monospace',
    // xterm 5.x 会把 lineHeight 乘以 fontSize 后取整作为每行 <div> 的 height。
    // 1.4 * 14 = 19.6 → 20px,行间留白 ≈ 6px;贴得太紧主要是 fallback 字体
    // (Menlo / Monaco / Consolas) 在 Windows 上 metrics 偏矮,canvas 渲染时
    // 字符基线和 DOM 行盒对不齐,视觉上挤成一团。
    // 提到 1.6 给字符上下都留更松的空间,fallback 字体下也不会贴边。
    lineHeight: 1.6,
    letterSpacing: 0,
    scrollback: 5000,
    allowProposedApi: true,
    theme: buildTerminalTheme()
  })

  fitAddon = new FitAddon()
  searchAddon = new SearchAddon()

  terminal.loadAddon(fitAddon)
  terminal.loadAddon(new WebLinksAddon())
  terminal.loadAddon(searchAddon)

  terminal.open(terminalRef.value)
  fitAddon.fit()

  terminal.onData((data) => {
    if (props.reconnectMode) {
      if (data === '\r' || data === '\n' || data === '\x0d') {
        emit('reconnect')
      }
      return
    }
    emit('data', data)
  })

  terminal.onResize(({ cols, rows }) => {
    emit('resize', cols, rows)
  })

  // 选区变化时更新右键菜单的"复制"可用状态
  terminal.onSelectionChange(() => {
    if (termCtxMenu.value) {
      termCtxMenu.value.hasSelection = terminal.getSelection().length > 0
    }
  })

  // ====== 键盘快捷键:复制 / 粘贴 ======
  // 约定(跟主流终端一致):
  //   复制: Ctrl+Shift+C / Cmd+Shift+C 总是复制
  //         Ctrl+C / Cmd+C 有选区时复制(无选区则放行,让 SIGINT 发到进程)
  //   粘贴: Ctrl+Shift+V / Ctrl+V / Cmd+V / Shift+Insert 总是粘贴
  terminal.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown') return true

    const key = event.key.toLowerCase()
    const isMod = event.ctrlKey || event.metaKey
    const isShift = event.shiftKey
    const selection = terminal.getSelection()

    // 复制(Ctrl+Shift+C / Cmd+Shift+C)
    if (isMod && isShift && key === 'c') {
      event.preventDefault()
      event.stopPropagation()
      if (selection) doCopy(selection)
      return false
    }
    // 复制(Ctrl+C / Cmd+C,有选区)
    if (isMod && !isShift && key === 'c' && selection) {
      event.preventDefault()
      event.stopPropagation()
      doCopy(selection)
      return false
    }
    // 粘贴(Ctrl+Shift+V / Ctrl+V / Cmd+V)
    if (isMod && key === 'v') {
      event.preventDefault()
      event.stopPropagation()
      doPaste()
      return false
    }
    // 粘贴(Shift+Insert,Windows 老式约定)
    if (isShift && event.key === 'Insert') {
      event.preventDefault()
      event.stopPropagation()
      doPaste()
      return false
    }
    return true
  })

  // ====== 右键菜单 ======
  // xterm.js 内部不接管 contextmenu,自己挂一个。
  terminalRef.value.addEventListener('contextmenu', onContextMenu)

  window.addEventListener('resize', handleResize)

  resizeObserver = new ResizeObserver(() => {
    requestAnimationFrame(() => fitAddon?.fit())
  })
  resizeObserver.observe(terminalRef.value)
  const parent = terminalRef.value.parentElement
  if (parent) resizeObserver.observe(parent)
})

function doCopy(text: string) {
  if (!text) return
  navigator.clipboard.writeText(text).then(() => {
    emit('copy', text)
  }).catch(() => {
    // 后备:用临时 textarea + execCommand
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    try { document.execCommand('copy') } catch {}
    document.body.removeChild(ta)
  })
  terminal.clearSelection()
}

function doPaste() {
  if (props.reconnectMode || pasteInFlight) return
  pasteInFlight = true
  navigator.clipboard.readText().then((text) => {
    if (!text) return
    // terminal.paste() 内部会触发 onData 事件,自动通过 SSH 通道发出去
    terminal.paste(text)
    emit('paste', text)
  }).catch(() => {
    // 不弹错误(权限拒绝/无文本),静默失败
  }).finally(() => {
    pasteInFlight = false
  })
}

function onContextMenu(e: MouseEvent) {
  e.preventDefault()
  e.stopPropagation()
  const sel = terminal.getSelection()
  termCtxMenu.value = {
    x: e.clientX,
    y: e.clientY,
    hasSelection: sel.length > 0
  }
}

function closeCtxMenu() {
  termCtxMenu.value = null
}

onBeforeUnmount(() => {
  window.removeEventListener('resize', handleResize)
  if (terminalRef.value) {
    terminalRef.value.removeEventListener('contextmenu', onContextMenu)
  }
  resizeObserver?.disconnect()
  resizeObserver = null
  terminal?.dispose()
})

watch(
  () => props.fontSize,
  (newSize) => {
    if (newSize && terminal) {
      terminal.options.fontSize = newSize
      fitAddon?.fit()
    }
  }
)

watch(() => themeStore.theme, () => {
  if (terminal) {
    terminal.options.theme = buildTerminalTheme()
  }
})

function handleResize() {
  fitAddon?.fit()
}

function write(data: string | Uint8Array) {
  terminal?.write(data)
}

function writeln(data: string) {
  terminal?.writeln(data)
}

function clear() {
  terminal?.clear()
}

function focus() {
  terminal?.focus()
}

function search(text: string) {
  searchAddon?.findNext(text)
}

function setFontSize(size: number) {
  if (terminal) {
    terminal.options.fontSize = size
    fitAddon?.fit()
  }
}

function fit() {
  fitAddon?.fit()
}

/**
 * 返回 FitAddon 按当前真实容器计算出的终端尺寸。
 *
 * SSH 建链前需要把这个尺寸交给远端 PTY；否则远端会按默认 80 列
 * 重绘 readline，而本地 xterm 按更宽的列数显示，长命令就会覆盖提示符。
 */
function getSize(): { cols: number; rows: number } | null {
  if (!terminal) return null
  fitAddon?.fit()
  return { cols: terminal.cols, rows: terminal.rows }
}

defineExpose({
  write,
  writeln,
  clear,
  focus,
  search,
  setFontSize,
  fit,
  getSize
})
</script>

<template>
  <div
    ref="terminalRef"
    class="terminal-container"
    :class="{ 'terminal-container-bottom-safe': props.bottomSafeArea }"
  >
    <ContextMenu
      v-if="termCtxMenu"
      :x="termCtxMenu.x"
      :y="termCtxMenu.y"
      :items="termCtxItems"
      @close="closeCtxMenu"
    />
  </div>
</template>

<style scoped>
.terminal-container {
  width: 100%;
  box-sizing: border-box;
  background: var(--bg-terminal);
  border-radius: 8px;
  border: 1px solid var(--line-2);
  padding: 8px;
  box-shadow: inset 0 0 0 1px var(--hover-cyan-faint);
  position: relative;
  overflow: hidden;
}

.terminal-container::before {
  content: "";
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 1px;
  background: var(--grad-primary);
  opacity: 0.3;
  pointer-events: none;
}

.terminal-container :deep(.xterm-viewport) {
  background-color: transparent !important;
}

/* 防御性兜底:有些浏览器(JetBrains Mono 没装,回退到
   Menlo / Monaco / Consolas)对字体的 line-box 计算比 xterm
   的 canvas 渲染要紧,会出现「字符底部被裁」「行间贴边」。
   这里强制把每行 div 的 line-height 锁成 normal,让
   xterm 自己算的 height 决定盒子高度,避免双重计算。*/
.terminal-container :deep(.xterm-rows) {
  line-height: 1;
}
.terminal-container :deep(.xterm-rows > div) {
  line-height: normal;
}
</style>
