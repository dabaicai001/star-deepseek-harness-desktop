/**
 * dsh session.event 全量流 → 渲染块列表的事件投影(AI 内核替换 P1-3,方案 5.4)。
 *
 * 事件溯源模型:前端不再维护增量消息缓存,每个会话一个 DshSessionProjection,
 * 从 `dsh://session-event` 通知的信封流重建消息列表;`dsh://session-status`
 * 驱动 running 状态(在调用方处理,见 aiHarness.ts subscribeSession)。
 *
 * 事件类型与 payload 以 dsh SessionEventMap 为准(vendor/deepseek-harness
 * packages/core/session/src/types.ts),这里只消费 AiView 渲染所需的子集:
 * - user/message(source.kind === 'user')→ 用户气泡
 * - assistant/chunk(text-delta / reasoning-delta / finish)→ 助手气泡(流式)
 * - assistant/message → 一个 step 的权威定稿(覆盖流式拼装结果)
 * - tool/call + tool/result(callId 配对)→ 工具卡片
 * - todo/write → 待办清单块(全量快照,原位更新)
 * - turn/end{reason} → 收口:completed 静默,error/aborted/interrupted/max-tokens 落块
 *
 * 纯 TS 模块(不依赖 Vue / Tauri),tests/ai-dsh-projection.test.mjs 直接驱动。
 */

/** dsh session.event 通知里的信封(aiHarness.ts DshSessionEventParams.event) */
export interface DshEventEnvelope {
  type?: string
  seq?: number
  time?: number
  data?: Record<string, unknown>
}

export interface DshTodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

export type ProjectionBlock =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string; reasoning: string; streaming: boolean }
  | {
      kind: 'tool'
      id: string
      callId: string
      name: string
      argumentsText: string
      resultText: string
      isError: boolean
      done: boolean
    }
  | { kind: 'todo'; id: string; todos: DshTodoItem[] }
  | { kind: 'notice'; id: string; notice: 'aborted' | 'interrupted' | 'max-tokens' | 'session-reset' }
  | { kind: 'subagent'; id: string; childId: string; running: boolean; ok: boolean; summary: string }
  | { kind: 'error'; id: string; message: string; code: string }

export interface DshTokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

type AssistantBlock = Extract<ProjectionBlock, { kind: 'assistant' }>
type ToolBlock = Extract<ProjectionBlock, { kind: 'tool' }>
type TodoBlock = Extract<ProjectionBlock, { kind: 'todo' }>

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/** 拼 content block 数组里的 text 正文(reasoning 另算) */
function contentText(content: unknown): string {
  return asArray(content)
    .map(asRecord)
    .filter((block) => block?.type === 'text')
    .map((block) => asString(block?.text))
    .join('')
}

export class DshSessionProjection {
  readonly blocks: ProjectionBlock[] = []
  /** 最近一次 usage 上报(assistant/message 或 usage chunk),供用量指示 */
  lastUsage: DshTokenUsage | null = null

  /** assistant 流式槽位:key = turn:step:blockIndex */
  private readonly assistantSlots = new Map<string, AssistantBlock>()
  private readonly toolByCallId = new Map<string, ToolBlock>()
  private todoBlock: TodoBlock | null = null
  private idSeq = 0

  private nextId(prefix: string): string {
    this.idSeq += 1
    return `${prefix}-${this.idSeq}`
  }

  /** 消费一个 session.event 信封,就地更新 blocks(调用方负责触发响应式刷新) */
  applyEvent(envelope: DshEventEnvelope): void {
    const data = envelope.data ?? {}
    switch (envelope.type) {
      case 'user/message':
        this.onUserMessage(data)
        break
      case 'assistant/chunk':
        this.onAssistantChunk(data)
        break
      case 'assistant/message':
        this.onAssistantMessage(data)
        break
      case 'tool/call':
        this.onToolCall(data)
        break
      case 'tool/result':
        this.onToolResult(data)
        break
      case 'todo/write':
        this.onTodoWrite(data)
        break
      case 'turn/end':
        this.onTurnEnd(data)
        break
      default:
        // turn/start、step/*、request/*、session/* 等边界/日志事件不参与渲染
        break
    }
  }

