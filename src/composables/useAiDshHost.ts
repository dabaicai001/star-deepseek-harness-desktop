/**
 * dsh 宿主编排 composable(AI 内核迁移 P1-5,替代 useAiChatHost)。
 *
 * 职责:把 dsh runtime 的会话生命周期(initialize → bindSession → subscribeSession →
 * prompt)、事件投影、审批/工具执行桥、会话存档收敛成一个可复用的宿主接口,
 * 供 SshTerminal / DbView / RedisView / ElasticsearchView / DockerView / ExcelView 使用。
 *
 * 与旧 useAiChatHost 的差异:
 * - 消息本体不再进 Pinia,由 DshSessionProjection 事件投影承载;
 * - 工具确认走 `dsh://approval` 门(宿主 dock 拒绝/批准),不再有「加入白名单」;
 * - 域工具执行走 `dsh://tool-exec` → createHostToolExecutor;
 * - @/# mention、会话级模型切换、手动压缩不迁移(dsh 内核接管压缩,模型走全局设置)。
 */
import { onBeforeUnmount, ref, shallowRef, toValue, type MaybeRefOrGetter } from 'vue'
import type { UnlistenFn } from '@tauri-apps/api/event'
import { useAiStore, type AiAssetType } from '@/stores/ai'
import {
  aiConvUpsert,
  aiMemoryCards,
  aiMsgSync,
  type AiMessageInput
} from '@/services/aiMemory'
import {
  bindSession,
  cancel as dshCancel,
  initialize,
  newSessionId,
  onApproval,
  onToolExec,
  prompt as dshPrompt,
  replyApproval,
  replyToolExec,
  subscribeSession,
  type DshApprovalParams,
  type DshSessionEventParams,
  type DshSessionStatusParams,
  type DshSubagentParams,
  type DshToolExecParams
} from '@/services/aiHarness'
import {
  DshSessionProjection,
  type DshTokenUsage,
  type ProjectionBlock
} from '@/services/aiHarnessProjection'
import {
  createHostToolExecutor,
  type HostKeyInfo,
  type HostToolExecutor
} from '@/services/dshToolExecutor'

/** 宿主确认 dock 的条目:dsh 审批请求或 AI 直连 SSH 的主机指纹确认 */
export type DshPendingApproval =
  | {
      kind: 'approval'
      requestId: string
      toolName: string
      reason: string
      /** 从投影的 tool 块按 callId 反查的 arguments 文本 */
      argumentsText: string
    }
  | {
      kind: 'hostkey'
      requestId: string
      toolName: string
      reason: string
      argumentsText: string
    }

/** useAiDshHost 选项 */
export interface UseAiDshHostOptions {
  /** 宿主域:ssh / db / redis / elasticsearch / docker / excel */
  assetType: string
  /** 绑定的资产 id(可为空:未绑定资产时 send 报错) */
  assetId: MaybeRefOrGetter<string | null>
  /** 每次初始化会话时求值的宿主基础 system prompt(可含 cwd、当前库等动态上下文) */
  makeSystemPrompt: () => string
  /** Excel 域:操作当前工作簿的执行器 */
  excelExecute?: (name: string, args: Record<string, unknown>) => Promise<string>
  /** SSH 终端域:把 ssh_exec 系列路由到终端自身执行通道(可见 PTY / 静默通道),保留 cwd 等终端语义 */
  sshExecOverride?: (command: string, timeoutSec: number) => Promise<string>
  /** 是否接域工具执行(默认 true;false 时 tool-exec 一律应答错误) */
  enableTools?: boolean
  /** send 前的宿主钩子(如审计、动态上下文抓取) */
  beforeSend?: (text: string) => Promise<void> | void
  /** 审批门决策后的宿主钩子(如审计) */
  onApprovalResolved?: (toolName: string, approved: boolean) => void
  /** stop / new-chat 时的宿主清理(如中断终端里仍在执行的 AI 命令) */
  onInterrupt?: (trigger: 'stop' | 'new-chat') => void
}

/** 记忆卡注入块格式(与 aiStore.loadMemoryBlock 的 Hermes 格式一致) */
function formatMemoryCard(title: string, scope: string, card?: { char_count: number; char_limit: number; content: string }): string {
  const limit = card?.char_limit ?? (scope === 'global' ? 2200 : 1375)
  const used = card?.char_count ?? 0
  const usage = `${Math.round((used / limit) * 100)}% — ${used}/${limit} chars`
  return `[${title}] [${usage}]\n${card && card.content ? card.content : '(空)'}`
}

