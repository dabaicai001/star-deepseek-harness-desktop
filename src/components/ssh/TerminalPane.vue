<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { SearchAddon } from '@xterm/addon-search'
import '@xterm/xterm/css/xterm.css'

const props = defineProps<{
  sessionId: string
  fontSize?: number
  reconnectMode?: boolean
}>()

const emit = defineEmits<{
  data: [data: string]
  reconnect: []
  resize: [cols: number, rows: number]
}>()

const terminalRef = ref<HTMLDivElement>()
let terminal: Terminal
let fitAddon: FitAddon
let searchAddon: SearchAddon
/** ResizeObserver 监听父元素尺寸变化 ——
 *  关键:HMR 替换 style / 字体加载完 / 父级 layout 变化时,
 *  .terminal-container 自身尺寸会变,我们必须重跑 fit() 让 xterm
 *  重新算 rows,否则 xterm 用的是 onMounted 第一次 fit() 时的老值,
 *  CSS 修改(底部留 buffer)根本反映不到字符网格上。
 *  这一行就把 fit 跟 layout 变化绑定,不再依赖 onMounted 一次。 */
let resizeObserver: ResizeObserver | null = null

onMounted(() => {
  if (!terminalRef.value) return

  terminal = new Terminal({
    cursorBlink: true,
    fontSize: props.fontSize ?? 14,
    fontFamily: '"JetBrains Mono", "Fira Code", Menlo, Monaco, monospace',
    lineHeight: 1.4,
    letterSpacing: 0,
    scrollback: 5000,
    allowProposedApi: true,
    theme: {
      background: '#03060d',
      foreground: '#e8efff',
      cursor: '#00f0ff',
      cursorAccent: '#03060d',
      selectionBackground: 'rgba(0, 240, 255, 0.3)',
      black: '#000000',
      red: '#ff4d6d',
      green: '#4ade80',
      yellow: '#facc15',
      blue: '#4d6bff',
      magenta: '#b56bff',
      cyan: '#00f0ff',
      white: '#e8efff',
      brightBlack: '#5a6a96',
      brightRed: '#ff7a92',
      brightGreen: '#7fffaa',
      brightYellow: '#ffe066',
      brightBlue: '#7d95ff',
      brightMagenta: '#d49aff',
      brightCyan: '#4dd9ff',
      brightWhite: '#ffffff'
    }
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
      // 断线状态:只响应 Enter(回车 / 换行 / 0x0d),其他输入丢弃
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

  window.addEventListener('resize', handleResize)

  // 监听 .terminal-container 自身 + 父元素尺寸变化,自动重 fit
  // 这覆盖了 HMR 替换 style、字体加载、tab 切换、左侧栏折叠等所有
  // 会改变终端可用空间的场景,不再依赖 onMounted 一次性 fit
  resizeObserver = new ResizeObserver(() => {
    // 用 rAF 包一下,确保 DOM 尺寸已经稳定
    requestAnimationFrame(() => fitAddon?.fit())
  })
  resizeObserver.observe(terminalRef.value)
  // 也监听父元素(.terminal-pane),margin-bottom 改父级时
  // .terminal-container 也会跟着变,这里双保险
  const parent = terminalRef.value.parentElement
  if (parent) resizeObserver.observe(parent)
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', handleResize)
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

function handleResize() {
  fitAddon?.fit()
}

function write(data: string) {
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
  <div ref="terminalRef" class="terminal-container" />
</template>

<style scoped>
.terminal-container {
  width: 100%;
  /* 物理 buffer(给 fit 算少行数):
     原来用 padding-bottom: calc(8px + 1.7em) 想让光标不贴底,但
     默认 content-box 下 padding 不算在 height 里,xterm fitAddon
     算 viewport 行数时只读 clientHeight(content 区高度),padding
     那 1.7em 完全是死空间,光标仍然停在父元素底部 → 被状态栏盖住。

     ⚠ 注意:不能用 height: calc(100% - 3.2em)!!
     .terminal-container 在 SshTerminal.vue 里是 flex item
     (.terminal-pane > :deep(.terminal-container) { flex: 1; }),
     flex item 上 height 会被 flex-basis: 0% 覆盖,完全没生效。
     必须用 margin-bottom —— flex 布局会把 margin 算进总占用,
     box 高度才会真的少掉,fitAddon 算的 clientHeight 才真的少 2 行。

     留 3.2em ≈ 2 行的 buffer,光标距离 .terminal-pane content 底
     ≈ 3.2em + 8px(padding) + 1px(border) ≈ 3 行,绝对不会再被
     statusbar 遮住。 */
  box-sizing: border-box;
  margin-bottom: 3.2em;
  background: #03060d;
  border-radius: 8px;
  border: 1px solid var(--line-2);
  padding: 8px;
  box-shadow: inset 0 0 0 1px rgba(0, 240, 255, 0.04);
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
  /* 视觉 buffer 兜底:
     即便 fit() 因任何原因没及时重算 rows,viewport 滚动到底时,
     屏幕底部仍然多出 1 行空白,光标视觉上不会贴 viewport 底。
     注意:这只影响视觉留白,不影响 fitAddon 算的 rows。 */
  padding-bottom: 1.6em;
  box-sizing: border-box;
}

.terminal-container :deep(.xterm-screen) {
  padding: 4px;
}
</style>
