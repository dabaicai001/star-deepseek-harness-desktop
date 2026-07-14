<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import KbInteractiveDialog from './KbInteractiveDialog.vue'
import HostKeyConfirmDialog, { type HostKeyInfo } from './HostKeyConfirmDialog.vue'
import BroadcastDialog, { type BroadcastSession } from './BroadcastDialog.vue'
import type { KbInteractiveEvent } from '@/services/ssh'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import TerminalPane from './TerminalPane.vue'
import RightPanel from '@/components/layout/RightPanel.vue'
import AiChat from '@/components/ai/AiChat.vue'
import SshDashboard from '@/components/dashboard/SshDashboard.vue'
import SftpPanel from '@/components/sftp/SftpPanel.vue'
import { useAssetStore } from '@/stores/asset'
import { useAppStore } from '@/stores/app'
import { useAiStore } from '@/stores/ai'
import { useNotifyStore } from '@/stores/notify'
import { useThemeStore } from '@/stores/theme'
import type { Asset } from '@/types/asset'
import { parseInstanceId } from '@/utils/tabId'
import { SSH_SYSTEM_PROMPT, sshTools, makeSshToolCaller } from '@/utils/aiTools'
import { makeSftpToolCaller, sftpTools } from '@/utils/aiSftpTools'
import { extractWhitelistPrefix } from '@/utils/commandGuard'
import type { LlmToolCall } from '@/services/ai'
import { createMcpRuntime } from '@/services/mcp'
import ZmodemModule from 'zmodem.js/src/zmodem_browser.js'

interface ZmodemTransfer {
  get_details: () => { name: string; size?: number | null }
  get_offset: () => number
  accept: () => Promise<Array<Uint8Array>>
}

interface ZmodemSession {
  type: 'send' | 'receive'
  on: (event: string, handler: (...args: unknown[]) => void) => ZmodemSession
  start: () => void
  close: () => Promise<void>
  abort: () => void
}

interface ZmodemDetection {
  confirm: () => ZmodemSession
  deny: () => void
}

interface ZmodemApi {
  Sentry: new (options: {
    to_terminal: (octets: number[]) => void
    sender: (octets: number[]) => void
    on_detect: (detection: ZmodemDetection) => void
    on_retract: () => void
  }) => { consume: (octets: number[] | Uint8Array) => void }
  Browser: {
    send_files: (
      session: ZmodemSession,
      files: FileList,
      options: {
        on_progress?: (file: File, transfer: ZmodemTransfer) => void
        on_file_complete?: (file: File) => void
      },
    ) => Promise<void>
    save_to_disk: (payloads: Array<Uint8Array>, name: string) => void
  }
}

const Zmodem = ZmodemModule as ZmodemApi

const { t } = useI18n()
const assetStore = useAssetStore()
const appStore = useAppStore()
const aiStore = useAiStore()
const notify = useNotifyStore()
const themeStore = useThemeStore()
const route = useRoute()
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
const devMockWorkspace = computed(() => import.meta.env.DEV && route.query.mock === '1')
const devMockLineCount = computed(() => {
  if (!devMockWorkspace.value) return 0
  const rawValue = Array.isArray(route.query.mockLines) ? route.query.mockLines[0] : route.query.mockLines
  const parsedValue = Number.parseInt(String(rawValue ?? '0'), 10)
  return Number.isFinite(parsedValue) ? Math.min(Math.max(parsedValue, 0), 200) : 0
})
const devMockTimestamp = Date.now()
const devMockAsset = computed<Asset | undefined>(() => devMockWorkspace.value ? {
  id: instanceInfo.value.assetId,
  type: 'ssh',
  name: 'Mock SSH Server',
  groupId: null,
  config: { host: 'demo.starhub.local', port: 22, username: 'root' },
  keyId: null,
  tags: ['mock'],
  favorite: false,
  lastUsedAt: devMockTimestamp,
  createdAt: devMockTimestamp,
  updatedAt: devMockTimestamp,
} : undefined)
const asset = computed(() =>
  assetStore.assets.find((a) => a.id === instanceInfo.value.assetId) ?? devMockAsset.value
)

const terminalRef = ref<InstanceType<typeof TerminalPane>>()
const connected = ref(false)
const connecting = ref(false)
const sftpReady = ref(false)
const lastError = ref<string | null>(null)
const sessionDuration = ref('00:00:00')
let unlisten: (() => void) | null = null
let unlistenKb: (() => void) | null = null
let unlistenClose: (() => void) | null = null
let unlistenHostkey: (() => void) | null = null
let connectedAt =0
let timerId: number | null = null
//防止旧 connect() 的 finally误关新连接的状态
let currentConnectId =0
let reconnectTimer: number | null = null
let beforeUnloadHandler: ((e: BeforeUnloadEvent) => void) | null = null
let sftpReadyTimer: number | null = null

const autoReconnect = ref(true)
const reconnectAttempt = ref(0)
const broadcastDialogRef = ref<InstanceType<typeof BroadcastDialog>>()
const hostKeyDialogRef = ref<InstanceType<typeof HostKeyConfirmDialog>>()

// ====== AI助手用:收集 SSH 输出 ======
//每次 SSH收到数据,都 push 到这里;内部 captureOutput 仍可做短探测,
//AI 工具执行则通过 promptCapture 等 shell prompt 返回后收口。
const dataBuffer = ref<string[]>([])
let captureBaseline =0 // captureOutput 调用前的 buffer长度
let captureResolve: ((s: string) => void) | null = null
let captureTimer: number | null = null
interface PromptCapture {
  baseline: number
  command: string
  /** 命令发送前终端最后一行的 prompt,用于识别自定义 PS1 / fish / zsh prompt */
  expectedPrompt: string | null
  resolve: (s: string) => void
  reject: (e: Error) => void
  safetyTimer: number | null
  settleTimer: number | null
}
let promptCapture: PromptCapture | null = null
const AI_PROMPT_CAPTURE_SAFETY_MS = 60 * 1000

