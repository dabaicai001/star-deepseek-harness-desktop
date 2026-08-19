// @vitest-environment jsdom
/**
 * web-browser-utils(需求 6 web 子集):normalizeUrl(自动补 https/补端口/非法
 * 输入容错)、proxyToOriginal(代理 URL 还原)、buildProxyUrl(代理 URL 构造)。
 * 纯函数全覆盖。
 */
import { describe, expect, it } from 'vitest'
import { buildProxyUrl, normalizeUrl, proxyToOriginal } from '../src/client/terminal/web-browser-utils.ts'

describe('normalizeUrl', () => {
  it('returns null for empty or whitespace input', () => {
    expect(normalizeUrl('')).toBeNull()
    expect(normalizeUrl('   ')).toBeNull()
  })

  it('defaults the scheme to https when omitted', () => {
    const n = normalizeUrl('example.com/path')
    expect(n).toEqual({ scheme: 'https', hostport: 'example.com', pathQuery: '/path', href: 'https://example.com/path' })
  })

  it('keeps an explicit scheme', () => {
    const n = normalizeUrl('http://localhost:8080/x')
    expect(n?.scheme).toBe('http')
    expect(n?.hostport).toBe('localhost:8080')
    expect(n?.pathQuery).toBe('/x')
  })

  it('omits the default port in hostport', () => {
    expect(normalizeUrl('https://h.com:443/')?.hostport).toBe('h.com')
    expect(normalizeUrl('http://h.com:80/')?.hostport).toBe('h.com')
  })

  it('keeps a non-default port in hostport', () => {
    expect(normalizeUrl('https://h.com:8443/a')?.hostport).toBe('h.com:8443')
  })

  it('returns null for a malformed URL', () => {
    expect(normalizeUrl('http://')).toBeNull()
    expect(normalizeUrl('::::')).toBeNull()
  })

  it('returns null when the parsed URL has no hostname', () => {
    // file:// 无 hostname。
    expect(normalizeUrl('file:///etc/passwd')).toBeNull()
  })

  it('preserves search and hash in pathQuery and produces an empty-path fallback', () => {
    const n = normalizeUrl('https://h.com/a?q=1#frag')
    expect(n?.pathQuery).toBe('/a?q=1#frag')
    expect(normalizeUrl('https://h.com')?.pathQuery).toBe('/')
  })
})

describe('proxyToOriginal', () => {
  it('rejects a non-proxy path', () => {
    expect(proxyToOriginal(new URL('http://127.0.0.1:8080/index.html'))).toBeNull()
  })

  it('rejects a too-short proxy path', () => {
    expect(proxyToOriginal(new URL('http://127.0.0.1:8080/__proxy__/https'))).toBeNull()
  })

  it('rejects a proxy path with an empty scheme', () => {
    expect(proxyToOriginal(new URL('http://127.0.0.1:8080/__proxy__//x/y'))).toBeNull()
  })

  it('reconstructs the original URL including search and hash', () => {
    const out = proxyToOriginal(new URL('http://127.0.0.1:8080/__proxy__/https/example.com/a/b?x=1#top'))
    expect(out).toBe('https://example.com/a/b?x=1#top')
  })
})

describe('buildProxyUrl', () => {
  it('returns null when the gateway is not running', () => {
    expect(buildProxyUrl(0, { scheme: 'https', hostport: 'h.com', pathQuery: '/', href: 'https://h.com/' })).toBeNull()
  })

  it('builds the gateway proxy URL from port and parts', () => {
    const n = { scheme: 'https', hostport: 'h.com', pathQuery: '/a?b=1', href: 'https://h.com/a?b=1' }
    expect(buildProxyUrl(18080, n)).toBe('http://127.0.0.1:18080/__proxy__/https/h.com/a?b=1')
  })
})
