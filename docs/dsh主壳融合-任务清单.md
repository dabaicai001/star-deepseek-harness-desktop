# StarHub × dsh 主壳融合(方案 B)任务清单

> 配套方案:`docs/AI内核替换方案-deepseek-harness.md`(整体方向)与主壳融合计划(会话计划)。
> 目标形态:Tauri 主窗口直接加载 dsh 官方 Web GUI(host 由 Rust 拉起的 dsh web 服务),StarHub 各功能页(SSH 终端 / SFTP / DB / Docker 等)以 `conversation.view` 页签 + 同源 iframe 挂进 dsh 壳,经 Tauri IPC 直连 Rust 主进程。

## P0 技术验证 spike(2026-08-15 完成)

- [x] 最小 client-nav 包(`vendor/deepseek-harness/packages/starhub/client-nav/`):`dsh.client` manifest + `./client` exports + tsdown clientBundle 预设 + 空 node 半 + 浏览器半 `ctx.slots.inject('conversation.view', …)` 注册 `starhub-terminal` iframe 页签
- [x] starhub-web 组合(`vendor/deepseek-harness/examples/starhub-web/`):profile 形态(package.json 声明 dsh-base + dsh-web-app bundles + client-nav 依赖,cordis.patch.yml 固定 127.0.0.1:3085 并 insert client-nav 行,boot.mjs 物化 `$DSH_HOME/profiles/web` + 补 junction)
- [x] client 面构建:`npm run build:lib:client`(tsc + tsdown,含 client-nav 的 lib/index.js + lib/client.js)与 `npm run build:web`(apps/web dist)
- [x] 起服并 curl 验证(无浏览器自动化):
  - 服务日志 `dsh web: http://127.0.0.1:3085`,端口/地址符合 profile patch 配置
  - `GET /` → 200,index.html 内 `window.__DSH_BOOT__` 含 `"id":"@deepseek-ai/dsh-starhub-client-nav"`(url/rev/inject 完整)
  - `GET /plugins/@deepseek-ai/dsh-starhub-client-nav/client.js` → 200,内容为 `window.__ModuleLoader__.load({id: …, factory: …})` 包裹的 bundle
- [x] Tauri IPC 继承实验(决定性):devUrl 指向 dsh 服务(127.0.0.1:3085),`npm run tauri:dev` 起真窗口;探测页(顶层 + 同源 iframe)经 no-cors fetch 回报本地监听:
  - 顶层帧:`__TAURI_INTERNALS__` 存在、`invoke` 为函数(0ms 即注入)
  - 同源 iframe:同样注入,`window.top.location.origin` 可读(同源成立)
  - 顶层与 iframe 内 `invoke('local_system_info')` 均真实往返成功(rpc=ok)
  - **结论:同源 iframe 白嫖 Tauri IPC 成立(端到端实测)**,P2 的 IPC 桥可直接在 iframe 内 `__TAURI_INTERNALS__.invoke`;无需 `dangerousRemoteDomainIpcAccess`

## P1 外壳融合(2026-08-15 完成)

- [x] starhub-web 组合固化:`boot.mjs` 同时补 client-nav + host-static 两个 junction;Rust 侧物化到 `<app_data_dir>/dsh-web-home`(boot.mjs 手动流仍用 `tmp/dsh-web-home`)
- [x] Rust 侧 web 服务管理器 `src-tauri/src/harness/web.rs`(DshWebManager):物化 profile + 改写 webserver 端口 + junction + spawn `bin.js web`,3085 占用递增(上限 +10),GET / 轮询就绪(30s),kill_on_drop + 主窗口销毁时 shutdown 回收;`dsh_web_url` command;`STARHUB_DSH_WEB=0` 逃生门
- [x] packages/starhub/host-static(host 插件):`/starhub` 前缀路由托管 StarHub embed dist(STARHUB_DIST > dist-embed > dist;非 embed 构建 fail loud;SPA fallback / 403 防穿越 / 405)
- [x] client-nav 正式化:`sidebar.footer.action` 注册 8 个功能页条目(终端/数据库/Redis/ES/Docker/Broker/Excel/设置)+ `shell.overlay` 注册整帧 iframe 层(共享 nav store;再点当前条目/Esc/关闭按钮关闭;P0 的 conversation.view 占位已删);条目 ↔ 路由常量表在 `src/client/sections.ts`
- [x] StarHub 前端 embed 模式:`src/lib/embed.ts`(`?embed=1&route=<path>`)+ App.vue 跳过启动页门控 + CyberLayout embed 去壳分支(无 titlebar/tab 条/侧栏/状态栏、不套 keep-alive、禁拖出、`/` 回退守卫、Esc postMessage);embed 构建 `npm run build:embed`(vite mode=embed,base `/starhub/`,产物 `dist-embed/`),router 用 `createWebHistory(import.meta.env.BASE_URL)`
- [x] 双轨开发流 `npm run tauri:dev:dsh`(`src-tauri/tauri.dev-dsh.json` 覆盖 devUrl/beforeDevCommand,默认 tauri.conf.json 不动):beforeDevCommand = `scripts/dev-dsh-shell.mjs`(vendor 构建存在性检查 + sidecar:build + build:embed + 3085 占位等待页;真实 dsh web 由 Rust 拉起在 3086+,占位页内 JS 轮询同源 `/__dsh_url` 拿到真实地址后自跳转 location.replace)

