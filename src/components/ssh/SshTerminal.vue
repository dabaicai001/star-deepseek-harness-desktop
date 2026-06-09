<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import TerminalPane from './TerminalPane.vue'
import SftpBrowser from './SftpBrowser.vue'
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
   * Tab instance id(由路由 ssh/:id 传入)
   * 同资产多个 tab 会有不同的 instanceId,各自独立 session
   */
  id: string
}>()

/** 从 instanceId 解析出资产 id,再用资产 id 找资产配置 */
const instanceInfo = computed(() => parseInstanceId(props.id))
const asset = computed(() => assetStore.assets.find((a) => a.id === instanceInfo.value.assetId))

const terminalRef = ref<InstanceType<typeof TerminalPane>>()
const connected = ref(false)
const connecting = ref(false)
const lastError = ref<string | null>(null)
const sessionDuration = ref('00:00:00')
let unlisten: (() => void) | null = null
let unlistenClose: (() => void) | null = null
let connectedAt = 0
let timerId: number | null = null
// 防止旧 connect() 的 finally 误关新连接的状态
let currentConnectId = 0

// ====== AI 助手用:收集 SSH 输出 ======
// 每次 SSH 收到数据,都 push 到这里;captureOutput(timeout) 等固定时间后返回这段输出
const dataBuffer = ref<string[]>([])
let captureBaseline = 0  // captureOutput 调用前的 buffer 长度
let captureResolve: ((s: string) => void) | null = null
let captureTimer: number | null = null

// SFTP 分栏宽度(终端:SFTP),默认 65:35,从 localStorage 记忆
const SPLIT_KEY = 'starhub.ssh.split'
const splitPercent = ref<number>(loadSplit())

function loadSplit(): number {
  try {
    const v = localStorage.getItem(SPLIT_KEY)
    if (!v) return 65
    const n = Number(v)
    if (Number.isFinite(n) && n >= 30 && n <= 85) return n
  } catch {}
  return 65
}

function saveSplit(n: number) {
  try { localStorage.setItem(SPLIT_KEY, String(Math.round(n))) } catch {}
}

const isDragging = ref(false)
let dragStartX = 0
let dragStartPercent = 0

function onDividerPointerDown(e: PointerEvent) {
  if (!splitEnabled.value) return
  e.preventDefault()
  isDragging.value = true
  dragStartX = e.clientX
  dragStartPercent = splitPercent.value
  ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
}

function onDividerPointerMove(e: PointerEvent) {
  if (!isDragging.value) return
  const workspace = (e.target as HTMLElement).closest('.workspace') as HTMLElement | null
  if (!workspace) return
  const w = workspace.getBoundingClientRect().width
  if (w <= 0) return
  const deltaPercent = ((e.clientX - dragStartX) / w) * 100
  // dragStartPercent 是 terminal 占的百分比
  const next = Math.min(85, Math.max(30, dragStartPercent + deltaPercent))
  splitPercent.value = next
}

function onDividerPointerUp(e: PointerEvent) {
  if (!isDragging.value) return
  isDragging.value = false
  try { (e.target as HTMLElement).releasePointerCapture(e.pointerId) } catch {}
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
  saveSplit(splitPercent.value)
  // 拖完通知 terminal 重排(xterm cols)
  requestAnimationFrame(() => terminalRef.value?.fit())
}

function resetSplit() {
  splitPercent.value = 65
  saveSplit(65)
  requestAnimationFrame(() => terminalRef.value?.fit())
}

const sftpPercent = computed(() => 100 - splitPercent.value)
const splitEnabled = computed(() => showSftp.value)

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

// ====== 右侧 Panel(仪表盘 / SFTP / AI 切换) ======
const rightActiveTab = ref<string>('dashboard')

const rightPanelTabs = computed(() => [
  { key: 'dashboard', label: '仪表盘', icon: 'mdi-view-dashboard-outline' },
  { key: 'sftp', label: 'SFTP', icon: 'mdi-folder-network-outline' },
  { key: 'ai', label: 'AI 助手', icon: 'mdi-robot-outline' }
])

