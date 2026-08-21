/**
 * 长期记忆开关的 settings 通道(2026-08-21):client-nav 侧把「启用长期记忆」
 * 写入 `starhub-memory-context` settings namespace,host 侧 memory-context
 * 插件在 `agent/pre-step` 读取——关闭则完全不注入记忆卡。
 * 写入失败静默(旧运行时无该 namespace;开关仍以 localStorage 为准)。
 */
import type { IApiClient } from '@deepseek-ai/dsh-client-connection/client'

/** Settings namespace holding the memory master switch. */
export const MEMORY_CONTEXT_NAMESPACE = 'starhub-memory-context'

/**
 * 同步「启用长期记忆」开关到 host 侧 namespace(尽力而为,不打断设置交互)。
 * @param api - 连接线的 settings RPC 面。
 * @param enabled - 开关状态。
 */
export function syncMemoryEnabled(api: IApiClient, enabled: boolean): void {
  void api.settings.update({
    ns: MEMORY_CONTEXT_NAMESPACE,
    patch: { enabled },
  }).catch(() => {})
}
