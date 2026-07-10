<script setup lang="ts">
import { ref, computed, onMounted, watch, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { useAssetStore } from '@/stores/asset'
import { useAppStore } from '@/stores/app'
import { useDockerStore } from '@/stores/docker'
import { useAiStore } from '@/stores/ai'
import { useNotifyStore } from '@/stores/notify'
import { useDialogStore } from '@/stores/dialog'
import RightPanel from '@/components/layout/RightPanel.vue'
import ResizableSidebarHandle from '@/components/layout/ResizableSidebarHandle.vue'
import AiChat from '@/components/ai/AiChat.vue'
import DockerDashboard from '@/components/dashboard/DockerDashboard.vue'
import HostKeyConfirmDialog, { type HostKeyInfo } from '@/components/ssh/HostKeyConfirmDialog.vue'
import KbInteractiveDialog from '@/components/ssh/KbInteractiveDialog.vue'
import { parseInstanceId } from '@/utils/tabId'
import { usePersistentPanelState } from '@/utils/panelState'
import { DOCKER_SYSTEM_PROMPT, dockerTools, makeDockerToolCaller } from '@/utils/aiTools'
import * as dockerService from '@/services/docker'
import { assetConfigToSshConfig, type KbInteractiveEvent } from '@/services/ssh'
import type { LlmToolCall } from '@/services/ai'
import type { ContainerInfo, DockerConnectParams } from '@/types/docker'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const assetStore = useAssetStore()
const appStore = useAppStore()
const dockerStore = useDockerStore()
const aiStore = useAiStore()
const rightPanelOpen = usePersistentPanelState('docker', true)
const notify = useNotifyStore()
const dlg = useDialogStore()

// 路由 :id 是 tab instanceId,需要解析出 assetId 找资产配置
const instanceId = computed(() => route.params.id as string)
const assetId = computed(() => parseInstanceId(instanceId.value).assetId)
const asset = computed(() => assetStore.assets.find(a => a.id === assetId.value))

const connected = ref(false)
const connecting = ref(false)
const connectError = ref<string | null>(null)
const activeTab = ref<'containers' | 'images'>('containers')
const selectedTab = ref<'logs' | 'stats'>('logs')
const sidebarCollapsed = ref(false)
const sidebarWidth = ref(260)
const sidebarDragging = ref(false)
const repairingHostKey = ref(false)
const trustSessionId = ref('')
const hostKeyDialogRef = ref<InstanceType<typeof HostKeyConfirmDialog>>()
const kbDialogRef = ref<InstanceType<typeof KbInteractiveDialog>>()
let connectAttemptId = 0
// 路由切换或 view 卸载时,把当前正在跑的连接尝试标为 stale,
// 避免 <transition mode="out-in"> leave 动画 (200ms) 期间
// Docker daemon 立即返回错误 → catch 里误以为"新 view 还在连" → 弹通知。
// 之前叫 viewDisposed,但 watch(assetId) 触发时 view 还没真正销毁,
// 名称易误导,这里改名 connectStale 更准确。
let connectStale = false
const ownedConnIds = new Set<string>()

function markStale() {
  if (connectStale) return
  connectStale = true
  connectAttemptId++
  connected.value = false
  connectError.value = null
  void disconnectOwnedSessions()
}

const dockerSshAsset = computed(() => {
  const sshAssetId = asset.value?.config.dockerSshAssetId
  if (!sshAssetId) return null
  return assetStore.assets.find(item => item.id === sshAssetId && item.type === 'ssh') ?? null
})

const dockerSshHostLabel = computed(() => {
  const sshAsset = dockerSshAsset.value
  if (!sshAsset?.config.host) return ''
  return `${sshAsset.config.host}:${sshAsset.config.port || 22}`
})

const canRepairDockerSshTrust = computed(() =>
  Boolean(dockerSshAsset.value && connectError.value && isSshTrustError(connectError.value))
)

function isSshTrustError(message: string | null | undefined): boolean {
  if (!message) return false
  const lower = message.toLowerCase()
  return lower.includes('host key mismatch')
    || lower.includes('trusted host key')
    || message.includes('主机密钥')
    || message.includes('尚未信任')
}

function normalizeDockerError(message: string): string {
  if (message.toLowerCase().includes('host key mismatch')) {
    return `${message}\n已保存的 SSH 主机密钥与远端当前密钥不一致。可能是服务器重装、IP 复用,也可能是 SSH 库协商到了另一种 Host Key 类型;请重新校验并信任该 SSH 主机密钥后再连接 Docker。`
  }
  if (message.includes('尚未信任') || message.toLowerCase().includes('trusted host key')) {
    return `${message}\nDocker SSH 隧道会严格复用已信任的 SSH 主机密钥。请先完成主机密钥校验。`
  }
  return message
}

function isStaleConnect(attemptId: number): boolean {
  return connectStale || attemptId !== connectAttemptId
}

async function disconnectOwnedSessions() {
  for (const connId of [...ownedConnIds]) {
    await dockerStore.disconnect(connId)
    ownedConnIds.delete(connId)
  }
}

async function repairDockerSshTrust() {
  const sshAsset = dockerSshAsset.value
  if (!sshAsset) return

  repairingHostKey.value = true
  const sessionId = `docker-trust-${Date.now()}`
  trustSessionId.value = sessionId
  let unlistenHostKey: UnlistenFn | null = null
  let unlistenKb: UnlistenFn | null = null

  try {
    unlistenHostKey = await listen<HostKeyInfo>(
      `ssh:hostkey-confirm:${sessionId}`,
      (event) => {
        const dialog = hostKeyDialogRef.value
        if (!dialog) {
          void invoke('ssh_hostkey_response', {
            id: sessionId,
            allowed: false,
            persist: false,
          })
          return
        }
        dialog.open(event.payload).then((result) => {
          void invoke('ssh_hostkey_response', {
            id: sessionId,
            allowed: result !== 'reject',
            // Docker 隧道只能使用持久化的可信 host key;本修复入口中 Allow 也会更新记录。
            persist: result !== 'reject',
          })
        })
      }
    )
    unlistenKb = await listen<KbInteractiveEvent>(
      `ssh:kb-interactive:${sessionId}`,
      (event) => kbDialogRef.value?.open(event.payload)
    )

    const result = await invoke<{ ok: boolean; message?: string; elapsed_ms?: number }>(
      'test_ssh_connection',
      {
        config: assetConfigToSshConfig(sshAsset.config),
        testSessionId: sessionId,
      }
    )
    if (!result.ok) {
      throw new Error(result.message || 'SSH 主机密钥校验失败')
    }

    notify.notify({ title: 'SSH 主机密钥已更新', message: '正在重新连接 Docker...', color: 'success' })
    connectError.value = null
    connected.value = false
    await connect()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    connectError.value = normalizeDockerError(msg)
    notify.notify({ title: 'SSH 主机密钥校验失败', message: msg, color: 'error', timeout: 5000 })
  } finally {
    unlistenHostKey?.()
    unlistenKb?.()
    kbDialogRef.value?.close()
    trustSessionId.value = ''
    repairingHostKey.value = false
  }
}

async function connect() {
  if (!asset.value || connected.value) return
  // 重新开始一轮连接,清除上一次 markStale 的状态
  connectStale = false
  const attemptId = ++connectAttemptId
  connecting.value = true
  connectError.value = null
  try {
    const config = asset.value.config
    const transport = config.dockerTransport || (config.remoteHost ? 'tcp' : 'socket')
    let params: DockerConnectParams
    if (transport === 'ssh') {
      const sshAsset = dockerSshAsset.value
      if (!sshAsset?.config.host || !sshAsset.config.username) {
        throw new Error('所选 SSH 资产不存在或配置不完整')
      }
      const sshPort = sshAsset.config.port || 22
      const knownHostKey = await invoke<string | null>('ssh_get_trusted_host_key', {
        host: sshAsset.config.host,
        port: sshPort,
      })
      if (!knownHostKey) {
        throw new Error(`尚未信任 ${sshAsset.config.host}:${sshPort}，请先打开该 SSH 连接并确认主机密钥`)
      }
      let jumpKnownHostKey: string | undefined
      if (sshAsset.config.jumpHost) {
        jumpKnownHostKey = await invoke<string | null>('ssh_get_trusted_host_key', {
          host: sshAsset.config.jumpHost,
          port: sshAsset.config.jumpPort || 22,
        }) || undefined
        if (!jumpKnownHostKey) {
          throw new Error(`尚未信任跳板机 ${sshAsset.config.jumpHost}:${sshAsset.config.jumpPort || 22}`)
        }
      }
      params = {
        transport: 'ssh',
        socketPath: config.socketPath || '/var/run/docker.sock',
        ssh: {
          host: sshAsset.config.host,
          port: sshPort,
          username: sshAsset.config.username,
          password: sshAsset.config.password,
          privateKey: sshAsset.config.privateKey,
          passphrase: sshAsset.config.passphrase,
          knownHostKey,
          jumpHost: sshAsset.config.jumpHost,
          jumpPort: sshAsset.config.jumpPort,
          jumpUsername: sshAsset.config.jumpUsername,
          jumpPassword: sshAsset.config.jumpPassword,
          jumpPrivateKey: sshAsset.config.jumpPrivateKey,
          jumpPassphrase: sshAsset.config.jumpPassphrase,
          jumpKnownHostKey,
          protocol: config.dockerSshProtocol || 'unix-over-nc-sudo',
        },
      }
    } else if (transport === 'tcp') {
      params = { transport: 'tcp', host: config.remoteHost || 'tcp://127.0.0.1:2375' }
    } else {
      const socketPath = config.socketPath || '/var/run/docker.sock'
      params = {
        transport: 'socket',
        host: socketPath.includes('://') ? socketPath : `unix://${socketPath}`,
      }
    }
    const session = await dockerStore.connect(assetId.value, asset.value.name, params)
    if (isStaleConnect(attemptId)) {
      await dockerStore.disconnect(session.connId)
      return
    }
    ownedConnIds.add(session.connId)
    connected.value = true
    await dockerStore.loadContainers()
    if (isStaleConnect(attemptId)) return
    await dockerStore.loadImages()
  } catch (err) {
    if (isStaleConnect(attemptId)) return
    const msg = normalizeDockerError(err instanceof Error ? err.message : String(err))
    connectError.value = msg
    notify.notify({ title: 'Docker 连接失败', message: msg, color: 'error', timeout: 5000 })
  } finally {
    if (!isStaleConnect(attemptId)) {
      connecting.value = false
    }
  }
}

async function selectContainer(container: ContainerInfo) {
  dockerStore.selectContainer(container.id)
  selectedTab.value = 'logs'
  await dockerStore.loadContainerLogs(container.id, '200')
}

function getStateColor(state: string): string {
  switch (state) {
    case 'running': return 'var(--green)'
    case 'exited': return 'var(--red)'
    case 'paused': return 'var(--yellow)'
    case 'restarting': return 'var(--cyan)'
    default: return 'var(--muted)'
  }
}

function getStateIcon(state: string): string {
  switch (state) {
    case 'running': return 'mdi-play-circle'
    case 'exited': return 'mdi-stop-circle'
    case 'paused': return 'mdi-pause-circle'
    case 'restarting': return 'mdi-refresh'
    default: return 'mdi-help-circle'
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

function formatMemory(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function formatPorts(ports: ContainerInfo['ports']): string {
  return ports
    .filter(p => p.public != null && p.public > 0)
    .map(p => `${p.public}->${p.private}/${p.type}`)
    .join(', ')
}

async function doStart(id: string) {
  await dockerStore.startContainer(id)
}

async function doStop(id: string) {
  if (!(await dlg.confirm({
    title: '停止容器',
    message: '停止容器会中断其中运行的服务,确认继续?',
    confirmText: t('docker.stop'),
    danger: true
  }))) return
  await dockerStore.stopContainer(id)
  notify.notify({ title: 'Docker', message: '容器已停止', color: 'success' })
}

async function doRestart(id: string) {
  if (!(await dlg.confirm({
    title: '重启容器',
    message: '重启容器会造成短暂服务中断,确认继续?',
    confirmText: t('docker.restart'),
    danger: true
  }))) return
  await dockerStore.restartContainer(id)
  notify.notify({ title: 'Docker', message: '容器已重启', color: 'success' })
}

async function doRemove(id: string) {
  if (!(await dlg.confirm({
    title: '删除容器',
    message: '删除容器不可撤销。请输入 REMOVE 确认。',
    confirmText: t('docker.remove'),
    danger: true,
    requireTyping: 'REMOVE'
  }))) return
  await dockerStore.removeContainer(id, true)
  notify.notify({ title: 'Docker', message: '容器已删除', color: 'success' })
}

onMounted(() => {
  connectStale = false
  if (asset.value && asset.value.type === 'docker') {
    connect()
  } else if (!asset.value) {
    // 资产不存在(被删除)→ 关闭对应 tab,workspace 自动落到欢迎页
    if (appStore.activeTab) appStore.removeTab(appStore.activeTab)
    router.push('/')
  }
})

watch(() => assetId.value, () => {
  // 路由变了(切资产 / 关 tab)→ 立即标 stale,不等 leave 动画结束
  markStale()
  if (asset.value && !connected.value) connect()
  else if (!asset.value) {
    if (appStore.activeTab) appStore.removeTab(appStore.activeTab)
    router.push('/')
  }
})

onBeforeUnmount(() => {
  markStale()
  connecting.value = false
})

// ====== 右侧 Panel(仪表盘 / AI 切换) ======
const rightActiveTab = ref('dashboard')
const rightPanelTabs = computed(() => [
  { key: 'dashboard', label: '仪表盘', icon: 'mdi-view-dashboard-outline' },
  { key: 'ai', label: 'AI 助手', icon: 'mdi-robot-outline' }
])

const aiSession = computed(() => {
  if (!asset.value) return null
  return aiStore.getOrCreateSession(instanceId.value, asset.value.id, 'docker')
})

async function executeDockerTool(name: string, args: Record<string, unknown>): Promise<string> {
  const connId = dockerStore.currentConnId
  if (!connId) throw new Error('Docker 未连接')
  if (name === 'docker_list_containers') {
    const showAll = args.all !== 'false'
    const list = await dockerService.listContainers(connId, showAll)
    if (list.length === 0) return '(没有容器)'
    return list.slice(0, 50).map((c: any) =>
      `${(c.id || '').slice(0, 12)} | ${(c.name || '').padEnd(20)} | ${(c.image || '').padEnd(30)} | ${(c.state || '').padEnd(10)} | ${c.ports || ''}`
    ).join('\n') + (list.length > 50 ? `\n… (共 ${list.length} 个)` : '')
  }
  if (name === 'docker_logs') {
    const container = String(args.container ?? '')
    const tail = String(args.tail ?? '200')
    const logs = await dockerService.containerLogs(connId, container, tail)
    if (logs.length === 0) return '(无日志)'
    return logs.map((l: any) => `[${l.stream}] ${l.message}`).join('\n')
  }
  if (name === 'docker_inspect') {
    return `inspect ${args.target} - 后端暂未实现,可以用 docker_list_containers 替代`
  }
  if (name === 'docker_exec' || name === 'docker_exec_confirmed') {
    const container = String(args.container ?? '')
    const command = String(args.command ?? '').trim()
    if (!container || !command) {
      return '[Error] docker_exec 需要 container 和 command 参数'
    }
    const result = await dockerService.dockerExec(
      connId,
      container,
      ['sh', '-c', command],  // shell -c 支持多命令组合(管道、&&、重定向)
      { timeoutSec: 30 }
    )
    const parts: string[] = []
    if (result.stdout) parts.push(result.stdout)
    if (result.stderr) parts.push(`[stderr]\n${result.stderr}`)
    if (parts.length === 0) parts.push('(无输出)')
    if (result.exitCode !== 0) parts.push(`\n[exit ${result.exitCode}]`)
    return parts.join('\n')
  }
  return `[Unknown tool] ${name}`
}

const dockerPendingConfirms = ref<Map<string, (approved: boolean) => void>>(new Map())

async function onAiSend(text: string) {
  if (!aiSession.value) return
  aiSession.value.messages.push({ role: 'user', content: text })

  const confirmFn: import('@/utils/aiTools').ToolConfirmFn = async (ctx) => {
    const session = aiSession.value!
    const running = [...session.toolCalls].reverse().find(t => t.status === 'running' || t.status === 'awaiting-confirm')
    const recordId = running?.id || `pending-${Date.now()}`
    if (running) {
      running.status = 'awaiting-confirm'
      running.result = ctx.message
    } else {
      session.toolCalls.push({
        id: recordId, name: ctx.toolName, args: ctx.args,
        status: 'awaiting-confirm', result: ctx.message, startedAt: Date.now()
      })
    }
    return new Promise<boolean>((resolve) => {
      dockerPendingConfirms.value.set(recordId, resolve)
    })
  }

  const caller = makeDockerToolCaller(
    executeDockerTool,
    () => aiStore.settings.commandWhitelist,
    confirmFn
  )
  const toolExec = async (call: LlmToolCall) =>
    await caller({ function: { name: call.function.name, arguments: call.function.arguments } })
  const sysPrompt = aiStore.buildSystemPrompt(DOCKER_SYSTEM_PROMPT, 'docker')
  await aiStore.runAgent(instanceId.value, dockerTools, toolExec, sysPrompt)
}

async function onAiRetry() {
  if (!aiSession.value) return
  const msgs = aiSession.value.messages
  while (msgs.length && msgs[msgs.length - 1].role !== 'user') msgs.pop()
  if (msgs.length) await onAiSend('')
}

function onAiNewChat() {
  aiStore.resetSession(instanceId.value)
}

function onAiStop() {
  aiStore.stopAgent(instanceId.value)
}

function onAiConfirmTool(recordId: string, decision: 'approve' | 'reject' | 'whitelist') {
  if (!aiSession.value) return
  const rec = aiSession.value.toolCalls.find(t => t.id === recordId)
  if (rec) {
    if (decision === 'whitelist') {
      const cmd = String(rec.args.command ?? '')
      const prefix = cmd.trim().split(/\s+/).slice(0, 2).join(' ') || ''
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
  const resolve = dockerPendingConfirms.value.get(recordId)
  if (resolve) {
    resolve(decision === 'approve' || decision === 'whitelist')
    dockerPendingConfirms.value.delete(recordId)
  }
}
</script>

<template>
  <div class="docker-view-with-panel">
    <div class="docker-view">
    <!-- Sidebar -->
    <div
      class="docker-sidebar"
      :class="{ collapsed: sidebarCollapsed, dragging: sidebarDragging }"
      :style="{
        width: sidebarCollapsed ? '40px' : `${sidebarWidth}px`,
        minWidth: sidebarCollapsed ? '40px' : `${sidebarWidth}px`
      }"
    >
      <div class="sidebar-header">
        <template v-if="!sidebarCollapsed">
          <span class="sidebar-title">Docker</span>
          <button class="action-btn" @click="sidebarCollapsed = true">
            <v-icon size="14">mdi-chevron-left</v-icon>
          </button>
        </template>
        <button v-else class="action-btn expand-btn" @click="sidebarCollapsed = false">
          <v-icon size="14">mdi-chevron-right</v-icon>
        </button>
      </div>

      <template v-if="!sidebarCollapsed">
        <!-- Connection status -->
        <div class="conn-status" :class="{ connected }">
          <span class="status-dot" :class="{ online: connected, connecting }"></span>
          <span class="conn-name">{{ asset?.name || '...' }}</span>
        </div>

        <!-- Container list -->
        <div class="sidebar-section">
          <div class="section-label">
            <v-icon size="12" color="green">mdi-docker</v-icon>
            <span>{{ t('docker.containers') }} ({{ dockerStore.containers.length }})</span>
            <button class="action-btn-sm" @click="dockerStore.loadContainers()" :title="t('sftp.refresh')">
              <v-icon size="10">mdi-refresh</v-icon>
            </button>
          </div>

          <!-- Running -->
          <div v-if="dockerStore.runningContainers.length > 0" class="sub-label">
            <span class="status-dot online" style="width:6px;height:6px"></span>
            Running ({{ dockerStore.runningContainers.length }})
          </div>
          <div
            v-for="c in dockerStore.runningContainers"
            :key="c.id"
            class="container-item"
            :class="{ active: dockerStore.selectedContainerId === c.id }"
            @click="selectContainer(c)"
          >
            <v-icon size="12" :color="getStateColor(c.state)">{{ getStateIcon(c.state) }}</v-icon>
            <span class="item-name">{{ c.name }}</span>
            <span class="item-meta">{{ c.image.split(':').pop() }}</span>
          </div>

          <!-- Stopped -->
          <div v-if="dockerStore.stoppedContainers.length > 0" class="sub-label">
            <span class="status-dot offline" style="width:6px;height:6px"></span>
            Stopped ({{ dockerStore.stoppedContainers.length }})
          </div>
          <div
            v-for="c in dockerStore.stoppedContainers"
            :key="c.id"
            class="container-item"
            :class="{ active: dockerStore.selectedContainerId === c.id }"
            @click="selectContainer(c)"
          >
            <v-icon size="12" :color="getStateColor(c.state)">{{ getStateIcon(c.state) }}</v-icon>
            <span class="item-name">{{ c.name }}</span>
            <span class="item-meta">{{ c.image.split(':').pop() }}</span>
          </div>
        </div>
      </template>
      <ResizableSidebarHandle
        :open="!sidebarCollapsed"
        :width="sidebarWidth"
        :min="200"
        :max="420"
        :default-width="260"
        :collapse-threshold="160"
        aria-label="Resize Docker sidebar"
        @update:open="sidebarCollapsed = !$event"
        @update:width="sidebarWidth = $event"
        @dragging="sidebarDragging = $event"
      />
    </div>

    <!-- Main content -->
    <div class="docker-main">
      <!-- Toolbar -->
      <div class="docker-toolbar">
        <div class="toolbar-tabs">
          <div class="toolbar-tab" :class="{ active: activeTab === 'containers' }" @click="activeTab = 'containers'">
            <v-icon size="14">mdi-docker</v-icon>
            {{ t('docker.containers') }}
          </div>
          <div class="toolbar-tab" :class="{ active: activeTab === 'images' }" @click="activeTab = 'images'">
            <v-icon size="14">mdi-package-variant</v-icon>
            {{ t('docker.images') }}
          </div>
        </div>
        <div class="toolbar-actions">
          <button class="action-btn" @click="dockerStore.loadContainers(); dockerStore.loadImages()" :title="t('sftp.refresh')">
            <v-icon size="14">mdi-refresh</v-icon>
          </button>
          <button
            class="action-btn"
            :class="{ active: rightPanelOpen }"
            title="Toggle Panel"
            @click="rightPanelOpen = !rightPanelOpen"
          >
            <v-icon size="16">mdi-panel-right</v-icon>
          </button>
        </div>
      </div>

      <div v-if="connectError" class="connection-error-card">
        <v-icon size="18">mdi-alert-circle-outline</v-icon>
        <div class="error-copy">
          <strong>Docker 连接失败</strong>
          <span>{{ connectError }}</span>
        </div>
        <div class="error-actions">
          <button
            v-if="canRepairDockerSshTrust"
            class="cyber-btn-secondary"
            :disabled="repairingHostKey || connecting"
            @click="repairDockerSshTrust"
          >
            <v-icon size="14">{{ repairingHostKey ? 'mdi-loading mdi-spin' : 'mdi-shield-refresh-outline' }}</v-icon>
            {{ repairingHostKey ? '校验中' : '校验并更新 SSH 主机密钥' }}
          </button>
          <button class="cyber-btn-secondary" :disabled="connecting || repairingHostKey" @click="connect">
            <v-icon size="14">mdi-refresh</v-icon>
            重试
          </button>
        </div>
      </div>

      <!-- Containers tab -->
      <div v-if="activeTab === 'containers' && !connectError" class="content-area">
        <!-- Container detail panel -->
        <div v-if="dockerStore.selectedContainer" class="detail-panel">
          <div class="detail-header">
            <v-icon size="16" :color="getStateColor(dockerStore.selectedContainer.state)">
              {{ getStateIcon(dockerStore.selectedContainer.state) }}
            </v-icon>
            <span class="detail-name">{{ dockerStore.selectedContainer.name }}</span>
            <span class="detail-image">{{ dockerStore.selectedContainer.image }}</span>
            <span class="detail-status cyber-badge" :style="{ color: getStateColor(dockerStore.selectedContainer.state), borderColor: getStateColor(dockerStore.selectedContainer.state) }">
              {{ dockerStore.selectedContainer.state }}
            </span>

            <div class="detail-actions">
              <button v-if="dockerStore.selectedContainer.state !== 'running'" class="cyber-btn" @click="doStart(dockerStore.selectedContainer!.id)">
                <v-icon size="12">mdi-play</v-icon> {{ t('docker.start') }}
              </button>
              <button v-if="dockerStore.selectedContainer.state === 'running'" class="cyber-btn-secondary" @click="doStop(dockerStore.selectedContainer!.id)">
                <v-icon size="12">mdi-stop</v-icon> {{ t('docker.stop') }}
              </button>
              <button v-if="dockerStore.selectedContainer.state === 'running'" class="cyber-btn-secondary" @click="doRestart(dockerStore.selectedContainer!.id)">
                <v-icon size="12">mdi-restart</v-icon> {{ t('docker.restart') }}
              </button>
              <button class="cyber-btn-danger" @click="doRemove(dockerStore.selectedContainer!.id)">
                <v-icon size="12">mdi-delete</v-icon> {{ t('docker.remove') }}
              </button>
            </div>
          </div>

          <!-- Detail tabs -->
          <div class="detail-tabs">
            <div class="detail-tab" :class="{ active: selectedTab === 'logs' }" @click="selectedTab = 'logs'">
              <v-icon size="12">mdi-text-box</v-icon> {{ t('docker.logs') }}
            </div>
            <div class="detail-tab" :class="{ active: selectedTab === 'stats' }" @click="selectedTab = 'stats'">
              <v-icon size="12">mdi-chart-line</v-icon> Stats
            </div>
          </div>

          <!-- Logs -->
          <div v-if="selectedTab === 'logs'" class="logs-panel">
            <div class="logs-toolbar">
              <button class="action-btn-sm" @click="dockerStore.loadContainerLogs(dockerStore.selectedContainer!.id, '200')">
                <v-icon size="10">mdi-refresh</v-icon> Refresh
              </button>
              <button class="action-btn-sm" @click="dockerStore.loadContainerLogs(dockerStore.selectedContainer!.id, '1000')">
                <v-icon size="10">mdi-arrow-down</v-icon> 1000 lines
              </button>
            </div>
            <div class="logs-content">
              <div
                v-for="(entry, idx) in dockerStore.containerLogs"
                :key="idx"
                class="log-line"
                :class="entry.stream"
              >
                <span class="log-time" v-if="entry.timestamp">{{ entry.timestamp.split('T')[1]?.split('.')[0] || entry.timestamp }}</span>
                <span class="log-stream" v-if="entry.stream === 'stderr'">ERR</span>
                <span class="log-msg">{{ entry.message }}</span>
              </div>
              <div v-if="dockerStore.containerLogs.length === 0" class="logs-empty">
                No logs available
              </div>
            </div>
          </div>

          <!-- Stats -->
          <div v-if="selectedTab === 'stats'" class="stats-panel">
            <div v-if="dockerStore.containerStatsMap.get(dockerStore.selectedContainer!.id)" class="stats-grid">
              <div class="stat-card">
                <div class="stat-label">CPU</div>
                <div class="stat-value">{{ (dockerStore.containerStatsMap.get(dockerStore.selectedContainer!.id)?.cpuPercent || 0).toFixed(1) }}%</div>
                <div class="stat-bar">
                  <div class="stat-bar-fill cpu" :style="{ width: Math.min(100, dockerStore.containerStatsMap.get(dockerStore.selectedContainer!.id)?.cpuPercent || 0) + '%' }"></div>
                </div>
              </div>
              <div class="stat-card">
                <div class="stat-label">Memory</div>
                <div class="stat-value">{{ formatMemory(dockerStore.containerStatsMap.get(dockerStore.selectedContainer!.id)?.memoryUsage || 0) }} / {{ formatMemory(dockerStore.containerStatsMap.get(dockerStore.selectedContainer!.id)?.memoryLimit || 0) }}</div>
                <div class="stat-bar">
                  <div class="stat-bar-fill memory" :style="{ width: Math.min(100, dockerStore.containerStatsMap.get(dockerStore.selectedContainer!.id)?.memoryPercent || 0) + '%' }"></div>
                </div>
              </div>
              <div class="stat-card">
                <div class="stat-label">Network</div>
                <div class="stat-value">
                  ↓ {{ formatSize(dockerStore.containerStatsMap.get(dockerStore.selectedContainer!.id)?.netRx || 0) }}
                  ↑ {{ formatSize(dockerStore.containerStatsMap.get(dockerStore.selectedContainer!.id)?.netTx || 0) }}
                </div>
              </div>
              <div class="stat-card">
                <div class="stat-label">Block I/O</div>
                <div class="stat-value">
                  R {{ formatSize(dockerStore.containerStatsMap.get(dockerStore.selectedContainer!.id)?.blockRead || 0) }}
                  W {{ formatSize(dockerStore.containerStatsMap.get(dockerStore.selectedContainer!.id)?.blockWrite || 0) }}
                </div>
              </div>
              <div class="stat-card">
                <div class="stat-label">PIDs</div>
                <div class="stat-value">{{ dockerStore.containerStatsMap.get(dockerStore.selectedContainer!.id)?.pids || 0 }}</div>
              </div>
            </div>
            <div v-else class="stats-loading">
              <button class="cyber-btn-secondary" @click="dockerStore.loadContainerStats(dockerStore.selectedContainer!.id)">
                <v-icon size="14">mdi-chart-line</v-icon> Load Stats
              </button>
            </div>
          </div>
        </div>

        <!-- Container table (when no container selected) -->
        <div v-else class="container-table-wrap">
          <table class="container-table">
            <thead>
              <tr>
                <th>Status</th>
                <th>Name</th>
                <th>Image</th>
                <th>Ports</th>
                <th>State</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="c in dockerStore.containers" :key="c.id" @click="selectContainer(c)">
                <td>
                  <span class="status-dot" :style="{ background: getStateColor(c.state), boxShadow: c.state === 'running' ? `0 0 6px ${getStateColor(c.state)}` : 'none' }"></span>
                </td>
                <td class="cell-name">{{ c.name }}</td>
                <td class="cell-image">{{ c.image }}</td>
                <td class="cell-ports">{{ formatPorts(c.ports) || '-' }}</td>
                <td>
                  <span class="state-badge" :style="{ color: getStateColor(c.state), borderColor: getStateColor(c.state) }">{{ c.state }}</span>
                </td>
                <td class="cell-actions" @click.stop>
                  <button v-if="c.state !== 'running'" class="action-btn-sm" @click="doStart(c.id)" :title="t('docker.start')">
                    <v-icon size="12" color="green">mdi-play</v-icon>
                  </button>
                  <button v-if="c.state === 'running'" class="action-btn-sm" @click="doStop(c.id)" :title="t('docker.stop')">
                    <v-icon size="12" color="red">mdi-stop</v-icon>
                  </button>
                  <button v-if="c.state === 'running'" class="action-btn-sm" @click="doRestart(c.id)" :title="t('docker.restart')">
                    <v-icon size="12" color="cyan">mdi-restart</v-icon>
                  </button>
                  <button class="action-btn-sm" @click="doRemove(c.id)" :title="t('docker.remove')">
                    <v-icon size="12" color="red">mdi-delete</v-icon>
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
          <div v-if="dockerStore.containers.length === 0 && !dockerStore.isLoading" class="empty-state">
            <v-icon size="48" color="muted">mdi-docker</v-icon>
            <span>No containers found</span>
          </div>
        </div>
      </div>

      <!-- Images tab -->
      <div v-if="activeTab === 'images' && !connectError" class="content-area">
        <div class="container-table-wrap">
          <table class="container-table">
            <thead>
              <tr>
                <th>Repository</th>
                <th>Tag</th>
                <th>ID</th>
                <th>Size</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="img in dockerStore.images" :key="img.id">
                <td class="cell-name">{{ img.tags[0]?.split(':')[0] || '<none>' }}</td>
                <td>{{ img.tags[0]?.split(':')[1] || '<none>' }}</td>
                <td class="cell-mono">{{ img.id }}</td>
                <td>{{ formatSize(img.size) }}</td>
                <td class="cell-actions">
                  <button class="action-btn-sm" @click="dockerStore.images = dockerStore.images.filter(i => i.id !== img.id)" :title="t('docker.remove')">
                    <v-icon size="12" color="red">mdi-delete</v-icon>
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
          <div v-if="dockerStore.images.length === 0 && !dockerStore.isLoading" class="empty-state">
            <v-icon size="48" color="muted">mdi-package-variant</v-icon>
            <span>No images found</span>
          </div>
        </div>
      </div>
    </div>
    </div>

    <RightPanel
      v-model="rightPanelOpen"
      v-model:active-tab="rightActiveTab"
      :tabs="rightPanelTabs"
    >
      <template #tab-dashboard>
        <DockerDashboard
          :conn-id="dockerStore.currentConnId || ''"
          :connected="connected"
        />
      </template>
      <template #tab-ai>
        <AiChat
          v-if="aiSession"
          :session="aiSession"
          :sending="aiSession.loading"
          placeholder="问我关于这个 Docker 主机的任何事,例如'列一下所有容器'"
          @send="onAiSend"
          @retry="onAiRetry"
          @confirm-tool="onAiConfirmTool"
          @new-chat="onAiNewChat"
          @stop="onAiStop"
        />
      </template>
    </RightPanel>
    <HostKeyConfirmDialog ref="hostKeyDialogRef" />
    <KbInteractiveDialog
      ref="kbDialogRef"
      :session-id="trustSessionId"
      :host="dockerSshHostLabel"
    />
  </div>
</template>

<style scoped>
.docker-view-with-panel {
  display: flex;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.docker-view {
  display: flex;
  flex: 1;
  min-width: 0;
  min-height: 0;
  height: 100%;
  overflow: hidden;
}

.docker-sidebar {
  position: relative;
  background: var(--panel);
  border-right: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  transition: width 0.25s, min-width 0.25s;
}

.docker-sidebar.dragging {
  transition: none;
}

.docker-sidebar.collapsed {
  width: 40px;
  min-width: 40px;
}

.sidebar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border-bottom: 1px solid var(--line);
  flex-shrink: 0;
}

.docker-sidebar.collapsed .sidebar-header {
  justify-content: center;
  padding: 10px 0;
}

.expand-btn {
  margin: 0 auto;
}

.sidebar-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
}

.conn-status {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  font-size: 12px;
  color: var(--text-2);
  border-bottom: 1px solid var(--line);
}

.conn-status.connected .status-dot {
  background: var(--green);
  box-shadow: 0 0 6px var(--green);
}

.sidebar-section {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
}

.section-label {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  font-size: 11px;
  font-weight: 600;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.section-label .action-btn-sm {
  margin-left: auto;
}

.sub-label {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px 4px 20px;
  font-size: 10px;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.container-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px 5px 20px;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s;
  border-left: 2px solid transparent;
}

.container-item:hover {
  background: rgba(74, 222, 128, 0.04);
}

.container-item.active {
  background: rgba(74, 222, 128, 0.08);
  border-left-color: var(--green);
}

.item-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  color: var(--text);
}

.item-meta {
  font-size: 9px;
  color: var(--muted);
  font-family: 'JetBrains Mono', monospace;
}

.docker-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
}

.docker-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 12px;
  border-bottom: 1px solid var(--line);
  flex-shrink: 0;
}

.toolbar-tabs {
  display: flex;
  gap: 0;
}

.toolbar-tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 16px;
  font-size: 12px;
  color: var(--muted);
  cursor: pointer;
  border-bottom: 2px solid transparent;
  transition: all 0.2s;
}

.toolbar-tab:hover {
  color: var(--text-2);
}

.toolbar-tab.active {
  color: var(--green);
  border-bottom-color: var(--green);
}

.toolbar-actions {
  display: flex;
  gap: 8px;
}

.connection-error-card {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 12px 16px;
  padding: 14px 16px;
  border: 1px solid var(--status-error-border);
  border-radius: 8px;
  background: var(--status-error-bg);
  color: var(--red);
  flex-shrink: 0;
}

.connection-error-card > .v-icon {
  flex-shrink: 0;
}

.error-copy {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.error-copy strong {
  color: var(--text);
  font-size: 13px;
}

.error-copy span {
  color: var(--text-2);
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.error-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  flex-wrap: wrap;
  flex-shrink: 0;
}

.content-area {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.detail-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}

.detail-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--line);
  flex-shrink: 0;
}

