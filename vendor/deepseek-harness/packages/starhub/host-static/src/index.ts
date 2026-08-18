/**
 * @deepseek-ai/dsh-starhub-host-static — StarHub dist server over a webserver
 * prefix route (StarHub-local package, not upstream). Claims two named prefix
 * routes:
 *  - `/starhub` — the StarHub Vue frontend embed build, with SPA semantics
 *    (the dsh frontend keeps the fallback seat). Serving StarHub from the dsh
 *    origin is what lets the shell's same-origin iframes inherit the Tauri IPC
 *    injection.
 *  - `/starhub-react` — the standalone React workbench window app (the
 *    `starhub-window` Vite build, repo `dist-starhub-react/`). Independent
 *    windows opened for Tools instance clicks load this entry; it reuses the
 *    client-nav React workbenches full-window instead of a shell modal or a
 *    Vue embed.
 *
 * A miss on a GET falls back to the prefix's index.html with 200; traversal
 * outside a dist root is 403; non-GET/HEAD is 405. Both dists must use their
 * vite base (`/starhub/` / `/starhub-react/`) so bare asset URLs don't escape
 * the prefix and hit the dsh fallback — a wrong-base index fails loud at load.
 * Location resolution: per-prefix env (`STARHUB_DIST` / `STARHUB_WINDOW_DIST`)
 * first, then the repo `dist-embed` / `dist-starhub-react` (an actually-built
 * dist is required; no dist fails loud).
 *
 * @module @deepseek-ai/dsh-starhub-host-static
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'

/** Stable Cordis plugin name. */
export const name = 'starhub-host-static'

/** Service required before the prefix route can be claimed. */
export const inject = ['webServer']

/** URL prefix for the Vue embed build (matches its vite base). */
export const PREFIX = '/starhub'

/** URL prefix for the standalone React workbench window app (matches its vite base). */
export const WINDOW_PREFIX = '/starhub-react'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.map': 'application/json',
}

/**
 * Locate the StarHub repo root by walking up from this module (built:
 * packages/starhub/host-static/lib/) to the directory holding
 * `vendor/deepseek-harness`.
 * @returns the absolute repo root, or undefined outside a StarHub checkout.
 */
