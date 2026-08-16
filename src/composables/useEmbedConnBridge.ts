/**
 * embed 连接上下文头部桥(方案第 3 章 3.1/3.2)。
 *
 * 功能页视图接入:watch 视图自身的连接状态(connected / connecting /
 * error),变化时经 postMessage 上报给父帧的 EmbedAssetBar;并监听父帧
 * 发来的「连接/断开」动作请求,调用视图的 connect / disconnect。
 *
 * 视图职责:传入状态 ref + connect/disconnect 回调,其余(上报时机、
 * 动作分派、assetId 比对)由本 composable 处理。
 */
import { watch, onBeforeUnmount } from 'vue'
import { onConnAction, postConnState, type EmbedConnState } from '@/lib/embed'

export interface EmbedConnBridgeOptions {
  /** 视图当前资产 id(instanceId 已反解);空串 = 无资产,不上报 */
  assetId: () => string
  /** 连接中(布尔 ref) */
  connecting: () => boolean
  /** 已连接(布尔 ref) */
  connected: () => boolean
  /** 错误原因(字符串 ref,空 = 无错误) */
  error: () => string | null
  /** 执行连接 */
  connect: () => void | Promise<void>
  /** 执行断开 */
  disconnect: () => void | Promise<void>
}

/** 汇总当前连接状态(未连接/连接中/已连接/错误)。 */
function deriveState(o: EmbedConnBridgeOptions): EmbedConnState {
  if (o.error()) return 'error'
  if (o.connecting()) return 'connecting'
  if (o.connected()) return 'connected'
  return 'disconnected'
}

/**
 * 接入连接上下文头部:状态上报 + 动作监听。
 * @param options - 状态来源与动作回调。
 * @returns 停止函数(组件卸载时调用)。
 */
export function useEmbedConnBridge(options: EmbedConnBridgeOptions): () => void {
  // 状态变化 → 上报父帧资产条
  const offWatch = watch(
    () => [options.connected(), options.connecting(), options.error()] as const,
    () => {
      const id = options.assetId()
      if (!id) return
      postConnState(id, deriveState(options), options.error() ?? undefined)
    },
    { immediate: true },
  )

  // 父帧动作请求 → 调用视图 connect/disconnect
  const offAction = onConnAction((msg) => {
    if (msg.assetId !== options.assetId()) return
    if (msg.action === 'connect') void options.connect()
    else void options.disconnect()
  })

  return () => {
    offWatch()
    offAction()
  }
}

/** 组件卸载清理:与 onBeforeUnmount 配套的便捷封装。 */
export function useEmbedConnBridgeOnUnmount(options: EmbedConnBridgeOptions): void {
  const stop = useEmbedConnBridge(options)
  onBeforeUnmount(stop)
}
