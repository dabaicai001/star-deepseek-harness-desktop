# @deepseek-ai/dsh-starhub-host-static

StarHub-local host plugin (not upstream). Registers the `/starhub-react` prefix route on the dsh `webServer` for the standalone React workbench window app (`npm run build:window` → repo `dist-starhub-react/`, vite base `/starhub-react/`). Independent windows opened for Tools instance clicks load this entry and reuse the client-nav React workbenches full-window.

The plugin resolves the dist from `STARHUB_WINDOW_DIST` or repo `dist-starhub-react` (the repo root is found by walking up to the directory containing `vendor/deepseek-harness`). Its `index.html` must reference `/starhub-react`-prefixed assets. A missing or incorrectly based build fails plugin startup.

## Known Limitations and Deferred Work

- Asset MIME coverage is the minimal set the StarHub build emits (html/js/css/svg/png/woff2/json/map); other extensions ship as `application/octet-stream`.
- HEAD responses currently write the body like GET (mirrors `frontend-static`).
