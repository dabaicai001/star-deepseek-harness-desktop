import { onMounted, onActivated, onDeactivated, onBeforeUnmount } from 'vue'

/**
 * 通用轮询 composable(Ssh / Docker / Db 三个 Dashboard 共用):
 * - 挂载后立即启动定时器
 * - `<KeepAlive>` 失活时暂停(节省资源),激活时恢复
 * - 组件卸载时清理,绝不泄漏 interval
 *
 * 首次数据加载由调用方自己的 onMounted 负责,这里只管 interval。
 */
export function usePolling(callback: () => void, intervalMs = 30000) {
  let timer: number | null = null

  function start() {
    stop()
    timer = window.setInterval(callback, intervalMs)
  }

  function stop() {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  onMounted(start)
  onActivated(start)
  onDeactivated(stop)
  onBeforeUnmount(stop)

  return { start, stop }
}
