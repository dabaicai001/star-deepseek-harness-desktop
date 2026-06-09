<script setup lang="ts">
/**
 * SFTP独立视图
 *
 * 设计目标:把 SFTP 从 SshTerminal 的右栏拆出来,变成一个完全独立的页面,
 * 用户从资产列表右键"打开 SFTP"或工具栏图标进来,看到的就是一个独立工具。
 *
 *协议层说明:SFTP subsystem 必须挂在 SSH 连接上,所以这里仍然会调
 * `ssh_connect` 建连接 —— 这是 SSH协议本身的设计,不是 UI耦合。
 * 同资产同时开 SSH终端 + SFTP tab 时,后端连接池会复用同一条 SSH 连接,
 *不会让用户输两次密码。前端两个 tab各自走自己的 `instanceId`,
 * `sftpEnsureSession` 在后端按 instanceId 注册 SFTP channel。
 *
 *路径:`/sftp/:id`,id = `${assetId}__${suffix}`(沿用 tabId工具)。
 */
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import SftpBrowser from './SftpBrowser.vue'
import { useAssetStore } from '@/stores/asset'
import { useNotifyStore } from '@/stores/notify'
import { parseInstanceId } from '@/utils/tabId'

const router = useRouter()
const assetStore = useAssetStore()
const notify = useNotifyStore()

const props = defineProps<{
 /** Tab instance id(由路由 /sftp/:id传入) */
 id: string
}>()

const instanceInfo = computed(() => parseInstanceId(props.id))
const asset = computed(() =>
 assetStore.assets.find((a) => a.id === instanceInfo.value.assetId)
)

const connected = ref(false)
const connecting = ref(false)
const lastError = ref<string | null>(null)

let unlistenClose: UnlistenFn | null = null
//防止旧 connect() 的 finally误关新连接的状态
let currentConnectId =0

const statusKind = computed<'connecting' | 'online' | 'offline' | 'error'>(() => {
 if (connecting.value) return 'connecting'
 if (connected.value) return 'online'
 if (lastError.value) return 'error'
 return 'offline'
})

const statusText = computed(() => {
 switch (statusKind.value) {
 case 'connecting': return 'CONNECTING'
 case 'online': return 'ONLINE'
 case 'offline': return 'OFFLINE'
 case 'error': return 'ERROR'
 }
})

function buildAuth(assetConfig: any) {
 if (assetConfig.password) {
 return { Password: assetConfig.password }
 }
 if (assetConfig.privateKey) {
 return { PrivateKey: { key: assetConfig.privateKey, passphrase: assetConfig.passphrase } }
 }
 return { Password: '' }
}

async function connect() {
 const a = asset.value
 if (!a || !a.config.host || !a.config.username) {
 lastError.value = 'Missing host or username'
 return
 }

 const sessionId = props.id
 if (unlistenClose) { unlistenClose(); unlistenClose = null }
 connected.value = false
 connecting.value = true
 lastError.value = null

 const connectCallId = ++currentConnectId

 try {
 const config = {
 host: a.config.host,
 port: a.config.port ||22,
 username: a.config.username,
 auth: buildAuth(a.config),
 }

 //跟 SshTerminal同样的15s兜底,避免 ssh_connect 在某一步 hang住
 const CONNECT_TIMEOUT_MS =15_000
 let timeoutHandle: number | null = null
 const timeoutPromise = new Promise<never>((_, reject) => {
 timeoutHandle = window.setTimeout(() => {
 reject(new Error(`Connection timed out after ${CONNECT_TIMEOUT_MS /1000}s`))
 }, CONNECT_TIMEOUT_MS)
 })

 try {
 await Promise.race([
 invoke('ssh_connect', { id: sessionId, config }),
 timeoutPromise,
 ])
 } finally {
 if (timeoutHandle !== null) window.clearTimeout(timeoutHandle)
 }

 if (connectCallId !== currentConnectId) return

 connected.value = true

 //监听连接关闭(SFTP视图也要感知,否则用户以为还连着)
 unlistenClose = await listen(`ssh:close:${sessionId}`, () => {
 connected.value = false
 })
 } catch (error) {
 const msg = error instanceof Error ? error.message : String(error)
 lastError.value = msg
 try {
 await invoke('ssh_disconnect', { id: sessionId })
 } catch {
 // 后端可能本来就没 insert
 }
 notify.notify({
 message: `SFTP 连接失败: ${msg}`,
 color: 'error',
 timeout:5000,
 })
 } finally {
 if (connectCallId === currentConnectId) {
 connecting.value = false
 }
 }
}

async function disconnect() {
 if (unlistenClose) {
 unlistenClose()
 unlistenClose = null
 }
 if (connected.value) {
 try {
 await invoke('ssh_disconnect', { id: props.id })
 } catch (error) {
 console.error('Failed to disconnect:', error)
 }
 connected.value = false
 }
}

async function retry() {
 lastError.value = null
 await connect()
}

function openTerminalInstead() {
 // SFTP视图里提供"去终端"的快捷按钮 ——复用同 instanceId
 router.push({ name: 'ssh-terminal', params: { id: props.id.replace(/^sftp-/, '') } })
}

onMounted(async () => {
 if (asset.value) {
 await connect()
 } else {
 router.push({ name: 'home' })
 }
})

onBeforeUnmount(async () => {
 await disconnect()
})
</script>

