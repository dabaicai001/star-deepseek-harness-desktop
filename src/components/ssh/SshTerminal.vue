<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import TerminalPane from './TerminalPane.vue'
import RightPanel from '@/components/layout/RightPanel.vue'
import AiChat from '@/components/ai/AiChat.vue'
import SshDashboard from '@/components/dashboard/SshDashboard.vue'
import { useAssetStore } from '@/stores/asset'
import { useAppStore } from '@/stores/app'
import { useAiStore } from '@/stores/ai'
import { useNotifyStore } from '@/stores/notify'
import { parseInstanceId } from '@/utils/tabId'
import { SSH_SYSTEM_PROMPT, sshTools, makeSshToolCaller } from '@/utils/aiTools'
import { extractWhitelistPrefix } from '@/utils/commandGuard'
import type { LlmToolCall } from '@/services/ai'

const { t } = useI18n()
const assetStore = useAssetStore()
const appStore = useAppStore()
const aiStore = useAiStore()
const notify = useNotifyStore()
const router = useRouter()

const props = defineProps<{
 /**
 * Tab instance id(由路由 ssh/:id传入)
 * 同资产多个 tab会有不同的 instanceId,各自独立 session
 */
 id: string
}>()

/** 从 instanceId解析出资产 id,再用资产 id找资产配置 */
const instanceInfo = computed(() => parseInstanceId(props.id))
const asset = computed(() => assetStore.assets.find((a) => a.id === instanceInfo.value.assetId))

const terminalRef = ref<InstanceType<typeof TerminalPane>>()
const connected = ref(false)
const connecting = ref(false)
const lastError = ref<string | null>(null)
const sessionDuration = ref('00:00:00')
let unlisten: (() => void) | null = null
let unlistenClose: (() => void) | null = null
let connectedAt =0
let timerId: number | null = null
//防止旧 connect() 的 finally误关新连接的状态
let currentConnectId =0

// ====== AI助手用:收集 SSH 输出 ======
//每次 SSH收到数据,都 push 到这里;captureOutput(timeout) 等固定时间后返回这段输出
const dataBuffer = ref<string[]>([])
let captureBaseline =0 // captureOutput 调用前的 buffer长度
let captureResolve: ((s: string) => void) | null = null
let captureTimer: number | null = null

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

// ======右侧 Panel(仪表盘 / AI切换) ======
// SFTP 已拆为独立路由 /sftp/:id,不再嵌在终端右栏。
const rightActiveTab = ref<string>('dashboard')

const rightPanelTabs = computed(() => [
 { key: 'dashboard', label: '仪表盘', icon: 'mdi-view-dashboard-outline' },
 { key: 'ai', label: 'AI助手', icon: 'mdi-robot-outline' }
])

// ====== AI助手(每个 tab独立) ======
const aiSession = computed(() => {
 if (!asset.value) return null
 const session = aiStore.getOrCreateSession(props.id, asset.value.id, 'ssh')
 return session
})

async function onAiSend(text: string) {
 if (!aiSession.value) return
 aiSession.value.messages.push({ role: 'user', content: text })
 await runSshAgent()
}

async function onAiRetry() {
 if (!aiSession.value) return
 //删最后一条 assistant + user 对,重发最后一条 user
 const msgs = aiSession.value.messages
 while (msgs.length && msgs[msgs.length -1].role !== 'user') {
 msgs.pop()
 }
 if (msgs.length) await runSshAgent()
}

function onAiNewChat() {
 aiStore.resetSession(props.id)
}

function onAiStop() {
 aiStore.stopAgent(props.id)
}

function onAiConfirmTool(recordId: string, decision: 'approve' | 'reject' | 'whitelist') {
 if (!aiSession.value) return
 const rec = aiSession.value.toolCalls.find(t => t.id === recordId)
 if (rec) {
 if (decision === 'whitelist') {
 // 加入白名单并批准
 const command = String(rec.args.command ?? '')
 const prefix = extractWhitelistPrefix(command)
 if (prefix) {
 aiStore.addToWhitelist(prefix)
 }
 rec.status = 'success'
 rec.result = `✓ 已加入白名单 (${prefix}),正在执行…`
 } else if (decision === 'approve') {
 rec.status = 'success'
 rec.result = '✓ 已批准,正在执行…'
 } else {
 rec.status = 'rejected'
 rec.result = '✗ 已拒绝'
 }
 }
 //唤醒 caller 中的 await confirmFn()
 const resolve = pendingConfirms.value.get(recordId)
 if (resolve) {
 resolve(decision === 'approve' || decision === 'whitelist')
 pendingConfirms.value.delete(recordId)
 }
}

