# @deepseek-ai/dsh-starhub-host-static

StarHub-local host plugin (not upstream). Registers two prefix routes on the dsh `webServer`:

- `/starhub` — the StarHub Vue frontend embed build (`npm run build:embed` → repo `dist-embed/`, vite base `/starhub/`) with SPA fallback, so the dsh Web GUI can embed StarHub pages in same-origin iframes that inherit the Tauri IPC injection.
- `/starhub-react` — the standalone React workbench window app (`npm run build:window` → repo `dist-starhub-react/`, vite base `/starhub-react/`). Independent windows opened for Tools instance clicks load this entry, which reuses the client-nav React workbenches full-window instead of a shell modal or a Vue embed.

Dist resolution for each prefix: the per-prefix env (`STARHUB_DIST` / `STARHUB_WINDOW_DIST`) → repo `dist-embed` / `dist-starhub-react` (repo root found by walking up to the directory containing `vendor/deepseek-harness`). A dist whose index.html does not reference its `/starhub` (or `/starhub-react`) prefixed assets fails that route at load. The embed dist is required (a missing one fails the fiber); the React window dist is best-effort — if unbuilt, `/starhub-react` serves 404 while the shell and `/starhub` keep working.

## Known Limitations and Deferred Work

- Asset MIME coverage is the minimal set the StarHub build emits (html/js/css/svg/png/woff2/json/map); other extensions ship as `application/octet-stream`.
- HEAD responses currently write the body like GET (mirrors `frontend-static`).
