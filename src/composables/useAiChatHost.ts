import { computed, nextTick, onBeforeUnmount, ref, toValue, type ComputedRef, type MaybeRefOrGetter } from 'vue'
import { useAiStore, type AiAssetType, type AiSession, type AiToolCallRecord } from '@/stores/ai'
import { useAssetStore } from '@/stores/asset'
import {
  sessionSearchTools,
  sessionSearchToolCaller,
  memoryTools,
  makeMemoryToolCaller,
  skillSaveTools,
  makeSkillSaveToolCaller,
  type ToolConfirmFn
} from '@/utils/aiTools'
import {
  assetMentionToken,
  assetSummary,
  extractMentionScopes,
  filterMentionedAgents,
  filterMentionedAssets,
  workspacePrefix
} from '@/utils/aiMention'
import { resolveStickyContextBinding, type StickyContextBinding } from '@/utils/aiContext'
import { createMcpRuntime } from '@/services/mcp'
import { createLocalAiRuntime, localTools } from '@/services/aiLocal'
import { createDirectWorkspaceRuntime } from '@/services/aiWorkspace'
import type { LlmTool, LlmToolCall } from '@/services/ai'

/** 工具确认决定(与 AiChat 的 confirm-tool 事件载荷一致) */
export type AiToolDecision = 'approve' | 'reject' | 'whitelist'

/**
 * 「内嵌 AI 助手宿主」聊天编排 composable 参数。
 * 公共骨架(防并发守卫 / steering / user 消息入列 / 工具组装 / systemPrompt / runAgent)
 * 由 composable 实现;各宿主的差异点全部经参数注入。
 */
export interface UseAiChatHostOptions {
  /** 会话 instanceId(tab 级;通常为冻结的路由 id 或终端 props.id) */
  instanceId: MaybeRefOrGetter<string>
  /** 会话绑定的资产 id(也用于 memory 工具的资产级写入) */
  getAssetId: () => string
  /** 会话上下文类型(决定 buildSystemPrompt 注入的技能组) */
  assetType: AiAssetType
  /** 会话可用条件(如连接就绪 / 资产存在),返回 false 时 session 为 null、AiChat 不渲染 */
  enabled?: () => boolean
  /** 宿主业务工具集(session_search / memory / mcp 工具由 composable 统一追加) */
  tools: LlmTool[]
  /**
   * 用共享 confirmFn 组装宿主业务工具执行器(每次 agent 运行时调用)。
   * 返回的执行器只需处理宿主业务工具;session_search / memory / mcp__ 前缀由 composable 分流。
   */
  makeToolExecutor: (confirmFn: ToolConfirmFn) => (call: LlmToolCall) => Promise<string>
  /** 每次 agent 运行时求值的基础 system prompt(可含 cwd、当前库等动态上下文) */
  getBasePrompt: () => string
  /** 工具确认流程(默认 true;无风险命令确认的宿主如 Excel 传 false) */
  confirm?: boolean
  /** 是否注入 MCP 工具(默认 true) */
  mcp?: boolean
  /**
   * 重试策略:
   * - resend(默认):弹出最后一条 user 消息,重走完整 send 流程
   * - rerun:保留最后一条 user 消息,直接重跑 agent
   */
  retryMode?: 'resend' | 'rerun'
  /** decision === 'whitelist' 时从工具记录提取白名单前缀(confirm 开启时建议提供) */
  extractWhitelistPrefix?: (rec: AiToolCallRecord) => string
  /** send 推送 user 消息后、启动 agent 前的宿主钩子(如审计、cwd 抓取) */
  beforeRun?: (text: string) => Promise<void> | void
  /** stop / new-chat 时的宿主清理(如中断在途命令);stop 在 stopAgent 后、new-chat 在 resetSession 前调用 */
  onInterrupt?: (trigger: 'stop' | 'new-chat') => void
  /** 确认 promise 被 resolve 时的宿主钩子(如审计) */
  onConfirmResolved?: (rec: AiToolCallRecord | undefined, decision: AiToolDecision) => void
  /** MCP discovery 警告的 console 日志前缀(如 'ssh-ai') */
  logTag: string
}

/**
 * 内嵌 AI 助手宿主的共用聊天编排(SshTerminal / DbView / DockerView / RedisView /
 * ElasticsearchView / ExcelView 共用)。返回值的 handler 签名与 AiChat 的 emit 一一对应,
 * 宿主模板里 `@send="onAiSend"` 等绑定可直接沿用。
 */
