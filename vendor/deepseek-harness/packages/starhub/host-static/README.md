# @deepseek-ai/dsh-starhub-host-static

StarHub-local host plugin (not upstream). Registers the `/starhub` prefix route on the dsh `webServer` and serves the StarHub frontend embed build (`npm run build:embed` → repo `dist-embed/`, vite base `/starhub/`) with SPA fallback semantics, so the dsh Web GUI can embed StarHub pages in same-origin iframes that inherit the Tauri IPC injection.

Dist resolution: `STARHUB_DIST` env → `<repo>/dist-embed` → `<repo>/dist` (repo root found by walking up to the directory containing `vendor/deepseek-harness`). A dist whose index.html does not reference `/starhub/`-prefixed assets, or no dist at all, fails the plugin fiber at load — run `npm run build:embed` first.

## Known Limitations and Deferred Work

- Asset MIME coverage is the minimal set the StarHub build emits (html/js/css/svg/png/woff2/json/map); other extensions ship as `application/octet-stream`.
- HEAD responses currently write the body like GET (mirrors `frontend-static`).
