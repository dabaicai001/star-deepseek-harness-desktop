/**
 * 网页访问 tab 的一次性初始导航意图。
 *
 * web tab 的 keep-alive 缓存以 route.fullPath 为 key,初始 URL 若走
 * query 参数传递,tab 切换时(不带 query 的 push)会产生不同 fullPath,
 * 组件实例被重建、浏览状态全丢。因此初始 URL 不进路由,改为开 tab 前
 * 暂存、目标实例 onMounted 时取走。
 */

const pendingUrls = new Map<string, string>()

/** 新开 web tab 前暂存初始 URL(tab 实例挂载后自动导航用) */
export function stashWebNavUrl(tabId: string, url: string) {
  pendingUrls.set(tabId, url)
}

/** 取出并清除该 tab 的初始 URL;没有则返回 undefined */
export function takeWebNavUrl(tabId: string): string | undefined {
  const url = pendingUrls.get(tabId)
  if (url !== undefined) pendingUrls.delete(tabId)
  return url
}