  /** 宿主侧注入通知块(非 session 事件:如 cancel 杀进程后的中断标记、runtime 重启后的会话重置) */
  pushNotice(notice: 'aborted' | 'interrupted' | 'max-tokens' | 'session-reset'): void {
    for (const block of this.assistantSlots.values()) block.streaming = false
    this.blocks.push({ kind: 'notice', id: this.nextId('notice'), notice })
  }

  /**
   * 子代理生命周期通知(dsh://subagent,非 session.event 信封):
   * started 落一张运行中卡片,finished 按 childId 收口并附最后一条助手回复摘要。
   */
  applySubagent(params: {
    kind?: 'started' | 'finished'
    childSessionId?: string
    status?: string
    stopReason?: string
    lastAssistantMessage?: { content?: unknown[] }
  }): void {
    const childId = params.childSessionId ?? ''
    if (!childId) return
    if (params.kind === 'started') {
      this.blocks.push({
        kind: 'subagent',
        id: this.nextId('subagent'),
        childId,
        running: true,
        ok: false,
        summary: '',
      })
      return
    }
    const block = this.blocks.find(
      (item): item is Extract<ProjectionBlock, { kind: 'subagent' }> =>
        item.kind === 'subagent' && item.childId === childId,
    )
    if (!block) return
    block.running = false
    block.ok = params.status === 'ok'
    block.summary = contentText(params.lastAssistantMessage?.content) || asString(params.stopReason)
  }

  private onUserMessage(data: Record<string, unknown>): void {
    const source = asRecord(data.source)
    if (source?.kind !== 'user') return // plugin 注入 / 工具结果不回显为对话气泡
    const text = contentText(data.content)
    if (!text) return
    this.blocks.push({ kind: 'user', id: this.nextId('user'), text })
  }

  private assistantSlot(turn: number, step: number, index: number): AssistantBlock {
    const key = `${turn}:${step}:${index}`
    let block = this.assistantSlots.get(key)
    if (!block) {
      block = { kind: 'assistant', id: this.nextId('assistant'), text: '', reasoning: '', streaming: true }
      this.assistantSlots.set(key, block)
      this.blocks.push(block)
    }
    return block
  }

  private onAssistantChunk(data: Record<string, unknown>): void {
    const turn = asNumber(data.turn)
    const step = asNumber(data.step)
    const chunk = asRecord(data.chunk)
    if (!chunk) return
    switch (chunk.type) {
      case 'text-delta':
        this.assistantSlot(turn, step, asNumber(chunk.index)).text += asString(chunk.text)
        break
      case 'reasoning-delta':
        this.assistantSlot(turn, step, asNumber(chunk.index)).reasoning += asString(chunk.text)
        break
      case 'usage': {
        const usage = asRecord(chunk.usage)
        if (usage) {
          this.lastUsage = {
            inputTokens: asNumber(usage.inputTokens),
            outputTokens: asNumber(usage.outputTokens),
            cacheReadTokens: usage.cacheReadTokens === undefined ? undefined : asNumber(usage.cacheReadTokens),
            cacheWriteTokens: usage.cacheWriteTokens === undefined ? undefined : asNumber(usage.cacheWriteTokens),
            reasoningTokens: usage.reasoningTokens === undefined ? undefined : asNumber(usage.reasoningTokens),
          }
        }
        break
      }
      case 'finish':
        // 一次模型请求结束:该 step 的槽位全部定稿
        for (const [key, block] of this.assistantSlots) {
          if (key.startsWith(`${turn}:${step}:`)) block.streaming = false
        }
        break
      default:
        // block-start / block-end / tool-call-delta:tool/call 与 assistant/message 携带权威数据
        break
    }
  }