// SSH AI interactive input dialog
const aiInputDialogVisible = ref(false)
const aiInputDialogPrompt = ref('')
const aiInputFieldValue = ref('')
const aiInputField = ref<HTMLInputElement>()
const aiSensitiveInputs = new Set<string>()
const aiInputIsPassword = computed(() => /password|passphrase|口令|密码/i.test(aiInputDialogPrompt.value))
const aiInputIsConfirmation = computed(() => /\[(?:Y|y)\/(?:N|n)\]|\[(?:N|n)\/(?:Y|y)\]|yes\s*\/\s*no|确认|继续/i.test(aiInputDialogPrompt.value))
// 检测命令是否需要交互输入的模式
const INTERACTIVE_PROMPT_PATTERNS = [
  /\[sudo\]\s/i,
  /password\s*(?:for\s+\S+)?\s*:\s*$/im,
  /enter\s+(?:your\s+)?password\s*:\s*$/im,
  /\[(?:Y|y)\/(?:N|n)\]\s*$/m,
  /\(\s*(?:yes|no)\s*\)\s*$/im,
  /continue\s*\?\s*$/im,
  /do you want to continue\??\s*$/im,
  /are you sure\??\s*$/im,
  /proceed\s*\?\s*$/im,
  /confirm\s*(?:\S+\s+)?\?\s*$/im,
  /(?:请输入|输入).*(?:密码|口令)\s*[：:]?\s*$/m,
  /(?:是否|确认).*(?:继续|执行|安装|删除)\s*[？?]?\s*$/m,
]

const kbDialogRef = ref<InstanceType<typeof KbInteractiveDialog>>()

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

const fontSize = computed(() => themeStore.fontSize)
const showSearch = ref(false)
const searchQuery = ref('')
const zmodemInputRef = ref<HTMLInputElement>()
const zmodemPromptVisible = ref(false)
const zmodemStatus = ref('')
const zmodemProgress = ref(0)
let zmodemSession: ZmodemSession | null = null
let zmodemSentry: InstanceType<ZmodemApi['Sentry']> | null = null
const terminalDecoder = new TextDecoder()

// ======右侧 Panel(仪表盘 / AI切换) ======
const rightActiveTab = ref<string>('dashboard')

const rightPanelTabs = computed(() => [
  { key: 'dashboard', label: '仪表盘', icon: 'mdi-view-dashboard-outline' },
  { key: 'ai', label: 'AI助手', icon: 'mdi-robot-outline' },
  { key: 'sftp', label: '文件', icon: 'mdi-folder-network-outline' }
])

// ====== AI助手(每个 tab独立) ======
const sshCwd = ref<string>('')
const aiSession = computed(() => {
 if (!asset.value) return null
 const session = aiStore.getOrCreateSession(props.id, asset.value.id, 'ssh')
 return session
})

async function onAiSend(text: string) {
 if (!aiSession.value) return
 // 防并发:loading 在 runAgent 之前就设 true,这样:
 // 1) UI 立刻切到"停止"按钮,textarea 立刻 disable
 // 2) 即使用户在 pwd/agent 启动间隙连点 send 也会被守卫拦掉
 // 不这么做会触发 pwd 抢占 promptCapture(Superseded)、
 // messages 数组被并发 push 污染(LLM 400 tool call 错位)
 if (aiSession.value.loading) return
 aiSession.value.loading = true
 aiSession.value.messages.push({ role: 'user', content: text })
 // 先获取当前工作目录
 try {
   const cwdOutput = await runAiCommandWithPrompt('pwd')
   const pwdMatch = cwdOutput.match(/\/[\w\-./]+/)
   if (pwdMatch) sshCwd.value = pwdMatch[0]
 } catch { /* ignore */ }
 await runSshAgent()
 // runAgent 内部 finally 会把 loading 还原
}

async function onAiRetry() {
 if (!aiSession.value) return
 if (aiSession.value.loading) return
 //删最后一条 assistant + user 对,重发最后一条 user
 const msgs = aiSession.value.messages
 while (msgs.length && msgs[msgs.length -1].role !== 'user') {
 msgs.pop()
 }
 if (msgs.length) await runSshAgent()
}

function onAiNewChat() {
 resolvePendingAiConfirms()
 interruptAiCommand(new Error('已开始新会话,当前 SSH AI 命令已停止'))
 aiStore.resetSession(props.id)
}

function onAiStop() {
 resolvePendingAiConfirms()
 aiStore.stopAgent(props.id)
 interruptAiCommand(new Error('SSH AI 命令已由用户停止'))
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

function resolvePendingAiConfirms() {
 for (const resolve of pendingConfirms.value.values()) resolve(false)
 pendingConfirms.value.clear()
}

async function runSshAgent() {
 if (!aiSession.value) return

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
 running.confirmReason = ctx.reason
 } else {
 session.toolCalls.push({
 id: recordId,
 name: ctx.toolName,
 args: ctx.args,
 status: 'awaiting-confirm',
 result: ctx.message,
 confirmReason: ctx.reason,
 startedAt: Date.now()
 })
 }
 // 强制触发 Vue 响应式:替换 toolCalls 数组引用 + 等 nextTick 刷新 DOM
 session.toolCalls = [...session.toolCalls]
 await nextTick()
 return new Promise<boolean>((resolve) => {
 pendingConfirms.value.set(recordId, resolve)
 })
 }

 const caller = makeSshToolCaller(
 runAiCommandWithPrompt,
 () => aiStore.settings.commandWhitelist,
 confirmFn
 )
 const sftpCaller = makeSftpToolCaller(props.id, confirmFn, asset.value?.name)
 const mcpRuntime = await createMcpRuntime(await aiStore.getMcpServers(), confirmFn)
 if (mcpRuntime.warnings.length) console.warn('[ssh-ai] MCP discovery warnings:', mcpRuntime.warnings)
 const toolExec = async (call: LlmToolCall) => {
 if (call.function.name.startsWith('mcp__')) return mcpRuntime.execute(call)
 const target = call.function.name.startsWith('sftp_') ? sftpCaller : caller
 return await target({ function: { name: call.function.name, arguments: call.function.arguments } })
 }
 const basePrompt = sshCwd.value
   ? SSH_SYSTEM_PROMPT.replace('当前已连接到远程服务器', `当前已连接到远程服务器,当前工作目录: ${sshCwd.value}`)
   : SSH_SYSTEM_PROMPT
 const sysPrompt = aiStore.buildSystemPrompt(basePrompt, 'ssh')
 await aiStore.runAgent(props.id, [...sshTools, ...sftpTools, ...mcpRuntime.tools], toolExec, sysPrompt)
}

onMounted(async () => {
 beforeUnloadHandler = (e: BeforeUnloadEvent) => {
   if (connected.value) {
     e.preventDefault()
     e.returnValue = ''
   }
 }
 window.addEventListener('beforeunload', beforeUnloadHandler)

 initQuickCommands()

 if (asset.value) {
   await connect()
   } else {
   //资产已被删除 → 关闭对应 tab,workspace 自动落到欢迎页
   if (appStore.activeTab) appStore.removeTab(appStore.activeTab)
   router.push('/')
   }
})