.detail-name {
  font-family: 'JetBrains Mono', monospace;
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
}

.detail-image {
  font-size: 11px;
  color: var(--muted);
  font-family: 'JetBrains Mono', monospace;
}

.detail-status {
  font-size: 10px;
  text-transform: uppercase;
}

.detail-actions {
  margin-left: auto;
  display: flex;
  gap: 6px;
}

.detail-tabs {
  display: flex;
  gap: 0;
  border-bottom: 1px solid var(--line);
  flex-shrink: 0;
}

.detail-tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  font-size: 12px;
  color: var(--muted);
  cursor: pointer;
  border-bottom: 2px solid transparent;
  transition: all 0.2s;
}

.detail-tab:hover {
  color: var(--text-2);
}

.detail-tab.active {
  color: var(--cyan);
  border-bottom-color: var(--cyan);
}

.logs-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}

.logs-toolbar {
  display: flex;
  gap: 8px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--line);
  flex-shrink: 0;
}

.logs-content {
  flex: 1;
  overflow-y: auto;
  padding: 8px 12px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  background: var(--panel-solid-2);
}

.log-line {
  display: flex;
  gap: 8px;
  padding: 1px 0;
  line-height: 1.5;
}

.log-line.stderr {
  color: var(--red);
}

.log-time {
  color: var(--muted);
  flex-shrink: 0;
  font-size: 10px;
}

