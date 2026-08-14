/**
 * dsh(deepseek-harness)runtime 前端封装(AI 内核替换,P0-4 起)。
 *
 * 对应 Rust 侧 `src-tauri/src/harness/` + `commands/harness.rs`:
 * - `initialize` / `prompt` / `cancel` / `shutdown` 走 invoke;
 * - 流式输出走事件:`dsh://session-event`(session.event 通知,全量事件溯源信封)、
 *   `dsh://session-status`(session.status 通知,running=进行中,idle=一轮结束的权威信号)。
 *
 * 注意(G-3):每个新会话必须用 `newSessionId()` 生成全新 id;runtime 重启
 * (initialize 返回 restarted=true 或 cancel 杀进程后)旧 sessionId 已持久化,
 * 复用会 id collision,必须换新 id 重新开始。
 */
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

/** initialize 选项:模型配置来自 StarHub AI 设置(stores/ai.ts resolveModelConfig) */
export interface DshInitializeOptions {
  /** 会话工作目录(同时注入 DSH_CWD);缺省 '.' */
  cwd?: string
  /** 模型名,缺省 deepseek-v4-flash */
  model?: string
  /** OpenAI 兼容端点,经 DEEPSEEK_BASE_URL env 注入 */
  baseUrl?: string
  /** API key(Keyring 明文,仅经 env 注入子进程,不落盘) */
  apiKey?: string
  maxTokens?: number
  /** Agent 角色提示词,经 DSH_SYSTEM_PROMPT env 注入(persona) */
  systemPrompt?: string
}

/** initialize 响应 */
export interface DshServerInfo {
  /** dsh SDK 的 initialize 结果 */
  serverInfo?: {
    name?: string
    version?: string
    [key: string]: unknown
  }
  /** true = runtime 进程是本次新起的,旧会话上下文已丢失,必须换全新 sessionId */
  restarted?: boolean
}

/** session/prompt 响应 */
export interface DshPromptResult {
  messageId?: string
}

/**
 * session.event 通知 params。event 为完整事件溯源信封
 * `{type, seq, time, data}`,具体事件类型与 payload 见
 * `aiHarnessProjection.ts`(前端只消费,全集以 dsh SessionEventMap 为准)。
 */
export interface DshSessionEventParams {
  sessionId?: string
  event?: {
    type?: string
    seq?: number
    time?: number
    data?: Record<string, unknown>
    [key: string]: unknown
  }
}

/** session.status 通知 params */
export interface DshSessionStatusParams {
  sessionId?: string
  status?: 'running' | 'idle' | string
}

/**
 * subagent.started / subagent.finished 通知 params(Rust 侧已注入 kind 区分)。
 * started:{parentSessionId, childSessionId};
 * finished:另有 status('ok'|'error')/ stopReason / lastAssistantMessage。
 */
export interface DshSubagentParams {
  kind?: 'started' | 'finished'
  parentSessionId?: string
  childSessionId?: string
  status?: 'ok' | 'error' | string
  stopReason?: string
  lastAssistantMessage?: { content?: unknown[] }
}

/** 生成全新 sessionId(G-3:禁止复用已持久化的 id) */
export function newSessionId(): string {
  return `starhub-${crypto.randomUUID()}`
}

/** 启动(或复用)dsh runtime 并完成 initialize 握手 */
export async function initialize(options: DshInitializeOptions = {}): Promise<DshServerInfo> {
  return invoke<DshServerInfo>('dsh_initialize', {
    cwd: options.cwd,
    model: options.model,
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
    maxTokens: options.maxTokens,
    systemPrompt: options.systemPrompt,
  })
}

/** 发送一轮对话,返回 messageId;流式输出经 subscribeSession / promptStream 获取 */
export async function prompt(sessionId: string, text: string): Promise<DshPromptResult> {
  return invoke<DshPromptResult>('dsh_prompt', { sessionId, text })
}

/**
 * 中断所有进行中的回合:SDK 协议无 mid-turn cancel(方案 D1),
 * Rust 侧杀进程兜底;之后 runtime 已不在,下一轮 initialize 会重启。
 */
export async function cancel(): Promise<void> {
  await invoke('dsh_cancel')
}

