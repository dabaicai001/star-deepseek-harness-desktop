/**
 * dsh 壳 iframe 内嵌模式的窗口侧协议(P1 主壳融合)。
 *
 * dsh 侧 client-nav 插件把功能页嵌进 `/starhub/index.html?embed=1&route=<path>`
 * 的同源 iframe(host-static 插件托管 dist,base `/starhub/`)。
 * embed=1 时 CyberLayout 渲染去壳外壳(无 titlebar / tab 条 / 侧栏 / 状态栏,
 * 不套 keep-alive、不进 appStore.tabs),并直接 router.replace 到 route。
 *
 * 与 detached 窗口(windowDetach.ts)同理:参数在窗口/iframe 生命周期内只解析一次。
 */

let cachedEmbed: boolean | undefined
let cachedRoute: string | null | undefined

/** 当前页面是否运行在 dsh 壳的 embed iframe 内 */
export function isEmbedMode(): boolean {
  if (cachedEmbed !== undefined) return cachedEmbed
  try {
    cachedEmbed = new URLSearchParams(window.location.search).get('embed') === '1'
  } catch {
    cachedEmbed = false
  }
  return cachedEmbed
}

/** embed 入口指定的直达路由(如 /ssh/embed);未指定或非 embed 时为 null */
export function embedRoute(): string | null {
  if (cachedRoute !== undefined) return cachedRoute
  cachedRoute = null
  if (isEmbedMode()) {
    try {
      const route = new URLSearchParams(window.location.search).get('route')
      // 只接受站内绝对路径,挡掉协议相对 / 外站注入
      if (route && route.startsWith('/') && !route.startsWith('//')) cachedRoute = route
    } catch {
      cachedRoute = null
    }
  }
  return cachedRoute
}
