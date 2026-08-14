/**
 * dsh(deepseek-harness)runtime 前端薄封装(AI 内核替换 P0-4)。
 *
 * 对应 Rust 侧 `src-tauri/src/harness/` + `commands/harness.rs`:
 * - `initialize` / `prompt` / `shutdown` 走 invoke;
 * - 流式输出走事件:`dsh://session-event`(session.event 通知)、
 *   `dsh://session-status`(session.status 通知,running=进行中,idle=一轮结束的权威信号)。
 *
 * 注意(G-3):sessionId 每轮必须用全新 id,复用已持久化的 id 会 id collision。
 * UI 接入是后续 P1-3 的事,这里只提供服务层能力。
 */
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

/** initialize 响应(rust 侧透传 serverInfo) */
export interface DshServerInfo {
  serverInfo?: {
    name?: string
    version?: string
  }
}

/** session/prompt 响应 */
export interface DshPromptResult {
  messageId?: string
}

/** session.event 通知 params(结构以 dsh SDK 为准,这里只取流式所需字段) */
export interface DshSessionEventParams {
  sessionId?: string
  event?: {
    type?: string
    seq?: number
    time?: number
    data?: {
      chunk?: {
        type?: string
        text?: string
        [key: string]: unknown
      }
      [key: string]: unknown
    }
    [key: string]: unknown
  }
}

/** session.status 通知 params */
export interface DshSessionStatusParams {
  sessionId?: string
  status?: 'running' | 'idle' | string
}

/** 启动(或复用)dsh runtime 并完成 initialize 握手 */
export async function initialize(cwd?: string): Promise<DshServerInfo> {
  return invoke<DshServerInfo>('dsh_initialize', { cwd })
}

/** 发送一轮对话,返回 messageId;流式输出经 onSessionEvent / promptStream 获取 */
export async function prompt(sessionId: string, text: string): Promise<DshPromptResult> {
  return invoke<DshPromptResult>('dsh_prompt', { sessionId, text })
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

export interface DshPromptStreamOptions {
  /** 每个 text-delta 增量回调 */
  onDelta?: (delta: string) => void
  /** 兜底超时(默认 120s);正常结束以 idle 通知为准,不等超时 */
  timeoutMs?: number
}

/**
 * 发送一轮对话并拼好 text-delta 流,直到该 session 回到 idle。
 * 返回完整文本;messageId 经 prompt() 的响应拿到后可另行获取。
 */
export async function promptStream(
  sessionId: string,
  text: string,
  options: DshPromptStreamOptions = {}
): Promise<string> {
  const { onDelta, timeoutMs = 120_000 } = options
  let fullText = ''

  const unlistenEvent = await onSessionEvent((params) => {
    if (params.sessionId !== sessionId) return
    const chunk = params.event?.data?.chunk
    if (params.event?.type === 'assistant/chunk' && chunk?.type === 'text-delta' && chunk.text) {
      fullText += chunk.text
      onDelta?.(chunk.text)
    }
  })

  let unlistenStatus: UnlistenFn | undefined
  const idleReceived = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`dsh 等待 idle 超时(${timeoutMs}ms)`)), timeoutMs)
    onSessionStatus((params) => {
      if (params.sessionId === sessionId && params.status === 'idle') {
        clearTimeout(timer)
        resolve()
      }
    })
      .then((unlisten) => {
        unlistenStatus = unlisten
      })
      .catch(reject)
  })

  try {
    await prompt(sessionId, text)
    await idleReceived
    return fullText
  } finally {
    unlistenEvent()
    unlistenStatus?.()
  }
}
