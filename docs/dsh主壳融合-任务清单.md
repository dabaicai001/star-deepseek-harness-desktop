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

## P1 外壳融合

- [ ] starhub-web 组合固化(端口/数据目录/日志走 StarHub 约定,DSH_HOME 落应用数据目录)
- [ ] Rust 侧 web 服务管理器(仿 HarnessManager:spawn 便携 Node + bin.js web、健康检查、随应用退出回收)
- [ ] packages/starhub/host-static(host 插件):把 StarHub 前端 dist 挂到 webserver 的 `/starhub/` 前缀(替换 P0 的 SPA fallback 占位)
- [ ] client-nav 正式化:功能页页签清单、label/图标、embed 模式 URL 参数
- [ ] StarHub 前端 embed 模式(`?embed=1` 去壳:无标题栏/无侧边栏,供 iframe 用)

## P2 IPC 桥(按 spike 结论)

- [ ] iframe 内封装 `window.__TAURI_INTERNALS__.invoke` 访问层(embed 模式检测 + 降级)
- [ ] 事件通道:iframe 内 `listen`(Tauri event)可用性验证与封装
- [ ] dsh 会话与 StarHub 功能页的联动(如 AI 上下文绑定到当前终端/连接)

## P3 功能页逐个接入

- [ ] SSH 终端页签(iframe embed)
- [ ] SFTP 页签
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
