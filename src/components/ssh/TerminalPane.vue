<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { SearchAddon } from '@xterm/addon-search'
import '@xterm/xterm/css/xterm.css'

const props = defineProps<{
  sessionId: string
}>()

const emit = defineEmits<{
  data: [data: string]
  resize: [cols: number, rows: number]
}>()

const terminalRef = ref<HTMLDivElement>()
let terminal: Terminal
let fitAddon: FitAddon
let searchAddon: SearchAddon

onMounted(() => {
  if (!terminalRef.value) return

  terminal = new Terminal({
    cursorBlink: true,
    fontSize: 14,
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    theme: {
      background: '#1e1e1e',
      foreground: '#cccccc',
      cursor: '#ffffff',
      selectionBackground: '#264f78',
      black: '#000000',
      red: '#cd3131',
      green: '#0dbc79',
      yellow: '#e5e510',
      blue: '#2472c8',
      magenta: '#bc3fbc',
      cyan: '#11a8cd',
      white: '#e5e5e5',
      brightBlack: '#666666',
      brightRed: '#f14c4c',
      brightGreen: '#23d18b',
      brightYellow: '#f5f543',
      brightBlue: '#3b8eea',
      brightMagenta: '#d670d6',
      brightCyan: '#29b8db',
      brightWhite: '#e5e5e5'
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
    emit('data', data)
  })

  terminal.onResize(({ cols, rows }) => {
    emit('resize', cols, rows)
  })

  window.addEventListener('resize', handleResize)
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', handleResize)
  terminal?.dispose()
})

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

defineExpose({
  write,
  writeln,
  clear,
  focus,
  search
})
</script>

<template>
  <div ref="terminalRef" class="terminal-container" />
</template>

<style scoped>
.terminal-container {
  width: 100%;
  height: 100%;
  padding: 8px;
}
</style>