onBeforeUnmount(async () => {
  currentConnectId++
  if (beforeUnloadHandler) {
    window.removeEventListener('beforeunload', beforeUnloadHandler)
    beforeUnloadHandler = null
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  if (sftpReadyTimer) {
    clearTimeout(sftpReadyTimer)
    sftpReadyTimer = null
  }
  if (captureTimer) {
    clearTimeout(captureTimer)
    captureTimer = null
  }
  captureResolve = null
  clearPromptCapture(new Error('SSH terminal closed'))
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

function resetSftpReady() {
  sftpReady.value = false
  if (sftpReadyTimer) {
    clearTimeout(sftpReadyTimer)
    sftpReadyTimer = null
  }
}

function markSftpReady() {
  if (!connected.value || sftpReady.value) return
  sftpReady.value = true
  if (sftpReadyTimer) {
    clearTimeout(sftpReadyTimer)
    sftpReadyTimer = null
  }
}

function scheduleSftpReadyFallback() {
  if (sftpReadyTimer) clearTimeout(sftpReadyTimer)
  sftpReadyTimer = window.setTimeout(() => {
    markSftpReady()
  }, 800)
}

async function connect() {
 const a = asset.value
 if (!a || !a.config.host || !a.config.username) {
 terminalRef.value?.writeln('\x1b[31mError: Missing host or username\x1b[0m')
 return
 }
 // 后端按 instanceId(不是 assetId)管 session,这样同资产多 tab各自独立
 const sessionId = props.id

  if (devMockWorkspace.value) {
    const connectCallId = ++currentConnectId
    connecting.value = true
    connected.value = false
    resetSftpReady()
    stopTimer()
    await nextTick()
    if (connectCallId !== currentConnectId) return
    terminalRef.value?.writeln(`\x1b[36m» Connecting to ${a.config.username}@${a.config.host}:${a.config.port || 22}...\x1b[0m`)
    terminalRef.value?.writeln('\x1b[32m✓ Connected (browser mock)\x1b[0m')
    for (let lineNumber = 1; lineNumber <= devMockLineCount.value; lineNumber++) {
      terminalRef.value?.writeln(`mock-output-${String(lineNumber).padStart(3, '0')}`)
    }
    terminalRef.value?.write('\x1b[32mroot@starhub\x1b[0m:\x1b[34m~\x1b[0m$ ')
    connected.value = true
    sftpReady.value = true
    connecting.value = false
    startTimer()
    return
  }

  //防御性清理:重连 /重复调用时,先把旧 listener 解绑,避免双写
  if (unlisten) { unlisten(); unlisten = null }
  if (unlistenKb) { unlistenKb(); unlistenKb = null }
  if (unlistenClose) { unlistenClose(); unlistenClose = null }
  if (unlistenHostkey) { unlistenHostkey(); unlistenHostkey = null }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
  stopTimer()
 connected.value = false
 resetSftpReady()
 connecting.value = true

 lastError.value = null
 terminalRef.value?.writeln('')
 terminalRef.value?.writeln(`\x1b[36m» Connecting to ${a.config.username}@${a.config.host}:${a.config.port ||22}...\x1b[0m`)

 //标记当前 connect 调用,避免老 timeout杀掉新连接
 const connectCallId = ++currentConnectId

   try {
    let effectivePassword = a.config.mfaEnabled ? a.config.mfaPassword : a.config.password

    const config: Record<string, unknown> = {
      host: a.config.host,
      port: a.config.port || 22,
      username: a.config.username,
      sftp_timeout_sec: a.config.sftpTimeoutSec ?? 30,
      auth: a.config.useKeyAuth && a.config.usePasswordAuth !== false && effectivePassword && a.config.privateKey
        ? { PasswordAndKey: { password: effectivePassword, key: a.config.privateKey, passphrase: a.config.passphrase ?? null } }
        : effectivePassword
          ? { Password: effectivePassword }
          : a.config.privateKey
            ? { PrivateKey: { key: a.config.privateKey, passphrase: a.config.passphrase ?? null } }
            : { Password: '' }
    }

   if (a.config.mfaEnabled) {
     (config as Record<string, unknown>).kb_interactive = {
       enabled: true,
       password: a.config.mfaPassword ?? null,
     }
   }

  // 在 invoke 之前注册 MFA / hostkey 事件监听(否则 Rust 端
  // check_server_key / keyboard-interactive 发出的 event 在前端
  // 还没 listen 时就丢掉了,导致 60s 超时连接失败)
  unlistenHostkey = await listen<HostKeyInfo>(
    `ssh:hostkey-confirm:${sessionId}`,
    (event) => {
      hostKeyDialogRef.value?.open(event.payload).then((result) => {
        invoke('ssh_hostkey_response', {
          id: sessionId,
          allowed: result !== 'reject',
          persist: result === 'persist'
        })
      })
    }
  )

  unlistenKb = await listen<KbInteractiveEvent>(
    `ssh:kb-interactive:${sessionId}`,
    (event) => {
      kbDialogRef.value?.open(event.payload)
    }
  )

  // Tauri2 的 invoke 没有内置 timeout,如果 Rust端 ssh_connect任何一步 hang
  // (TCP 连不上 /协议握手卡住 / auth死循环),前端就永远 await、connecting一直 true
  // →客户端加15s兜底,超时后主动让后端清理 session,避免后端继续耗资源
  const CONNECT_TIMEOUT_MS = 60_000
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
  reconnectAttempt.value = 0
  terminalRef.value?.writeln('\x1b[32m✓ Connected\x1b[0m')
  startTimer()

  setupZmodemSentry()
  unlisten = await listen(`ssh:data:${sessionId}`, (event) => {
  const payload = event.payload
  const octets = typeof payload === 'string'
    ? Array.from(new TextEncoder().encode(payload))
    : Array.from(payload as number[])
  zmodemSentry?.consume(octets)
  })
  scheduleSftpReadyFallback()

  unlistenClose = await listen(`ssh:close:${sessionId}`, () => {
  connected.value = false
  clearPromptCapture(new Error('SSH connection closed before prompt returned'))
  resetZmodem()
  resetSftpReady()
  stopTimer()
  terminalRef.value?.writeln('\r\n\x1b[33m! Connection closed by remote host\x1b[0m')
  if (autoReconnect.value && !asset.value?.config.mfaEnabled) {
    tryReconnect(sessionId)
  } else if (asset.value?.config.mfaEnabled) {
    terminalRef.value?.writeln('\x1b[36m MFA/2FA session closed. Click reconnect when you are ready to verify again.\x1b[0m')
  }
  })



 } catch (error) {
  const msg = error instanceof Error ? error.message : String(error)
  if (connectCallId !== currentConnectId) {
    return
  }
  lastError.value = msg
  terminalRef.value?.writeln(`\x1b[31m✗ Connection failed: ${msg}\x1b[0m`)
  //通知后端清掉可能半初始化的 session(防止 Rust端残留)
  try {
  await invoke('ssh_disconnect', { id: sessionId })
  } catch {
  //静默 — 后端可能本来就没 insert
  }
  // If currently in auto-reconnect flow, schedule next attempt without notification spam
  if (reconnectAttempt.value > 0 && connectCallId === currentConnectId && autoReconnect.value) {
  tryReconnect(sessionId)
  connecting.value = false
  return
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

function handleTerminalOctets(octets: number[]) {
  const chunk = terminalDecoder.decode(new Uint8Array(octets), { stream: true })
  if (!chunk) return
  terminalRef.value?.write(chunk)
  markSftpReady()
  //收集到 buffer(AI助手用)
  dataBuffer.value.push(chunk)
  //检测 pwd 输出,更新当前工作目录
  const pwdMatch = chunk.match(/(?:\r\n|\n|\r)(\/[\w\-./]{1,200})\s*(?:\r\n|\n|\r|$)/)
  if (pwdMatch && pwdMatch[1].startsWith('/')) {
    sshCwd.value = pwdMatch[1]
  }
  //唤醒正在等待的 captureOutput
  maybeResolveCapture()
  maybeResolvePromptCapture()
}

function setupZmodemSentry() {
  resetZmodem()
  zmodemSentry = new Zmodem.Sentry({
    to_terminal: handleTerminalOctets,
    sender: octets => {
      void invoke('ssh_write_binary', { id: props.id, data: octets })
    },
    on_detect: detection => {
      zmodemSession = detection.confirm()
      zmodemProgress.value = 0
      if (zmodemSession.type === 'send') {
        zmodemStatus.value = '远端 rz 已就绪，请选择要发送的文件'
        zmodemPromptVisible.value = true
        return
      }

      zmodemStatus.value = '正在等待远端文件…'
      zmodemPromptVisible.value = true
      zmodemSession.on('offer', (...args: unknown[]) => {
        const transfer = args[0] as ZmodemTransfer
        const details = transfer.get_details()
        zmodemStatus.value = `正在接收 ${details.name}`
        void transfer.accept().then(payloads => {
          Zmodem.Browser.save_to_disk(payloads, details.name)
          zmodemStatus.value = `已接收 ${details.name}`
          zmodemProgress.value = 100
        })
      })
      zmodemSession.on('session_end', finishZmodem)
      zmodemSession.start()
    },
    on_retract: () => {
      if (!zmodemSession) finishZmodem()
    },
  })
}

function chooseZmodemFiles() {
  zmodemInputRef.value?.click()
}

async function onZmodemFilesSelected(event: Event) {
  const input = event.target as HTMLInputElement
  if (!input.files?.length || !zmodemSession) return
  const files = input.files
  const totalBytes = Array.from(files).reduce((sum, file) => sum + file.size, 0)
  try {
    zmodemStatus.value = `正在发送 ${files.length} 个文件`
    await Zmodem.Browser.send_files(zmodemSession, files, {
      on_progress: (_file, transfer) => {
        const sent = transfer.get_offset()
        zmodemProgress.value = totalBytes > 0 ? Math.min(99, sent / totalBytes * 100) : 0
      },
      on_file_complete: file => {
        zmodemStatus.value = `已发送 ${file.name}`
      },
    })
    await zmodemSession.close()
    zmodemProgress.value = 100
    notify.notify({ message: 'ZMODEM 文件发送完成', color: 'success', timeout: 2200 })
  } catch (error) {
    notify.notify({ message: `ZMODEM 发送失败: ${String(error)}`, color: 'error', timeout: 5000 })
    zmodemSession?.abort()
  } finally {
    input.value = ''
    window.setTimeout(finishZmodem, 700)
  }
}

function cancelZmodem() {
  zmodemSession?.abort()
  finishZmodem()
}

function finishZmodem() {
  zmodemSession = null
  zmodemPromptVisible.value = false
  zmodemStatus.value = ''
  zmodemProgress.value = 0
}

function resetZmodem() {
  if (zmodemSession) {
    try { zmodemSession.abort() } catch { /* session may already be closed */ }
  }
  finishZmodem()
  zmodemSentry = null
}

async function disconnect() {
   resetZmodem()
   resetSftpReady()
   clearPromptCapture(new Error('SSH disconnected before prompt returned'))
   if (unlisten) {
     unlisten()
     unlisten = null
   }
   if (unlistenKb) {
     unlistenKb()
     unlistenKb = null
   }
   if (unlistenClose) {
  unlistenClose()
  unlistenClose = null
  }
  if (unlistenHostkey) {
    unlistenHostkey()
    unlistenHostkey = null
  }

  if (connected.value) {
    if (devMockWorkspace.value) {
      connected.value = false
      stopTimer()
      return
    }
    try {
      await invoke('ssh_disconnect', { id: props.id })
    } catch (error) {
      console.error('Failed to disconnect:', error)
    }
    connected.value = false
    stopTimer()
  }
}

async function tryReconnect(sessionId: string) {
  reconnectAttempt.value++
  if (reconnectAttempt.value > 3) {
    terminalRef.value?.writeln('\x1b[31m✗ Auto-reconnect failed after 3 attempts\x1b[0m')
    reconnectAttempt.value = 0
    return
  }
  const delay = Math.pow(2, reconnectAttempt.value - 1) * 1000
  terminalRef.value?.writeln(`\x1b[33m! Reconnecting (attempt ${reconnectAttempt.value}/3) in ${delay / 1000}s...\x1b[0m`)

  reconnectTimer = window.setTimeout(async () => {
    reconnectTimer = null
    try {
      await connect()
      if (connected.value) {
        terminalRef.value?.writeln('\x1b[32m✓ Reconnected successfully\x1b[0m')
      }
    } catch {
      // connect() handles its own error display
    }
  }, delay)
}

async function handleData(data: string) {
  if (connected.value) {
  if (devMockWorkspace.value) return
  let finalData = data
  if (data.endsWith('\n') && data.trimStart().startsWith('cd ')) {
    finalData = data.slice(0, -1) + ' && pwd\n'
  }
  try {
  await invoke('ssh_write', { id: props.id, data: finalData })
  } catch (error) {
  console.error('Failed to write data:', error)
  }
  }
}

async function handleResize(cols: number, rows: number) {
 if (connected.value) {
  if (devMockWorkspace.value) return
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

function runAiCommandWithPrompt(command: string): Promise<string> {
 if (!connected.value) {
 throw new Error('SSH not connected')
 }

 if (promptCapture) {
  return Promise.reject(new Error('上一条 SSH AI 命令仍在执行,已拒绝并发发送新命令'))
 }
 return new Promise((resolve, reject) => {
  promptCapture = {
  baseline: dataBuffer.value.length,
  command,
  expectedPrompt: getCurrentPromptLine(),
  resolve,
  reject,
  safetyTimer: null,
  settleTimer: null
  }
 promptCapture.safetyTimer = window.setTimeout(() => {
 const current = promptCapture
 if (!current) return
 const raw = dataBuffer.value.slice(current.baseline).join('')
 const partial = cleanPromptCapturedOutput(raw, current.command)
 interruptAiCommand(new Error(`等待 shell prompt 返回超时,已发送 Ctrl+C 恢复终端。已收到输出:\n${partial || '(无输出)'}`))
 }, AI_PROMPT_CAPTURE_SAFETY_MS)

 writeCommand(command).catch(error => {
 const current = promptCapture
 if (!current) {
 reject(error instanceof Error ? error : new Error(String(error)))
 return
 }
 clearPromptCapture()
 current.reject(error instanceof Error ? error : new Error(String(error)))
 })
 })
}

function clearPromptCapture(error?: Error) {
 const current = promptCapture
 if (!current) return
 if (current.safetyTimer) window.clearTimeout(current.safetyTimer)
 if (current.settleTimer) window.clearTimeout(current.settleTimer)
 promptCapture = null
 if (error) current.reject(error)
}

/** 终止仍占用 PTY 的 AI 命令,并用 Ctrl+C 把共享终端恢复到 shell prompt。 */
function interruptAiCommand(error: Error): boolean {
 const hadCapture = Boolean(promptCapture)
 if (!hadCapture) return false
 clearPromptCapture(error)
 if (connected.value) {
  void invoke('ssh_write_binary', { id: props.id, data: [3] }).catch(invokeError => {
   console.error('Failed to interrupt SSH AI command:', invokeError)
  })
 }
 return true
}

function maybeResolvePromptCapture() {
  const current = promptCapture
  if (!current) return
  const raw = dataBuffer.value.slice(current.baseline).join('')
  
  // 先检测是否需要交互输入
  if (detectInteractivePrompt(raw)) return
  
  if (hasReturnedPrompt(raw, current.expectedPrompt)) {
    if (current.settleTimer) window.clearTimeout(current.settleTimer)
    current.settleTimer = window.setTimeout(() => {
      const latest = promptCapture
      if (!latest) return
      const output = dataBuffer.value.slice(latest.baseline).join('')
      if (!hasReturnedPrompt(output, latest.expectedPrompt)) return
      const cleaned = cleanPromptCapturedOutput(output, latest.command)
      if (latest.safetyTimer) window.clearTimeout(latest.safetyTimer)
      if (latest.settleTimer) window.clearTimeout(latest.settleTimer)
      promptCapture = null
      latest.resolve(cleaned || '(无输出)')
    }, 80)
  }
}

/**
 * 检测终端输出中是否有交互式输入提示(如 sudo 密码、[Y/n] 确认等)。
 * 如果检测到,弹出输入对话框让用户输入,然后发送输入继续执行。
 */
function detectInteractivePrompt(raw: string): boolean {
  if (aiInputDialogVisible.value) return true
  // 只检查最近 2000 字符
  const recent = normalizeTerminalText(raw).slice(-2000)
  
  for (const pattern of INTERACTIVE_PROMPT_PATTERNS) {
    if (pattern.test(recent)) {
      // 提取最后几行作为提示上下文
      const lines = recent.split('\n').filter(l => l.trim())
      const context = lines.slice(-4).join('\n')
      
      // 暂停安全定时器(用户可能要看一会儿)
      const current = promptCapture
      if (!current) return false
      if (current.safetyTimer) {
        window.clearTimeout(current.safetyTimer)
        current.safetyTimer = null
      }
      
      showAiInputDialog(context)
      return true
    }
  }
  return false
}

function showAiInputDialog(promptHint: string) {
  aiInputDialogPrompt.value = promptHint
  aiInputFieldValue.value = ''
  aiInputDialogVisible.value = true
  void nextTick(() => aiInputField.value?.focus())
}

function onAiInputSubmit(input: string) {
  const value = input
  if (aiInputIsPassword.value && value) aiSensitiveInputs.add(value)
  aiInputFieldValue.value = ''
  aiInputDialogVisible.value = false
  const current = promptCapture
  if (!current) return
  
  // 发送用户输入
  void invoke('ssh_write', { id: props.id, data: value + '\n' }).catch(err => {
    console.error('Failed to write AI input:', err)
  })
  
  // 重新启动安全定时器
  current.safetyTimer = window.setTimeout(() => {
    const pc = promptCapture
    if (!pc) return
    const raw2 = dataBuffer.value.slice(pc.baseline).join('')
    const partial = cleanPromptCapturedOutput(raw2, pc.command)
    interruptAiCommand(new Error(`等待 shell prompt 返回超时,已发送 Ctrl+C 恢复终端。已收到输出:\n${partial || '(无输出)'}`))
  }, AI_PROMPT_CAPTURE_SAFETY_MS)
}

function onAiInputCancel() {
  aiInputFieldValue.value = ''
  aiInputDialogVisible.value = false
  const current = promptCapture
  if (!current) return
  // 取消:发送 Ctrl+C 中断命令
  interruptAiCommand(new Error('用户取消了交互输入'))
}

function stripTerminalControl(input: string): string {
 return input
   .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g, '')
   .replace(/\x07/g, '')
}

function normalizeTerminalText(input: string): string {
 return stripTerminalControl(input)
   .replace(/\r\n/g, '\n')
   .replace(/\r/g, '\n')
}

function getCurrentPromptLine(): string | null {
 const text = normalizeTerminalText(dataBuffer.value.slice(-200).join('')).slice(-1200)
 const lines = text.split('\n').map(line => line.trimEnd()).filter(line => line.trim().length > 0)
 const last = lines[lines.length - 1] || ''
 if (!last || last.length > 180) return null
 if (isShellPromptLine(last) || /(?:[$#%>]|❯|➜)\s*$/.test(last)) return last
 return null
}

function hasReturnedPrompt(raw: string, expectedPrompt: string | null): boolean {
 const text = normalizeTerminalText(raw).slice(-1200)
 const lines = text.split('\n').map(line => line.trimEnd()).filter(line => line.trim().length > 0)
 const last = lines[lines.length - 1] || ''
 if (expectedPrompt && last === expectedPrompt) return true
 return isShellPromptLine(last)
}

function isShellPromptLine(line: string): boolean {
 const trimmed = line.trimEnd()
 if (!trimmed || trimmed.length > 180) return false
 if (/^[#$]\s*$/.test(trimmed)) return true
 if (/^\[[^\]\n]{1,140}\]\s*[#$]\s*$/.test(trimmed)) return true
 if (/^[\w.-]+@[\w.-]+(?::[^\n]{0,120})?\s*[#$]\s*$/.test(trimmed)) return true
 if (/^(?:~|\/[\w./-]*|\.\.?)(?:\s+[^\n]{0,80})?\s*[#$]\s*$/.test(trimmed)) return true
 return false
}

function cleanPromptCapturedOutput(raw: string, command: string): string {
 const commandText = command.trim()
 const lines = normalizeTerminalText(raw)
   .split('\n')
   .map(line => line.trimEnd())

 while (lines.length && !lines[0].trim()) lines.shift()
 if (lines.length && commandText) {
   const first = lines[0].trim()
   if (first === commandText || first.endsWith(commandText)) {
     lines.shift()
   }
 }
 while (lines.length && !lines[lines.length - 1].trim()) lines.pop()
 if (lines.length && isShellPromptLine(lines[lines.length - 1])) {
   lines.pop()
 }
 let output = lines.join('\n').trim()
 for (const secret of aiSensitiveInputs) {
   if (secret) output = output.split(secret).join('[REDACTED]')
 }
 aiSensitiveInputs.clear()
 return output
}

// ======快速命令栏(连接后顶部一条小横条) ======
interface QuickCommand {
  label: string
  cmd: string
  icon: string
  isDefault?: boolean
}

const DEFAULT_QUICK_COMMANDS: QuickCommand[] = [
  { label: 'ls', cmd: 'ls -la', icon: 'mdi-format-list-bulleted', isDefault: true },
  { label: 'pwd', cmd: 'pwd', icon: 'mdi-map-marker-outline', isDefault: true },
  { label: 'df', cmd: 'df -h', icon: 'mdi-harddisk', isDefault: true },
  { label: 'top', cmd: 'top -b -n1 | head -20', icon: 'mdi-chip', isDefault: true },
  { label: 'whoami', cmd: 'whoami', icon: 'mdi-account-outline', isDefault: true },
  { label: 'uptime', cmd: 'uptime', icon: 'mdi-clock-outline', isDefault: true },
]

const QC_STORAGE_PREFIX = 'starhub.quickCmds.'
function loadQuickCommands(assetId: string): QuickCommand[] {
  try {
    const raw = localStorage.getItem(QC_STORAGE_PREFIX + assetId)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.map((q: QuickCommand) => ({ ...q, isDefault: false }))
      }
    }
  } catch { /* corrupt storage — fall through */ }
  return []
}
function saveQuickCommands(assetId: string, cmds: QuickCommand[]) {
  const custom = cmds.filter(c => !c.isDefault)
  localStorage.setItem(QC_STORAGE_PREFIX + assetId, JSON.stringify(custom))
}

const quickCommands = ref<QuickCommand[]>([...DEFAULT_QUICK_COMMANDS])
const showQuickCmdEditor = ref(false)
const quickCmdDragIdx = ref<number | null>(null)
const quickCmdDragOverIdx = ref<number | null>(null)
let quickCmdBackup: QuickCommand[] | null = null

function openQuickCmdEditor() {
  quickCmdBackup = quickCommands.value.map(q => ({ ...q }))
  showQuickCmdEditor.value = true
}
function cancelQuickCmdEditor() {
  if (quickCmdBackup) {
    quickCommands.value = quickCmdBackup
    quickCmdBackup = null
  }
  showQuickCmdEditor.value = false
}

function initQuickCommands() {
  const a = asset.value
  if (!a) { quickCommands.value = [...DEFAULT_QUICK_COMMANDS]; return }
  const custom = loadQuickCommands(a.id)
  quickCommands.value = [...DEFAULT_QUICK_COMMANDS, ...custom]
}

function onQuickCmdAdd() {
  quickCommands.value.push({ label: '', cmd: '', icon: 'mdi-console', isDefault: false })
}
function onQuickCmdRemove(idx: number) {
  quickCommands.value.splice(idx, 1)
}
function onQuickCmdSave() {
  const a = asset.value
  if (!a) return
  saveQuickCommands(a.id, quickCommands.value)
  quickCmdBackup = null
  showQuickCmdEditor.value = false
}

// ====== 拖拽排序 ======
function onQuickCmdDragStart(e: DragEvent, idx: number) {
  quickCmdDragIdx.value = idx
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', String(idx))
  }
}
function onQuickCmdDragOver(e: DragEvent, idx: number) {
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
  quickCmdDragOverIdx.value = idx
}
function onQuickCmdDrop(e: DragEvent, idx: number) {
  e.preventDefault()
  const from = quickCmdDragIdx.value
  if (from === null || from === idx) { quickCmdDragIdx.value = null; quickCmdDragOverIdx.value = null; return }
  const items = [...quickCommands.value]
  const [moved] = items.splice(from, 1)
  items.splice(idx, 0, moved)
  quickCommands.value = items
  quickCmdDragIdx.value = null
  quickCmdDragOverIdx.value = null
}
function onQuickCmdDragEnd() {
  quickCmdDragIdx.value = null
  quickCmdDragOverIdx.value = null
}

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

// ======广播命令 ======
async function handleBroadcast() {
  try {
    const sessions = await invoke<BroadcastSession[]>('ssh_get_sessions')
    if (!sessions || sessions.length === 0) {
      notify.notify({ message: 'No other sessions to broadcast to', color: 'warning', timeout: 3000 })
      return
    }
    const result = await broadcastDialogRef.value?.open(sessions)
    if (!result || !result.command.trim()) return

    const { command: cmd, sessionIds } = result
    for (const sid of sessionIds) {
      try {
        await invoke('ssh_write', { id: sid, data: cmd + '\n' })
      } catch (e) {
        console.error(`Failed to broadcast to session ${sid}:`, e)
      }
    }
    notify.notify({ message: `Broadcast sent to ${sessionIds.length} session(s)`, color: 'success', timeout: 2000 })
  } catch (e) {
    console.error('Broadcast failed:', e)
    notify.notify({ message: 'Broadcast failed', color: 'error', timeout: 3000 })
  }
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
 themeStore.setFontSize(themeStore.fontSize + delta)
}

function handleSearch() {
  if (searchQuery.value) {
  terminalRef.value?.search(searchQuery.value)
  }
}

function handleKbDone() {
  // KB response sent, connection flow continues
}

function handleKbCancelled() {
  disconnect()
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
 data-tooltip="减小终端字号"
 title="减小终端字号"
 @click="adjustFontSize(-1)"
 >
 <v-icon size="14">mdi-format-font-size-decrease</v-icon>
 </button>
 <span class="font-size-indicator">{{ fontSize }}px</span>
 <button
 class="action-btn"
 data-tooltip="增大终端字号"
 title="增大终端字号"
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
 :title="t('ssh.search')"
 @click="showSearch = true"
 >
 <v-icon size="14">mdi-magnify</v-icon>
 </button>

 <!-- 清屏 -->
 <button
 class="action-btn"
 :data-tooltip="t('ssh.clear')"
 :title="t('ssh.clear')"
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
 :title="t('asset.connect')"
 :disabled="connecting || !asset"
 @click="connect"
 >
 <v-icon size="14">mdi-connection</v-icon>
 </button>

  <button
  class="action-btn disconnect-btn"
  :class="{ 'pulse-danger': connected }"
  :data-tooltip="t('asset.disconnect')"
  :title="t('asset.disconnect')"
  :disabled="!connected"
  @click="disconnect"
  >
  <v-icon size="14">mdi-power-standby</v-icon>
  </button>

  <button
  class="action-btn"
  data-tooltip="命令广播"
  title="命令广播"
  @click="handleBroadcast"
  >
  <v-icon size="14">mdi-broadcast</v-icon>
  </button>
  </div>
 </div>

 <div class="workspace">
 <div class="terminal-pane">
 <input
 ref="zmodemInputRef"
 class="zmodem-file-input"
 type="file"
 multiple
 @change="onZmodemFilesSelected"
 />
 <Transition name="zmodem-transfer">
 <div v-if="zmodemPromptVisible" class="zmodem-transfer-bar">
   <div class="zmodem-transfer-icon">
     <v-icon size="16">mdi-swap-vertical-bold</v-icon>
   </div>
   <div class="zmodem-transfer-copy">
     <strong>ZMODEM</strong>
     <span>{{ zmodemStatus }}</span>
     <div class="zmodem-progress">
       <span :style="{ width: `${zmodemProgress}%` }" />
     </div>
   </div>
   <button
     v-if="zmodemSession?.type === 'send'"
     class="cyber-btn zmodem-select-btn"
     @click="chooseZmodemFiles"
   >
     选择文件
   </button>
   <button class="action-btn" title="取消 ZMODEM 传输" @click="cancelZmodem">
     <v-icon size="14">mdi-close</v-icon>
   </button>
 </div>
 </Transition>
 <!--快速命令栏:刚连接时给新手指引,常用查看命令一键发 -->
 <div v-if="connected" class="quick-commands">
 <span class="qc-label">QUICK</span>
 <button
 v-for="qc in quickCommands"
 :key="qc.cmd + qc.label"
 class="qc-btn"
 :disabled="!connected || connecting"
 @click="runQuickCommand(qc.cmd)"
 >
 <v-icon size="11">{{ qc.icon }}</v-icon>
 <span>{{ qc.label }}</span>
 </button>
 <button
 class="qc-btn qc-settings-btn"
 :title="t('ssh.quickCommandEditor.title')"
 :aria-label="t('ssh.quickCommandEditor.title')"
 @click="openQuickCmdEditor"
 >
 <v-icon size="12">mdi-tune</v-icon>
 </button>
 </div>

 <!-- 快速命令编辑弹窗 -->
 <v-dialog v-model="showQuickCmdEditor" max-width="560" transition="cyber-dialog">
 <div class="cyber-panel quick-command-editor">
 <div class="section-header">
 <v-icon class="quick-command-editor-icon" size="14">mdi-tune-variant</v-icon>
 <h3>{{ t('ssh.quickCommandEditor.title') }}</h3>
 </div>
 <p class="quick-command-editor-description">
 {{ t('ssh.quickCommandEditor.description') }}
 </p>
 <div class="qc-editor-list">
 <div
 v-for="(qc, idx) in quickCommands"
 :key="'edit-' + idx"
 class="qc-editor-row"
 :class="{
 'qc-dragging': quickCmdDragIdx === idx,
 'qc-drag-over': quickCmdDragOverIdx === idx,
 'qc-default': qc.isDefault
 }"
 :draggable="true"
 @dragstart="onQuickCmdDragStart($event, idx)"
 @dragover="onQuickCmdDragOver($event, idx)"
 @drop="onQuickCmdDrop($event, idx)"
 @dragend="onQuickCmdDragEnd"
 >
 <v-icon size="16" class="qc-drag-handle">mdi-drag-vertical</v-icon>
 <v-text-field
 v-model="qc.label"
 :label="t('ssh.quickCommandEditor.label')"
 variant="outlined"
 density="compact"
 hide-details
 :readonly="qc.isDefault"
 class="qc-edit-field qc-edit-field-label"
 />
 <v-text-field
 v-model="qc.cmd"
 :label="t('ssh.quickCommandEditor.command')"
 variant="outlined"
 density="compact"
 hide-details
 :readonly="qc.isDefault"
 class="qc-edit-field qc-edit-field-command"
 />
 <v-text-field
 v-model="qc.icon"
 :label="t('ssh.quickCommandEditor.icon')"
 variant="outlined"
 density="compact"
 hide-details
 :readonly="qc.isDefault"
 class="qc-edit-field qc-edit-field-icon"
 />
 <v-icon
 v-if="qc.isDefault"
 class="qc-default-icon"
 size="14"
 :title="t('ssh.quickCommandEditor.defaultCommand')"
 >mdi-shield-check-outline</v-icon>
 <button
 class="action-btn qc-delete-btn"
 :title="t('ssh.quickCommandEditor.deleteCommand')"
 :aria-label="t('ssh.quickCommandEditor.deleteCommand')"
 @click="onQuickCmdRemove(idx)"
 >
 <v-icon size="14">mdi-delete-outline</v-icon>
 </button>
 </div>
 </div>
 <div class="qc-editor-actions">
 <button class="cyber-btn-secondary qc-editor-action-btn" @click="onQuickCmdAdd">
 <v-icon size="14">mdi-plus</v-icon>
 {{ t('ssh.quickCommandEditor.addCommand') }}
 </button>
 <div class="qc-editor-action-spacer" />
 <button class="cyber-btn-secondary qc-editor-action-btn" @click="cancelQuickCmdEditor">
 {{ t('ssh.quickCommandEditor.cancel') }}
 </button>
 <button class="cyber-btn qc-editor-action-btn primary" @click="onQuickCmdSave">
 {{ t('ssh.quickCommandEditor.save') }}
 </button>
 </div>
 </div>
 </v-dialog>

 <TerminalPane
 ref="terminalRef"
 :session-id="id"
 :font-size="fontSize"
 :reconnect-mode="!connected && !connecting"
 bottom-safe-area
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
  <template #tab-sftp>
    <SftpPanel :asset-id="asset?.id" :session-id="id" :ssh-connected="connected && sftpReady" />
  </template>
  </RightPanel>
  </div>

    <KbInteractiveDialog
      v-if="id"
      ref="kbDialogRef"
      :session-id="id"
      :host="asset?.config.host ?? ''"
      @done="handleKbDone"
      @cancelled="handleKbCancelled"
    />

    <HostKeyConfirmDialog ref="hostKeyDialogRef" />

    <BroadcastDialog ref="broadcastDialogRef" />

    <!-- SSH AI 交互输入对话框 -->
    <v-dialog v-model="aiInputDialogVisible" max-width="420" transition="cyber-dialog" persistent>
      <div class="cyber-panel" style="padding: 24px;">
        <div class="section-header">
          <span class="section-number">?</span>
          <h3>命令需要输入</h3>
        </div>
        <p style="color: var(--muted); font-size: 11px; margin-bottom: 8px;">
          AI 执行的命令正在等待交互输入:
        </p>
        <pre style="background: var(--bg-2); padding: 10px; border-radius: 6px; font-size: 11px;
          color: var(--text-2); max-height: 140px; overflow-y: auto; font-family: 'JetBrains Mono', monospace;
          white-space: pre-wrap; word-break: break-all;">{{ aiInputDialogPrompt }}</pre>
        <input
          ref="aiInputField"
          v-model="aiInputFieldValue"
          class="cyber-input"
          style="margin-top: 12px; width: 100%;"
          :type="aiInputIsPassword ? 'password' : 'text'"
          :autocomplete="aiInputIsPassword ? 'current-password' : 'off'"
          :placeholder="aiInputIsPassword ? '输入密码（不会发送给 AI）' : '输入要发送的内容…'"
          @keydown.enter="onAiInputSubmit(aiInputFieldValue)"
        />
        <div style="display: flex; gap: 8px; margin-top: 16px; justify-content: flex-end;">
          <button class="cyber-btn-secondary" style="font-size: 12px; padding: 6px 14px;" @click="onAiInputCancel()">
            取消 (Ctrl+C)
          </button>
          <button v-if="aiInputIsConfirmation" class="cyber-btn-secondary" style="font-size: 12px; padding: 6px 14px;" @click="onAiInputSubmit('n')">
            否 (n)
          </button>
          <button v-if="aiInputIsConfirmation" class="cyber-btn" style="font-size: 12px; padding: 6px 18px;" @click="onAiInputSubmit('y')">
            是 (y)
          </button>
          <button v-else class="cyber-btn" style="font-size: 12px; padding: 6px 18px;" @click="onAiInputSubmit(aiInputFieldValue)">
            发送
          </button>
        </div>
      </div>
    </v-dialog>
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

.zmodem-file-input {
 display: none;
}

.zmodem-transfer-bar {
 display: flex;
 align-items: center;
 gap: 12px;
 padding: 8px 12px;
 margin-bottom: 8px;
 border: 1px solid var(--focus-cyan);
 border-radius: 8px;
 background: var(--panel-solid-2);
 box-shadow: var(--glow-cyan);
}

.zmodem-transfer-icon {
 width: 30px;
 height: 30px;
 display: grid;
 place-items: center;
 flex: 0 0 auto;
 border-radius: 6px;
 color: var(--cyan);
 background: var(--active-cyan);
}

.zmodem-transfer-copy {
 min-width: 0;
 flex: 1;
 display: grid;
 gap: 2px;
}

.zmodem-transfer-copy strong {
 color: var(--cyan);
 font: 600 10px/1.2 'Orbitron', sans-serif;
 letter-spacing: 0.1em;
}

.zmodem-transfer-copy > span {
 overflow: hidden;
 color: var(--text-2);
 font-size: 11px;
 text-overflow: ellipsis;
 white-space: nowrap;
}

.zmodem-progress {
 height: 2px;
 overflow: hidden;
 border-radius: 2px;
 background: var(--line-2);
}

.zmodem-progress span {
 display: block;
 height: 100%;
 border-radius: inherit;
 background: var(--grad-primary);
 transition: width 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.zmodem-select-btn {
 min-height: 28px;
 padding: 4px 12px;
 font-size: 11px;
}

.zmodem-transfer-enter-active,
.zmodem-transfer-leave-active {
 transition: opacity 0.2s, transform 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.zmodem-transfer-enter-from,
.zmodem-transfer-leave-to {
 opacity: 0;
 transform: translateY(-6px);
}

.terminal-pane > :deep(.terminal-container) {
 flex:1;
}

.quick-commands {
 display: flex;
 align-items: center;
 gap: 8px;
 padding: 8px 12px;
 background: var(--hover-cyan-faint);
 border: 1px solid var(--line-2);
 border-radius: 8px;
 margin-bottom: 8px;
 flex-wrap: wrap;
 box-shadow: inset 2px 0 0 var(--cyan);
}
.qc-label {
 font-size: 9px;
 font-weight: 700;
 font-family: 'Orbitron', sans-serif;
 color: var(--cyan);
 letter-spacing: 0.12em;
 margin-right: 4px;
 padding-right: 10px;
 border-right: 1px solid var(--line-2);
 text-shadow: 0 0 6px var(--glow-soft);
}
.qc-btn {
 display: inline-flex;
 align-items: center;
 gap: 5px;
 min-height: 26px;
 padding: 4px 10px;
 background: var(--hover-cyan-soft);
 border: 1px solid var(--line-2);
 border-radius: 6px;
 color: var(--text-2);
 font-size: 11px;
 font-family: 'JetBrains Mono', monospace;
 cursor: pointer;
 transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}
.qc-btn:hover:not(:disabled) {
 background: var(--active-cyan);
 border-color: var(--focus-cyan);
 color: var(--cyan);
 transform: translateY(-1px);
 box-shadow: 0 4px 12px var(--glow-soft);
}
.qc-btn:disabled {
 opacity:0.4;
 cursor: not-allowed;
}
.qc-settings-btn {
 padding: 4px 8px;
 opacity: 0.6;
}
.qc-settings-btn:hover {
 opacity: 1;
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
