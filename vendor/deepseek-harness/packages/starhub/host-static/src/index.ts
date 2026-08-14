/**
 * @deepseek-ai/dsh-starhub-host-static — StarHub dist server over a webserver
 * prefix route (StarHub-local package, not upstream). Claims `/starhub` as a
 * named prefix route (the dsh frontend keeps the fallback seat), serving the
 * StarHub frontend build with SPA semantics: traversal outside the dist root
 * is 403, a miss on a GET falls back to index.html with 200, non-GET/HEAD is
 * 405. Serving StarHub from the dsh origin is what lets the shell's same-origin
 * iframes inherit the Tauri IPC injection.
 *
 * The dist must be an embed build (vite base `/starhub/`, `npm run
 * build:embed`, repo `dist-embed/`): bare-base asset URLs (`/assets/...`)
 * would escape the prefix and hit the dsh fallback, so a non-embed index
 * fails loud at plugin load. Location resolution: `STARHUB_DIST` env first,
 * then `<repo>/dist-embed`, then `<repo>/dist`, where the repo root is found
 * by walking up from this module to the directory containing
 * `vendor/deepseek-harness`. No dist at all fails loud as well.
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

/** URL prefix this plugin serves; matches the embed build's vite base. */
export const PREFIX = '/starhub'

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
 * Resolve the served dist root: `STARHUB_DIST` wins; the fallback prefers the
 * embed build (`dist-embed/`) over the plain build (`dist/`). The index must
 * reference assets under the `/starhub/` prefix (the embed build's vite
 * base) — a plain `npm run build` dist would pull its scripts from the dsh
 * fallback and die at runtime, so it is rejected here instead.
 * @returns absolute dist root containing an embed-base index.html.
 * @throws when no qualifying dist exists — the composition cannot serve its iframe payload.
 */
export function resolveDistRoot(): string {
  const fromEnv = process.env.STARHUB_DIST
  const candidates = fromEnv !== undefined && fromEnv !== ''
    ? [resolve(fromEnv)]
    : (() => {
        const repoRoot = findRepoRoot()
        return repoRoot === undefined ? [] : [join(repoRoot, 'dist-embed'), join(repoRoot, 'dist')]
      })()
  for (const distRoot of candidates) {
    const distIndex = join(distRoot, 'index.html')
    if (!existsSync(distIndex)) continue
    if (readFileSync(distIndex, 'utf8').includes(`${PREFIX}/assets/`)) return distRoot
    if (fromEnv !== undefined && fromEnv !== '') {
      throw new Error(
        `starhub-host-static: ${distIndex} 不是 embed 构建(资源引用未带 ${PREFIX}/ 前缀);` +
        '请用 npm run build:embed 产出,或把 STARHUB_DIST 指向 embed dist',
      )
    }
  }
  throw new Error(
    'starhub-host-static: 未找到 StarHub embed dist(先跑 npm run build:embed,或用 STARHUB_DIST 指定)',
  )
}

/**
 * Serve one GET/HEAD request under the prefix from the dist root; a miss
 * falls back to index.html with 200 (SPA routing / embed query entries).
 * @param relPath - decoded pathname with the `/starhub` prefix already stripped.
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
 * Claim the `/starhub` prefix route and serve the embed dist. Dist resolution
 * runs synchronously so a missing or non-embed dist fails the fiber at load.
 * @param ctx - plugin context carrying the webServer service.
 */
export function apply(ctx: Context): void {
  const distRoot = resolveDistRoot()
  const distIndex = join(distRoot, 'index.html')
  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405)
      res.end()
      return
    }
    /* node:http always sets url on server requests. */
    const rawPath = new URL(req.url ?? '/', 'http://x').pathname
    await serveStatic(decodeURIComponent(rawPath).slice(PREFIX.length), res, distRoot, distIndex)
  }
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: PREFIX, handler }),
    'starhub-host-static: /starhub prefix route',
  )
}