/** 关闭 runtime;以收到 shutdown 响应为完成信号(G-1,进程退出码被忽略) */
export async function shutdown(): Promise<void> {
  await invoke('dsh_shutdown')
}

/** 订阅 session.event 原始通知,返回取消订阅函数 */
export function onSessionEvent(
  handler: (params: DshSessionEventParams) => void
): Promise<UnlistenFn> {
  return listen<DshSessionEventParams>('dsh://session-event', (event) => handler(event.payload))
}

/** 订阅 session.status 通知(running / idle),返回取消订阅函数 */
export function onSessionStatus(
  handler: (params: DshSessionStatusParams) => void
): Promise<UnlistenFn> {
  return listen<DshSessionStatusParams>('dsh://session-status', (event) => handler(event.payload))
}

// ====== 会话级订阅 hub:单例 Tauri listener,按 sessionId 分发 ======
// prompt 前必须先 await subscribeSession,避免 listen 注册竞态漏接事件。

export interface DshSessionHandlers {
  onEvent?: (params: DshSessionEventParams) => void
  onStatus?: (params: DshSessionStatusParams) => void
  /** 子代理生命周期;按 parentSessionId 路由到父会话 */
  onSubagent?: (params: DshSubagentParams) => void
}

const subscriptions = new Map<string, DshSessionHandlers>()
let hubReady: Promise<unknown> | null = null

function ensureHub(): Promise<unknown> {
  if (!hubReady) {
    hubReady = Promise.all([
      onSessionEvent((params) => {
        if (params.sessionId) subscriptions.get(params.sessionId)?.onEvent?.(params)
      }),
      onSessionStatus((params) => {
        if (params.sessionId) subscriptions.get(params.sessionId)?.onStatus?.(params)
      }),
      listen<DshSubagentParams>('dsh://subagent', (event) => {
        const params = event.payload
        if (params.parentSessionId) subscriptions.get(params.parentSessionId)?.onSubagent?.(params)
      }),
    ])
  }
  return hubReady
}

/**
 * 订阅指定 session 的事件与状态(prompt 前 await)。
 * 返回取消订阅函数;同一 sessionId 重复订阅会覆盖旧 handler。
 */
export async function subscribeSession(
  sessionId: string,
  handlers: DshSessionHandlers
): Promise<() => void> {
  await ensureHub()
  subscriptions.set(sessionId, handlers)
  return () => {
    if (subscriptions.get(sessionId) === handlers) subscriptions.delete(sessionId)
  }
}

export interface DshPromptStreamOptions {
  /** 每个 text-delta 增量回调 */
  onDelta?: (delta: string) => void
  /** 兜底超时(默认 120s);正常结束以 idle 通知为准,不等超时 */
  timeoutMs?: number
}

/**
 * 发送一轮对话并拼好 text-delta 流,直到该 session 回到 idle。
 * 返回完整文本;messageId 经 prompt() 的响应拿到后可另行获取。
 * (一次性问答便捷封装;UI 常驻会话请用 subscribeSession。)
 */
export async function promptStream(
  sessionId: string,
  text: string,
  options: DshPromptStreamOptions = {}
): Promise<string> {
  const { onDelta, timeoutMs = 120_000 } = options
  let fullText = ''
  let idleResolve!: () => void
  let idleReject!: (error: Error) => void
  const idleReceived = new Promise<void>((resolve, reject) => {
    idleResolve = resolve
    idleReject = reject
  })
  const timer = setTimeout(() => idleReject(new Error(`dsh 等待 idle 超时(${timeoutMs}ms)`)), timeoutMs)

  // 先完成两个订阅再发 prompt,避免 idle 通知在 listen 注册前到达而漏接
  const unsubscribe = await subscribeSession(sessionId, {
    onEvent: (params) => {
      const chunk = params.event?.data?.chunk as { type?: string; text?: string } | undefined
      if (params.event?.type === 'assistant/chunk' && chunk?.type === 'text-delta' && chunk.text) {
        fullText += chunk.text
        onDelta?.(chunk.text)
      }
    },
    onStatus: (params) => {
      if (params.status === 'idle') {
        clearTimeout(timer)
        idleResolve()
      }
    },
  })

  try {
    await prompt(sessionId, text)
    await idleReceived
    return fullText
  } finally {
    clearTimeout(timer)
    unsubscribe()
  }
}
