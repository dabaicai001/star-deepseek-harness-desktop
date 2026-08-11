<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, onActivated, watch, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import KbInteractiveDialog from './KbInteractiveDialog.vue'
import HostKeyConfirmDialog, { type HostKeyInfo } from './HostKeyConfirmDialog.vue'
import BroadcastDialog, { type BroadcastSession } from './BroadcastDialog.vue'
import { sshExec, sshExecAbort, type KbInteractiveEvent } from '@/services/ssh'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import SplitTerminal from './SplitTerminal.vue'
import RightPanel from '@/components/layout/RightPanel.vue'
import AiChat from '@/components/ai/AiChat.vue'
import AiGuideDialog from '@/components/ai/AiGuideDialog.vue'
import SshDashboard from '@/components/dashboard/SshDashboard.vue'
import SftpPanel from '@/components/sftp/SftpPanel.vue'
import { useAssetStore } from '@/stores/asset'
import { useAppStore } from '@/stores/app'
import { useAiStore } from '@/stores/ai'
import { useNotifyStore } from '@/stores/notify'
import { useDialogStore } from '@/stores/dialog'
import { useThemeStore } from '@/stores/theme'
import type { Asset } from '@/types/asset'
import { parseInstanceId, withTabIndexSuffix, generateInstanceId } from '@/utils/tabId'
import { parseXshellQblDetailed, parseXshellQblx, decodeQblText } from '@/utils/xshellQuickCommand'
import { formatSize } from '@/services/sftp'
import { getDetachedInfo, LOCAL_TAB_DETACH_EVENT } from '@/lib/windowDetach'
import { SSH_SYSTEM_PROMPT, SSH_SILENT_MODE_PROMPT_NOTE, sshTools, makeSshToolCaller, sessionSearchTools, sessionSearchToolCaller, memoryTools, makeMemoryToolCaller } from '@/utils/aiTools'
import { makeSftpToolCaller, sftpTools } from '@/utils/aiSftpTools'
import { checkCommand, extractWhitelistPrefix, stripShellPrompt } from '@/utils/commandGuard'
import {
  buildCompletionMarkerCommand,
  cleanPromptCapturedOutput,
  findCompletionMarker,
  hasReturnedPrompt,
  isCompletionMarkerEchoLine,
  isShellPromptLine,
  newCompletionMarkerId,
  normalizeTerminalText
} from '@/utils/sshPromptCapture'
import type { LlmToolCall } from '@/services/ai'
import { createMcpRuntime } from '@/services/mcp'
import { logAudit } from '@/services/audit'
import { usePersistentPanelState } from '@/utils/panelState'
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

const terminalRef = ref<InstanceType<typeof SplitTerminal>>()
const paneCount = ref(1)
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
//固定容量环形缓冲:只保留最近 AI_BUFFER_MAX_CHUNKS 块,避免长会话内存无限增长;
//baseline 一律用「历史累计块数」绝对序号,截断后由 sliceBufferFrom 换算成相对下标。
const AI_BUFFER_MAX_CHUNKS = 500
const dataBuffer = ref<string[]>([])
let dataBufferTotalPushed = 0
let captureBaseline =0 // captureOutput 调用前的 buffer 绝对序号
let captureResolve: ((s: string) => void) | null = null
let captureTimer: number | null = null
interface PromptCapture {
  baseline: number
  command: string
  /** 命令发送前终端最后一行的 prompt,用于识别自定义 PS1 / fish / zsh prompt */
  expectedPrompt: string | null
  /** 本次命令的完成哨兵 ID(追加的 printf 行输出的 OSC 标记,见 sshPromptCapture.ts) */
  markerId: string
  resolve: (s: string) => void
  reject: (e: Error) => void
  safetyTimer: number | null
  settleTimer: number | null
  idleTimer: number | null
}
let promptCapture: PromptCapture | null = null
const AI_PROMPT_CAPTURE_SAFETY_MS = 60 * 1000
const AI_PROMPT_IDLE_FALLBACK_MS = 2000
/** 哨兵 ID 递增序号(拼接随机串保证单次命令唯一) */
let aiCompletionMarkerSeq = 0

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
/** 当前传输的文件名 / 已传字节 / 总字节(驱动任务条的数字区) */
const zmodemFileName = ref('')
const zmodemTransferred = ref(0)
const zmodemTotal = ref(0)
let zmodemSession: ZmodemSession | null = null
let zmodemSentry: InstanceType<ZmodemApi['Sentry']> | null = null
/** 接收方向没有 on_progress 回调,用定时器轮询 transfer.get_offset() 补进度 */
let zmodemRecvTimer: number | null = null

/** 接收等待远端发文件阶段:无法算百分比,进度条走 shimmer 不定态 */
const zmodemIndeterminate = computed(() =>
  zmodemPromptVisible.value && zmodemSession?.type === 'receive' && zmodemTotal.value === 0
)
const zmodemBytesText = computed(() => {
  if (zmodemTotal.value === 0 && zmodemTransferred.value === 0) return ''
  return `${formatSize(zmodemTransferred.value)} / ${formatSize(zmodemTotal.value)}`
})
const terminalDecoder = new TextDecoder()

// ====== 独立窗口(标签页拖出) ======
/** 非空 = 本组件运行在拖出的独立窗口里 */
const detachedWindowInfo = getDetachedInfo()
/** 附加模式:复用了主窗口建好的后端 session,unmount 时不能 disconnect */
let attachedToExisting = false
/** 主窗口侧:tab 被拖出后本实例被 keep-alive 缓存,标记以便送回时恢复订阅 */
let silencedForDetach = false

/** 主窗口把本 tab 拖成独立窗口:停止消费会话数据(ZMODEM sentry 会抢字节),
 *  但不断开后端 session — 留给独立窗口附加。 */
function onLocalDetachEvent(e: Event) {
  const detail = (e as CustomEvent<{ id?: string }>).detail
  if (detail?.id !== props.id) return
  silencedForDetach = true
  if (unlisten) { unlisten(); unlisten = null }
  if (unlistenClose) { unlistenClose(); unlistenClose = null }
  resetZmodem()
  stopTimer()
}

/** tab 从独立窗口送回主窗口:keep-alive 重激活,恢复订阅同一后端会话 */
onActivated(() => {
  if (!silencedForDetach) return
  silencedForDetach = false
  if (!connected.value) return
  terminalRef.value?.writeln('\x1b[36m⟐ 会话已从独立窗口送回(期间输出未回显)\x1b[0m')
  startTimer()
  setupZmodemSentry()
  void subscribeSessionEvents(props.id)
  void syncRemoteTerminalSize()
})

// ======右侧 Panel(仪表盘 / AI切换) ======
const rightActiveTab = ref<string>('dashboard')