<template>
 <div class="sftp-view">
 <!--顶部 status bar -->
 <div class="sftp-header cyber-panel">
 <div class="left">
 <v-icon size="14" class="brand-icon">mdi-folder-network-outline</v-icon>
 <span class="title">SFTP</span>
 <span v-if="asset" class="asset-name">
 {{ asset.config.username }}@{{ asset.config.host }}:{{ asset.config.port ||22 }}
 </span>
 </div>
 <div class="right">
 <span class="status" :class="['status-' + statusKind]">
 <span class="status-dot" :class="statusKind" />
 {{ statusText }}
 </span>
 <button
 v-if="!connected && !connecting"
 class="action-btn primary"
 data-tooltip="重试"
 @click="retry"
 >
 <v-icon size="13">mdi-refresh</v-icon>
 <span>RETRY</span>
 </button>
 <button
 v-if="connected"
 class="action-btn"
 data-tooltip="去 SSH终端"
 @click="openTerminalInstead"
 >
 <v-icon size="13">mdi-console</v-icon>
 <span>OPEN TERMINAL</span>
 </button>
 </div>
 </div>

 <!-- 主区:SFTP浏览器(等连接 ready 才挂载) -->
 <div class="sftp-main">
 <SftpBrowser
 v-if="connected"
 :session-id="id"
 :ready="connected"
 />
 <div v-else-if="connecting" class="state-overlay">
 <v-icon size="32" class="state-icon spin">mdi-loading</v-icon>
 <div class="state-text">连接中...</div>
 </div>
 <div v-else-if="lastError" class="state-overlay error">
 <v-icon size="32" class="state-icon">mdi-alert-circle-outline</v-icon>
 <div class="state-text">连接失败</div>
 <div class="state-detail">{{ lastError }}</div>
 <button class="cyber-btn" @click="retry">
 <v-icon size="13">mdi-refresh</v-icon>
 <span>RETRY</span>
 </button>
 </div>
 <div v-else class="state-overlay">
 <v-icon size="32" class="state-icon">mdi-folder-open-outline</v-icon>
 <div class="state-text">未连接</div>
 </div>
 </div>
 </div>
</template>

<style scoped>
.sftp-view {
 height:100%;
 display: flex;
 flex-direction: column;
 background: var(--bg);
}

.sftp-header {
 display: flex;
 align-items: center;
 justify-content: space-between;
 height:38px;
 padding:012px;
 flex-shrink:0;
 border-bottom:1px solid var(--line-2);
}

.sftp-header .left {
 display: flex;
 align-items: center;
 gap:8px;
 min-width:0;
}

.brand-icon {
 color: var(--cyan);
 filter: drop-shadow(004px var(--glow-cyan));
}

.sftp-header .title {
 font-family: 'Orbitron', sans-serif;
 font-size:11px;
 font-weight:700;
 letter-spacing:0.15em;
 color: var(--cyan);
 text-shadow:006px var(--glow-soft);
}

.sftp-header .asset-name {
 font-family: 'JetBrains Mono', monospace;
 font-size:11px;
 color: var(--text-2);
 white-space: nowrap;
 overflow: hidden;
 text-overflow: ellipsis;
}

.sftp-header .right {
 display: flex;
 align-items: center;
 gap:8px;
}

.status {
 display: inline-flex;
 align-items: center;
 gap:6px;
 font-family: 'JetBrains Mono', monospace;
 font-size:10px;
 font-weight:700;
 letter-spacing:0.1em;
 padding:3px8px;
 border-radius:4px;
 background: var(--panel-solid);
 border:1px solid var(--line-2);
}

.status-online { color: var(--green); border-color: rgba(0,230,130,0.3); }
.status-connecting { color: var(--cyan); border-color: rgba(0,240,255,0.3); }
.status-offline { color: var(--muted); }
.status-error { color: var(--red); border-color: rgba(255,80,100,0.3); }

.status-dot {
 width:6px;
 height:6px;
 border-radius:50%;
 display: inline-block;
}

.status-dot.online { background: var(--green); box-shadow:006px var(--green); animation: pulse2s infinite; }
.status-dot.connecting { background: var(--cyan); box-shadow:006px var(--cyan); animation: pulse1s infinite; }
.status-dot.offline { background: var(--muted); }
.status-dot.error { background: var(--red); box-shadow:006px var(--red); }

.sftp-main {
 flex:1;
 min-height:0;
 display: flex;
 position: relative;
 overflow: hidden;
}

.state-overlay {
 flex:1;
 display: flex;
 flex-direction: column;
 align-items: center;
 justify-content: center;
 gap:12px;
 color: var(--muted);
 padding:24px;
}

.state-overlay.error .state-icon { color: var(--red); }
.state-overlay .state-icon { color: var(--cyan); }

.state-icon.spin {
 animation: spin1.5s linear infinite;
}

.state-text {
 font-family: 'Orbitron', sans-serif;
 font-size:13px;
 letter-spacing:0.1em;
 color: var(--text-2);
}

.state-overlay.error .state-text { color: var(--red); }

.state-detail {
 font-family: 'JetBrains Mono', monospace;
 font-size:11px;
 color: var(--muted);
 max-width:480px;
 text-align: center;
 word-break: break-word;
}

@keyframes spin {
 from { transform: rotate(0deg); }
 to { transform: rotate(360deg); }
}

@keyframes pulse {
0%,100% { opacity:1; }
50% { opacity:0.4; }
}
</style>