function findRepoRoot(): string | undefined {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (;;) {
    if (existsSync(join(dir, 'vendor', 'deepseek-harness'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/**
 * Resolve a served dist root for one prefix. The optional env var wins; the
 * fallback checks repo roots (in order) and requires the index to reference
 * assets under the prefix's vite base so bare URLs don't escape to the dsh
 * fallback — a wrong-base index is rejected loud (env) or skipped (fallback).
 * @param prefix - the vite base the dist must use (`/starhub` / `/starhub-react`).
 * @param envVar - env var naming an explicit dist root, or undefined.
 * @param fallbackDirs - repo-root-relative candidates in preference order.
 * @param emptyMessage - thrown when no qualifying dist exists at all.
 * @returns the absolute dist root containing a matching index.html.
 * @throws when no qualifying dist exists.
 */
export function resolveDist(
  prefix: string, envVar: string | undefined, fallbackDirs: readonly string[], emptyMessage: string,
): string {
  const fromEnv = envVar !== undefined && envVar !== '' ? envVar : undefined
  const candidates = fromEnv !== undefined
    ? [resolve(fromEnv)]
    : (() => {
        const repoRoot = findRepoRoot()
        return repoRoot === undefined ? [] : fallbackDirs.map((d) => join(repoRoot, d))
      })()
  for (const distRoot of candidates) {
    const distIndex = join(distRoot, 'index.html')
    if (!existsSync(distIndex)) continue
    if (readFileSync(distIndex, 'utf8').includes(`${prefix}/assets/`)) return distRoot
    if (fromEnv !== undefined) {
      throw new Error(
        `starhub-host-static: ${distIndex} 资源引用未带 ${prefix}/ 前缀;` +
        `请用对应 vite base 构建,或把 ${envVar} 指向正确 dist`,
      )
    }
  }
  throw new Error(emptyMessage)
}

/**
 * Resolve the Vue embed dist root (kept for compatibility; see `apply`).
 * @returns absolute dist root.
 */
export function resolveDistRoot(): string {
  return resolveDist(
    PREFIX, process.env.STARHUB_DIST, ['dist-embed', 'dist'],
    'starhub-host-static: 未找到 StarHub embed dist(先跑 npm run build:embed,或用 STARHUB_DIST 指定)',
  )
}

/**
 * Resolve the standalone React window app dist root.
 * @returns absolute dist root.
 */
export function resolveWindowDistRoot(): string {
  return resolveDist(
    WINDOW_PREFIX, process.env.STARHUB_WINDOW_DIST, ['dist-starhub-react'],
    'starhub-host-static: 未找到 StarHub React window dist(先构建 starhub-window,或用 STARHUB_WINDOW_DIST 指定)',
  )
}

/**
 * Serve one GET/HEAD request under a prefix from the dist root; a miss
 * falls back to index.html with 200 (SPA routing / embed query entries).
 * @param relPath - decoded pathname with the prefix already stripped.
 * @param res - the node:http response to write.
 * @param distRoot - absolute dist root directory.
 * @param distIndex - absolute path of index.html inside distRoot.
 */
export async function serveStatic(
  relPath: string, res: ServerResponse, distRoot: string, distIndex: string,
): Promise<void> {
  const target = resolve(normalize(join(distRoot, relPath)))
  // Traversal rejection mirrors frontend-static: resolve() emits backslash
  // paths on Windows, so the boundary check must use `sep`.
  if (target !== distRoot && !target.startsWith(distRoot + sep)) {
    res.writeHead(403)
    res.end()
    return
  }
  const serveIndex = async (): Promise<void> => {
    const body = await readFile(distIndex)
    res.writeHead(200, { 'content-type': MIME['.html'] })
    res.end(body)
  }
  if (target === distRoot || target === distIndex) {
    await serveIndex()
    return
  }
  try {
    const body = await readFile(target)
    res.writeHead(200, { 'content-type': MIME[extname(target)] ?? 'application/octet-stream' })
    res.end(body)
  } catch {
    // Miss (ENOENT/EISDIR) falls back to index.html with 200 (SPA routing).
    await serveIndex()
  }
}

/**
 * Build a static-file handler for one prefix route: 405 for non-GET/HEAD,
 * SPA fallback to index.html, 403 on traversal outside the dist root.
 * @param prefix - the prefix the pathname is sliced by.
 * @param distRoot - absolute dist root.
 * @param distIndex - absolute index.html within the dist root.
 * @returns the node:http request handler.
 */
export function staticHandler(
  prefix: string, distRoot: string, distIndex: string,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405)
      res.end()
      return
    }
    /* node:http always sets url on server requests. */
    const rawPath = new URL(req.url ?? '/', 'http://x').pathname
    await serveStatic(decodeURIComponent(rawPath).slice(prefix.length), res, distRoot, distIndex)
  }
}

/**
 * Claim both prefix routes and serve their dists. `/starhub` resolves
 * synchronously and fails the fiber at load if a qualifying embed dist is
 * missing. `/starhub-react` is best-effort: a missing React window dist logs a
 * warning and registers a 404 handler instead of failing the whole plugin, so
 * an unbuilt window app never breaks the shell or the `/starhub` embeds.
 * @param ctx - plugin context carrying the webServer service.
 */
export function apply(ctx: Context): void {
  const distRoot = resolveDistRoot()
  const distIndex = join(distRoot, 'index.html')
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'prefix', path: PREFIX, handler: staticHandler(PREFIX, distRoot, distIndex),
    }),
    'starhub-host-static: /starhub prefix route',
  )
  let windowHandler: (req: IncomingMessage, res: ServerResponse) => Promise<void>
  try {
    const windowDistRoot = resolveWindowDistRoot()
    const windowDistIndex = join(windowDistRoot, 'index.html')
    windowHandler = staticHandler(WINDOW_PREFIX, windowDistRoot, windowDistIndex)
  } catch (error) {
    // 未构建 starhub-window:仅 /starhub-react 不可用,不影响壳与 /starhub。
    console.warn(`starhub-host-static: /starhub-react 未就绪(独立 React 窗口不可用): ${(error as Error).message}`)
    windowHandler = async (_req, res) => {
      res.writeHead(404)
      res.end()
    }
  }
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: WINDOW_PREFIX, handler: windowHandler }),
    'starhub-host-static: /starhub-react prefix route',
  )
}