/**等待用户确认的 tool call记录 ID → resolve回调 */
const pendingConfirms = ref<Map<string, (approved: boolean) => void>>(new Map())

async function runSshAgent() {
 if (!aiSession.value) return
 const timeoutSec = aiStore.settings.commandTimeoutSec

 /**
 * 等用户确认(通过 AiChat弹按钮,emit confirm-tool事件)
 */
 const confirmFn: import('@/utils/aiTools').ToolConfirmFn = async (ctx) => {
 // 把正在 confirm 的 call标 awaiting-confirm,记录 id 用于后续 resolve
 //找到 session 里最近一个 running 的 record,改成 awaiting-confirm
 const session = aiSession.value!
 const running = [...session.toolCalls].reverse().find(t => t.status === 'running' || t.status === 'awaiting-confirm')
 const recordId = running?.id || `pending-${Date.now()}`
 if (running) {
 running.status = 'awaiting-confirm'
 running.result = ctx.message
 } else {
 session.toolCalls.push({
 id: recordId,
 name: ctx.toolName,
 args: ctx.args,
 status: 'awaiting-confirm',
 result: ctx.message,
 startedAt: Date.now()
 })
 }
 return new Promise<boolean>((resolve) => {
 pendingConfirms.value.set(recordId, resolve)
 })
 }

 const caller = makeSshToolCaller(
 async (cmd) => { await writeCommand(cmd) },
 async (ms) => { return await captureOutput(ms || timeoutSec *1000) },
 () => aiStore.settings.commandWhitelist,
 confirmFn
 )
 const toolExec = async (call: LlmToolCall) => {
 return await caller({ function: { name: call.function.name, arguments: call.function.arguments } })
 }
 await aiStore.runAgent(props.id, sshTools, toolExec, SSH_SYSTEM_PROMPT)
}

