<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { SearchAddon } from '@xterm/addon-search'
import { useThemeStore } from '@/stores/theme'
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
type CtxMenu = {
  visible: boolean
  x: number
  y: number
  hasSelection: boolean
}
const ctxMenu = ref<CtxMenu>({ visible: false, x: 0, y: 0, hasSelection: false })

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
    if (ctxMenu.value.visible) {
      ctxMenu.value.hasSelection = terminal.getSelection().length > 0
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
  // 点别处关菜单
  document.addEventListener('pointerdown', closeCtxMenu)

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
  ctxMenu.value = {
    visible: true,
    x: e.clientX,
    y: e.clientY,
    hasSelection: sel.length > 0
  }
}

function closeCtxMenu() {
  if (ctxMenu.value.visible) ctxMenu.value.visible = false
}

function ctxCopy() {
  const sel = terminal.getSelection()
  if (sel) doCopy(sel)
  closeCtxMenu()
}

function ctxPaste() {
  doPaste()
  closeCtxMenu()
}

function ctxSelectAll() {
  terminal.selectAll()
  closeCtxMenu()
  // 重开菜单显示已选(用户可以接着点复制)
  // 这里简化,直接关闭;有需要可再开
}

function ctxClear() {
  terminal.clear()
  closeCtxMenu()
}

onBeforeUnmount(() => {
  window.removeEventListener('resize', handleResize)
  document.removeEventListener('pointerdown', closeCtxMenu)
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

defineExpose({
  write,
  writeln,
  clear,
  focus,
  search,
  setFontSize,
  fit
})
</script>

<template>
  <div
    ref="terminalRef"
    class="terminal-container"
    :class="{ 'terminal-container-bottom-safe': props.bottomSafeArea }"
  >
    <!-- 右键菜单 -->
    <div
      v-if="ctxMenu.visible"
      class="term-ctx-menu"
      :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }"
      @pointerdown.stop
    >
      <button class="ctx-item" :disabled="!ctxMenu.hasSelection" @click="ctxCopy">
        <v-icon size="13">mdi-content-copy</v-icon>
        <span class="label">复制</span>
        <kbd>Ctrl+Shift+C</kbd>
      </button>
      <button class="ctx-item" @click="ctxPaste">
        <v-icon size="13">mdi-content-paste</v-icon>
        <span class="label">粘贴</span>
        <kbd>Ctrl+Shift+V</kbd>
      </button>
      <div class="ctx-divider" />
      <button class="ctx-item" @click="ctxSelectAll">
        <v-icon size="13">mdi-selection-multiple</v-icon>
        <span class="label">全选</span>
      </button>
      <button class="ctx-item" @click="ctxClear">
        <v-icon size="13">mdi-eraser</v-icon>
        <span class="label">清屏</span>
      </button>
    </div>
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

/* ====== 右键菜单 ====== */
.term-ctx-menu {
  position: fixed;
  z-index: 9999;
  min-width: 200px;
  background: var(--panel-solid);
  border: 1px solid var(--line-2);
  border-radius: 8px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.55);
  padding: 4px;
  font-size: 12px;
  color: var(--text-2);
  font-family: 'Outfit', -apple-system, 'PingFang SC', sans-serif;
  user-select: none;
  animation: ctxMenuIn 0.1s ease;
}
@keyframes ctxMenuIn {
  from { opacity: 0; transform: translateY(-2px); }
  to   { opacity: 1; transform: translateY(0); }
}
.ctx-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 7px 10px;
  background: transparent;
  border: 0;
  border-radius: 5px;
  color: var(--text-2);
  font-family: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
  transition: all 0.12s;
}
.ctx-item:hover:not(:disabled) {
  background: var(--hover-cyan);
  color: var(--cyan);
}
.ctx-item:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.ctx-item .label { flex: 1; }
.ctx-item kbd {
  font-family: 'JetBrains Mono', monospace;
  font-size: 9px;
  padding: 1px 5px;
  background: var(--kbd-bg);
  border: 1px solid var(--line-2);
  border-radius: 3px;
  color: var(--muted);
  letter-spacing: 0;
}
.ctx-item:hover:not(:disabled) kbd {
  border-color: var(--focus-cyan);
  color: var(--cyan);
}
.ctx-divider {
  height: 1px;
  background: var(--line);
  margin: 4px 2px;
}
</style>