export function useAiChatHost(options: UseAiChatHostOptions) {
  const aiStore = useAiStore()
  const assetStore = useAssetStore()
  const confirmEnabled = options.confirm ?? true
  const mcpEnabled = options.mcp ?? true
  const retryMode = options.retryMode ?? 'resend'

  const session: ComputedRef<AiSession | null> = computed(() => {
    if (options.enabled && !options.enabled()) return null
    return aiStore.getOrCreateSession(toValue(options.instanceId), options.getAssetId(), options.assetType)
  })
  const sending = computed(() => session.value?.loading ?? false)

  /** 等待用户确认的 tool call 记录 ID → resolve 回调 */
  const pendingConfirms = ref<Map<string, (approved: boolean) => void>>(new Map())

  function resolvePendingConfirms() {
    for (const resolve of pendingConfirms.value.values()) resolve(false)
    pendingConfirms.value.clear()
  }

  /**
   * 等用户确认(AiChat 弹确认卡,emit confirm-tool 事件后由 onAiConfirmTool resolve)。
   * 把最近一个 running 的记录标为 awaiting-confirm;找不到就补一条占位记录。
   */
  const confirmFn: ToolConfirmFn = async (ctx) => {
    const s = session.value!
    const running = [...s.toolCalls].reverse().find(t => t.status === 'running' || t.status === 'awaiting-confirm')
    const recordId = running?.id || `pending-${Date.now()}`
    if (running) {
      running.status = 'awaiting-confirm'
      running.result = ctx.message
      running.confirmReason = ctx.reason
    } else {
      s.toolCalls.push({
        id: recordId, name: ctx.toolName, args: ctx.args,
        status: 'awaiting-confirm', result: ctx.message, confirmReason: ctx.reason, startedAt: Date.now()
      })
    }
    // 强制触发 Vue 响应式:替换 toolCalls 数组引用 + 等 nextTick 刷新 DOM
    s.toolCalls = [...s.toolCalls]
    await nextTick()
    return new Promise<boolean>((resolve) => {
      pendingConfirms.value.set(recordId, resolve)
    })
  }

  /**
   * 解析消息中的 @ / # mention(语义与 AiView 一致,内嵌场景无 planner 直跑):
   * - @Agent名 → 切换本会话 Agent(session.agentId,运行时字段;再次 @ 即切换);
   *   该 Agent 配置了默认绑定目标(boundAssetIds / boundLocal)且本轮无显式
   *   # token 时,按 AiView 同款语义注入为绑定
   * - #目标   → 写入 session.contextBinding(sticky:本轮显式提及则更新,未提及沿用上一轮)
   * 无 # 提及时不触碰既有绑定;# 后紧跟无法解析的 token 视为显式清空(同 AiView)。
   */
  function applyMentions(text: string, s: AiSession) {
    const mentionedAgents = filterMentionedAgents(aiStore.agents, text)
    const primaryAgent = mentionedAgents[0]
    if (primaryAgent) {
      aiStore.setSessionAgent(toValue(options.instanceId), primaryAgent.id)
    }
    const scopes = extractMentionScopes(text)
    const referencedAssets = filterMentionedAssets(assetStore.assets, text)
    const explicitTokens = [
      ...scopes.map(scope => `#${workspacePrefix(scope)}`),
      ...referencedAssets.map(asset => assetMentionToken(asset.type, asset.name))
    ]
    const agentDefault = primaryAgent ? agentDefaultBinding(primaryAgent) : undefined
    if (explicitTokens.length === 0 && !agentDefault) return
    // 模块作用域(#SSH 等)覆盖该类型全部资产,与 AiView 的 scopedAssets 语义一致
    const explicitIds = new Set(referencedAssets.map(asset => asset.id))
    for (const asset of assetStore.assets) {
      if (scopes.includes(asset.type)) explicitIds.add(asset.id)
    }
    const resolved = resolveStickyContextBinding({
      explicitAssetIds: Array.from(explicitIds),
      explicitLocal: scopes.includes('local'),
      explicitTokens,
      previous: s.contextBinding ?? agentDefault,
      availableAssetIds: assetStore.assets.map(asset => asset.id)
    })
    s.contextBinding = resolved.binding
  }

  /** Agent 配置的默认绑定目标(与 AiView 的 agentDefaultBinding 语义一致) */
  function agentDefaultBinding(agent: { boundAssetIds?: string[]; boundLocal?: boolean }): StickyContextBinding | undefined {
    const ids = (agent.boundAssetIds ?? []).filter(id => assetStore.assets.some(asset => asset.id === id))
    const local = Boolean(agent.boundLocal)
    if (ids.length === 0 && !local) return undefined
    const tokens = [
      ...ids.map(id => {
        const asset = assetStore.assets.find(item => item.id === id)
        return asset ? assetMentionToken(asset.type, asset.name) : ''
      }).filter(token => token.length > 0),
      ...(local ? ['#LOCAL'] : [])
    ]
    return { assetIds: ids, local, tokens }
  }

  /**
   * # 绑定目标的 system prompt 附加块。
   * 绑定含本机(local 作用域或 local 资产)时接入 local_* 工具;
   * 绑定含非宿主资产时接入对应类型的 workspace 工具(ssh/sftp/db/redis/es/
   * docker/excel,workspace 参数区分目标)。两者都没有时才是纯参照。
   */
  function buildBoundContextBlock(s: AiSession): string {
    const binding = s.contextBinding
    if (!binding) return ''
    const boundIds = new Set(binding.assetIds)
    const assets = assetStore.assets.filter(asset => boundIds.has(asset.id))
    if (assets.length === 0 && !binding.local) return ''
    const localAuthorized = binding.local || assets.some(asset => asset.type === 'local')
    const hostAssetId = options.getAssetId() || ''
    const crossCount = assets.filter(asset => asset.id !== hostAssetId).length
    const inventory = [
      ...assets.map(asset => `- ${asset.type.toUpperCase()} | ${asset.name} | ${assetSummary(asset)}`),
      ...(binding.local ? ['- LOCAL | 本机 | 当前运行 StarHub 的设备'] : [])
    ].join('\n')
    const localText = '本机:可用 local_* 工具读写文件与执行 Shell(先调 local_system_info 判断平台与用户目录;文件读取免确认,写操作与 Shell 命令需用户确认)'
    const crossText = '绑定工作区:可用 ssh_*/sftp_*/db_*/redis_*/es_*/docker_*/excel_* 工具直接操作(workspace 参数区分目标;省略 workspace 或指向本标签页宿主资产时落在当前宿主)'
    const capability = [localAuthorized ? localText : '', crossCount > 0 ? crossText : '']
      .filter(Boolean)
      .join(';') || '以上目标仅供参照;可用工具仍限于当前标签页宿主能力,不要声称能直接操作未接入的目标'
    const rule = '未绑定的资产与本机能力不得访问。'
    return `\n\n本会话通过 # 绑定的目标: ${binding.tokens.join(', ')}\n绑定目标信息:\n${inventory}\n\n已接入能力:\n${capability}\n${rule}`
  }

  // ====== 绑定资产 runtime:非宿主绑定资产的实际工具接入(连接缓存 + unmount 关闭) ======
  let bindingRuntime: { runtime: ReturnType<typeof createDirectWorkspaceRuntime>; key: string } | null = null

  function ensureBindingRuntime(boundAssetIds: string[]): ReturnType<typeof createDirectWorkspaceRuntime> | null {
    const key = boundAssetIds.join(',')
    if (bindingRuntime?.key === key) return bindingRuntime.runtime
    void bindingRuntime?.runtime.close()
    bindingRuntime = null
    if (boundAssetIds.length === 0) return null
    const hostAssetId = options.getAssetId() || ''
    const assets = assetStore.assets.filter(asset => boundAssetIds.includes(asset.id) && asset.id !== hostAssetId)
    if (assets.length === 0) return null
    bindingRuntime = {
      key,
      runtime: createDirectWorkspaceRuntime({
        runtimeId: `${toValue(options.instanceId)}:binding`,
        assets,
        dependencyAssets: assetStore.assets,
        getWhitelist: () => aiStore.settings.commandWhitelist,
        // 未启用工具确认的宿主(Excel)对需要确认的操作一律拒绝
        confirm: confirmEnabled ? confirmFn : () => Promise.resolve(false)
      })
    }
    return bindingRuntime.runtime
  }

  onBeforeUnmount(() => {
    if (bindingRuntime) {
      void bindingRuntime.runtime.close()
      bindingRuntime = null
    }
  })

  /** 组装本轮工具集与 systemPrompt,启动 agent(runAgent 内部 finally 会还原 loading) */
  async function runAgentOnce() {
    if (!session.value) return
    const executor = options.makeToolExecutor(confirmFn)
    const memoryToolCaller = makeMemoryToolCaller({
      // 确认流程关闭的宿主(Excel)不传 confirmFn,记忆写入直接执行
      confirmFn: confirmEnabled ? confirmFn : undefined,
      getAssetId: () => options.getAssetId() || null,
      getSettings: () => aiStore.settings
    })
    const skillSaveToolCaller = makeSkillSaveToolCaller({
      confirmFn: confirmEnabled ? confirmFn : undefined,
      getAssetType: () => options.assetType,
      upsert: (draft) => aiStore.upsertCustomSkill(draft)
    })
    const mcpRuntime = mcpEnabled
      ? await createMcpRuntime(await aiStore.getMcpServers(), confirmFn)
      : null
    if (mcpRuntime?.warnings.length) console.warn(`[${options.logTag}] MCP discovery warnings:`, mcpRuntime.warnings)
    // # 绑定目标 → 工具接入:
    // - local(作用域或 local 资产):接 local_* 工具(宿主自带时由宿主执行器处理)
    // - 非宿主资产:接 direct workspace runtime(ssh/sftp/db/redis/es/docker/excel,
    //   workspace 参数路由);与宿主同名的工具用带 workspace 参数的版本,
    //   省略 workspace 或指向宿主资产时落在当前宿主执行器
    const hostAssetId = options.getAssetId() || ''
    const hostAsset = hostAssetId ? assetStore.assets.find(asset => asset.id === hostAssetId) : undefined
    const hostToolNames = new Set(options.tools.map(tool => tool.function.name))
    const binding = session.value.contextBinding
    const boundAssets = binding ? assetStore.assets.filter(asset => binding.assetIds.includes(asset.id)) : []
    const localBound = Boolean(binding && (
      binding.local || boundAssets.some(asset => asset.type === 'local')
    ))
    const localRuntime = localBound
      ? createLocalAiRuntime({
          getWhitelist: () => aiStore.settings.commandWhitelist,
          confirm: confirmEnabled ? confirmFn : undefined
        })
      : null
    const workspaceRuntime = ensureBindingRuntime(boundAssets.map(asset => asset.id))
    const crossToolDefs = workspaceRuntime?.tools ?? []
    const crossToolNames = new Set(crossToolDefs.map(tool => tool.function.name))
    // 与宿主同名(绑定含同类型资产):替换为 workspace 参数版,省略 workspace = 当前宿主
    const clashingTools = crossToolDefs
      .filter(tool => hostToolNames.has(tool.function.name))
      .map(tool => ({
        ...tool,
        function: {
          ...tool.function,
          description: `${tool.function.description} workspace 省略或指向本标签页宿主资产时作用于当前宿主;指向 # 绑定的其他资产时作用于该工作区。`
        }
      }))
    const extraCrossTools = crossToolDefs.filter(tool => !hostToolNames.has(tool.function.name))
    const hostKeptTools = workspaceRuntime
      ? options.tools.filter(tool => !crossToolNames.has(tool.function.name))
      : options.tools

    function bindingWorkspaceArg(call: LlmToolCall): string {
      try {
        const args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>
        return typeof args.workspace === 'string' ? args.workspace.trim() : ''
      } catch {
        return ''
      }
    }

    function refsHostAsset(workspace: string): boolean {
      if (!hostAsset || !workspace) return false
      const w = workspace.toLowerCase()
      return hostAsset.id.toLowerCase() === w || hostAsset.name.toLowerCase() === w
    }

    const toolExec = async (call: LlmToolCall): Promise<string> => {
      if (call.function.name === 'session_search') return sessionSearchToolCaller(call)
      if (call.function.name === 'memory') return memoryToolCaller(call)
      if (call.function.name === 'skill_save') return skillSaveToolCaller(call)
      if (localRuntime && call.function.name.startsWith('local_') && !hostToolNames.has(call.function.name)) {
        return localRuntime.execute(call)
      }
      if (workspaceRuntime && crossToolNames.has(call.function.name)) {
        const workspace = bindingWorkspaceArg(call)
        // 宿主同名工具:无 workspace 或指向宿主资产 → 宿主执行器;否则落到绑定资产
        if (hostToolNames.has(call.function.name) && (!workspace || refsHostAsset(workspace))) {
          return executor(call)
        }
        return workspaceRuntime.execute(call)
      }
      if (mcpRuntime && call.function.name.startsWith('mcp__')) return mcpRuntime.execute(call)
      return executor(call)
    }
    // @ 切换的会话 Agent 优先:用其角色与技能(buildAgentPrompt)作为基础 prompt,
    // 宿主动态上下文(cwd、当前库等)降级为参考块;清空 agentId 即回退宿主默认 prompt
    const mentionAgent = session.value.agentId ? aiStore.getAgent(session.value.agentId) : undefined
    const basePrompt = mentionAgent
      ? `${aiStore.buildAgentPrompt(mentionAgent)}\n\n宿主标签页上下文(供参考):\n${options.getBasePrompt()}`
      : options.getBasePrompt()
    const sysPrompt = aiStore.buildSystemPrompt(basePrompt, options.assetType) + buildBoundContextBlock(session.value)
    const extraTools = [
      ...sessionSearchTools,
      ...memoryTools,
      ...skillSaveTools,
      ...(localRuntime && !hostToolNames.has('local_system_info') ? localTools : []),
      ...clashingTools,
      ...extraCrossTools
    ]
    const tools = mcpRuntime
      ? [...hostKeptTools, ...extraTools, ...mcpRuntime.tools]
      : [...hostKeptTools, ...extraTools]
    await aiStore.runAgent(toValue(options.instanceId), tools, toolExec, sysPrompt)
  }

  async function onAiSend(text: string) {
    const s = session.value
    if (!s) return
    // @ / # mention 在 send 入口统一应用(含 steering 分支:运行中也能切换 Agent / 调整绑定)
    applyMentions(text, s)
    // 防并发 send:loading 在 runAgent 之前立刻设,挡住重复点击,
    // 否则两个 runAgent 并发跑会污染 messages(LLM 报 400 tool call 错位)
    if (s.loading) {
      // 运行中:作为 steering 引导注入历史,runAgent 下一步边界生效
      aiStore.steer(toValue(options.instanceId), text)
      return
    }
    s.loading = true
    s.messages.push({ role: 'user', content: text })
    await options.beforeRun?.(text)
    await runAgentOnce()
  }

  async function onAiRetry() {
    const s = session.value
    if (!s) return
    if (retryMode === 'rerun') {
      // 保留最后一条 user 消息直接重跑 agent;运行中不重试
      if (s.loading) return
      const msgs = s.messages
      while (msgs.length && msgs[msgs.length - 1].role !== 'user') msgs.pop()
      if (msgs.length) await runAgentOnce()
      return
    }
    const msgs = s.messages
    // 先删到最后一轮 user 消息为止(去掉 assistant 回答 / 错误尾巴)
    while (msgs.length && msgs[msgs.length - 1].role !== 'user') msgs.pop()
    // 弹出最后一条 user,重走完整 send 流程(含 beforeRun 钩子)
    const lastUserText = msgs.pop()?.content
    if (lastUserText) await onAiSend(lastUserText)
  }

  function onAiNewChat() {
    resolvePendingConfirms()
    options.onInterrupt?.('new-chat')
    aiStore.resetSession(toValue(options.instanceId))
  }

  function onAiStop() {
    resolvePendingConfirms()
    aiStore.stopAgent(toValue(options.instanceId))
    options.onInterrupt?.('stop')
  }

  function onAiConfirmTool(recordId: string, decision: AiToolDecision) {
    // 确认流程关闭的宿主(Excel)不存在确认卡,忽略该事件
    if (!confirmEnabled) return
    const s = session.value
    if (!s) return
    const rec = s.toolCalls.find(t => t.id === recordId)
    if (rec) {
      if (decision === 'whitelist') {
        // 加入白名单并批准
        const prefix = options.extractWhitelistPrefix?.(rec) ?? ''
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
      options.onConfirmResolved?.(rec, decision)
      resolve(decision === 'approve' || decision === 'whitelist')
      pendingConfirms.value.delete(recordId)
    }
  }

  return {
    session,
    sending,
    onAiSend,
    onAiRetry,
    onAiNewChat,
    onAiStop,
    onAiConfirmTool
  }
}