// 把现有 SFTP 显示开关接进 RightPanel(共用 appStore.rightPanelOpen)
watch(showSftp, (v) => {
  if (!v) appStore.rightPanelOpen = false
})
watch(() => appStore.rightPanelOpen, (v) => {
  if (v && !showSftp.value && rightActiveTab.value === 'sftp') showSftp.value = true
})

// ====== AI 助手(每个 tab 独立) ======
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
  // 删最后一条 assistant + user 对,重发最后一条 user
  const msgs = aiSession.value.messages
  while (msgs.length && msgs[msgs.length - 1].role !== 'user') {
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
  // 唤醒 caller 中的 await confirmFn()
  const resolve = pendingConfirms.value.get(recordId)
  if (resolve) {
    resolve(decision === 'approve' || decision === 'whitelist')
    pendingConfirms.value.delete(recordId)
  }
}

/** 等待用户确认的 tool call 记录 ID → resolve 回调 */
const pendingConfirms = ref<Map<string, (approved: boolean) => void>>(new Map())

async function runSshAgent() {
  if (!aiSession.value) return
  const timeoutSec = aiStore.settings.commandTimeoutSec

  /**
   * 等用户确认(通过 AiChat 弹按钮,emit confirm-tool 事件)
   */
  const confirmFn: import('@/utils/aiTools').ToolConfirmFn = async (ctx) => {
    // 把正在 confirm 的 call 标 awaiting-confirm,记录 id 用于后续 resolve
    // 找到 session 里最近一个 running 的 record,改成 awaiting-confirm
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
    async (ms) => { return await captureOutput(ms || timeoutSec * 1000) },
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
    // 资产已被删除 → 自动回主页,避免卡在空 tab
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
  // 后端按 instanceId(不是 assetId)管 session,这样同资产多 tab 各自独立
  const sessionId = props.id

  // 防御性清理:重连 / 重复调用时,先把旧 listener 解绑,避免双写
  if (unlisten) { unlisten(); unlisten = null }
  if (unlistenClose) { unlistenClose(); unlistenClose = null }
  stopTimer()
  connected.value = false
  connecting.value = true

  lastError.value = null
  terminalRef.value?.writeln('')
  terminalRef.value?.writeln(`\x1b[36m» Connecting to ${a.config.username}@${a.config.host}:${a.config.port || 22}...\x1b[0m`)

  // 标记当前 connect 调用,避免老 timeout 杀掉新连接
  const connectCallId = ++currentConnectId

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

    // Tauri 2 的 invoke 没有内置 timeout,如果 Rust 端 ssh_connect 任何一步 hang
    // (TCP 连不上 / 协议握手卡住 / auth 死循环),前端就永远 await、connecting 一直 true
    // → 客户端加 15s 兜底,超时后主动让后端清理 session,避免后端继续耗资源
    const CONNECT_TIMEOUT_MS = 15_000
    let timeoutHandle: number | null = null
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = window.setTimeout(() => {
        reject(new Error(`Connection timed out after ${CONNECT_TIMEOUT_MS / 1000}s`))
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

    // 上面 race resolve 后,可能是 invoke 成功也可能是 timeout 兜底失败
    // → 如果 connectCallId 已经不是最新的了(用户重连了),本次结果作废
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
      // 收集到 buffer(AI 助手用)
      dataBuffer.value.push(chunk)
      // 唤醒正在等待的 captureOutput
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
    // 通知后端清掉可能半初始化的 session(防止 Rust 端残留)
    try {
      await invoke('ssh_disconnect', { id: sessionId })
    } catch {
      // 静默 — 后端可能本来就没 insert
    }
    notify.notify({
      message: `SSH 连接失败: ${msg}`,
      color: 'error',
      timeout: 5000
    })
  } finally {
    // 只有"自己这一发"才清状态,避免新连接被旧 finally 覆盖
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

// ====== AI 助手用:写命令 + 捕获输出 ======

/**
 * AI 写一条命令到 terminal(用户能看到)
 * 注意:这里发的是用户输入风格(末尾加 \n),相当于按了回车
 */
async function writeCommand(command: string): Promise<void> {
  if (!connected.value) {
    throw new Error('SSH not connected')
  }
  await invoke('ssh_write', { id: props.id, data: command + '\n' })
}

// ====== 快速命令栏(连接后顶部一条小横条) ======
const quickCommands = [
  { label: 'ls', cmd: 'ls -la', icon: 'mdi-format-list-bulleted' },
  { label: 'pwd', cmd: 'pwd', icon: 'mdi-map-marker-outline' },
  { label: 'df', cmd: 'df -h', icon: 'mdi-harddisk' },
  { label: 'top', cmd: 'top -b -n 1 | head -20', icon: 'mdi-chip' },
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
 * 调用时记录当前 buffer 长度,等待 timeoutMs 或 buffer 增长 200ms 内无新数据,
 * 返回 [基线, 现在] 之间的所有数据。
 *
 * 简化策略(MVP):
 *  - 记录 baseline = 当前 buffer.length
 *  - 设一个 timeoutMs 计时器,到点 resolve 并清空计时器
 *  - 如果 baseline 之后又来数据,刷新一个"静默计时器"(200ms 无新数据)提前 resolve
 */
function captureOutput(timeoutMs: number): Promise<string> {
  return new Promise(resolve => {
    if (captureResolve) {
      // 已有 capture 在进行:合并,直接 return 旧的
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
  // 收到新数据 → 重新计时(给"还在输出中"的命令多 200ms 缓冲)
  if (captureTimer) clearTimeout(captureTimer)
  captureTimer = window.setTimeout(() => {
    if (captureResolve) {
      const output = dataBuffer.value.slice(captureBaseline).join('')
      captureResolve(output)
    }
  }, 200)
}

function clearBuffer() {
  dataBuffer.value = []
  captureBaseline = 0
}

defineExpose({
  writeCommand,
  captureOutput,
  clearBuffer,
  isConnected: () => connected.value
})

// ====== 断线 Enter 重连 ======
function handleReconnect() {
  if (connecting.value) return
  connect()
}

// ====== 复制 / 粘贴 反馈(子组件 emit) ======
function handleCopy(text: string) {
  const lines = text.split('\n').length
  const chars = text.length
  notify.notify({
    message: `已复制 ${lines} 行 · ${chars} 字符`,
    color: 'success',
    timeout: 1500
  })
}

function handlePaste(text: string) {
  const chars = text.length
  notify.notify({
    message: `已粘贴 ${chars} 字符`,
    color: 'info',
    timeout: 1500
  })
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

        <button
          class="action-btn"
          :class="{ active: showSftp }"
          :data-tooltip="showSftp ? 'Hide SFTP' : 'Show SFTP'"
          @click="showSftp = !showSftp"
        >
          <v-icon size="14">mdi-folder-network-outline</v-icon>
        </button>

        <span class="divider" />

        <!-- 状态 + 重连/断开(紧挨状态) -->
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

    <div class="workspace" :class="{ dragging: isDragging }">
      <div class="terminal-pane">
        <!-- 快速命令栏:刚连接时给新手指引,常用查看命令一键发 -->
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
        <template #tab-sftp>
          <SftpBrowser :session-id="id" :ready="connected" />
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
  position: relative;
}

.workspace:not(.with-sftp) .terminal-pane {
  flex: 1;
}

.terminal-pane {
  min-width: 0;
  min-height: 0;
  padding: 8px;
  display: flex;
  flex-direction: column;
  transition: flex-basis 0s; /* 拖拽时不带过渡,跟手 */
}

.quick-commands {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 10px;
  background: rgba(0, 240, 255, 0.04);
  border: 1px solid var(--line-2);
  border-radius: 6px;
  margin-bottom: 6px;
  flex-wrap: wrap;
}
.qc-label {
  font-size: 9px;
  font-weight: 700;
  font-family: 'Orbitron', sans-serif;
  color: var(--cyan);
  letter-spacing: 0.12em;
  margin-right: 4px;
  text-shadow: 0 0 6px rgba(0, 240, 255, 0.4);
}
.qc-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  background: rgba(0, 240, 255, 0.05);
  border: 1px solid var(--line-2);
  border-radius: 4px;
  color: var(--text-2);
  font-size: 11px;
  font-family: 'JetBrains Mono', monospace;
  cursor: pointer;
  transition: all 0.15s;
}
.qc-btn:hover:not(:disabled) {
  background: rgba(0, 240, 255, 0.12);
  border-color: rgba(0, 240, 255, 0.4);
  color: var(--cyan);
}
.qc-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.workspace:not(.dragging) .terminal-pane,
.workspace:not(.dragging) .sftp-pane {
  transition: flex-basis 0.15s cubic-bezier(0.4, 0, 0.2, 1);
}

.terminal-pane > :deep(.terminal-container) {
  flex: 1;
}

.sftp-pane {
  min-width: 240px;
  min-height: 0;
  border-left: 1px solid var(--line-2);
  display: flex;
  flex-direction: column;
  background: var(--bg-2);
}

/* 可拖拽分隔条 */
.pane-divider {
  width: 6px;
  flex-shrink: 0;
  cursor: col-resize;
  position: relative;
  background: transparent;
  z-index: 2;
  /* 命中区域加大,方便抓取 */
  margin: 0 -2px;
}

.pane-divider::before {
  content: "";
  position: absolute;
  top: 0;
  bottom: 0;
  left: 50%;
  width: 1px;
  background: var(--line-2);
  transform: translateX(-50%);
  transition: background 0.15s, width 0.15s, box-shadow 0.15s;
}

.pane-divider:hover::before,
.pane-divider.active::before {
  background: var(--cyan);
  width: 2px;
  box-shadow: 0 0 8px rgba(0, 240, 255, 0.45);
}

/* 中间的握把点(3 个竖点) */
.divider-grip {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 2px;
  height: 28px;
  border-radius: 1px;
  background: var(--cyan);
  opacity: 0;
  transition: opacity 0.2s, height 0.2s;
  box-shadow: 0 0 6px rgba(0, 240, 255, 0.4);
}

.pane-divider:hover .divider-grip,
.pane-divider.active .divider-grip {
  opacity: 0.7;
}

.pane-divider.active .divider-grip {
  height: 40px;
  opacity: 1;
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

.reconnect-btn:not([disabled]) {
  color: var(--green);
  border-color: rgba(80, 250, 123, 0.25);
}

.reconnect-btn:not([disabled]):hover {
  background: rgba(80, 250, 123, 0.12);
  border-color: rgba(80, 250, 123, 0.4);
  box-shadow: 0 0 8px rgba(80, 250, 123, 0.2);
}

.disconnect-btn:not([disabled]) {
  color: var(--red);
  border-color: rgba(255, 77, 109, 0.25);
}

.disconnect-btn:not([disabled]):hover {
  background: rgba(255, 77, 109, 0.12);
  border-color: rgba(255, 77, 109, 0.4);
  box-shadow: 0 0 8px rgba(255, 77, 109, 0.2);
}

.disconnect-btn.pulse-danger {
  animation: pulse-red 2s infinite;
}

@keyframes pulse-red {
  0%, 100% { box-shadow: none; }
  50% { box-shadow: 0 0 6px rgba(255, 77, 109, 0.25); }
}

.search-wrap {
  position: relative;
  display: flex;
  align-items: center;
}

.cyber-search-input {
  background: var(--bg-input);
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