.log-stream {
  color: var(--red);
  font-weight: 600;
  flex-shrink: 0;
  font-size: 9px;
  padding: 0 4px;
  border-radius: 2px;
  background: rgba(255, 77, 109, 0.1);
}

.log-msg {
  word-break: break-all;
  white-space: pre-wrap;
}

.logs-empty {
  color: var(--muted);
  text-align: center;
  padding: 40px;
}

.stats-panel {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
}

.stats-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 12px;
}

.stat-card {
  background: var(--panel-solid-2);
  border: 1px solid var(--line-2);
  border-radius: 10px;
  padding: 14px;
}

.stat-label {
  font-size: 11px;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-bottom: 6px;
}

.stat-value {
  font-family: 'JetBrains Mono', monospace;
  font-size: 16px;
  font-weight: 600;
  color: var(--text);
  margin-bottom: 8px;
}

.stat-bar {
  height: 4px;
  background: rgba(120, 160, 255, 0.1);
  border-radius: 2px;
  overflow: hidden;
}

.stat-bar-fill {
  height: 100%;
  border-radius: 2px;
  transition: width 0.3s;
}

.stat-bar-fill.cpu {
  background: var(--cyan);
}

.stat-bar-fill.memory {
  background: var(--purple);
}

.stats-loading {
  display: flex;
  justify-content: center;
  padding: 40px;
}

