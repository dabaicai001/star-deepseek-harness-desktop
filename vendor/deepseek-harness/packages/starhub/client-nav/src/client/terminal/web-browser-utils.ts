/**
 * StarHub Web 浏览器 URL 纯函数(需求 6 web 子集,React 化)。
 *
 * 从 Vue `src/views/WebBrowserView.vue` 移植的两段纯逻辑:
 * - `normalizeUrl(input)`:规范化用户输入 → 自动补 `https://`、提取
 *   scheme/hostport(含非默认端口)/pathQuery/href;非法输入返回 null。
 * - `proxyToOriginal(url)`:把网关代理 URL `http://127.0.0.1:{port}/__proxy__/
 *   {scheme}/{hostport}/path` 还原为原始 URL;非代理路径返回 null。
 * - `buildProxyUrl(gatewayPort, original)`:由原始 URL + 端口拼网关代理 URL。
 *
 * 网关代理形态:`http://127.0.0.1:{port}/__proxy__/{scheme}/{hostport}{pathQuery}`。
 * 纯函数,无 DOM/Tauri 依赖,便于 100% 覆盖测试。
 *
 * @module StarHub web browser url utils (client)
 */

/** 规范化结果(见 normalizeUrl)。 */
export interface NormalizedUrl {
  scheme: string
  hostport: string
  pathQuery: string
  href: string
}

/**
 * Normalize a user-entered URL: default to https, extract parts, reject garbage.
 * @param input - raw address-bar text.
 * @returns parsed parts, or null when the input has no usable hostname.
 */
export function normalizeUrl(input: string): NormalizedUrl | null {
  const raw = input.trim()
  if (raw === '') return null
  let candidate = raw
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(candidate)) candidate = `https://${candidate}`
  let url: URL
  try { url = new URL(candidate) } catch { return null }
  if (url.hostname === '') return null
  const scheme = url.protocol.replace(':', '')
  let hostport = url.hostname
  const port = parseInt(url.port, 10) || (scheme === 'https' ? 443 : 80)
  const defaultPort = scheme === 'https' ? 443 : 80
  if (port !== defaultPort) hostport += `:${port}`
  const pathQuery = url.pathname + url.search + url.hash
  // v8 ignore next -- 防御:合法 URL 的 pathname 至少为 '/'，pathQuery 恒非空
  return { scheme, hostport, pathQuery: pathQuery || '/', href: url.href }
}

/**
 * Rebuild the original URL from a proxy URL, or null when the path is not a
 * gateway proxy path (`/__proxy__/{scheme}/{hostport}/...`).
 * @param url - the proxy URL to reverse-map.
 * @returns the original URL string, or null.
 */
export function proxyToOriginal(url: URL): string | null {
  const prefix = '/__proxy__/'
  if (!url.pathname.startsWith(prefix)) return null
  const rest = url.pathname.slice(prefix.length)
  const parts = rest.split('/')
  if (parts.length < 2) return null
  const scheme = parts[0]
  const hostport = parts[1]
  if (!scheme || !hostport) return null
  const path = `/${parts.slice(2).join('/')}`
  return `${scheme}://${hostport}${path}${url.search}${url.hash}`
}

/**
 * Build the local gateway proxy URL for an original URL on a given port.
 * @param gatewayPort - the local web-gateway port (0 means not started).
 * @param normalized - normalized parts from normalizeUrl.
 * @returns the proxy URL to load in the iframe, or null when the gateway is off.
 */
export function buildProxyUrl(gatewayPort: number, normalized: NormalizedUrl): string | null {
  if (gatewayPort <= 0) return null
  return `http://127.0.0.1:${gatewayPort}/__proxy__/${normalized.scheme}/${normalized.hostport}${normalized.pathQuery}`
}
