<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import TerminalPane from './TerminalPane.vue'
import SftpBrowser from './SftpBrowser.vue'
import { useAssetStore } from '@/stores/asset'

const { t } = useI18n()
const assetStore = useAssetStore()

const props = defineProps<{
  id: string
}>()

const asset = computed(() => assetStore.assets.find((a) => a.id === props.id))

const terminalRef = ref<InstanceType<typeof TerminalPane>>()
const connected = ref(false)
const connecting = ref(false)
const lastError = ref<string | null>(null)
const sessionDuration = ref('00:00:00')
let unlisten: (() => void) | null = null
let unlistenClose: (() => void) | null = null
let connectedAt = 0
let timerId: number | null = null

const statusKind = computed<'connecting' | 'online' | 'offline' | 'error'>(() => {
  if (connecting.value) return 'connecting'
  if (connected.value) return 'online'
  if (lastError.value) return 'error'
  return 'offline'
})

const statusText = computed(() => {
  switch (statusKind.value) {
    case 'connecting': return 'CONNECTING'
    case 'online': return 'CONNECTED'
    case 'offline': return 'DISCONNECTED'
    case 'error': return 'ERROR'
  }
})

const fontSize = ref(14)
const showSearch = ref(false)
const searchQuery = ref('')

// SFTP 面板显示开关(连接成功后默认开启,跟终端并排)
const showSftp = ref(true)

onMounted(async () => {
  if (asset.value) {
    await connect()
  } else {
    terminalRef.value?.writeln('\x1b[31mError: Asset not found\x1b[0m')
  }
})

onBeforeUnmount(async () => {
  stopTimer()
  await disconnect()
})

function startTimer() {
  stopTimer()
  connectedAt = Date.now()
  timerId = window.setInterval(() => {
    const elapsed = Math.floor((Date.now() - connectedAt) / 1000)
    const h = String(Math.floor(elapsed / 3600)).padStart(2, '0')
    const m = String(Math.floor((elapsed % 3600) / 60)).padStart(2, '0')
    const s = String(elapsed % 60).padStart(2, '0')
    sessionDuration.value = `${h}:${m}:${s}`
  }, 1000)
}

function stopTimer() {
  if (timerId !== null) {
    window.clearInterval(timerId)
    timerId = null
  }
}

async function connect() {
  const a = asset.value
  if (!a || !a.config.host || !a.config.username) {
    terminalRef.value?.writeln('\x1b[31mError: Missing host or username\x1b[0m')
    return
  }

  // 防御性清理:重连 / 重复调用时,先把旧 listener 解绑,避免双写
  if (unlisten) { unlisten(); unlisten = null }
  if (unlistenClose) { unlistenClose(); unlistenClose = null }
  stopTimer()
  connected.value = false
  connecting.value = true

  lastError.value = null
  terminalRef.value?.writeln('')
  terminalRef.value?.writeln(`\x1b[36m» Connecting to ${a.config.username}@${a.config.host}:${a.config.port || 22}...\x1b[0m`)

  try {
    const config = {
      host: a.config.host,
      port: a.config.port || 22,
      username: a.config.username,
      auth: a.config.password
        ? { Password: a.config.password }
        : a.config.privateKey
          ? { PrivateKey: { key: a.config.privateKey, passphrase: a.config.passphrase } }
          : { Password: '' }
    }

    await invoke('ssh_connect', { id: a.id, config })
    connected.value = true
    terminalRef.value?.writeln('\x1b[32m✓ Connected\x1b[0m')
    startTimer()

    unlisten = await listen(`ssh:data:${a.id}`, (event) => {
      terminalRef.value?.write(event.payload as string)
    })

    unlistenClose = await listen(`ssh:close:${a.id}`, () => {
      connected.value = false
      stopTimer()
      terminalRef.value?.writeln('\r\n\x1b[33m! Connection closed by remote host\x1b[0m')
    })
  } catch (error) {
    lastError.value = String(error)
    terminalRef.value?.writeln(`\x1b[31m✗ Connection failed: ${error}\x1b[0m`)
  } finally {
    connecting.value = false
  }
}