.container-table-wrap {
  flex: 1;
  overflow: auto;
}

.container-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.container-table th {
  background: var(--panel-solid-2);
  border-bottom: 1px solid var(--line-2);
  padding: 8px 12px;
  text-align: left;
  font-weight: 600;
  color: var(--text-2);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  position: sticky;
  top: 0;
  z-index: 1;
}

.container-table td {
  padding: 8px 12px;
  border-bottom: 1px solid var(--line);
  color: var(--text);
}

.container-table tr {
  cursor: pointer;
  transition: background 0.15s;
}

.container-table tr:hover td {
  background: rgba(74, 222, 128, 0.04);
}

.cell-name {
  font-family: 'JetBrains Mono', monospace;
  font-weight: 600;
  color: var(--text);
}

.cell-image {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  color: var(--text-2);
}

.cell-ports {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  color: var(--cyan);
}

.cell-mono {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
}

.cell-actions {
  display: flex;
  gap: 4px;
}

.state-badge {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 10px;
  font-weight: 600;
  border: 1px solid;
  text-transform: uppercase;
}

.cyber-badge {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 600;
  background: rgba(0, 240, 255, 0.08);
  color: var(--cyan);
  border: 1px solid rgba(0, 240, 255, 0.2);
  font-family: 'JetBrains Mono', monospace;
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 60px;
  color: var(--muted);
  font-size: 13px;
}

