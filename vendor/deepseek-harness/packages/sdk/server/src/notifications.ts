/**
 * StarHub 本地补丁(联动契约 §0/§2.1,不在上游):入站 JSON-RPC notification
 * 的多路分发。宿主(Rust 主进程)经 `JsonRpcLineTransport.notify()` 单向推送
 * `starhub/registry.sync`、`starhub/domain.event` 等帧(无 id、有 method);
 * 本模块把入站 notification 按 method 名分发给同组合内订阅插件(服务名
 * `sdk-notifications`,与 `sdk-transport` 同为宿主私有服务,不走 Context
 * 接口声明合并,消费方 `ctx.get('sdk-notifications')` 后自行窄化)。
 * 未订阅的方法静默忽略,订阅者异常被隔离,均不打断协议读循环。
 *
 * @module @deepseek-ai/dsh-sdk-jsonrpc-server/notifications
 */

/** One inbound notification's params, as normalized by the transport. */
export type SdkNotificationHandler = (params: unknown) => void

/**
 * Subscription surface of the `sdk-notifications` service: inbound JSON-RPC
 * notifications multiplexed by method name.
 */
export interface SdkNotificationHub {
  /**
   * Subscribe to one inbound notification method.
   * @param method - the JSON-RPC method name to subscribe to.
   * @param handler - invoked synchronously per inbound frame with the
   * normalized params object; a throwing handler is isolated from the
   * protocol loop and from sibling subscribers.
   * @returns disposer removing exactly this subscription.
   */
  subscribe(method: string, handler: SdkNotificationHandler): () => void
}

/**
 * Method-keyed multicast over inbound notifications. Methods without
 * subscribers are dropped silently; dispatch is synchronous and isolates
 * handler failures so the transport's read loop never observes them.
 */
export class SdkNotificationDispatcher implements SdkNotificationHub {
  private readonly handlers = new Map<string, Set<SdkNotificationHandler>>()

  subscribe(method: string, handler: SdkNotificationHandler): () => void {
    let set = this.handlers.get(method)
    if (set === undefined) {
      set = new Set()
      this.handlers.set(method, set)
    }
    set.add(handler)
    return () => {
      set.delete(handler)
      if (set.size === 0) this.handlers.delete(method)
    }
  }

  /**
   * Deliver one inbound notification to every current subscriber of its method.
   * @param method - the inbound JSON-RPC method name.
   * @param params - the normalized params object from the wire.
   */
  dispatch(method: string, params: Record<string, unknown>): void {
    const set = this.handlers.get(method)
    if (set === undefined) return
    // Snapshot: a handler may unsubscribe itself or siblings mid-dispatch.
    for (const handler of [...set]) {
      try {
        handler(params)
      } catch {
        // 订阅者异常被隔离:notification 无响应通道,向上抛只会打断
        // transport 的读循环(void handleLine 的未处理拒绝),宿主无从感知。
      }
    }
  }
}