/** 把三级记忆卡(user / global / asset:{id})拼成 system prompt 注入块 */
async function loadMemoryBlock(assetId: string): Promise<string> {
  try {
    const cards = await aiMemoryCards(['user', 'global', `asset:${assetId}`])
    const cardMap = new Map(cards.map(card => [card.scope, card]))
    const sections = [
      formatMemoryCard('USER PROFILE — 用户画像', 'user', cardMap.get('user')),
      formatMemoryCard('GLOBAL — 环境与经验', 'global', cardMap.get('global')),
      formatMemoryCard(`ASSET — 当前资产(${assetId})`, `asset:${assetId}`, cardMap.get(`asset:${assetId}`))
    ]
    return [
      '══════════════════════════════════════════════',
      'MEMORY — 长期记忆(以下是你跨会话记住的事实,用 memory 工具维护)',
      '══════════════════════════════════════════════',
      sections.join('\n\n')
    ].join('\n')
  } catch (error) {
    console.warn('[ai-dsh] 加载记忆卡失败:', error)
    return ''
  }
}

/** 投影块 → ai_msg_sync 落库行(storeToolOutputs=false 只存 user/assistant 文本) */
function buildArchiveRows(blocks: readonly ProjectionBlock[], storeToolOutputs: boolean): AiMessageInput[] {
  const createdAt = Math.floor(Date.now() / 1000)
  if (!storeToolOutputs) {
    return blocks
      .filter((block): block is Extract<ProjectionBlock, { kind: 'user' | 'assistant' }> =>
        block.kind === 'user' || block.kind === 'assistant')
      .filter(block => block.text.trim().length > 0)
      .map(block => ({ role: block.kind, content: block.text, created_at: createdAt }))
  }
  const rows: AiMessageInput[] = []
  for (const block of blocks) {
    if (block.kind === 'user' && block.text.trim()) {
      rows.push({ role: 'user', content: block.text, created_at: createdAt })
    } else if (block.kind === 'assistant' && block.text.trim()) {
      rows.push({ role: 'assistant', content: block.text, created_at: createdAt })
    } else if (block.kind === 'tool') {
      const content = [block.name, block.argumentsText, block.resultText].filter(Boolean).join('\n\n')
      if (content) rows.push({ role: 'tool', content, created_at: createdAt })
    }
  }
  return rows
}

/** 存档标题:首条 user 块截 80 字符 */
function buildArchiveTitle(blocks: readonly ProjectionBlock[]): string {
  const firstUser = blocks.find(block => block.kind === 'user')
  const text = firstUser && firstUser.kind === 'user' ? firstUser.text.trim().replace(/\s+/g, ' ') : ''
  if (!text) return '新会话'
  return text.length > 80 ? `${text.slice(0, 80)}…` : text
}

/** 会话级记忆注入与技能组装:buildSystemPrompt(基础 + 启用技能)+ 记忆块 */
async function buildSystemPrompt(assetType: string, assetId: string, base: string): Promise<string> {
  const aiStore = useAiStore()
  // redis / elasticsearch 宿主按 db 域取技能(与旧 useAiChatHost 的 assetType 映射一致)
  const skillType: AiAssetType = assetType === 'redis' || assetType === 'elasticsearch' ? 'db' : assetType as AiAssetType
  const withSkills = aiStore.buildSystemPrompt(base, skillType)
  if (aiStore.settings.memoryEnabled === false) return withSkills
  const memoryBlock = await loadMemoryBlock(assetId)
  return memoryBlock ? `${withSkills}\n\n${memoryBlock}` : withSkills
}

/**
 * 创建 dsh 宿主编排实例。
 * @param options - 宿主差异点(域、资产、系统提示、Excel 执行器)。
 * @returns 状态(投影块 / 发送中 / 待确认 / 用量 / 错误)与操作(send / stop / newChat / resolveApproval)。
 */