.cyber-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 5px 10px;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 500;
  font-family: inherit;
  color: #050810;
  background: var(--grad-primary);
  border: none;
  cursor: pointer;
  transition: all 0.25s;
}

.cyber-btn:hover {
  box-shadow: 0 0 12px rgba(0, 240, 255, 0.3);
}

.cyber-btn-secondary {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 5px 10px;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 500;
  font-family: inherit;
  color: var(--text-2);
  background: transparent;
  border: 1px solid var(--line-2);
  cursor: pointer;
  transition: all 0.25s;
}

.cyber-btn-secondary:hover {
  border-color: var(--cyan);
  color: var(--cyan);
}

.cyber-btn-danger {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 5px 10px;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 500;
  font-family: inherit;
  color: var(--red);
  background: transparent;
  border: 1px solid rgba(255, 77, 109, 0.2);
  cursor: pointer;
  transition: all 0.25s;
}

.cyber-btn-danger:hover {
  background: rgba(255, 77, 109, 0.08);
  border-color: var(--red);
}

.action-btn {
  width: 28px;
  height: 28px;
  border-radius: 6px;
  border: 1px solid var(--line-2);
  background: transparent;
  color: var(--text-2);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s;
}

.action-btn:hover {
  border-color: var(--green);
  color: var(--green);
}

.action-btn-sm {
  width: 22px;
  height: 22px;
  border-radius: 4px;
  border: 1px solid var(--line-2);
  background: transparent;
  color: var(--text-2);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s;
  font-size: 10px;
}

.action-btn-sm:hover {
  border-color: var(--green);
  color: var(--green);
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
  background: var(--muted);
}

.status-dot.online {
  background: var(--green);
  box-shadow: 0 0 8px var(--green);
  animation: pulse 2s infinite;
}

.status-dot.connecting {
  background: var(--cyan);
  animation: pulse 1s infinite;
}

:deep(.mdi-spin) {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}
</style>
