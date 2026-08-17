/**
 * 长期记忆工具(memory)定义与执行器 —— 供记忆自动沉淀服务
 * (aiMemoryReview) 使用;旧内核(useAiChatHost / aiTools)退役后,
 * 内嵌 AI 会话的 memory 工具由 dsh 侧的 dsh-starhub-tools 桥接管。
 */

import type { LlmTool } from '@/services/ai'
import { aiMemoryAdd, aiMemoryRemove, aiMemoryReplace } from '@/services/aiMemory'
import { logAudit } from '@/services/audit'
import { useNotifyStore } from '@/stores/notify'
import { scanMemoryContent } from '@/utils/memoryGuard'
import type { ToolConfirmFn } from '@/services/mcp'

function safeParse(s: string): Record<string, unknown> {
  try { return JSON.parse(s) } catch { return {} }
}

function truncateForDisplay(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/**
 * 长期记忆注入 system prompt 的前提说明:记忆内容已在会话开始时以记忆卡
 * 形式注入;Rust 侧的 [DUPLICATE] / [FULL] / [NOMATCH] / [AMBIGUOUS] 错误
 * 不 throw,原样作为工具结果返回,LLM 看到 [FULL] 会自行 replace 合并后重试。
 */
export const memoryTools: LlmTool[] = [
  {
    type: 'function',
    function: {
      name: 'memory',
      description: '管理长期记忆(跨会话持久)。三个动作:add 新增条目;replace 用 old_text 唯一子串定位并替换条目;remove 用 old_text 唯一子串删除条目。target:user=用户偏好与习惯;global=跨资产的通用环境事实与经验;asset=当前绑定资产的专属事实(如"这台是生产库,DDL 前必须备份")。记忆内容会在以后的会话开始时就出现在你的上下文里。该存:用户偏好、环境事实(系统/端口/拓扑)、用户纠正、项目约定、已完成的重要工作;不该存:琐碎信息、可重新查到的知识、原始数据(日志/大段代码)、会话临时状态、任何密码/密钥/令牌。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['add', 'replace', 'remove'] },
          target: { type: 'string', enum: ['user', 'global', 'asset'] },
          content: { type: 'string', description: 'add/replace 的新条目内容,信息密度要高,可多条事实合并成一条' },
          old_text: { type: 'string', description: 'replace/remove 用:能唯一定位目标条目的短子串' }
        },
        required: ['action', 'target']
      }
    }
  }
]

/** 执行器依赖的设置子集(由宿主从 aiStore.settings 提供) */
export interface MemoryToolSettings {
  memoryEnabled: boolean
  memoryWriteNeedsConfirm: boolean
}

/** [DUPLICATE]/[FULL]/[NOMATCH]/[AMBIGUOUS] 是策展交互信号,原样回给 LLM 自行纠正 */
const MEMORY_SOFT_ERROR_PREFIXES = ['[DUPLICATE]', '[FULL]', '[NOMATCH]', '[AMBIGUOUS]']

/** 创建 memory 工具执行器(写入确认闸开启时经 confirmFn 弹确认) */
export function makeMemoryToolCaller(opts: {
  confirmFn?: ToolConfirmFn
  getAssetId?: () => string | null
  getSettings: () => MemoryToolSettings
}) {
  return async (call: { function: { name: string; arguments: string } }): Promise<string> => {
    const args = safeParse(call.function.arguments)
    const settings = opts.getSettings()
    if (settings.memoryEnabled === false) return '记忆功能已在设置中禁用'

    const action = typeof args.action === 'string' ? args.action : ''
    const target = typeof args.target === 'string' ? args.target : ''
    if (!['add', 'replace', 'remove'].includes(action)) {
      return `[Error] 未知 action:「${action}」,只支持 add / replace / remove`
    }
    if (!['user', 'global', 'asset'].includes(target)) {
      return `[Error] 未知 target:「${target}」,只支持 user / global / asset`
    }

    let scope = target
    if (target === 'asset') {
      const assetId = opts.getAssetId?.() ?? null
      if (!assetId) {
        return '当前会话未绑定资产,无法写入资产级记忆,请让用户用 # 绑定资产后重试'
      }
      scope = `asset:${assetId}`
    }

    const content = typeof args.content === 'string' ? args.content.trim() : ''
    const oldText = typeof args.old_text === 'string' ? args.old_text.trim() : ''
    if (action !== 'remove' && !content) return '[Error] content 不能为空(add/replace 必须提供新条目内容)'
    if (action !== 'add' && !oldText) return '[Error] old_text 不能为空(replace/remove 需要能唯一定位目标条目的短子串)'

    // 写入前安全扫描:隐形 Unicode / prompt 注入 / 凭据字面量
    if (content) {
      const scan = scanMemoryContent(content)
      if (!scan.ok) return `[Error] 记忆写入被安全策略拦截:${scan.reason}`
    }

    // 确认闸:设置开启后每次写入走工作区内嵌确认卡
    if (settings.memoryWriteNeedsConfirm && opts.confirmFn) {
      const summary = action === 'add'
        ? `[新增 → ${target}] ${truncateForDisplay(content, 100)}`
        : action === 'replace'
          ? `[更新 → ${target}] ${truncateForDisplay(oldText, 50)} ⇒ ${truncateForDisplay(content, 50)}`
          : `[删除 → ${target}] ${truncateForDisplay(oldText, 100)}`
      const approved = await opts.confirmFn({
        toolName: 'memory',
        args,
        reason: 'always-confirm',
        message: `AI 请求写入记忆:${summary}`
      })
      if (!approved) throw new Error('[Rejected by user]')
    }

    try {
      if (action === 'add') await aiMemoryAdd(scope, content)
      else if (action === 'replace') await aiMemoryReplace(scope, oldText, content)
      else await aiMemoryRemove(scope, oldText)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (MEMORY_SOFT_ERROR_PREFIXES.some(prefix => message.startsWith(prefix))) return message
      throw error
    }

    const brief = truncateForDisplay(content, 80)
    const oldBrief = truncateForDisplay(oldText, 80)
    const result = action === 'add'
      ? `已记住(${target}):${brief}`
      : action === 'replace'
        ? `记忆已更新(${target}):${brief}`
        : `记忆已删除(${target}):${oldBrief}`
    try {
      useNotifyStore().notify({
        message: action === 'remove' ? `💾 已删除记忆:${oldBrief}` : `💾 已记住:${brief || oldBrief}`,
        color: 'success',
        timeout: 3000
      })
    } catch { /* 无激活 pinia 的上下文(如测试)跳过通知 */ }
    void logAudit({
      category: 'ai',
      action: action === 'add' ? 'memory_add' : action === 'replace' ? 'memory_update' : 'memory_remove',
      target: scope,
      detail: { content: truncateForDisplay(content || oldText, 200) }
    })
    return result
  }
}