async function disconnect() {
  if (unlisten) {
    unlisten()
    unlisten = null
  }
  if (unlistenClose) {
    unlistenClose()
    unlistenClose = null
  }

  if (connected.value && asset.value) {
    try {
      await invoke('ssh_disconnect', { id: asset.value.id })
    } catch (error) {
      console.error('Failed to disconnect:', error)
    }
    connected.value = false
    stopTimer()
  }
}

async function handleData(data: string) {
  if (connected.value && asset.value) {
    try {
      await invoke('ssh_write', { id: asset.value.id, data })
    } catch (error) {
      console.error('Failed to write data:', error)
    }
  }
}

async function handleResize(cols: number, rows: number) {
  if (connected.value && asset.value) {
    try {
      await invoke('ssh_resize', { id: asset.value.id, cols, rows })
    } catch (error) {
      console.error('Failed to resize:', error)
    }
  }
}

// ====== 断线 Enter 重连 ======
function handleReconnect() {
  if (connecting.value) return
  connect()
}

watch(connected, (now, prev) => {
  // 从已连接 → 断开,提示用户按 Enter 重连
  if (prev === true && now === false) {
    terminalRef.value?.writeln('')
    terminalRef.value?.writeln('\x1b[33m! Connection closed.\x1b[0m')
    terminalRef.value?.writeln('\x1b[36m  Press Enter to reconnect, or click the reconnect button.\x1b[0m')
  }
})

function handleClear() {
  terminalRef.value?.clear()
}

function adjustFontSize(delta: number) {
  const next = Math.min(20, Math.max(10, fontSize.value + delta))
  fontSize.value = next
  terminalRef.value?.setFontSize(next)
}

function handleSearch() {
  if (searchQuery.value) {
    terminalRef.value?.search(searchQuery.value)
  }
}
</script>

<template>
  <div class="ssh-terminal">
    <div class="terminal-toolbar">
      <div class="info">
        <div class="title">
          <v-icon size="13" color="cyan">mdi-console</v-icon>
          <span v-if="asset">{{ asset.name }}</span>
          <span v-else style="color: var(--muted);">Asset not found</span>
        </div>
        <div class="subtitle" v-if="asset">
          {{ asset.config.username }}@{{ asset.config.host }}:{{ asset.config.port || 22 }}
          <span v-if="connected" style="color: var(--cyan); margin-left: 8px;">
            · {{ sessionDuration }}
          </span>
        </div>
        <div class="subtitle" v-else>—</div>
      </div>

      <div class="actions">
        <!-- 字体缩放 -->
        <button
          class="action-btn"
          :data-tooltip="`- font`"
          @click="adjustFontSize(-1)"
        >
          <v-icon size="14">mdi-format-font-size-decrease</v-icon>
        </button>
        <span class="font-size-indicator">{{ fontSize }}px</span>
        <button
          class="action-btn"
          :data-tooltip="`+ font`"
          @click="adjustFontSize(1)"
        >
          <v-icon size="14">mdi-format-font-size-increase</v-icon>
        </button>

        <div class="divider" />

        <!-- 搜索 -->
        <div class="search-wrap" v-if="showSearch">
          <input
            v-model="searchQuery"
            type="text"
            class="cyber-search-input"
            :placeholder="t('ssh.search') + '...'"
            @keydown.enter="handleSearch"
            @keydown.esc="showSearch = false"
          />
        </div>
        <button
          v-else
          class="action-btn"
          :data-tooltip="t('ssh.search')"
          @click="showSearch = true"
        >
          <v-icon size="14">mdi-magnify</v-icon>
        </button>

        <!-- 清屏 -->
        <button
          class="action-btn"
          :data-tooltip="t('ssh.clear')"
          @click="handleClear"
        >
          <v-icon size="14">mdi-broom</v-icon>
        </button>

        <div class="divider" />

        <!-- 重连 -->
        <button
          class="action-btn"
          :data-tooltip="t('asset.connect')"
          :disabled="connecting || !asset"
          @click="connect"
        >
          <v-icon size="14">mdi-connection</v-icon>
        </button>

        <!-- 断开 -->
        <button
          class="action-btn danger"
          :data-tooltip="t('asset.disconnect')"
          :disabled="!connected"
          @click="disconnect"
        >
          <v-icon size="14">mdi-power-standby</v-icon>
        </button>

        <span class="divider" />

        <button
          class="action-btn"
          :class="{ active: showSftp }"
          :data-tooltip="showSftp ? 'Hide SFTP' : 'Show SFTP'"
          @click="showSftp = !showSftp"
        >
          <v-icon size="14">mdi-folder-network-outline</v-icon>
        </button>

        <span class="status" :class="statusKind">
          <span class="dot" />
          {{ statusText }}
        </span>
      </div>
    </div>

    <div class="workspace" :class="{ 'with-sftp': showSftp }">
      <div class="terminal-pane">
        <TerminalPane
          ref="terminalRef"
          :session-id="id"
          :font-size="fontSize"
          :reconnect-mode="!connected && !connecting"
          @data="handleData"
          @reconnect="handleReconnect"
          @resize="handleResize"
        />
      </div>
      <div v-if="showSftp" class="pane-divider" />
      <div v-if="showSftp" class="sftp-pane">
        <SftpBrowser :session-id="id" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.ssh-terminal {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg);
}

