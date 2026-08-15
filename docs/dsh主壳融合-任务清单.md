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
- [x] DB / Redis / ES 页签
- [x] Docker 页签
- [x] 其余页签(Settings / 审计 / Excel 等)

> P3b 第二批(2026-08-14 完成):DB(MySQL/PG/ClickHouse 共用 DbView)/ Redis / ES / Docker / Broker / Excel / Settings 全部接入。
> - **真 bug 修复:embed 入口白屏**。入口 URL `/starhub/index.html?embed=1&route=...` 经 history base(`/starhub/`)剥离后路径是 `/index.html`,router 无匹配 → 整树不挂载(P3a 真窗口走的是 vite 1420 根路径,没踩到;P3b 探针实测发现)。修复:router 新增 `index.html` 子路由(空占位,CyberLayout 挂载后由 embed 分支读 query.route 再 replace)。
> - **ES/Excel 资产解析去 tabs 依赖**:ElasticsearchView/ExcelView 原先经 `appStore.tabs` 反查 assetId,embed 没有 tab 系统恒为空 → 改为直接从 instanceId `parseInstanceId` 解析(与 DbView/RedisView/DockerView/BrokerView 同模式,旧外壳语义不变)。
> - **Settings embed 化**:`/settings` 在 embed 下整页渲染(旧外壳的 dialog 形式只存在于 CyberLayout 非 embed 分支,天然不冲突);SettingsView header 新增 embed 关闭按钮(postMessage `starhub-embed-escape` 复用 Esc 通道让 client-nav overlay 关层);client-nav 设置条目路由 `/settings` 无需改。
> - **无人值守 DOM 探针验证法**(新配方,见踩坑记录 §22):同源 iframe 探针页(`tmp/p3b-smoke/probe.html`)放进 dist-embed 由 host-static 托管,真窗口加载探针 → 探针内顺序 iframe 各功能页 → DOM 摘要(路由/资产条/空态/正文)no-cors 回报本地采集器。7 页 + clickhouse 空态全部拿到 DOM 级证据。
> - 实测矩阵:全部页面「资产解析 → 段路由 replace → 页面挂载 → 错误态/空态」DOM 级验证通过;本机无 Docker daemon / MySQL / Redis / ES / Kafka,真实服务联通未实测(仅错误态验证,sidecar `go test ./...` 全绿兜底)。

## P4 退役与切换 + 打包

- [x] 旧 Vue 壳路由切换到 dsh 壳为默认入口(P4a,2026-08-15)
- [x] 退役旧 AiView 壳路径残留(P4a;AiChat 宿主 / stores/ai.ts / local_* 命令保留,dsh 内核 HarnessManager 保留待 D3/P2)
- [x] 打包:apps/web dist + client bundles 纳入构建链,便携 Node / dsh runtime 入包(P4b,2026-08-15)

> P4a(2026-08-15 完成):默认入口切换 + AiView/LocalView 退役 + 旧外壳代码退役。
> - **默认入口**:`tauri.conf.json` devUrl=127.0.0.1:3085 + beforeDevCommand=`scripts/dev-dsh-shell.mjs`(双轨取消,`tauri:dev:dsh` 别名与 `tauri.dev-dsh.json` 删除);**decorations 改 true**(native 标题栏,dsh GUI 无窗口控件,自画 chrome 随旧外壳删除);`STARHUB_DSH_WEB=0` 逃生门移除(旧外壳已删,无回退目标)。
> - **prod 方案(取舍)**:`frontendDist` 指本地 `shell-placeholder/` 跳板页(轮询 `dsh_web_url` command → `location.replace`),不用 remote URL——配置窗口在 setup 完成前就开始加载,远程地址未就绪会落在错误页且不重试。dist-embed / dsh runtime 入包是 P4b 的事。
> - **AiView/LocalView 退役**:`/ai`、`/local` 路由删除;AiView.vue / LocalView.vue / aiHarnessProjection.ts(+ 其 node --test 与 package.json 脚本)/ stores/localView.ts / components/local/ 删除;i18n `local:` 段(中英)删除;services/ai.ts 的旧 Tauri 通道 `chat()`/`listModels()` 前端死导出删除(Rust 侧 ai_chat/ai_list_models 暂未下线,留 P6)。
> - **旧外壳退役**:CyberLayout 瘦身为 embed 唯一形态(EmbedAssetBar + router-view + TransferDock);windowDetach.ts / AssetTree / AssetTreeNode / CommandPalette / SidebarHandle / NotificationCenter 删除;SshTerminal 拖出附加/送回逻辑清除;capabilities 去掉 `detach-*`。**stores/app.ts tab 系统保留**(消费者仍在:DbView 导出 Excel、WebBrowserView web tab、objectTree.openAndSelect;embed 下惰性 no-op,彻底移除留待后续);告警轮询 startAlertCheck 随旧外壳失去宿主,embed 不启动(避免 N 个 iframe 各自 60s 轮询)。
> - **资产 CRUD 新家**:SettingsView 新增「资产」tab(默认 tab,列表 + 新建/编辑复用 NewConnectionDialog + 删除确认),EmbedAssetBar/EmbedSectionEmpty 的「去设置添加」落点即此。
> - **实测**(真窗口 + DOM 探针,tmp/p4a-smoke/):`isDecorated()=true`;dsh GUI 侧栏 8 条目 DOM 在;8 条目逐一点击 overlay 开出(src=/starhub/index.html?embed=1&route=...)再点关闭全过;embed /ssh 真连 test-sftp stub(CONNECTED + 仪表盘 exec);设置页资产 tab 渲染 + IPC create/delete 往返 DOM 验证;默认 `npm run tauri:dev` 链路(占位页 3085 → Rust dsh web 3086)日志 + curl 证据。

## P5 全站换皮 dsw

- [x] StarHub 页面向 dsh `--dsw-*` token 体系靠拢(见方案文档第 9 节,2026-08-15)

> P5(2026-08-15 完成):移除 `.cyber-panel/.cyber-card` 顶部 liquid-light 发光灯带(扁平化 + hairline 描边);收敛散落 `--glow-cyan/--glow-pink` 残留(danger 按钮/拖拽把手/拖放区/进度条/overlay/开关)到克制阴影或移除;`--glow-soft` 暗色 token 中性化(去青,保留极轻环境光);输入 focus 光晕动画与硬编码 `rgba(93,214,214)` 收敛为 hairline focus ring。

## P6 文档/版本收尾

- [x] 方案文档/架构图/AGENTS.md 同步
- [x] CHANGELOG 与七处版本号