  private onAssistantMessage(data: Record<string, unknown>): void {
    const turn = asNumber(data.turn)
    const step = asNumber(data.step)
    const usage = asRecord(data.usage)
    if (usage) {
      this.lastUsage = {
        inputTokens: asNumber(usage.inputTokens),
        outputTokens: asNumber(usage.outputTokens),
        cacheReadTokens: usage.cacheReadTokens === undefined ? undefined : asNumber(usage.cacheReadTokens),
        cacheWriteTokens: usage.cacheWriteTokens === undefined ? undefined : asNumber(usage.cacheWriteTokens),
        reasoningTokens: usage.reasoningTokens === undefined ? undefined : asNumber(usage.reasoningTokens),
      }
    }
    const message = asRecord(data.message)
    const content = asArray(message?.content)
    content.forEach((raw, index) => {
      const block = asRecord(raw)
      if (block?.type !== 'text' && block?.type !== 'reasoning') return
      const slot = this.assistantSlot(turn, step, index)
      if (block.type === 'text') slot.text = asString(block.text)
      else slot.reasoning = asString(block.text)
      slot.streaming = false
    })
  }

  private onToolCall(data: Record<string, unknown>): void {
    const callId = asString(data.callId)
    if (!callId) return
    const existing = this.toolByCallId.get(callId)
    if (existing) {
      existing.name = asString(data.name) || existing.name
      existing.argumentsText = asString(data.arguments) || existing.argumentsText
      return
    }
    const block: ToolBlock = {
      kind: 'tool',
      id: this.nextId('tool'),
      callId,
      name: asString(data.name),
      argumentsText: asString(data.arguments),
      resultText: '',
      isError: false,
      done: false,
    }
    this.toolByCallId.set(callId, block)
    this.blocks.push(block)
  }

  private onToolResult(data: Record<string, unknown>): void {
    const message = asRecord(data.message)
    const resultBlock = asRecord(asArray(message?.content)[0])
    const callId = asString(resultBlock?.toolCallId ?? asRecord(message?.source)?.callId)
    if (!callId) return
    let block = this.toolByCallId.get(callId)
    if (!block) {
      // 结果先于 call 到达(重放/乱序):补一张已完成卡片
      block = {
        kind: 'tool',
        id: this.nextId('tool'),
        callId,
        name: '',
        argumentsText: '',
        resultText: '',
        isError: false,
        done: false,
      }
      this.toolByCallId.set(callId, block)
      this.blocks.push(block)
    }
    block.resultText = contentText(resultBlock?.content)
    block.isError = resultBlock?.isError === true || asRecord(data.error) !== undefined
    block.done = true
  }

  private onTodoWrite(data: Record<string, unknown>): void {
    const todos: DshTodoItem[] = asArray(data.todos)
      .map(asRecord)
      .filter((item): item is Record<string, unknown> => item !== undefined)
      .map((item) => ({
        content: asString(item.content),
        status:
          item.status === 'in_progress' || item.status === 'completed' ? item.status : 'pending',
      }))
    if (this.todoBlock) {
      this.todoBlock.todos = todos
      return
    }
    const block: TodoBlock = { kind: 'todo', id: this.nextId('todo'), todos }
    this.todoBlock = block
    this.blocks.push(block)
  }

  private onTurnEnd(data: Record<string, unknown>): void {
    for (const block of this.assistantSlots.values()) block.streaming = false
    const reason = asRecord(data.reason)
    if (!reason) return
    switch (reason.kind) {
      case 'error': {
        const error = asRecord(reason.error)
        this.blocks.push({
          kind: 'error',
          id: this.nextId('error'),
          message: asString(error?.message) || 'unknown error',
          code: asString(error?.code) || 'UNKNOWN',
        })
        break
      }
      case 'aborted':
        this.blocks.push({ kind: 'notice', id: this.nextId('notice'), notice: 'aborted' })
        break
      case 'interrupted':
        this.blocks.push({ kind: 'notice', id: this.nextId('notice'), notice: 'interrupted' })
        break
      case 'max-tokens':
        this.blocks.push({ kind: 'notice', id: this.nextId('notice'), notice: 'max-tokens' })
        break
      default:
        // completed / blocked:正常收口,静默
        break
    }
  }
}