export function useAiDshHost(options: UseAiDshHostOptions) {
  const aiStore = useAiStore()
  const toolsEnabled = options.enableTools ?? true

  // ====== 会话与投影 ======
  const sessionId = ref<string>(newSessionId())
  let projection = new DshSessionProjection()
  const blocks = shallowRef<readonly ProjectionBlock[]>([])
  const lastUsage = ref<DshTokenUsage | null>(null)
  const sending = ref(false)
  const sendError = ref<string | null>(null)
  const pendingApproval = ref<DshPendingApproval | null>(null)

  /** child → parent 映射:子会话的 approval/tool-exec 由父会话所在面板接管 */
  const childToParent = new Map<string, string>()

  let unsubscribeSession: (() => void) | null = null
  let unlistenApproval: UnlistenFn | null = null
  let unlistenToolExec: UnlistenFn | null = null
  let boundSession = false
  let disposed = false

  /** 挂起中的 hostkey 确认 resolver(与 pendingApproval.kind === 'hostkey' 配对) */
  const hostkeyResolvers: Array<(approved: boolean) => void> = []

  // ====== 域执行器(惰性创建,assetId 变化时重建) ======
  let executor: HostToolExecutor | null = null
  let executorAssetId: string | null = null

  function ensureExecutor(assetId: string): HostToolExecutor | null {
    if (!toolsEnabled) return null
    if (executor && executorAssetId === assetId) return executor
    void executor?.dispose()
    executorAssetId = assetId
    executor = createHostToolExecutor({
      assetType: options.assetType,
      assetId,
      excelExecute: options.excelExecute,
      sshExecOverride: options.sshExecOverride,
      confirmHostKey
    })
    return executor
  }

  /** hostkey 确认桥:桥到宿主确认 dock(v1 沿用 aiWorkspace 的「确认后信任并持久化」语义) */
  function confirmHostKey(info: HostKeyInfo): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      hostkeyResolvers.push(resolve)
      pendingApproval.value = {
        kind: 'hostkey',
        requestId: `hostkey:${info.hostname}:${info.port}`,
        toolName: 'ssh_host_key',
        reason: `首次连接 ${info.hostname}:${info.port},请核对主机指纹后确认。`,
        argumentsText: `类型: ${info.keyType}\nSHA256: ${info.sha256}`
      }
    })
  }

  function isMySession(sid?: string): boolean {
    if (!sid) return false
    return sid === sessionId.value || childToParent.has(sid)
  }

  /** 按 callId 从投影 tool 块反查 arguments 文本(供审批卡展示) */
  function findToolArguments(callId?: string): string {
    if (!callId) return ''
    for (const block of projection.blocks) {
      if (block.kind === 'tool' && block.callId === callId) return block.argumentsText
    }
    return ''
  }

  // ====== dsh 事件处理 ======
  function onDshEvent(params: DshSessionEventParams) {
    if (!params.event || disposed) return
    projection.applyEvent(params.event)
    blocks.value = projection.blocks.slice()
    if (projection.lastUsage) lastUsage.value = projection.lastUsage
  }

  function onDshStatus(params: DshSessionStatusParams) {
    if (disposed) return
    sending.value = params.status === 'running'
    if (params.status === 'idle' && params.sessionId === sessionId.value) {
      // 每轮 idle 后把投影块快照进 SQLite 存档
      void archiveSession()
    }
  }

  function onDshSubagent(params: DshSubagentParams) {
    if (disposed) return
    projection.applySubagent(params)
    blocks.value = projection.blocks.slice()
    if (params.childSessionId) {
      // 保留映射:子会话 finished 后仍可能有迟到的 approval/tool-exec
      childToParent.set(params.childSessionId, sessionId.value)
    }
  }

  // ====== 审批桥(dsh://approval) ======
  function onDshApproval(params: DshApprovalParams) {
    if (disposed || !params.requestId) return
    if (!isMySession(params.sessionId)) return
    pendingApproval.value = {
      kind: 'approval',
      requestId: params.requestId,
      toolName: params.toolName ?? '',
      reason: params.reason ?? '',
      argumentsText: findToolArguments(params.callId)
    }
  }

  // ====== 工具执行桥(dsh://tool-exec) ======
  async function onDshToolExec(params: DshToolExecParams) {
    if (disposed || !params.requestId || !params.sessionId) return
    if (!isMySession(params.sessionId)) return
    const assetId = toValue(options.assetId)
    const tool = ensureExecutor(assetId ?? '')
    if (!tool) {
      await replyToolExec(params.requestId, false, '当前面板未启用工具执行')
      return
    }
    try {
      const text = await tool.execute(params.name ?? '', params.args ?? {})
      await replyToolExec(params.requestId, true, text)
    } catch (error) {
      await replyToolExec(params.requestId, false, error instanceof Error ? error.message : String(error))
    }
  }

  // ====== 会话订阅(prompt 前必须完成) ======
  let subscribedId: string | null = null

  async function subscribe(id: string) {
    if (subscribedId === id) return
    unsubscribeSession?.()
    subscribedId = id
    unsubscribeSession = await subscribeSession(id, {
      onEvent: onDshEvent,
      onStatus: onDshStatus,
      onSubagent: onDshSubagent
    })
  }

  // ====== 会话存档 ======
  async function archiveSession() {
    const current = projection.blocks
    const rows = buildArchiveRows(current, aiStore.settings.memoryStoreToolOutputs)
    if (rows.length === 0) return
    const assetId = toValue(options.assetId)
    try {
      await aiConvUpsert({
        id: sessionId.value,
        assetId: assetId ?? null,
        assetType: options.assetType,
        title: buildArchiveTitle(current)
      })
      await aiMsgSync(sessionId.value, rows)
    } catch (error) {
      console.warn('[ai-dsh] 会话存档失败:', error)
    }
  }

  // ====== 对外操作 ======

  /** 发送一轮对话(首次 send 完成 initialize → bindSession → subscribeSession → prompt) */
  async function send(text: string) {
    const trimmed = text.trim()
    if (!trimmed || sending.value) return
    const assetId = toValue(options.assetId)
    if (!assetId) {
      sendError.value = '当前未绑定资产,无法使用 AI 助手'
      return
    }
    sendError.value = null
    sending.value = true
    try {
      await options.beforeSend?.(trimmed)
      const config = await aiStore.resolveModelConfig()
      const systemPrompt = await buildSystemPrompt(options.assetType, assetId, options.makeSystemPrompt())
      const info = await initialize({
        model: config.model,
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        maxTokens: config.maxTokens,
        systemPrompt
      })
      // G-3:runtime 重启(restarted=true)后旧 sessionId 已持久化,必须换全新 id
      if (info.restarted && projection.blocks.length > 0) {
        projection.pushNotice('session-reset')
        blocks.value = projection.blocks.slice()
        sessionId.value = newSessionId()
        boundSession = false
        childToParent.clear()
      }
      await subscribe(sessionId.value)
      if (!boundSession) {
        await bindSession(sessionId.value, options.assetType, assetId)
        boundSession = true
      }
      await dshPrompt(sessionId.value, trimmed)
    } catch (error) {
      sending.value = false
      sendError.value = error instanceof Error ? error.message : String(error)
    }
  }

  /** 释放域执行器(关闭 ssh/db/docker 连接),在途命令随连接断开中止 */
  function disposeExecutor() {
    void executor?.dispose()
    executor = null
    executorAssetId = null
  }

  /** 停止 = 杀 dsh 进程兜底;下一轮 send 的 initialize 会重启 runtime 并换全新 sessionId */
  async function stop() {
    if (!sending.value) return
    sending.value = false
    options.onInterrupt?.('stop')
    // 断开域执行器连接,中止仍在执行的 SSH/SFTP/DB 命令
    disposeExecutor()
    try {
      await dshCancel()
    } catch (error) {
      console.warn('[ai-dsh] cancel 失败(进程可能已退出):', error)
    }
    projection.pushNotice('interrupted')
    blocks.value = projection.blocks.slice()
  }

  /** 新会话:换全新 sessionId、清投影;runtime 未杀则复用,下次 send 重新 bind */
  async function newChat() {
    options.onInterrupt?.('new-chat')
    if (sending.value) await stop()
    disposeExecutor()
    projection = new DshSessionProjection()
    blocks.value = []
    sessionId.value = newSessionId()
    childToParent.clear()
    pendingApproval.value = null
    hostkeyResolvers.length = 0
    lastUsage.value = null
    sendError.value = null
    boundSession = false
    await subscribe(sessionId.value)
  }

  /** 用户对确认 dock 的决策:approval 走 dsh_approval_reply,hostkey 走本地 resolver */
  async function resolveApproval(approved: boolean) {
    const pending = pendingApproval.value
    if (!pending) return
    pendingApproval.value = null
    if (pending.kind === 'hostkey') {
      const resolve = hostkeyResolvers.shift()
      resolve?.(approved)
      return
    }
    options.onApprovalResolved?.(pending.toolName, approved)
    try {
      await replyApproval(pending.requestId, approved)
    } catch (error) {
      console.warn('[ai-dsh] approval 应答失败:', error)
    }
  }

  // ====== 挂载/卸载 ======
  // 纯浏览器预览(无 Tauri IPC)下不接线;事件桥与订阅都依赖 Tauri 事件通道
  const isDesktop = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
  if (isDesktop) {
    void (async () => {
      unlistenApproval = await onApproval(onDshApproval)
      unlistenToolExec = await onToolExec(onDshToolExec)
      await subscribe(sessionId.value)
    })()
  }

  onBeforeUnmount(() => {
    disposed = true
    unsubscribeSession?.()
    unsubscribeSession = null
    unlistenApproval?.()
    unlistenApproval = null
    unlistenToolExec?.()
    unlistenToolExec = null
    disposeExecutor()
    // 未决确认一律按拒绝收口,避免悬挂 promise
    for (const resolve of hostkeyResolvers) resolve(false)
    hostkeyResolvers.length = 0
  })

  return {
    sessionId,
    blocks,
    sending,
    sendError,
    pendingApproval,
    lastUsage,
    send,
    stop,
    newChat,
    resolveApproval
  }
}