onMounted(async () => {
 if (asset.value) {
 await connect()
 } else {
 //资产已被删除 → 自动回主页,避免卡在空 tab
 router.push({ name: 'home' })
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
 const elapsed = Math.floor((Date.now() - connectedAt) /1000)
 const h = String(Math.floor(elapsed /3600)).padStart(2, '0')
 const m = String(Math.floor((elapsed %3600) /60)).padStart(2, '0')
 const s = String(elapsed %60).padStart(2, '0')
 sessionDuration.value = `${h}:${m}:${s}`
 },1000)
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
 // 后端按 instanceId(不是 assetId)管 session,这样同资产多 tab各自独立
 const sessionId = props.id

 //防御性清理:重连 /重复调用时,先把旧 listener 解绑,避免双写
 if (unlisten) { unlisten(); unlisten = null }
 if (unlistenClose) { unlistenClose(); unlistenClose = null }
 stopTimer()
 connected.value = false
 connecting.value = true

 lastError.value = null
 terminalRef.value?.writeln('')
 terminalRef.value?.writeln(`\x1b[36m» Connecting to ${a.config.username}@${a.config.host}:${a.config.port ||22}...\x1b[0m`)

 //标记当前 connect 调用,避免老 timeout杀掉新连接
 const connectCallId = ++currentConnectId

 try {
 const config = {
 host: a.config.host,
 port: a.config.port ||22,
 username: a.config.username,
 auth: a.config.password
 ? { Password: a.config.password }
 : a.config.privateKey
 ? { PrivateKey: { key: a.config.privateKey, passphrase: a.config.passphrase } }
 : { Password: '' }
 }

 // Tauri2 的 invoke 没有内置 timeout,如果 Rust端 ssh_connect任何一步 hang
 // (TCP 连不上 /协议握手卡住 / auth死循环),前端就永远 await、connecting一直 true
 // →客户端加15s兜底,超时后主动让后端清理 session,避免后端继续耗资源
 const CONNECT_TIMEOUT_MS =15_000
 let timeoutHandle: number | null = null
 const timeoutPromise = new Promise<never>((_, reject) => {
 timeoutHandle = window.setTimeout(() => {
 reject(new Error(`Connection timed out after ${CONNECT_TIMEOUT_MS /1000}s`))
 }, CONNECT_TIMEOUT_MS)
 })

 try {
 await Promise.race([
 invoke<unknown>('ssh_connect', { id: sessionId, config }),
 timeoutPromise
 ])
 } finally {
 if (timeoutHandle !== null) {
 window.clearTimeout(timeoutHandle)
 }
 }

 //上面 race resolve 后,可能是 invoke成功也可能是 timeout兜底失败
 // → 如果 connectCallId已经不是最新的了(用户重连了),本次结果作废
 if (connectCallId !== currentConnectId) {
 terminalRef.value?.writeln('\x1b[33m! Superseded by a newer connection attempt\x1b[0m')
 return
 }

 connected.value = true
 terminalRef.value?.writeln('\x1b[32m✓ Connected\x1b[0m')
 startTimer()

 unlisten = await listen(`ssh:data:${sessionId}`, (event) => {
 const chunk = event.payload as string
 terminalRef.value?.write(chunk)
 //收集到 buffer(AI助手用)
 dataBuffer.value.push(chunk)
 //唤醒正在等待的 captureOutput
 maybeResolveCapture()
 })

 unlistenClose = await listen(`ssh:close:${sessionId}`, () => {
 connected.value = false
 stopTimer()
 terminalRef.value?.writeln('\r\n\x1b[33m! Connection closed by remote host\x1b[0m')
 })
 } catch (error) {
 const msg = error instanceof Error ? error.message : String(error)
 lastError.value = msg
 terminalRef.value?.writeln(`\x1b[31m✗ Connection failed: ${msg}\x1b[0m`)
 //通知后端清掉可能半初始化的 session(防止 Rust端残留)
 try {
 await invoke('ssh_disconnect', { id: sessionId })
 } catch {
 //静默 — 后端可能本来就没 insert
 }
 notify.notify({
 message: `SSH 连接失败: ${msg}`,
 color: 'error',
 timeout:5000
 })
 } finally {
 // 只有"自己这一发"才清状态,避免新连接被旧 finally覆盖
 if (connectCallId === currentConnectId) {
 connecting.value = false
 }
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

 if (connected.value) {
 try {
 await invoke('ssh_disconnect', { id: props.id })
 } catch (error) {
 console.error('Failed to disconnect:', error)
 }
 connected.value = false
 stopTimer()
 }
}

async function handleData(data: string) {
 if (connected.value) {
 try {
 await invoke('ssh_write', { id: props.id, data })
 } catch (error) {
 console.error('Failed to write data:', error)
 }
 }
}

async function handleResize(cols: number, rows: number) {
 if (connected.value) {
 try {
 await invoke('ssh_resize', { id: props.id, cols, rows })
 } catch (error) {
 console.error('Failed to resize:', error)
 }
 }
}

// ====== AI助手用:写命令 +捕获输出 ======

/**
 * AI写一条命令到 terminal(用户能看到)
 * 注意:这里发的是用户输入风格(末尾加 \n),相当于按了回车
 */
async function writeCommand(command: string): Promise<void> {
 if (!connected.value) {
 throw new Error('SSH not connected')
 }
 await invoke('ssh_write', { id: props.id, data: command + '\n' })
}

// ======快速命令栏(连接后顶部一条小横条) ======
const quickCommands = [
 { label: 'ls', cmd: 'ls -la', icon: 'mdi-format-list-bulleted' },
 { label: 'pwd', cmd: 'pwd', icon: 'mdi-map-marker-outline' },
 { label: 'df', cmd: 'df -h', icon: 'mdi-harddisk' },
 { label: 'top', cmd: 'top -b -n1 | head -20', icon: 'mdi-chip' },
 { label: 'whoami', cmd: 'whoami', icon: 'mdi-account-outline' },
 { label: 'uptime', cmd: 'uptime', icon: 'mdi-clock-outline' }
]
async function runQuickCommand(cmd: string) {
 try {
 await writeCommand(cmd)
 } catch (e) {
 terminalRef.value?.writeln(`\x1b[31m✗ ${e instanceof Error ? e.message : String(e)}\x1b[0m`)
 }
}

/**
 * 等固定时间收集 SSH 输出。
 * 调用时记录当前 buffer长度,等待 timeoutMs 或 buffer增长200ms 内无新数据,
 * 返回 [基线, 现在] 之间的所有数据。
 *
 *简化策略(MVP):
 * -记录 baseline = 当前 buffer.length
 * - 设一个 timeoutMs计时器,到点 resolve 并清空计时器
 * - 如果 baseline之后又来数据,刷新一个"静默计时器"(200ms 无新数据)提前 resolve
 */
function captureOutput(timeoutMs: number): Promise<string> {
 return new Promise(resolve => {
 if (captureResolve) {
 //已有 capture 在进行:合并,直接 return旧的
 captureResolve(dataBuffer.value.slice(captureBaseline).join(''))
 captureResolve = null
 if (captureTimer) { clearTimeout(captureTimer); captureTimer = null }
 }
 captureBaseline = dataBuffer.value.length
 captureResolve = (s: string) => {
 resolve(s)
 captureResolve = null
 if (captureTimer) { clearTimeout(captureTimer); captureTimer = null }
 }
 captureTimer = window.setTimeout(() => {
 if (captureResolve) {
 const output = dataBuffer.value.slice(captureBaseline).join('')
 captureResolve(output)
 }
 }, timeoutMs)
 })
}

function maybeResolveCapture() {
 if (!captureResolve) return
 //收到新数据 →重新计时(给"还在输出中"的命令多200ms缓冲)
 if (captureTimer) clearTimeout(captureTimer)
 captureTimer = window.setTimeout(() => {
 if (captureResolve) {
 const output = dataBuffer.value.slice(captureBaseline).join('')
 captureResolve(output)
 }
 },200)
}

function clearBuffer() {
 dataBuffer.value = []
 captureBaseline =0
}

defineExpose({
 writeCommand,
 captureOutput,
 clearBuffer,
 isConnected: () => connected.value
})

// ======断线 Enter 重连 ======
function handleReconnect() {
 if (connecting.value) return
 connect()
}

// ======复制 /粘贴反馈(子组件 emit) ======
function handleCopy(text: string) {
 const lines = text.split('\n').length
 const chars = text.length
 notify.notify({
 message: `已复制 ${lines} 行 · ${chars}字符`,
 color: 'success',
 timeout:1500
 })
}

function handlePaste(text: string) {
 const chars = text.length
 notify.notify({
 message: `已粘贴 ${chars}字符`,
 color: 'info',
 timeout:1500
 })
}

watch(connected, (now, prev) => {
 // 从已连接 →断开,提示用户按 Enter 重连
 if (prev === true && now === false) {
 terminalRef.value?.writeln('')
 terminalRef.value?.writeln('\x1b[33m! Connection closed.\x1b[0m')
 terminalRef.value?.writeln('\x1b[36m Press Enter to reconnect, or click the reconnect button.\x1b[0m')
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
 {{ asset.config.username }}@{{ asset.config.host }}:{{ asset.config.port ||22 }}
 <span v-if="connected" style="color: var(--cyan); margin-left:8px;">
 · {{ sessionDuration }}
 </span>
 </div>
 <div class="subtitle" v-else>—</div>
 </div>

 <div class="actions">
 <!--字体缩放 -->
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

 <!--搜索 -->
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

 <span class="divider" />

 <!--状态 + 重连/断开(紧挨状态) -->
 <span class="status" :class="statusKind">
 <span class="dot" />
 {{ statusText }}
 </span>

 <button
 class="action-btn reconnect-btn"
 :data-tooltip="t('asset.connect')"
 :disabled="connecting || !asset"
 @click="connect"
 >
 <v-icon size="14">mdi-connection</v-icon>
 </button>

 <button
 class="action-btn disconnect-btn"
 :class="{ 'pulse-danger': connected }"
 :data-tooltip="t('asset.disconnect')"
 :disabled="!connected"
 @click="disconnect"
 >
 <v-icon size="14">mdi-power-standby</v-icon>
 </button>
 </div>
 </div>

 <div class="workspace">
 <div class="terminal-pane">
 <!--快速命令栏:刚连接时给新手指引,常用查看命令一键发 -->
 <div v-if="connected" class="quick-commands">
 <span class="qc-label">QUICK</span>
 <button
 v-for="qc in quickCommands"
 :key="qc.cmd"
 class="qc-btn"
 :disabled="!connected || connecting"
 @click="runQuickCommand(qc.cmd)"
 >
 <v-icon size="11">{{ qc.icon }}</v-icon>
 <span>{{ qc.label }}</span>
 </button>
 </div>
 <TerminalPane
 ref="terminalRef"
 :session-id="id"
 :font-size="fontSize"
 :reconnect-mode="!connected && !connecting"
 @data="handleData"
 @reconnect="handleReconnect"
 @resize="handleResize"
 @copy="handleCopy"
 @paste="handlePaste"
 />
 </div>

 <RightPanel
 v-model="appStore.rightPanelOpen"
 v-model:active-tab="rightActiveTab"
 :tabs="rightPanelTabs"
 >
 <template #tab-dashboard>
 <SshDashboard :session-id="id" :connected="connected" />
 </template>
 <template #tab-ai>
 <AiChat
 v-if="aiSession"
 :session="aiSession"
 :sending="aiSession.loading"
 placeholder="问我关于这台主机的任何事,例如'看看磁盘空间'"
 @send="onAiSend"
 @retry="onAiRetry"
 @confirm-tool="onAiConfirmTool"
 @new-chat="onAiNewChat"
 @stop="onAiStop"
 />
 </template>
 </RightPanel>
 </div>
 </div>
</template>

<style scoped>
.ssh-terminal {
 height:100%;
 display: flex;
 flex-direction: column;
 background: var(--bg);
}

.terminal-body {
 flex:1;
 min-height:0;
 padding:8px;
}

.workspace {
 flex:1;
 min-height:0;
 display: flex;
 flex-direction: row;
 overflow: hidden;
 position: relative;
}

.terminal-pane {
 flex:1;
 min-width:0;
 min-height:0;
 padding:8px;
 display: flex;
 flex-direction: column;
}

.terminal-pane > :deep(.terminal-container) {
 flex:1;
}

.quick-commands {
 display: flex;
 align-items: center;
 gap:4px;
 padding:6px10px;
 background: var(--hover-cyan-faint);
 border:1px solid var(--line-2);
 border-radius:6px;
 margin-bottom:6px;
 flex-wrap: wrap;
}
.qc-label {
 font-size:9px;
 font-weight:700;
 font-family: 'Orbitron', sans-serif;
 color: var(--cyan);
 letter-spacing:0.12em;
 margin-right:4px;
 text-shadow:006px var(--glow-soft);
}
.qc-btn {
 display: inline-flex;
 align-items: center;
 gap:4px;
 padding:3px8px;
 background: var(--hover-cyan-soft);
 border:1px solid var(--line-2);
 border-radius:4px;
 color: var(--text-2);
 font-size:11px;
 font-family: 'JetBrains Mono', monospace;
 cursor: pointer;
 transition: all0.15s;
}
.qc-btn:hover:not(:disabled) {
 background: var(--active-cyan);
 border-color: var(--focus-cyan);
 color: var(--cyan);
}
.qc-btn:disabled {
 opacity:0.4;
 cursor: not-allowed;
}

.action-btn.active {
 background: var(--active-cyan);
 color: var(--cyan);
 border-color: var(--focus-cyan);
}

.font-size-indicator {
 font-size:10px;
 font-family: 'JetBrains Mono', monospace;
 color: var(--muted);
 min-width:32px;
 text-align: center;
}

.divider {
 width:1px;
 height:18px;
 background: var(--line-2);
 margin:04px;
}

.action-btn[disabled] {
 opacity:0.35;
 cursor: not-allowed;
}

.action-btn.danger:hover:not([disabled]) {
 background: rgba(255,77,109,0.12);
 color: var(--red);
 border-color: rgba(255,77,109,0.3);
}

.reconnect-btn:not([disabled]) {
 color: var(--green);
 border-color: rgba(80,250,123,0.25);
}

.reconnect-btn:not([disabled]):hover {
 background: rgba(80,250,123,0.12);
 border-color: rgba(80,250,123,0.4);
 box-shadow:008px rgba(80,250,123,0.2);
}

.disconnect-btn:not([disabled]) {
 color: var(--red);
 border-color: rgba(255,77,109,0.25);
}

.disconnect-btn:not([disabled]):hover {
 background: rgba(255,77,109,0.12);
 border-color: rgba(255,77,109,0.4);
 box-shadow:006px rgba(255,77,109,0.2);
}

.disconnect-btn.pulse-danger {
 animation: pulse-red2s infinite;
}

@keyframes pulse-red {
0%,100% { box-shadow: none; }
50% { box-shadow:006px rgba(255,77,109,0.25); }
}

.search-wrap {
 position: relative;
 display: flex;
 align-items: center;
}

.cyber-search-input {
 background: var(--bg-input);
 border:1px solid var(--line-2);
 border-radius:6px;
 padding:4px8px;
 font-size:11px;
 color: var(--text);
 outline: none;
 width:160px;
 transition: all0.2s;
}

.cyber-search-input:focus {
 border-color: var(--cyan);
 box-shadow:0003px var(--focus-cyan);
 width:200px;
}

.cyber-search-input::placeholder {
 color: var(--muted);
}

.status {
 position: relative;
}

.status .dot {
 width:6px;
 height:6px;
 border-radius:50%;
 background: currentColor;
 box-shadow:006px currentColor;
 animation: pulse2s infinite;
}

.status.connecting .dot {
 animation: pulse1s infinite;
}

.status.offline .dot {
 animation: none;
 opacity:0.4;
}

@keyframes pulse {
0%,100% { opacity:1; transform: scale(1); }
50% { opacity:0.4; transform: scale(0.7); }
}
</style>