.terminal-body {
  flex: 1;
  min-height: 0;
  padding: 8px;
}

/* 两栏布局:terminal + sftp */
.workspace {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: row;
  overflow: hidden;
}

.workspace:not(.with-sftp) .terminal-pane {
  flex: 1;
}

.terminal-pane {
  flex: 1 1 50%;
  min-width: 0;
  min-height: 0;
  padding: 8px;
  display: flex;
}

.terminal-pane > :deep(.terminal-container) {
  flex: 1;
}

.sftp-pane {
  flex: 1 1 50%;
  min-width: 320px;
  min-height: 0;
  border-left: 1px solid var(--line-2);
  display: flex;
  flex-direction: column;
  background: var(--bg-2);
}

.pane-divider {
  width: 1px;
  background: var(--line-2);
  flex-shrink: 0;
  position: relative;
}

.pane-divider::before {
  content: "";
  position: absolute;
  inset: 0;
  background: var(--grad-primary);
  opacity: 0;
  transition: opacity 0.2s;
}

.workspace:hover .pane-divider::before {
  opacity: 0.3;
}

.action-btn.active {
  background: rgba(0, 240, 255, 0.12);
  color: var(--cyan);
  border-color: rgba(0, 240, 255, 0.3);
}

.font-size-indicator {
  font-size: 10px;
  font-family: 'JetBrains Mono', monospace;
  color: var(--muted);
  min-width: 32px;
  text-align: center;
}

.divider {
  width: 1px;
  height: 18px;
  background: var(--line-2);
  margin: 0 4px;
}

.action-btn[disabled] {
  opacity: 0.35;
  cursor: not-allowed;
}

.action-btn.danger:hover:not([disabled]) {
  background: rgba(255, 77, 109, 0.12);
  color: var(--red);
  border-color: rgba(255, 77, 109, 0.3);
}

.search-wrap {
  position: relative;
  display: flex;
  align-items: center;
}

.cyber-search-input {
  background: rgba(20, 25, 40, 0.6);
  border: 1px solid var(--line-2);
  border-radius: 6px;
  padding: 4px 8px;
  font-size: 11px;
  color: var(--text);
  outline: none;
  width: 160px;
  transition: all 0.2s;
}

.cyber-search-input:focus {
  border-color: var(--cyan);
  box-shadow: 0 0 0 2px rgba(0, 240, 255, 0.1);
  width: 200px;
}

.cyber-search-input::placeholder {
  color: var(--muted);
}

.status {
  position: relative;
}

.status .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  box-shadow: 0 0 6px currentColor;
  animation: pulse 2s infinite;
}

.status.connecting .dot {
  animation: pulse 1s infinite;
}

.status.offline .dot {
  animation: none;
  opacity: 0.4;
}

@keyframes pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.4; transform: scale(0.7); }
}
</style>