## P2 IPC 桥(按 spike 结论)

- [ ] iframe 内封装 `window.__TAURI_INTERNALS__.invoke` 访问层(embed 模式检测 + 降级)
- [ ] 事件通道:iframe 内 `listen`(Tauri event)可用性验证与封装
- [ ] dsh 会话与 StarHub 功能页的联动(如 AI 上下文绑定到当前终端/连接)

## P3 功能页逐个接入

> P3a 第一批(2026-08-15 完成):SSH/SFTP 接入 + 资产选择骨架。
> - 资产选择骨架:`src/components/common/EmbedAssetBar.vue`(embed 顶部细条:段图标 + 当前资产下拉 + 切换 = router.replace 同段新 instanceId;无资产给「去设置添加」)+ `src/components/common/EmbedSectionEmpty.vue`(段空态页);段事实表与解析在 `src/lib/embed.ts`(`EMBED_SECTIONS` / `resolveEmbedTarget` / `embedSectionForRoute` / `postEmbedOpenSection`,match 复用 `routeNameForAsset`)
> - 段路由:client-nav `sections.ts` 改为无 id 段路由(`/ssh`、`/db/mysql` …),StarHub router 新增 9 条静态段路由(meta.embedSection → 空态页);embed 守卫(CyberLayout)有资产 → replace 到 `<prefix>/<instanceId>`,无资产 → 停空态;旧外壳不可达、行为不变
> - 「去设置添加」链路:embed postMessage `starhub-embed-open-section` → client-nav overlay 校验 key 后 `openSection`(store 新增 action)切到设置页 iframe
> - SSH/SFTP 页适配结论:Ctrl+W 等窗口级快捷键 embed 分支本就不挂;windowDetach 的 emitTo/listen 在 embed 惰性;TransferDock 挂进 embed 分支(每功能 iframe 一份,SFTP 在同页)
> - 实测:stub 服务器(test-sftp/server.py 扩展 shell/exec/持久 host key)上,真窗口 embed `/ssh` 自动解析资产并 `ssh_connect` 成功(pty+shell+断线自动重连,仪表盘 exec 轮询正常);russh-sftp ↔ stub 互操作由 `src-tauri/tests/sftp_stub.rs`(#[ignore] 手动测试)覆盖读目录/上传/下载/删除

- [x] SSH 终端页签(iframe embed)
- [x] SFTP 页签
- [ ] DB / Redis / ES 页签
- [ ] Docker 页签
- [ ] 其余页签(Settings / 审计 / Excel 等)

## P4 退役与切换 + 打包

- [ ] 旧 Vue 壳路由切换到 dsh 壳为默认入口
- [ ] 退役旧 AiView 壳路径残留(AiChat 宿主等)
- [ ] 打包:apps/web dist + client bundles 纳入构建链,便携 Node / dsh runtime 入包

## P5 全站换皮 dsw

- [ ] StarHub 页面向 dsh `--dsw-*` token 体系靠拢(见方案文档第 9 节)

## P6 文档/版本收尾

- [ ] 方案文档/架构图/AGENTS.md 同步
- [ ] CHANGELOG 与七处版本号