const rightPanelTabs = computed(() => [
  { key: 'dashboard', label: '仪表盘', icon: 'mdi-view-dashboard-outline' },
  { key: 'ai', label: 'AI助手', icon: 'mdi-robot-outline' },
  { key: 'sftp', label: '文件', icon: 'mdi-folder-network-outline' }
])

// ====== AI 新手引导(首次打开 AI 面板自动弹出,「?」按钮可重开) ======
const aiGuideVisible = ref(false)
watch(rightActiveTab, tab => {
  if (tab !== 'ai') return
  try {
    if (localStorage.getItem('starhub.ai.guideSeen') === 'true') return
  } catch { return }
  aiGuideVisible.value = true
}, { immediate: true })

// ====== AI助手(每个 tab独立) ======
const sshCwd = ref<string>('')
// 后台静默模式:开关全局持久化(所有 SSH tab 共享一个 localStorage key)
const aiSilentMode = usePersistentPanelState('sshAiSilentMode', false)
/** 静默执行的 cwd 跟踪:每条命令结束后从 marker 解析更新,跨命令保持 cd 语义 */
const aiSilentCwd = ref<string>('')
/** 在途静默命令的 exec_id,停止按钮用它调 ssh_exec_abort 中断远端执行 */
let aiSilentExecId: string | null = null
/** 静默执行单条命令超时(秒) */
const AI_SILENT_EXEC_TIMEOUT_S = 120
/** 静默执行追加到命令末尾的 cwd 上报 marker(从 stdout 解析后剥离) */
const AI_SILENT_CWD_MARKER = '__SH_CWD__'
/** 预检:命中这些模式的命令需要交互输入,静默通道没有 PTY/stdin,自动回退到终端执行 */
const SILENT_INTERACTIVE_CMD_RE = /(?:^|[;&|`(]\s*)(?:sudo\s+)?(?:vi|vim|nvim|nano|emacs|top|htop|atop|less|more|man|passwd|ssh|sftp|ftp|telnet|mysql|mycli|psql|pgcli|redis-cli|sqlite3|mongo|mongosh|watch|crontab|chsh|su)(?:\s|$)|\b(?:rm|mv|cp)\s+-(?:[a-zA-Z]*i|i[a-zA-Z]*)\b|\b(?:bash|zsh|sh|fish|python|python3|node|irb|bc)\s*(?:-i)?\s*(?:$|[;&|>])/i
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
 if (aiSession.value.loading) {
   // 运行中:作为 steering 引导注入历史,runAgent 下一步边界生效
   aiStore.steer(props.id, text)
   return
 }
 aiSession.value.loading = true
 aiSession.value.messages.push({ role: 'user', content: text })
 logAudit({ category: 'ai', action: 'ssh_ai_query', target: text.slice(0, 120), detail: { question: text.length > 500 ? text.slice(0, 500) + '…' : text }, sessionId: props.id, assetId: asset.value?.id, success: true })
 // 先获取当前工作目录:静默模式优先用已跟踪的 cwd,为空才跑 pwd 并顺带初始化跟踪值
 try {
   if (aiSilentMode.value && aiSilentCwd.value) {
     sshCwd.value = aiSilentCwd.value
   } else {
     const cwdOutput = await runAiCommandWithPrompt('pwd')
     const pwdMatch = cwdOutput.match(/\/[\w\-./]+/)
     if (pwdMatch) {
       sshCwd.value = pwdMatch[0]
       if (aiSilentMode.value && !aiSilentCwd.value) aiSilentCwd.value = pwdMatch[0]
     }
   }
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
   if (rec) {
     const cmd = String(rec.args.command ?? rec.args.sql ?? '')
     logAudit({ category: 'ai', action: `tool_${decision}`, target: cmd.slice(0, 200), detail: { toolName: rec.name }, sessionId: props.id, assetId: asset.value?.id, success: decision !== 'reject' })
   }
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
 confirmFn,
 undefined,
 // ssh_wait_task 的轮询命令走独立静默 exec channel(不占用用户终端);
 // 远端非 0 退出(如任务目录不存在)时 Rust 侧把已收到 stdout 拼进错误消息,原样回给 AI
 async (cmd, timeoutSec) => {
   try {
     return await sshExec(props.id, cmd, timeoutSec)
   } catch (error) {
     return error instanceof Error ? error.message : String(error)
   }
 }
 )
 const sftpCaller = makeSftpToolCaller(props.id, confirmFn, asset.value?.name)
 const memoryToolCaller = makeMemoryToolCaller({
 confirmFn,
 getAssetId: () => asset.value?.id ?? null,
 getSettings: () => aiStore.settings
 })
 const mcpRuntime = await createMcpRuntime(await aiStore.getMcpServers(), confirmFn)
 if (mcpRuntime.warnings.length) console.warn('[ssh-ai] MCP discovery warnings:', mcpRuntime.warnings)
 const toolExec = async (call: LlmToolCall) => {
 if (call.function.name === 'session_search') return sessionSearchToolCaller(call)
 if (call.function.name === 'memory') return memoryToolCaller(call)
 if (call.function.name.startsWith('mcp__')) return mcpRuntime.execute(call)
 const target = call.function.name.startsWith('sftp_') ? sftpCaller : caller
 return await target({ function: { name: call.function.name, arguments: call.function.arguments } })
 }
 const basePrompt = sshCwd.value
   ? SSH_SYSTEM_PROMPT.replace('当前已连接到远程服务器', `当前已连接到远程服务器,当前工作目录: ${sshCwd.value}`)
   : SSH_SYSTEM_PROMPT
 // 静默模式下每次 exec 都是新 channel,export/环境变量跨命令留不住,提前告诉 LLM 别依赖
 const sysPrompt = aiStore.buildSystemPrompt(
   aiSilentMode.value ? `${basePrompt}\n${SSH_SILENT_MODE_PROMPT_NOTE}` : basePrompt,
   'ssh'
 )
 await aiStore.runAgent(props.id, [...sshTools, ...sftpTools, ...sessionSearchTools, ...memoryTools, ...mcpRuntime.tools], toolExec, sysPrompt)
}

onMounted(async () => {
 beforeUnloadHandler = (e: BeforeUnloadEvent) => {
   if (connected.value) {
     e.preventDefault()
     e.returnValue = ''
   }
 }
 window.addEventListener('beforeunload', beforeUnloadHandler)
 window.addEventListener(LOCAL_TAB_DETACH_EVENT, onLocalDetachEvent)

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
  window.removeEventListener(LOCAL_TAB_DETACH_EVENT, onLocalDetachEvent)
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
  // 附加模式下 session 属于主窗口原会话,unmount 不断开(独立窗口销毁后,
  // 主窗口 reattach 还要复用它;后端 session 的生命周期由主窗口侧管理)
  if (!attachedToExisting) {
    await disconnect()
  }
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

  // ===== 独立窗口附加模式 =====
  // 本 tab 是从主窗口拖出的:后端 SSH session 还活着,直接附加
  // (订阅同一 sessionId 的事件),不重新建链 — 远端 shell 与正在
  // 运行的任务完全不受影响;拖出前的历史输出不回显。
  if (detachedWindowInfo) {
    try {
      const sessions = await invoke<Array<{ id: string; connected: boolean }>>('ssh_get_sessions')
      if (sessions.some(s => s.id === sessionId && s.connected)) {
        attachedToExisting = true
        connected.value = true
        connecting.value = false
        reconnectAttempt.value = 0
        terminalRef.value?.writeln('\x1b[36m⟐ 已附加到现有会话(拖出前的历史输出未回显)\x1b[0m')
        startTimer()
        setupZmodemSentry()
        await subscribeSessionEvents(sessionId)
        await syncRemoteTerminalSize()
        scheduleSftpReadyFallback()
        return
      }
    } catch (error) {
      // 探测失败(后端未就绪等)→ 回退到正常建链
      console.warn('[ssh] attach probe failed, fallback to connect:', error)
    }
  }

 lastError.value = null
 terminalRef.value?.writeln('')
 terminalRef.value?.writeln(`\x1b[36m» Connecting to ${a.config.username}@${a.config.host}:${a.config.port ||22}...\x1b[0m`)

 //标记当前 connect 调用,避免老 timeout杀掉新连接
 const connectCallId = ++currentConnectId

   try {
    let effectivePassword = a.config.mfaEnabled ? a.config.mfaPassword : a.config.password

    const terminalSize = terminalRef.value?.getSize()
    const config: Record<string, unknown> = {
      host: a.config.host,
      port: a.config.port || 22,
      username: a.config.username,
      ...(terminalSize ? { pty_cols: terminalSize.cols, pty_rows: terminalSize.rows } : {}),
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

  // request_pty 已使用当前尺寸；建链完成后再同步一次，覆盖连接期间的布局变化。
  // resize 失败不应把一条已经可用的 SSH 连接判定为建链失败。
  await syncRemoteTerminalSize()

  connected.value = true
  reconnectAttempt.value = 0
  terminalRef.value?.writeln('\x1b[32m✓ Connected\x1b[0m')
  startTimer()
  logAudit({ category: 'ssh', action: 'connect', target: `${asset.value.config.username}@${asset.value.config.host}:${asset.value.config.port || 22}`, detail: { host: asset.value.config.host ?? null, port: asset.value.config.port || 22, username: asset.value.config.username ?? null }, sessionId, assetId: asset.value?.id, success: true })

  setupZmodemSentry()
  await subscribeSessionEvents(sessionId)
  scheduleSftpReadyFallback()



 } catch (error) {
  const msg = error instanceof Error ? error.message : String(error)
  if (connectCallId !== currentConnectId) {
    return
  }
  lastError.value = msg
  terminalRef.value?.writeln(`\x1b[31m✗ Connection failed: ${msg}\x1b[0m`)
  logAudit({ category: 'ssh', action: 'connect', target: asset.value ? `${asset.value.config.username}@${asset.value.config.host}:${asset.value.config.port}` : 'unknown', detail: asset.value ? { host: asset.value.config.host ?? null, port: asset.value.config.port || 22, username: asset.value.config.username ?? null } : null, sessionId, assetId: asset.value?.id, success: false })
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

/** 订阅会话数据 / 关闭事件(正常建链与独立窗口附加模式共用) */
async function subscribeSessionEvents(sessionId: string) {
  unlisten = await listen(`ssh:data:${sessionId}`, (event) => {
    const payload = event.payload
    const octets = typeof payload === 'string'
      ? Array.from(new TextEncoder().encode(payload))
      : Array.from(payload as number[])
    zmodemSentry?.consume(octets)
  })

  unlistenClose = await listen<string>(`ssh:close:${sessionId}`, (event) => {
    connected.value = false
    clearPromptCapture(new Error('SSH connection closed before prompt returned'))
    resetZmodem()
    resetSftpReady()
    stopTimer()
    // 后端透传断开原因:shell-exited(远程 shell 退出,连接未必断)/
    // channel-closed(服务端关通道)/ connection-lost(连接真的断了)
    const cause = typeof event.payload === 'string' ? event.payload : 'connection-lost'
    const causeText = cause === 'shell-exited'
      ? '! Remote shell exited (connection may still be alive)'
      : '! Connection closed by remote host'
    terminalRef.value?.writeln(`\r\n\x1b[33m${causeText}\x1b[0m`)
    if (autoReconnect.value && !asset.value?.config.mfaEnabled) {
      tryReconnect(sessionId)
    } else if (asset.value?.config.mfaEnabled) {
      terminalRef.value?.writeln('\x1b[36m MFA/2FA session closed. Click reconnect when you are ready to verify again.\x1b[0m')
    }
  })
}

/** 追加终端输出块,超出容量时丢弃最旧块(AI capture 只需要尾部)。 */
function pushDataChunk(chunk: string) {
  dataBuffer.value.push(chunk)
  dataBufferTotalPushed++
  if (dataBuffer.value.length > AI_BUFFER_MAX_CHUNKS) {
    dataBuffer.value.splice(0, dataBuffer.value.length - AI_BUFFER_MAX_CHUNKS)
  }
}

/** 按绝对序号切出 buffer 尾部并 join;环形截断后自动对齐到当前可用起点。 */
function sliceBufferFrom(absoluteBaseline: number): string {
  const firstAvailable = dataBufferTotalPushed - dataBuffer.value.length
  const start = Math.max(absoluteBaseline - firstAvailable, 0)
  return dataBuffer.value.slice(start).join('')
}

function handleTerminalOctets(octets: number[]) {
  const chunk = terminalDecoder.decode(new Uint8Array(octets), { stream: true })
  if (!chunk) return
  terminalRef.value?.write(chunk)
  markSftpReady()
  //收集到 buffer(AI助手用,固定容量环形缓冲)
  pushDataChunk(chunk)
  //检测 pwd 输出,更新当前工作目录
  const pwdMatch = chunk.match(/(?:\r\n|\n|\r)(\/[\w\-./]{1,200})\s*(?:\r\n|\n|\r|$)/)
  if (pwdMatch && pwdMatch[1].startsWith('/')) {
    sshCwd.value = pwdMatch[1]
  }
  //唤醒正在等待的 captureOutput
  maybeResolveCapture()
  maybeResolvePromptCapture()
  armPromptCaptureIdleFallback()
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
      zmodemFileName.value = ''
      zmodemTransferred.value = 0
      zmodemTotal.value = 0
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
        zmodemFileName.value = details.name
        zmodemTotal.value = details.size ?? 0
        zmodemStatus.value = `正在接收 ${details.name}`
        // accept() 没有进度回调,轮询 offset 补一个真实进度条
        if (zmodemRecvTimer !== null) window.clearInterval(zmodemRecvTimer)
        zmodemRecvTimer = window.setInterval(() => {
          const offset = transfer.get_offset()
          zmodemTransferred.value = offset
          if (zmodemTotal.value > 0) {
            zmodemProgress.value = Math.min(99, (offset / zmodemTotal.value) * 100)
          }
        }, 200)
        void transfer.accept().then(payloads => {
          if (zmodemRecvTimer !== null) {
            window.clearInterval(zmodemRecvTimer)
            zmodemRecvTimer = null
          }
          zmodemTransferred.value = zmodemTotal.value || zmodemTransferred.value
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
    zmodemTotal.value = totalBytes
    zmodemStatus.value = files.length === 1 ? `正在发送 ${files[0].name}` : `正在发送 ${files.length} 个文件`
    zmodemFileName.value = files.length === 1 ? files[0].name : `${files.length} 个文件`
    await Zmodem.Browser.send_files(zmodemSession, files, {
      on_progress: (file, transfer) => {
        const sent = transfer.get_offset()
        zmodemFileName.value = file.name
        zmodemTransferred.value = sent
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
  if (zmodemRecvTimer !== null) {
    window.clearInterval(zmodemRecvTimer)
    zmodemRecvTimer = null
  }
  zmodemSession = null
  zmodemPromptVisible.value = false
  zmodemStatus.value = ''
  zmodemProgress.value = 0
  zmodemFileName.value = ''
  zmodemTransferred.value = 0
  zmodemTotal.value = 0
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
    logAudit({ category: 'ssh', action: 'disconnect', target: asset.value ? `${asset.value.config.username}@${asset.value.config.host}:${asset.value.config.port}` : 'unknown', detail: asset.value ? { host: asset.value.config.host ?? null, port: asset.value.config.port || 22, username: asset.value.config.username ?? null } : null, sessionId: props.id, assetId: asset.value?.id, success: true })
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

// 危险命令拦截: 缓冲当前命令行,回车时检查
const lineBuffer = ref('')
const pendingRiskyCommand = ref<{ command: string; reason: string } | null>(null)

/**
 * 从终端 buffer 提取当前命令行的真实回显(剥离 shell 提示符)。
 *
 * Tab 补全 / 方向键历史召回 / shell 行编辑都是 shell 本地回显,不经过
 * onData — 只追踪本地按键会得到残缺命令,确认框显示不全甚至漏检。
 */
function readEchoedCommand(): string {
  const line = terminalRef.value?.readActiveCursorLine() ?? ''
  if (!line.trim()) return ''
  return stripShellPrompt(line)
}

function confirmRiskyCommand() {
  if (!pendingRiskyCommand.value) return
  pendingRiskyCommand.value = null
  lineBuffer.value = ''
  invoke('ssh_write', { id: props.id, data: '\r' }).catch(() => {})
}

function cancelRiskyCommand() {
  pendingRiskyCommand.value = null
  lineBuffer.value = ''
}

async function handleData(data: string) {
  if (connected.value) {

  // 危险命令拦截: 当用户按回车时检查当前命令行(mock 模式也跑,便于浏览器回归)
  if (data === '\r' && !pendingRiskyCommand.value) {
    // 回显(shell 真实命令行,含 Tab 补全 / 历史召回)优先;本地按键缓冲兜底
    // (提示符剥离失败或无回显时)。两个来源都过一遍风险检测,任一命中即拦截,
    // 弹窗展示命中来源的完整命令。
    const typed = lineBuffer.value.trim()
    const echoed = readEchoedCommand()
    lineBuffer.value = ''
    const sources = echoed && echoed !== typed ? [echoed, typed] : [typed]
    for (const command of sources) {
      if (!command) continue
      const result = checkCommand(command, aiStore.settings.commandWhitelist)
      if (result.isRisky) {
        pendingRiskyCommand.value = { command, reason: result.riskReason ?? '风险命令' }
        return // 不发送回车,等待用户确认
      }
    }
  } else if (data === '\x7f' || data === '\b') {
    lineBuffer.value = lineBuffer.value.slice(0, -1)
  } else if (data === '\x03') {
    lineBuffer.value = ''
  } else if (data.length === 1 && data >= ' ' && !pendingRiskyCommand.value) {
    lineBuffer.value += data
  } else if (data.length > 1 && !pendingRiskyCommand.value) {
    // 粘贴 / IME 等多字符输入:剥离 bracketed-paste 标记与 ANSI 转义序列,
    // 把可打印字符计入缓冲,避免整块粘贴的危险命令绕过检测
    const text = data
      .replace(/\x1b\[2(?:00|01)~/g, '')
      .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    for (const ch of text) {
      if (ch === '\r' || ch === '\n') {
        lineBuffer.value = ''
      } else if (ch === '\x7f' || ch === '\b') {
        lineBuffer.value = lineBuffer.value.slice(0, -1)
      } else if (ch >= ' ') {
        lineBuffer.value += ch
      }
    }
  }

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

async function syncRemoteTerminalSize() {
  if (devMockWorkspace.value) return
  const size = terminalRef.value?.getSize()
  if (!size) return
  try {
    await invoke('ssh_resize', { id: props.id, cols: size.cols, rows: size.rows })
  } catch (error) {
    console.error('Failed to synchronize terminal size:', error)
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

 if (aiSilentMode.value) {
   if (SILENT_INTERACTIVE_CMD_RE.test(command)) {
     // 交互式命令在静默通道(无 PTY/stdin)只会干等超时,回退到共享终端执行并在输出里注明原因
     logAudit({ category: 'ai', action: 'ssh_ai_silent_fallback', target: command.slice(0, 200), detail: { command: command.length > 2000 ? command.slice(0, 2000) + '…' : command, reason: 'interactive_command' }, sessionId: props.id, assetId: asset.value?.id, success: true })
     return runPtyAiCommand(command).then(out => `[${t('ssh.aiSilentFallbackNote')}]\n${out}`)
   }
   return runSilentAiCommand(command)
 }

 return runPtyAiCommand(command)
}

/**
 * 后台静默执行:每条命令在独立的非 PTY exec channel 里跑。
 * - 用 aiSilentCwd 包装 `cd <cwd> && <cmd>`,末尾追加 marker 上报真实 $PWD 与 exit code,
 *   从而在跨命令间保持 cd 语义(LLM 以为 cd 成功的目录,下条命令仍在那里)
 * - export / 环境变量无法跨命令保留(每次新 channel),已在 system prompt 里向 LLM 说明
 */
async function runSilentAiCommand(command: string): Promise<string> {
 const execId = crypto.randomUUID()
 aiSilentExecId = execId
 try {
   const raw = await sshExec(props.id, buildSilentCommand(command), AI_SILENT_EXEC_TIMEOUT_S, execId)
   const { output, cwd } = parseSilentOutput(raw)
   if (cwd) aiSilentCwd.value = cwd
   return output || '(无输出)'
 } catch (error) {
   // 非 0 退出码 / 中断时,Rust 侧把已收到的 stdout 拼在错误消息里,同样解析 cwd 后剥离 marker
   const message = error instanceof Error ? error.message : String(error)
   const { output, cwd } = parseSilentOutput(message)
   if (cwd) aiSilentCwd.value = cwd
   throw new Error(output)
 } finally {
   if (aiSilentExecId === execId) aiSilentExecId = null
 }
}

/** shell 单引号安全转义:'a'b' → 'a'\''b' */
function shellQuote(value: string): string {
 return `'${value.replace(/'/g, `'\\''`)}'`
}

/** 把用户命令包装成带 cwd 跟踪的静默命令:cd 到跟踪目录 → 执行 → 打印 marker(真实 $PWD) → 透传 exit code */
function buildSilentCommand(command: string): string {
 const cdPrefix = aiSilentCwd.value ? `cd ${shellQuote(aiSilentCwd.value)} && ` : ''
 return `${cdPrefix}${command}; __rc=$?; printf '\\n${AI_SILENT_CWD_MARKER}:%s\\n' "$PWD"; exit $__rc`
}

/** 从静默输出中剥离 marker 行,返回干净输出与解析到的 cwd */
function parseSilentOutput(raw: string): { output: string; cwd: string | null } {
 let cwd: string | null = null
 const kept = raw.split('\n').filter(line => {
   const match = line.replace(/\r$/, '').match(/^__SH_CWD__:(.*)$/)
   if (match) {
     cwd = match[1]
     return false
   }
   return true
 })
 return { output: kept.join('\n').replace(/\n$/, ''), cwd }
}

function runPtyAiCommand(command: string): Promise<string> {
 if (promptCapture) {
  return Promise.reject(new Error('上一条 SSH AI 命令仍在执行,已拒绝并发发送新命令'))
 }
 return new Promise((resolve, reject) => {
  const markerId = newCompletionMarkerId(++aiCompletionMarkerSeq)
  promptCapture = {
  baseline: dataBufferTotalPushed,
  command,
  expectedPrompt: getCurrentPromptLine(),
  markerId,
  resolve,
  reject,
  safetyTimer: null,
  settleTimer: null,
  idleTimer: null
  }
 promptCapture.safetyTimer = window.setTimeout(() => {
 const current = promptCapture
 if (!current) return
 const raw = sliceBufferFrom(current.baseline)
 const partial = cleanPromptCapturedOutput(raw, current.command, aiSensitiveInputs)
 interruptAiCommand(new Error(`等待 shell prompt 返回超时,已发送 Ctrl+C 恢复终端。已收到输出:\n${partial || '(无输出)'}`))
 }, AI_PROMPT_CAPTURE_SAFETY_MS)

 // 命令之后追加一行哨兵 printf(独立一行,多行命令也能正常排队执行):
 // 命中哨兵即判定完成,不再只靠 prompt 识别;哨兵被吞时退回 prompt 检测
 writeCommand(`${command}\n${buildCompletionMarkerCommand(markerId)}`).catch(error => {
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
 if (current.idleTimer) window.clearTimeout(current.idleTimer)
 promptCapture = null
 if (error) current.reject(error)
}

/** 终止仍在执行的 AI 命令:PTY 路径发 Ctrl+C 恢复终端;静默路径调 ssh_exec_abort 关闭远端 channel。 */
function interruptAiCommand(error: Error): boolean {
 let handled = false
 if (promptCapture) {
  clearPromptCapture(error)
  handled = true
  if (connected.value) {
   void invoke('ssh_write_binary', { id: props.id, data: [3] }).catch(invokeError => {
    console.error('Failed to interrupt SSH AI command:', invokeError)
   })
  }
 }
 if (aiSilentExecId) {
  const execId = aiSilentExecId
  aiSilentExecId = null
  handled = true
  void sshExecAbort(props.id, execId).catch(abortError => {
   console.error('Failed to abort silent SSH AI command:', abortError)
  })
 }
 return handled
}

function maybeResolvePromptCapture() {
  const current = promptCapture
  if (!current) return
  const raw = sliceBufferFrom(current.baseline)

  // 先检测是否需要交互输入
  if (detectInteractivePrompt(raw)) return

  // 主通道:命中完成哨兵。哨兵 printf 在命令输出之后执行,字节序保证
  // 它之前的输出已经全部到达,可以直接收口,无需 settle 等待
  const marker = findCompletionMarker(raw, current.markerId)
  if (marker) {
    const cleaned = cleanMarkerCapturedOutput(raw.slice(0, marker.start), current.command, marker.exitCode)
    if (current.safetyTimer) window.clearTimeout(current.safetyTimer)
    if (current.settleTimer) window.clearTimeout(current.settleTimer)
    if (current.idleTimer) window.clearTimeout(current.idleTimer)
    promptCapture = null
    current.resolve(cleaned || '(无输出)')
    return
  }

  // 兜底通道:哨兵行被吞(引号未闭合 / csh / PowerShell 等)时退回 prompt 识别
  if (hasReturnedPrompt(raw, current.expectedPrompt, current.command)) {
    if (current.settleTimer) window.clearTimeout(current.settleTimer)
    current.settleTimer = window.setTimeout(() => {
      const latest = promptCapture
      if (!latest) return
      const output = sliceBufferFrom(latest.baseline)
      if (!hasReturnedPrompt(output, latest.expectedPrompt, latest.command)) return
      const cleaned = cleanPromptCapturedOutput(output, latest.command, aiSensitiveInputs)
      if (latest.safetyTimer) window.clearTimeout(latest.safetyTimer)
      if (latest.settleTimer) window.clearTimeout(latest.settleTimer)
      if (latest.idleTimer) window.clearTimeout(latest.idleTimer)
      promptCapture = null
      latest.resolve(cleaned || '(无输出)')
    }, 80)
  }
}

/**
 * 清理哨兵通道捕获的输出:
 * 截取到哨兵之前(命令输出完整,不含返回的 prompt 行),
 * 剥掉命令回显与哨兵命令本身的回显行,非 0 退出码时附上 exit code 提示。
 */
function cleanMarkerCapturedOutput(rawBeforeMarker: string, command: string, exitCode: number | null): string {
  const cleaned = cleanPromptCapturedOutput(rawBeforeMarker, command, aiSensitiveInputs)
  const lines = cleaned.split('\n').filter(line => !isCompletionMarkerEchoLine(line))
  let output = lines.join('\n').trim()
  if (exitCode !== null && exitCode !== 0) {
    output = `${output}\n[exit code: ${exitCode}]`.trim()
  }
  return output
}

/**
 * 数据流 idle 兜底:仅当 shell prompt 无法被识别(自定义 PS1 / fish / zsh / 带 ❯➜ 的
 * 提示符等,getCurrentPromptLine 抓不到)时启用 — 此时数据流连续 AI_PROMPT_IDLE_FALLBACK_MS
 * 没有新内容就认为命令已结束,避免一直等到 safetyTimer 超时再发 Ctrl+C 报错。
 *
 * prompt 可识别时绝不能用它:sleep、下载、编译等命令会长时间静默,
 * 提前收口会把"命令还在跑"误判成"无输出"返回给 AI。
 */
function armPromptCaptureIdleFallback() {
  const current = promptCapture
  if (!current) return
  if (current.idleTimer) window.clearTimeout(current.idleTimer)
  if (current.expectedPrompt) return
  current.idleTimer = window.setTimeout(() => {
    const latest = promptCapture
    if (!latest) return
    latest.idleTimer = null
    if (aiInputDialogVisible.value) return
    const raw = sliceBufferFrom(latest.baseline)
    if (detectInteractivePrompt(raw)) return
    const cleaned = cleanPromptCapturedOutput(raw, latest.command, aiSensitiveInputs)
    if (latest.safetyTimer) window.clearTimeout(latest.safetyTimer)
    if (latest.settleTimer) window.clearTimeout(latest.settleTimer)
    promptCapture = null
    latest.resolve(cleaned || '(无输出)')
  }, AI_PROMPT_IDLE_FALLBACK_MS)
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
    const raw2 = sliceBufferFrom(pc.baseline)
    const partial = cleanPromptCapturedOutput(raw2, pc.command, aiSensitiveInputs)
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

function getCurrentPromptLine(): string | null {
 const text = normalizeTerminalText(dataBuffer.value.slice(-200).join('')).slice(-1200)
 const lines = text.split('\n').map(line => line.trimEnd()).filter(line => line.trim().length > 0)
 const last = lines[lines.length - 1] || ''
 if (!last || last.length > 180) return null
 if (isShellPromptLine(last) || /(?:[$#%>]|❯|➜)\s*$/.test(last)) return last
 return null
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
const QC_ICON_OPTIONS = [
  { title: 'mdi-console', value: 'mdi-console' },
  { title: 'mdi-format-list-bulleted', value: 'mdi-format-list-bulleted' },
  { title: 'mdi-map-marker-outline', value: 'mdi-map-marker-outline' },
  { title: 'mdi-harddisk', value: 'mdi-harddisk' },
  { title: 'mdi-chip', value: 'mdi-chip' },
  { title: 'mdi-account-outline', value: 'mdi-account-outline' },
  { title: 'mdi-clock-outline', value: 'mdi-clock-outline' },
  { title: 'mdi-server', value: 'mdi-server' },
  { title: 'mdi-database-outline', value: 'mdi-database-outline' },
  { title: 'mdi-folder-outline', value: 'mdi-folder-outline' },
  { title: 'mdi-file-document-outline', value: 'mdi-file-document-outline' },
  { title: 'mdi-cog-outline', value: 'mdi-cog-outline' },
  { title: 'mdi-shield-check-outline', value: 'mdi-shield-check-outline' },
  { title: 'mdi-network-outline', value: 'mdi-network-outline' },
  { title: 'mdi-memory', value: 'mdi-memory' },
  { title: 'mdi-cpu-64-bit', value: 'mdi-cpu-64-bit' },
  { title: 'mdi-lan', value: 'mdi-lan' },
  { title: 'mdi-docker', value: 'mdi-docker' },
  { title: 'mdi-web', value: 'mdi-web' },
  { title: 'mdi-bug-outline', value: 'mdi-bug-outline' },
  { title: 'mdi-magnify', value: 'mdi-magnify' },
  { title: 'mdi-download-outline', value: 'mdi-download-outline' },
  { title: 'mdi-upload-outline', value: 'mdi-upload-outline' },
  { title: 'mdi-restart', value: 'mdi-restart' },
  { title: 'mdi-power', value: 'mdi-power' },
  { title: 'mdi-terminal', value: 'mdi-terminal' },
  { title: 'mdi-script-text-outline', value: 'mdi-script-text-outline' },
  { title: 'mdi-chart-line', value: 'mdi-chart-line' },
  { title: 'mdi-bell-outline', value: 'mdi-bell-outline' },
  { title: 'mdi-lock-outline', value: 'mdi-lock-outline' },
]

function loadQuickCommands(assetId: string): QuickCommand[] | null {
  try {
    const raw = localStorage.getItem(QC_STORAGE_PREFIX + assetId)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.map((q: QuickCommand) => ({ ...q }))
      }
    }
  } catch { /* corrupt storage — fall through */ }
  return null
}
function saveQuickCommands(assetId: string, cmds: QuickCommand[]) {
  localStorage.setItem(QC_STORAGE_PREFIX + assetId, JSON.stringify(cmds))
}

const quickCommands = ref<QuickCommand[]>([...DEFAULT_QUICK_COMMANDS])
const showQuickCmdEditor = ref(false)
const quickCmdDragIdx = ref<number | null>(null)
const quickCmdDragOverIdx = ref<number | null>(null)
const qcDragEnabled = ref(false)
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
  if (custom) {
    quickCommands.value = custom
  } else {
    quickCommands.value = [...DEFAULT_QUICK_COMMANDS]
  }
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
function onQuickCmdResetDefaults() {
  quickCommands.value = DEFAULT_QUICK_COMMANDS.map(q => ({ ...q }))
}

// ====== 导入 Xshell 快速命令集(.qbl) ======
const qblFileInput = ref<HTMLInputElement | null>(null)
const qcImportMsg = ref('')
const qcImportMsgError = ref(false)
let qcImportMsgTimer: ReturnType<typeof setTimeout> | null = null

function showQcImportMsg(msg: string, isError: boolean) {
  qcImportMsg.value = msg
  qcImportMsgError.value = isError
  if (qcImportMsgTimer) clearTimeout(qcImportMsgTimer)
  qcImportMsgTimer = setTimeout(() => { qcImportMsg.value = '' }, 4000)
}

function triggerQblImport() {
  qblFileInput.value?.click()
}

async function onQblFileChange(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  try {
    const buf = await file.arrayBuffer()
    // .qblx 是 ZIP(PK 魔数):每个命令集一个 commands.qbl;否则按 .qbl 文本解析
    const head = new Uint8Array(buf, 0, 2)
    const result = head[0] === 0x50 && head[1] === 0x4b
      ? await parseXshellQblx(buf)
      : parseXshellQblDetailed(decodeQblText(buf))
    if (result.commands.length === 0) {
      showQcImportMsg(t('ssh.quickCommandEditor.importFailed'), true)
      return
    }
    quickCommands.value.push(...result.commands.map(p => ({ ...p, icon: 'mdi-script-text-outline', isDefault: false })))
    const msg = t('ssh.quickCommandEditor.importSuccess', { n: result.commands.length })
    showQcImportMsg(
      result.skippedScripts > 0
        ? msg + t('ssh.quickCommandEditor.importSkippedScripts', { m: result.skippedScripts })
        : msg,
      false,
    )
  } catch {
    showQcImportMsg(t('ssh.quickCommandEditor.importFailed'), true)
  }
}

// ====== 拖拽排序 ======
function onQuickCmdDragStart(e: DragEvent, idx: number) {
  if (!qcDragEnabled.value) { e.preventDefault(); return }
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
  qcDragEnabled.value = false
}

async function runQuickCommand(cmd: string) {
  try {
    await writeCommand(cmd)
    logAudit({ category: 'ssh', action: 'quick_command', target: cmd.slice(0, 200), detail: { command: cmd.length > 2000 ? cmd.slice(0, 2000) + '…' : cmd }, sessionId: props.id, assetId: asset.value?.id, success: true })
  } catch (e) {
    logAudit({ category: 'ssh', action: 'quick_command', target: cmd.slice(0, 200), detail: { command: cmd.length > 2000 ? cmd.slice(0, 2000) + '…' : cmd, error: e instanceof Error ? e.message : String(e) }, sessionId: props.id, assetId: asset.value?.id, success: false })
    terminalRef.value?.writeln(`\x1b[31m✗ ${e instanceof Error ? e.message : String(e)}\x1b[0m`)
  }
}

// ====== Web Access(打开网页浏览子页面 tab) ======
// 不再弹窗输入 URL:直接按项目 tab 模式新开 web/:id 子页面,
// 地址栏 + 端口转发 + 内嵌子 webview 都在 WebBrowserView 里完成。
// 注意:路由不带 query(session 由 tab.assetId 反解)—— keep-alive 以
// route.fullPath 为 key,带 query 的 push 与 tab 切换时的无 query push
// 会产生两个实例,浏览状态全丢。
function openWebBrowserTab() {
  if (!connected.value) return
  // 同一 SSH 会话已有 web tab → 直接激活,不重复开
  const existing = appStore.tabs.find(tab => tab.type === 'web' && tab.assetId === props.id)
  if (existing) {
    appStore.setActiveTab(existing.id)
    router.push({ name: 'web-browser', params: { id: existing.id } })
    return
  }
  const instanceId = generateInstanceId(`web-${props.id}`)
  const title = `${t('ssh.webAccess.title')} · ${asset.value?.name ?? asset.value?.config.host ?? props.id}`
  // assetId 存 SSH 会话 id(WebBrowserView 据此建端口转发,审计反解资产)
  appStore.addTab({ id: instanceId, assetId: props.id, title, type: 'web' })
  router.push({ name: 'web-browser', params: { id: instanceId } })
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
 captureResolve(sliceBufferFrom(captureBaseline))
 captureResolve = null
 if (captureTimer) { clearTimeout(captureTimer); captureTimer = null }
 }
 captureBaseline = dataBufferTotalPushed
 captureResolve = (s: string) => {
 resolve(s)
 captureResolve = null
 if (captureTimer) { clearTimeout(captureTimer); captureTimer = null }
 }
 captureTimer = window.setTimeout(() => {
 if (captureResolve) {
 const output = sliceBufferFrom(captureBaseline)
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
 const output = sliceBufferFrom(captureBaseline)
 captureResolve(output)
 }
 },200)
}

function clearBuffer() {
 dataBuffer.value = []
 dataBufferTotalPushed = 0
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
/** 后端 ssh_get_sessions 返回的会话元数据 */
interface SshSessionMeta {
  id: string
  host: string
  port: number
  username: string
  connected: boolean
}

async function handleBroadcast() {
  try {
    const infos = await invoke<SshSessionMeta[]>('ssh_get_sessions')
    // 只保留有活跃 shell 通道的会话(AI / 仪表盘的 exec-only 会话没有 PTY,无法接收输入)
    const allIds = (infos ?? []).filter((s) => s.connected).map((s) => s.id)
    const sessions: BroadcastSession[] = (infos ?? [])
      .filter((s) => s.connected)
      .map((s) => {
        const { assetId } = parseInstanceId(s.id)
        const assetName = assetStore.assets.find((a) => a.id === assetId)?.name
        const endpoint = `${s.username}@${s.host}:${s.port}`
        return {
          sessionId: s.id,
          title: assetName ? withTabIndexSuffix(assetName, s.id, allIds) : endpoint,
          host: endpoint,
        }
      })
    if (sessions.length === 0) {
      notify.notify({ message: t('ssh.broadcast.noSessions'), color: 'warning', timeout: 3000 })
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
    notify.notify({ message: t('ssh.broadcast.sent', { count: sessionIds.length }), color: 'success', timeout: 2000 })
  } catch (e) {
    console.error('Broadcast failed:', e)
    notify.notify({ message: t('ssh.broadcast.failed'), color: 'error', timeout: 3000 })
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
  :data-tooltip="t('ssh.broadcast.tooltip')"
  :title="t('ssh.broadcast.tooltip')"
  @click="handleBroadcast"
  >
  <v-icon size="14">mdi-broadcast</v-icon>
  </button>

  <button
  class="action-btn"
  :data-tooltip="t('ssh.webAccess.title')"
  :title="t('ssh.webAccess.title')"
  :aria-label="t('ssh.webAccess.title')"
  :disabled="!connected || connecting"
  @click="openWebBrowserTab"
  >
  <v-icon size="14">mdi-web</v-icon>
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
 <div
   v-if="zmodemPromptVisible"
   class="zmodem-transfer-bar"
   :class="zmodemSession?.type === 'send' ? 'send' : 'receive'"
 >
   <div class="zmodem-transfer-icon">
     <v-icon size="16">{{ zmodemSession?.type === 'send' ? 'mdi-upload-outline' : 'mdi-download-outline' }}</v-icon>
   </div>
   <div class="zmodem-transfer-copy">
     <div class="zmodem-transfer-head">
       <strong>ZMODEM</strong>
       <span class="zmodem-transfer-tag">{{ zmodemSession?.type === 'send' ? 'RZ · 发送' : 'SZ · 接收' }}</span>
       <span v-if="zmodemFileName" class="zmodem-transfer-file" :title="zmodemFileName">{{ zmodemFileName }}</span>
       <span class="zmodem-transfer-nums">
         <template v-if="zmodemBytesText">{{ zmodemBytesText }} · </template>{{ Math.round(zmodemProgress) }}%
       </span>
     </div>
     <span class="zmodem-transfer-status">{{ zmodemStatus }}</span>
     <div class="zmodem-progress" :class="{ indeterminate: zmodemIndeterminate }">
       <span :style="{ width: zmodemIndeterminate ? '40%' : `${zmodemProgress}%` }" />
     </div>
   </div>
   <button
     v-if="zmodemSession?.type === 'send'"
     class="cyber-btn zmodem-select-btn"
     @click="chooseZmodemFiles"
   >
     <v-icon size="13">mdi-file-upload-outline</v-icon>
     选择文件
   </button>
   <button class="action-btn" data-tooltip="取消 ZMODEM 传输" aria-label="取消 ZMODEM 传输" @click="cancelZmodem">
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
 <p v-if="qcImportMsg" class="qc-import-msg" :class="{ 'qc-import-msg-error': qcImportMsgError }">
 {{ qcImportMsg }}
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
 :draggable="qcDragEnabled"
 @dragstart="onQuickCmdDragStart($event, idx)"
 @dragover="onQuickCmdDragOver($event, idx)"
 @drop="onQuickCmdDrop($event, idx)"
 @dragend="onQuickCmdDragEnd"
 >
 <v-icon
 size="16"
 class="qc-drag-handle"
 @mousedown="qcDragEnabled = true"
 @mouseup="qcDragEnabled = false"
 >mdi-drag-vertical</v-icon>
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
 <v-select
 v-model="qc.icon"
 :items="QC_ICON_OPTIONS"
 :label="t('ssh.quickCommandEditor.icon')"
 variant="outlined"
 density="compact"
 hide-details
 :readonly="qc.isDefault"
 class="qc-edit-field qc-edit-field-icon"
 >
 <template #item="{ props: itemProps, item }">
 <v-list-item v-bind="itemProps">
 <template #prepend>
 <v-icon size="16">{{ item.value }}</v-icon>
 </template>
 </v-list-item>
 </template>
 <template #selection="{ item }">
 <div style="display: flex; align-items: center; gap: 6px;">
 <v-icon size="16">{{ item.value }}</v-icon>
 <span style="font-size: 11px; opacity: 0.7;">{{ item.value }}</span>
 </div>
 </template>
 </v-select>
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
 <button class="cyber-btn-secondary qc-editor-action-btn" @click="onQuickCmdResetDefaults">
 <v-icon size="14">mdi-restore</v-icon>
 {{ t('ssh.quickCommandEditor.resetDefaults') }}
 </button>
 <button class="cyber-btn-secondary qc-editor-action-btn" @click="triggerQblImport">
 <v-icon size="14">mdi-import</v-icon>
 {{ t('ssh.quickCommandEditor.importXshell') }}
 </button>
 <input
 ref="qblFileInput"
 type="file"
 accept=".qbl,.qblx"
 style="display: none"
 @change="onQblFileChange"
 />
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

 <SplitTerminal
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
 @panes-change="paneCount = $event"
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
    <div class="ai-silent-toggle">
      <v-icon size="12" :color="aiSilentMode ? 'var(--accent)' : 'var(--muted)'">mdi-run-fast</v-icon>
      <span class="ai-silent-label">{{ t('ssh.aiSilentMode') }}</span>
      <div class="cyber-segment" role="group" :aria-label="t('ssh.aiSilentMode')" :title="t('ssh.aiSilentModeHint')">
        <button
          :class="{ active: !aiSilentMode }"
          :aria-pressed="!aiSilentMode"
          @click="aiSilentMode = false"
        >
          <v-icon size="11">mdi-console</v-icon>{{ t('ssh.aiSilentSegmentTerminal') }}
        </button>
        <button
          :class="{ active: aiSilentMode }"
          :aria-pressed="aiSilentMode"
          @click="aiSilentMode = true"
        >
          <v-icon size="11">mdi-run-fast</v-icon>{{ t('ssh.aiSilentSegmentSilent') }}
        </button>
      </div>
      <button
        class="ai-guide-btn"
        :title="t('ai.guide.helpButton')"
        :aria-label="t('ai.guide.helpButton')"
        @click="aiGuideVisible = true"
      >
        <v-icon size="13">mdi-help-circle-outline</v-icon>
      </button>
    </div>
    <AiGuideDialog v-model="aiGuideVisible" />
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

    <!-- 危险命令确认弹窗 -->
    <v-dialog :model-value="!!pendingRiskyCommand" max-width="480" transition="cyber-dialog" persistent>
      <div v-if="pendingRiskyCommand" class="cyber-panel" style="padding: 24px;">
        <div class="section-header">
          <span class="section-number" style="color: var(--red);">!</span>
          <h3 style="color: var(--red);">危险命令确认</h3>
        </div>
        <p style="color: var(--text-2); font-size: 12px; margin-bottom: 8px;">
          检测到高风险操作: {{ pendingRiskyCommand.reason }}
        </p>
        <pre style="background: var(--bg-2); padding: 10px; border-radius: 6px; font-size: 11px;
          color: var(--red); max-height: 140px; overflow-y: auto; font-family: 'JetBrains Mono', monospace;
          white-space: pre-wrap; word-break: break-all; border: 1px solid var(--red);">{{ pendingRiskyCommand.command }}</pre>
        <div style="display: flex; gap: 8px; margin-top: 16px; justify-content: flex-end;">
          <button class="cyber-btn-secondary" style="font-size: 12px; padding: 6px 14px;" @click="cancelRiskyCommand">
            取消
          </button>
          <button class="cyber-btn" style="font-size: 12px; padding: 6px 18px; background: var(--red);" @click="confirmRiskyCommand">
            确认执行
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

/* ZMODEM 传输条样式已迁移到 cyber.css(.zmodem-*)全局组件类 */

.terminal-pane > :deep(.ssh-split-container) {
 flex:1;
 min-height:0;
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

.ai-silent-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.ai-silent-label {
  font-size: 11px;
  color: var(--muted);
}

.ai-guide-btn {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border: none;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  border-radius: 4px;
}

.ai-guide-btn:hover {
  color: var(--accent);
  background: var(--bg-3);
}
</style>
