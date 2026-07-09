# 更新日志 (Changelog)

本项目的所有重要变更都会记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/),
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/) 规范。

## [未发布]

### 计划中
- PostgreSQL / SQLite 数据库适配器
- AI 助手流式输出
- ZMODEM 文件传输
- Settings 补「代理」「安全」2 个 tab

---

## [0.14.15] - 2026-07-09

### 修复
- 🐛 fix(excel): 彻底修复 Excel 数据区下方留白。Vite 实测确认 StarHub 的 Univer 挂载容器 `.univer-grid` 与 Univer 0.25.1 全局 `display: grid` 工具类同名,导致 504px 容器被自动拆成 290px + 214px 两行,Workbench 只占第一行。挂载容器改名为 `.univer-host`,避开全局类污染,数据画布现在会完整铺到 Sheet 标签栏。
- 🐛 fix(excel): 纯 Vite 开发环境不再调用 Tauri Webview 拖放 API,便于使用浏览器 mock 数据排查 Excel 布局。

---

## [0.14.14] - 2026-07-09

### 修复
- 🐛 fix(excel): 继续修 Excel 视图下方留白(v0.14.13 的 grid 模板兜底只让数据多 1 行+2 列,远不够)。v0.14.14 直接放弃 grid 兜底,改用 flexbox 强制撑开 `[data-u-comp="workbench-layout"]` → 中间 section → `[data-range-selector]` 的整条高度链。`UniverGrid.vue` 给 `workbench-layout`、`.univer-grid`、中间 section、`data-range-selector` 分别加 `display: flex` / `flex-direction: column|row` / `flex: 1 1 0` / `min-height: 0`,让 canvas 的 mountPoint 直接填满到 StarHub 状态栏上方,不依赖 Tailwind 任意值 grid 模板。

---

## [0.14.13] - 2026-07-09

### 修复
- 🐛 fix(excel): 修复 Excel 视图下方大面积留白。Univer 0.25.1 用 Tailwind 任意值语法写的 grid 模板类(`univer-grid-cols-[auto_1fr_auto]`、`univer-grid-rows-[100%]`、`univer-grid-rows-[auto_1fr]`、`univer-grid-rows-[auto_1fr_auto]`)在 `@univerjs/design` 编译产物里被 Tailwind JIT 漏掉,导致 `Workbench` 两层 grid 退化成单行单列,`[data-range-selector]` 拿不到 `1fr` 那行的高度,只能缩到 canvas 自身的内容高度(约 10 行)。`UniverGrid.vue` 增加 `:deep()` 兜底,把缺失的 `grid-template-*` 与右侧栏 `z-index: 100` 补回去,canvas 现在能跟着窗口撑满到 Sheet 标签条上方。

---

## [0.14.12] - 2026-07-09

### 优化
- ⚡ perf(excel): `UniverGrid` 把 `requestUniverResize` 从「`MutationObserver` 持续监听 `attributes:style`」改为「轻量 `MutationObserver` 仅等 `[data-range-selector]` 出现 → 立刻切换为 `ResizeObserver` 监听 mountPoint 尺寸变化」。`ResizeObserver` 的初始回调顺带校准一次,处理引擎 `_previousWidth/_previousHeight` 缓存导致首次挂载尺寸错位的旧 bug。比持续监听 style 更省 CPU,也避免了父层尺寸变化时 style 抖动引起的多余回调。

---

## [0.14.11] - 2026-07-08

### 优化
- ⚡ perf(excel): `UniverGrid` 把"等 Univer 画布挂载 + 强制引擎重测尺寸"从 `setInterval(50ms)` 轮询改为 `MutationObserver`,DOM 真正变化才触发回调,画布尺寸对齐就立刻 disconnect。比之前省 CPU,且对齐响应更快。

---

## [0.14.10] - 2026-07-08

### 修复
- 🐛 fix(home): 修复首页右上角内容溢出。收紧工作区与空 tab 最近使用条的 flex 边界,并让首页指标、能力卡片和最近工作网格按容器宽度自动换列,避免长文件名或多列卡片把右侧顶出窗口。

---

## [0.14.9] - 2026-07-08

### 修复
- 🐛 fix(excel): 修复 v0.14.8 收缩 `UniverGrid` 外层容器导致数据画布不显示、Sheet 标签栏上浮的问题;恢复外层 flex 占位让 SheetBar 固定在底部,并将工作簿尾行从一整屏改为少量自适应缓冲,避免底部继续出现大段空白网格。

---

## [0.14.8] - 2026-07-08

### 修复
- 🐛 fix(excel): `UniverGrid` 外层容器改为按 Univer 实际 `[data-range-selector]` 区域高度收缩,同时移除外层网格兜底背景,避免数据区下方继续铺满整页。

---

## [0.14.7] - 2026-07-08

### 修复
- 🐛 fix(excel): `UniverGrid` 恢复按当前视口高度补齐底部网格,并给工作区底层增加 Excel 网格背景兜底,避免数据末尾到 Sheet 标签栏之间露出大块纯白留白。
- 🐛 fix(redis): Redis key 读取遇到已过期/已删除 key 时不再返回 RPC `-32603`,而是转换为可读的“Key 已不存在或已过期”状态;hash/set/zset/list 预览限制为 1000 条采样,避免大 key 查询一次性拉全量导致卡顿。
- 🐛 fix(redis): 修复 Redis 切换 DB 后 `SCAN` 偶发扫不到 key 的问题。原实现通过连接池执行 `SELECT db`,只改变了池中单条连接的 DB,后续 `SCAN/GET/TYPE` 可能落到其他仍在旧 DB 的连接;现在切 DB 会重建 Redis client 连接池,确保 `DBSIZE`、Key 列表和读取都在同一个 DB。
- ⚡ perf(redis): Redis key 浏览器单次 SCAN 页面从 500 下调到 120,降低远程 Redis 上 `SCAN + TYPE + TTL` 批量查询的瞬时压力。

---

## [0.14.6] - 2026-07-08

### 修复
- 🐛 fix(excel): 将 `UniverGrid` 数据下方的尾部空白网格从一个视口高度缩小为固定 2 行,避免滚到底部后仍显示过长空白网格。

---

## [0.14.5] - 2026-07-08

### 修复
- 🐛 fix(excel): 修复 Excel 滚到底部仍露出大块空白的问题。`UniverGrid` 不再只按真实数据行 + 5 行 buffer 结束画布,而是在数据后补一个视口高度的网格尾部,用 `D:/中汇豪泰/执行结果11/导出_2026-07-03.xlsx` 这类 1 表头 + 100 行真实数据文件滚动到底时仍保持 Excel 网格背景。
- 🎨 style(excel): Excel 工作区主题从 StarHub 青色暗色面板调整为 Office Excel 绿色标题栏 + 浅色 Ribbon / 网格 / 选区,Univer canvas 主题同步读取 `--excel-*` token,AI 表头样式也改为 Excel 绿。
- 🐛 fix(chrome): 标题栏最小化 / 最大化 / 关闭按钮改用 MDI 图标并固定窗口控件宽度,提高默认可见性,避免右上角按钮在缩窄或主题切换时消失。

---

## [0.14.4] - 2026-07-08

### 修复
- 🐛 fix(excel): 彻底修复 Excel 页面数据下方大面积留白 -- 根因是 Univer Engine 的 `resize()` 方法会缓存上次测量的尺寸(`_previousWidth`/`_previousHeight`),当尺寸未变时跳过 resize,导致画布在 300ms 延迟挂载后尺寸不正确且无法自动修正。修复:1) `requestUniverResize` 改为轮询方式(每 50ms 检查一次,最多 1.5s),等待画布挂载后直接重置引擎尺寸缓存(`_previousWidth = -1`)强制重新测量,若仍不匹配则直接调用 `resizeBySize()` 设置正确尺寸;2) `renderWorkbook` 在创建 Univer 实例前等待容器有非零高度(ResizeObserver + 500ms 超时兜底),避免 0 高度挂载;3) `disposeWorkbook` 清理容器 innerHTML 防止残留 DOM 干扰下次渲染;4) 移除 CSS 中的调试边框(lime/cyan outline);5) `[data-u-comp="workbench-layout"]` 增加 `height: 100% !important` 确保工作区填满容器。

---

## [0.14.3] - 2026-07-08

### 修复
- 🐛 fix(excel): 修复 Excel 页面大面积留白 -- Univer Engine 的 ResizeObserver 使用 `requestIdleCallback` 延迟画布 resize,导致画布尺寸长时间不正确。修改 `@univerjs/engine-render` 编译产物(ES + CJS),将 `requestIdleCallback` 替换为 `requestAnimationFrame` 使画布在下一帧立即 resize;同时增强 `UniverGrid.vue` 的 `requestUniverResize`,增加多次延迟触发(100ms/350ms/600ms)覆盖 Univer 300ms 延迟挂载,并直接检测 canvas 与容器尺寸是否匹配来强制触发 resize。

---

## [0.14.2] - 2026-07-08

### 修复
- 🐛 fix(excel): 修复 Excel 页面大面积留白根因 -- `UniverGrid.vue` 的所有 `:deep()` CSS 选择器(如 `.univer-workbench`、`.univer-sheet-canvas` 等)使用的是 Univer 旧版类名,在 Univer 0.25.1 中不存在(改用了 Tailwind 工具类 + `data-u-comp` 属性),导致全部深色主题覆盖 CSS 失效。修复:1) 通过 Univer 官方主题系统注入 `starhubTheme`(覆盖 `gray.800`/`gray.900` 为 `#0d1420`/`#080d14`),传入 `darkMode: true`;2) CSS 选择器全部替换为 `[data-u-comp="workbench-layout"]`、`[data-range-selector]`、`[data-u-comp="render-canvas"]` 等属性选择器;3) 移除 330 行对 canvas 渲染元素的无效 CSS(行/列头、单元格、选区等由画布引擎绘制,无法用 CSS 覆盖);4) `requestUniverResize` 从 dispatch `window.resize`(Univer 不监听)改为短暂修改容器尺寸触发 Engine 的 `ResizeObserver`;5) `VISIBLE_MIN_ROWS` 从 24 提升到 40。

---

## [0.14.1] - 2026-07-08

### 修复
- 🐛 fix(excel): 在 v0.14.0 重写基线上补齐真正的自控网格渲染,`ExcelGrid` 明确绘制公式栏、列头、字段名第 1 行、全部数据行和视口补齐空白网格行,避免 Excel 工作区只画到第 10 行后露出整块白底。
- 🔧 chore(release): 同步 package / Cargo / Tauri / lock / AGENTS 到 v0.14.1,修正 v0.14.0 后遗留的版本源不一致。

---

## [0.13.11] - 2026-07-08

### 修复
- 🐛 fix(excel): 重写 Excel 页面中间工作区,`ExcelView` 不再使用 Univer 画布渲染网格,改为 `ExcelToolbar + ExcelGrid` 自控布局;网格明确渲染公式栏、列头、字段名第 1 行、数据行和填满视口的空白网格行,按 `store.rowData.length` 铺出 100 行数据,避免第三方画布只画到第 10 行后露出整块白底。

---

## [0.13.10] - 2026-07-08

### 修复
- 🐛 fix(excel): 修复含 100 行数据的 Excel 仍只画到第 11 行、下方大面积纯白的问题。`UniverGrid` 之前按最后一个非空单元格推断 `rowCount`,会把 Excel 中真实存在但内容为空的数据行从渲染层裁掉;现在 `rowCount` 改为按 `store.rowData.length + 表头 + buffer` 渲染,sidecar 读到多少数据行就画多少行网格,空数据行也保留行号和网格线。

---

## [0.13.9] - 2026-07-08

### 修复
- 🐛 fix(excel): 修复 Univer 工作区底部仍出现大块纯白留白的问题。上一版只裁掉了数据源尾部空行,但前端又把 Univer 容器高度按内容裁短,导致水平滚动条停在上方、Sheet 标签栏前露出外层白底;现在 Univer 容器始终占满 Excel 工作区,`rowCount` 同时按真实数据末行和当前视口可容纳行数兜底,窗口尺寸变化时自动重建 workbook 并触发 Univer resize。

---

## [0.13.8] - 2026-07-08

### 修复
- 🐛 fix(excel): 修复 Excel 视图大面积留白 —— `sidecar/adapters/excel.go` 的 `ReadSheet` 用 `excelize.GetRows` 直接拿整张 sheet 的物理 row,会把"曾经编辑过但已清空"的行也一并返回,前端 `store.rowData` 一次性收到 100 行(其中 90 行空白),导致状态栏显示 `100/100`、Univer 渲染远超真实数据量的画布。修复:`ReadSheet` 增加 `trimTrailingEmptyRows` 裁掉数据区尾部所有 cell 为空的行,`totalRows` 也按裁剪后的真实数据行数返回;前端 `stores/excel.ts#loadData` 加双保险再裁一次;`UniverGrid#lastNonEmptyDataIndex` 改用更稳健的 null-safe 判断;新增 Go 单测 `TestReadSheetTrimsTrailingBlankRows` 锁定行为

---

## [0.13.7] - 2026-07-08

### 改进
- 🔧 chore(brand): 移除死代码旧 Logo `src/assets/logo.png`(旧版小星星 + "starhub" 文字 logo,代码侧已统一引用 `logo-star.png`,新文件并存易混淆),保持仓库图标资产单一事实来源
- 🔧 chore(release): 同步 5 处版本号 0.13.6 → 0.13.7

---

## [0.13.6] - 2026-07-08

### 文档
- 📝 docs(agents): AGENTS.md 新增 10.6 节「应用图标管理」,记录图标 3 个独立位置(打包图标 / 标题栏 / 前端引用)、换 Logo 标准流程 7 步、以及 v0.13.2~v0.13.5 踩过的 5 个坑(JPEG 伪装 PNG / CSS 几何 Logo / Tauri 构建缓存 / SVG 手动嵌入 / Windows 图标缓存)

---

## [0.13.5] - 2026-07-07

### 修复
- 🐛 fix(brand): 标题栏 Logo 还是 CSS 画的旧 S 轨道图标,桌面快捷方式/任务栏图标还是旧设计;CyberLayout titlebar 从 CSS 几何 Logo 改为 `<img>` 引用 `logo-star.png`(H1 星星设计);用 `tauri icon` 从 `H1-text-below-transparent.png` 重新生成全套打包图标(ICO/ICNS/PNG/iOS/Android/Store Logo),确保 exe / 快捷方式 / 托盘全部统一为新星星 Logo

---

## [0.13.4] - 2026-07-07

### 修复
- 🐛 fix(brand): H1-text-below-real.png 无透明通道(Format24bppRgb,米黄色背景),生成的 icon.ico/icon.png 也无透明背景,导致 exe 图标显示为带背景的方形;用 LockBits 将背景色(R≈254 G≈251 B≈238,容差40)设为 Alpha=0(83.6% 像素透明),重新生成全套图标(ICO/ICNS/PNG/iOS/Android);icon.ico MD5 从 062E0003 变为 2DC50447(57934 bytes)

---

## [0.13.3] - 2026-07-07

### 修复
- 🐛 fix(excel): UniverGrid `rowCount` 包含 `containerRows`(容器可容纳行数+5)导致数据少时画布出现大量空行留白;移除 `containerRows`,rowCount 改为 `max(数据行+5, 5)`;新增 `applyContainerHeight()` 让 Univer 容器高度自适应到内容(`min(行数×22+表头, 父容器高度)`),ResizeObserver 改为监听父容器避免循环触发
- 🐛 fix(brand): `icon.svg` / `icon-source.svg` 仍为旧 "S 轨道" 设计,`tauri icon` 不生成 SVG;改为以 `icon.png` base64 嵌入 SVG `<image>` 保持一致;重新生成 `icon.icns`

---

## [0.13.2] - 2026-07-07

### 改进
- 🎨 style(brand): 应用 Logo 更换为 H1-text-below 设计,从 `icons/_candidates/H1-text-below.png`(JPEG 伪装 .png,先用 .NET System.Drawing 转真 PNG)用 `tauri icon` 重新生成全套打包图标(ICO/ICNS/PNG/iOS/Android/Store Logo);CyberLayout titlebar 内 HTML logo 从 CSS 几何轨道风改为 `<img>` 引用实际图标

---

## [0.13.1] - 2026-07-07

### 修复
- 🐛 fix(excel): UniverGrid `rowCount` 未考虑容器实际高度,数据少的表格在下方出现大范围纯空白;改为 `max(数据行+buffer, 30, 容器可容纳行数+5)`

---

## [0.13.0] - 2026-07-07

### 新增
- ✨ feat(motion): 新增 Motion System 交互动画基础设施,在 `cyber.css` 追加弹性曲线 token(`--ease-back` / `--ease-spring` / `--ease-back-strong`)与时长 token(`--dur-fast` / `--dur-mid` / `--dur-slow`);提供路由切换(`.cyber-route-*`)、Tab 增删(`.cyber-tab-*`)、列表过渡(`.cyber-list-*`)、弹窗入场(`.cyber-dialog-*`)、欢迎页 stagger(`.cyber-stagger`)、数字 pop(`.cyber-count-pop`)、骨架屏(`.cyber-skeleton`)、按钮 press 微缩等组件类;尊重 `prefers-reduced-motion` 无障碍降级

### 改进
- 🎨 style(layout): `CyberLayout` 路由切换包 `<Transition name="cyber-route" mode="out-in">`(fade + slide + scale + blur 弹性入场),Tab 栏包 `<TransitionGroup name="cyber-tab">`(滑入滑出 + FLIP 移动),欢迎页元素按 `--i` 交错入场,状态栏资产计数变化时 `.cyber-count-pop` 弹跳反馈
- 🎨 style(asset): `AssetTree` 收藏 / SSH / DB / Docker / Excel 五个分组的 v-for 包 `<TransitionGroup name="cyber-list">`,资产增删有滑入滑出过渡
- 🎨 style(dialog): `GlobalDialogHost` 与设置弹窗的 `v-dialog` transition 从 `dialog-bottom-transition` 换成 `cyber-dialog`(弹性 scale + fade + 上浮)
- 🎨 style(hover): `.cyber-card` / `.connection-card` / `.feature-card` / `.recent-card` hover 上抬加深(translateY -4px) + 轻微放大(scale 1.008) + 光晕增强

---

## [0.12.3] - 2026-07-07

### 改进
- 🎨 style(brand): 应用图标更换为 `H1-text-below`,通过 `tauri icon` 从 `icons/_candidates/H1-text-below.png` 重新生成全套打包图标(Windows ICO / Store Logo、macOS ICNS、各尺寸 PNG、iOS AppIcon、Android mipmap);源文件实为 JPEG 伪装 .png 扩展名,先用 .NET System.Drawing 转成真 PNG 再生成

---

## [0.12.2] - 2026-07-07

### 修复
- 🐛 fix(db): 修复 `src-tauri/src/db/mod.rs` 中 `key_id` 被 `sqlx::query().bind(key_id)` move 后又在 `keyring::store(key_id, ...)` 复用导致的 `E0382 use of moved value` 编译错误,改为 `&key_id` 借用
- 🐛 fix(ssh): 去掉 `src-tauri/src/ssh/session.rs` resize 函数中多余的 `let mut ch`,消除 `unused_mut` 警告
- 🐛 fix(build): 修复 `vue-tsc --noEmit` 类型检查阻断打包的两处错误 —— `KeyBrowser.vue` 补 `onBeforeUnmount` import;`AiChat.vue` 用 `idx` 替换未定义的 `msgKey` 作为 v-for key

### 改进
- 🔧 chore(release): 同步 Tauri / Rust / package.json 三处版本号到 0.12.2,修复此前 `Cargo.toml` 与 `tauri.conf.json` 仍停留在 0.12.0、与 `package.json`(0.12.1)不一致的问题
- 📝 docs(agents): 在 AGENTS.md 第 6.5 节明确「每次更新代码必须同步更新版本号」的硬约束,并将发布检查清单扩展为覆盖 `package.json` / `src-tauri/Cargo.toml` / `src-tauri/tauri.conf.json` / `CHANGELOG.md` / `AGENTS.md` 五处

---

## [0.12.1] - 2026-07-07

### 改进
- 🎨 style(brand): 重新设计应用 Logo 与 `StarHub` 字标,采用手绘插画风格(奶油底 + 粉色 / 芥末黄 / 鼠尾草绿水彩 + 圆润手写体),告别几何轨道风
- 🎨 style(brand): 全套打包图标资源(Windows `.ico` / macOS `.icns` / Linux PNG / iOS / Android / Windows Store)替换为新版 Logo,exe 安装包与系统托盘同步更新

---

## [0.12.0] - 2026-07-03

### 新增
- ✨ feat(excel): Excel 工作区封装 Univer Sheets,接入开源 preset 能力集(公式、格式、筛选、排序、查找替换、数据验证、条件格式、超链接、批注、表格、绘图/附件等),保留 StarHub 自有删除重复项与按选中列去重到新 Sheet 功能
- ✨ feat(excel): 固定 Univer 与 Univer Presets 上游源码到 `vendor/`,并新增 `src/lib/univer.ts` 作为 StarHub 本地封装入口,便于后续按上游源码调整适配逻辑

### 改进
- 🎨 style(excel): 用 Univer 原生表格画布替换自研网格渲染层,保留 StarHub 工具栏、SheetBar、AI 助手与状态栏作为外层工作台
- 🐛 fix(excel): Univer 网格按「数据最后一行 + 20 行 buffer」渲染 sheet,数据下方不再留出与文件总行数等高的全空白画布,大表格下视觉留白显著减少;store 仍保留文件全部原始行,保存时不会丢数据

---

## [0.11.7] - 2026-06-26

### 改进
- 🎨 style(light-theme): 将浅色主题主色调整为低饱和钢蓝/灰绿,降低白底下青色高亮的刺激感
- 🎨 style(db): 统一数据库图标、类型徽章、DB 表单与数据表格选中态为低饱和视觉 token
- 🎨 style(brand): 生成并提交新版 StarHub 几何轨道 Logo 打包图标资源,用于 exe / 安装包 / 系统图标

---

## [0.11.6] - 2026-06-26

### 改进
- 🎨 style(ui): 调整全局暗色主题为低饱和控制台色调,降低青色/紫色光晕强度并统一主框架、资产树与命令面板视觉层次
- 🎨 style(brand): 优化应用 Logo 与 StarHub 字标,使用几何标识和 Orbitron 字体增强品牌质感
- 🎨 style(ux): 统一资产打开交互,单击优先激活已有标签,右键/标签栏加号保留新标签多开能力并恢复 Docker 资产入口
- 📝 docs(readme): 刷新 README 到 v0.11.6 功能、快捷键与打包说明
- 🔧 chore(release): 同步 Tauri 与 Rust 包版本到 0.11.6

---

## [0.11.5] - 2026-06-26

### 修复
- 🐛 fix(ssh): 修复终端 Ctrl+V 粘贴可能被浏览器/xterm 默认事件重复处理的问题

---

## [0.11.4] - 2026-06-26

### 新增
- ✨ feat(excel): 增加原生打开模式,可一键交给系统 Office Excel / 默认表格程序编辑当前文件

### 改进
- 🎨 style(excel): Excel 工作区切换为 Office 风格标题栏、Ribbon、公式栏、网格与 Sheet 标签

---

## [0.11.3] - 2026-06-26

### 改进
- 🎨 style(ui): 各业务侧边栏支持拖拽伸缩,拖到阈值以下自动收起

---

## [0.11.2] - 2026-06-23

### 修复
- 🐛 fix(excel): 本地列头筛选支持勾选多个值组合过滤
- 🐛 fix(excel): 新建 Excel 连接时支持直接拖入 .xlsx/.xls/.csv 文件填充路径
- ⚡ perf(redis): Redis Key 列表扫描批量获取 TYPE/TTL,减少远程连接下的串行往返
- 🐛 fix(redis): 修复 Key Browser Pattern 筛选参数未传入后端的问题,输入后自动刷新筛选结果
- 🐛 fix(db): 修复首次进入 MySQL/ClickHouse 标签页未恢复上次选中数据库的问题
- 🐛 fix(db): 表格单元格编辑确认后立即回显待保存值,保存成功后同步刷新当前页数据

---

## [0.11.1] - 2026-06-18

### 改进
- 🎨 style(db): 单元格编辑器弹窗改为居中显示,避免底部按钮被遮挡

---

## [0.11.0] - 2026-06-18

### 新增
- ✨ feat(db): 数据库选择记忆功能 — 记住上次展开和选中的数据库,下次进入自动恢复

### 修复
- 🐛 fix(db): 修复数据库表格双击单元格报错的问题(event 对象未正确传入)

---

## [0.10.9] - 2026-06-18

### 新增
- ✨ feat(db): 数据库表格双击单元格弹出编辑器弹窗,支持查看完整长文本内容、编辑和一键复制,替代原来截断在窄格子里的行内编辑

### 修复
- 🐛 fix(redis): 修复 Redis KeyBrowser 侧栏折叠后展开按钮不可见的问题,与 DbView/DockerView 保持一致的折叠交互

---

## [0.10.8] - 2026-06-18

### 修复
- 🐛 fix(ui): 修复 MySQL、Docker、Excel 等视图右侧面板点击收起/展开把手无响应的问题,原因是把手事件直接写全局 store 状态而非通过 v-model 更新视图本地状态

---

## [0.10.5] - 2026-06-18

### 新增
- ✨ feat(ui): 欢迎页与模块卡片新增右键菜单,支持就地新建连接、打开命令面板、设置与布局切换

### 改进
- 🎨 style(ui): 右键菜单补齐键盘导航与选中态,统一弹窗关闭/返回路径并优化禁用按钮和窄屏表单底部布局

### 修复
- 🐛 fix(ui): 修复 Ctrl/Cmd+K 搜索快捷键未注册、输入框/弹窗中全局快捷键误触发底层 tab 的问题
- 🐛 fix(ui): 纯 Web dev 环境下 Tauri window/asset 调用降级,避免页面验证时进入错误边界或刷控制台错误

---

## [0.10.4] - 2026-06-18

### 修复
- 🐛 fix(db): 修复 MySQL 新建表失败被当作成功、SQL 执行失败无提示、表格编辑保存后数据不刷新的交互问题
- 🐛 fix(db): 表格数据页新增刷新入口,手写 DDL/DML 成功后自动刷新表列表或已打开表数据
- 🐛 fix(db): 表格 CSV 导出入口补齐执行反馈,导出内容复制到剪贴板

---

## [0.10.3] - 2026-06-17

### 修复
- 🐛 fix(ssh): SFTP 侧边栏等待终端通道 ready 后再初始化,避免 SSH 已连接但文件面板一直停在连接中,需要手动回车才显示目录

---

## [0.10.2] - 2026-06-17

### 修复
- 🐛 fix(ui): 修复缩小窗口后右上角最大化和关闭按钮被标题栏内容挤出不可见的问题
- 🐛 fix(excel): 修复按选中列去重到新 Sheet 后保存按钮不可用,导致新 Sheet 无法写回原文件的问题
- 🐛 fix(excel): 表头筛选弹框新增每个值的出现次数统计

---

## [0.10.1] - 2026-06-17

### 修复
- 🐛 fix(redis): 修复切换 DB 后 KeyBrowser 可能抢在 `SELECT` 完成前扫描,导致 key 偶发不显示的问题
- 🐛 fix(redis): 修复 Redis `SCAN` 空页但 cursor 未结束时误显示空列表的问题,并对增量加载结果去重
- 🐛 fix(redis): 修复跨 DB 同名 key 复用旧编辑 tab、重复点击 key 不刷新内容导致数据不显示的问题
- 🐛 fix(redis): Redis Stream key 支持读取并以 JSON 文本展示

---

## [0.10.0] - 2026-06-17

### 新增
- ✨ feat(excel): 删除重复项新增按选中列去重并输出到新 Sheet,保留原表数据
- ✨ feat(excel): 表头筛选菜单新增总行、非空、空白与 Distinct Count 计数
- ✨ feat(excel-ai): AI 助手支持按指定列或当前选中列去重并输出到新 Sheet,重复列值只保留首次出现的整行数据

---

## [0.9.0] - 2026-06-17

### 新增
- ✨ feat(excel-ai): AI 助手接入高级 Excel 工具,支持批量区域写入、公式填充、表头重命名、查找替换、Sheet 新增/删除/重命名/切换、表头样式和写入自动筛选
- ✨ feat(excel): 支持 Ctrl/Cmd + 单元格右下角填充柄拖拽,把源单元格批量赋值到目标区域
- ✨ feat(sidecar): Excel/CSV sidecar 新增 `writeHeaders`;Excel 新增 `styleHeader`,用于 AI 修改表头和保存表头样式

---

## [0.8.0] - 2026-06-17

### 新增
- ✨ feat(excel): Excel 右侧接入 AI 助手,支持读取当前表上下文、读取数据、写单元格、插入/删除行列、排序、筛选、冻结、去重与保存,工具执行后表格实时更新
- ✨ feat(excel): 表头显示导入文件第一行字段名,并新增 WPS/Excel 风格列头筛选入口
- ✨ feat(excel): 支持拖拽 `.xlsx/.xls/.csv` 文件到 Excel 视图后直接导入打开
- ✨ feat(excel): 单元格支持鼠标拖拽框选、Shift 扩展选择、Ctrl/Cmd 非连续多选和右键保留选区

### 修复
- 🐛 fix(excel): Ribbon「数据」「视图」改为可切换工具页,避免看起来无法点击
- 🐛 fix(ssh): MFA/2FA 终端右侧 SFTP 复用已验证 SSH session,不再二次登录导致无法使用
- 🐛 fix(ssh): 移除 SSH 300 秒空闲断线配置,并禁止 MFA/2FA 会话自动重连反复弹验证码

---

## [0.7.1] - 2026-06-17

### 修复
- 🐛 fix(excel): 修复 ExcelView 打开成功后更新 `lastUsedAt` 触发 watcher 循环重开,导致页面一直显示加载中的问题

---

## [0.7.0] - 2026-06-16

### 新增
- ✨ feat(csv): CSV 文件作为 ExcelView 一等编辑体验接入 — 打开后按单 Sheet 工作簿展示,支持单元格编辑、保存、插入/删除行列、排序、查找替换、删除重复项、复制粘贴、撤销/重做和本地冻结视图
- ✨ feat(sidecar): CSV sidecar 补齐 `readSheet/writeCells/insertRows/deleteRows/insertCols/deleteCols/sortRows/findReplace/removeDuplicates` 等 sheet-like RPC,并在启动握手中校验关键 CSV 方法

### 修复
- 🐛 fix(excel): 删除重复行按最大列宽补齐尾部空单元格后再生成去重 key,避免 `a` 和 `a,` 被误判为不同记录
- 🐛 fix(csv): CSV 读取允许可变列数(`FieldsPerRecord = -1`)并在前端展示时按最大列宽补齐,避免短行/长行文件打开失败或列错位

### 测试
- ✅ test(sidecar): 增加 CSV 可变列读取、写入保存、插删行列、排序、查找替换和删除重复项测试

---

## [0.6.0] - 2026-06-16

### 新增
- ✨ feat(excel): Excel 模块升级为工作簿编辑体验 — 新增 Ribbon 工具区、名称框、公式栏、底部选区统计、Sheet 新建/删除/重命名、右键菜单、Ctrl+C/V/X、Shift 扩展选区、撤销/重做、冻结表头/首列/窗格、自动筛选、排序与查找替换
- ✨ feat(sidecar): Excel sidecar 新增 `insertRows/deleteRows/insertCols/deleteCols/sortRows/findReplace/freezePanes/autoFilter` RPC,结构性编辑可真实写入内存工作簿并等待保存

### 修复
- 🐛 fix(excel): 修复单元格编辑写回行号偏移错误,避免编辑第一条数据时覆盖第 1 行表头
- 🐛 fix(excel): 筛选视图下编辑单元格会映射回原始行号,避免写错文件行
- 🐛 fix(excel): 公式单元格读取时保留 `=FORMULA` 文本,写入 `=` 开头内容时使用 Excel 公式而不是普通字符串

### 测试
- ✅ test(sidecar): 增加 Excel 写入偏移、公式读取、插删行列、查找替换与排序回归测试

---

## [0.5.2] - 2026-06-15

### 修复
- 🐛 fix(sidecar): release 构建强制同步最新 Sidecar 到 Tauri target 目录,避免运行时优先加载历史二进制
- 🐛 fix(db): Sidecar 启动时校验协议版本和关键 RPC 方法,彻底避免点击表后才出现 `Method not found`
- ✅ test(sidecar): 增加数据库关键方法注册回归测试

---

## [0.5.1] - 2026-06-15

### 安全
- 🔧 refactor(security): 资产密码、私钥、跳板机凭据与 AI API Key 迁移到系统 Keyring,SQLite/localStorage 只保留引用
- 🐛 fix(db): MySQL/ClickHouse 动态标识符统一转义,补齐查询迭代错误检查

### 修复
- 🐛 fix(sidecar): stdin/stdout 读写拆分,支持按请求 ID 并发关联响应并增加 120 秒超时
- 🐛 fix(sftp): 取消或失败传输仍会发送终态事件并清理取消令牌
- 🐛 fix(startup): 数据库与 Sidecar 在窗口可用前完成初始化,消除首次加载竞态
- 🐛 fix(build): Sidecar 构建脚本跨平台化,仅 Windows release 使用 `windowsgui`

### 改进
- ⚡ perf(frontend): Vue/Vuetify、CodeMirror、xterm 拆分为独立缓存 chunk
- ✅ test(ci): 增加 RPC 并发/大消息、SQL 标识符测试及前端/Rust/Go 质量工作流
- 🔧 chore(rust): 全量 `cargo fmt`,清除 `clippy -D warnings` 问题

---

## [0.5.0] - 2026-06-12

### 新增
- ✨ feat(db): 新增 ClickHouse 数据库连接支持 — Go sidecar 28 个 RPC 方法(23 个 MySQL 对齐 + 3 个特有元数据)、Rust 透传、前端复用 DbView.vue
- ✨ feat(home): Quick Actions 4 张卡片接入点击(SSH/数据库/Docker/AI) — 资产数为 0 时弹新建 dialog,有多条时跳最近一条,单条直接开
- ✨ feat(home): 完全空态欢迎卡 — 零资产时显示「欢迎使用 StarHub」+ 渐变标题 + 双 CTA 按钮
- ✨ feat(layout): 顶栏 ⌘K/Ctrl+K 快捷键聚焦搜索框(之前 kbd 提示是装饰,按了没反应)
- ✨ feat(layout): 顶栏搜索实时下拉 — 输入时显示前 8 个匹配资产,↑↓/Enter 选中,Esc 关闭
- ✨ feat(layout): 头像下拉菜单新增「数据库」「Docker」快捷入口,带 Esc 关闭支持
- ✨ feat(dialog): NewConnectionDialog 新增 `initialType` prop — 从顶栏菜单/Quick Action 进入时跳过 type 选择页,直达对应配置
- ✨ feat(error): 全局 ErrorBoundary 组件 — 任意子组件渲染错误时显示友好错误页(重置视图/复制堆栈/重新加载),避免整页白屏
- ✨ feat(settings): SettingsView 补 2 个 tab:「通用」(启动行为/最大 tab 数/关闭确认,localStorage 持久化)、「关于」(版本/GitHub/许可证/检查更新占位)
- ✨ feat(welcome): 欢迎页 CAPABILITIES 卡片接入点击(SSH/数据库/Docker) — 有同类资产跳最近一条,0 资产弹新建 dialog(预设类型);数据库/Docker P1 升 P0;移除 AI 助手卡片;移除「测试连接」按钮
- 🌐 i18n: 新增 `home.recent / assets / quickActions / emptyWelcome / tryAi / subtitle / settings.general* / about*` 等 key,中英文同步
- ✨ feat(ssh): **新增 `ssh_exec` Tauri 命令** — 在已有 SSH 会话上跑任意命令,自动管理 channel、超时、EOF,给仪表盘拉系统指标用
- ✨ feat(dashboard): **HomeView 仪表盘全部接入真实数据** — 顶部 4 张统计卡(总资产/SSH/数据库/Docker)、SVG 自绘资产类型分布环图、近 7 天使用频次柱状图、数据库子类型分布、收藏统计
- ✨ feat(dashboard): 新组件 `StatCard` / `charts/DonutChart` / `charts/BarChart` — 纯 SVG/CSS 自绘,不引入 ECharts
- ✨ feat(dashboard): SshDashboard 改真实数据 —— `cat /proc/meminfo` / `cat /proc/loadavg` / `nproc` / `df -P` / `uname -a` / `hostname` / `cat /proc/uptime` 并发采集,前端在 `utils/sshMetrics.ts` 解析
- ✨ feat(dashboard): DockerDashboard 改真实数据 —— `docker_list_containers` + `docker_list_images` 真实 RPC,运行/暂停/停止数从 `state` 字段实时统计
- ✨ feat(dashboard): DbDashboard 改真实数据 —— Redis 走 `redisInfo` + `redisDBSize` 解析(版本/内存/键数/命中率/ops),MySQL 跑 `SHOW GLOBAL STATUS` + `SHOW GLOBAL VARIABLES` + `information_schema.tables` 解析连接数/慢查询/缓冲池命中率/表数/数据大小
- ✨ feat(util): `utils/assetStats.ts` —— 从 asset 数组派生 6 类指标(类型分桶/收藏/7 天活跃/标签云/数据库子类型),纯函数无副作用
- ✨ feat(util): `utils/sshMetrics.ts` —— 解析 `/proc/meminfo`、`/proc/loadavg`、`df -P`、`uname -a`、`/proc/uptime` 的纯函数集合
- ✨ feat(util): `utils/dbMetrics.ts` —— 解析 Redis INFO 文本 / MySQL `SHOW STATUS` QueryResult 的纯函数集合
- 🌐 i18n: 新增 `home.stat* / activityTitle / typeDistribution / last7Days / dbBreakdown / justNow / minutesAgo / ...` 等 18 个 key,中英文同步

### 修复
- 🐛 fix(layout): 顶栏搜索框 kbd 提示对应的快捷键 ⌘K 全局监听,按了无效
- 🐛 fix(home): Quick Actions 4 张卡片原本无 `@click`,看着像入口实际点不动
- 🐛 fix(home): 第三节标题误写为「搜索」,实际是 Quick Actions
- 🐛 fix(welcome): 欢迎页「数据库」/「Docker」CAPABILITIES 卡片原标 disabled-card 无点击
- 🐛 fix(asset): **删除连接报错「Asset not found」** —— 路由 params.id 是 instanceId 而非 assetId,旧判断 `=== target.id` 永远为 false,导致删完 tab 路由不跳回,tab 渲染时资产不存在抛错;改用 `tabsToRemove.some(t => t.id === route.params.id)` 精确匹配
- 🐛 fix(tab): SshTerminal / DbView / DockerView mount 时若 asset 不存在,自动 router.push('/'),避免卡在空 tab 触发 ErrorBoundary
- 🐛 fix(dashboard): **SshDashboard / DockerDashboard / DbDashboard 三个单资产仪表盘指标全是 mock 数据** —— 现已全部改接真实 RPC,具体见上方「新增」中三条 feat(dashboard)
- 🐛 fix(home): HomeView 主页内容过单薄,只展示最近 6 张资产卡,看起来像假数据;现已扩充为 6 段(统计/分析/数据库分布/最近/全部/快捷操作),全部基于真实 assetStore
- 🐛 fix(asset-tree): **点击侧边栏 db 资产完全无反应** —— `connectToAsset()` 里有 `if (asset.type !== 'ssh') return`,db/docker 被直接吞掉;现 db 走 addTab + 路由到 `db-mysql` / `db-redis`(复用 `openInNewTab` 的现成逻辑)
- 🐛 fix(db-view): **MySQL 数据库树形菜单一次性并行加载所有 db 的所有表** —— 连接成功后立即 `loadAllTables()` 并行调 `mysqlListTables` 给每个 db,在企业内网几十上百个 db 的场景下,既慢又容易因为某个无权限 db 拖垮整次连接;现改为**懒加载** —— 只预加载第一个非系统 db,其他 db 保持收起+未加载,等用户点 toggle 时再单独 `loadTablesForDb`
- 🐛 fix(db-view): **DbView 多个 catch 块只 console.warn 不通知用户** —— 报错用户看不见,就感觉"没反应";现 connect / list databases / load tables 失败都会通过 `useNotifyStore` 弹 toast;树上 db 加载失败时,inline 显示错误消息 + 重试按钮(不弹 toast,避免反复点的时候太吵)
- 🎨 style(ssh): SSH 表单认证方式改为 4 颗互斥 chip 单选组(密码 / 私钥 / 密码+私钥 / MFA/2FA),新增 `.auth-chip` 通用样式(走 `--cyan` token),MFA 详情折叠区并入右列与 chip 联动;旧 `usePasswordAuth` / `useKeyAuth` / `mfaEnabled` 三 bool 同时保留向后兼容
- 🎨 style(design-system): cyber.css 新增 `.auth-chip` / `.auth-chip-group`(互斥单选胶囊),复用已有的 `--cyan` + `--hover-cyan` + `--focus-cyan` token,可被 DB/Redis 等认证方式复用
- 🐛 fix(ssh): **MFA 模式下点「测试连接」会卡 6 分钟才报错** —— 后端 `test_ssh_connection` 用局部 `pending_kb` map,前端 `ssh_kb_response` 走全局 `manager.pending_kb`,通道对不上,server 端 oneshot 等满 360s 才超时;改为测试连接也走全局 `pending_kb`(测试结束统一清理防 map 膨胀),前端在表单里挂一个临时 `KbInteractiveDialog` 监听 `ssh:kb-interactive:<testId>` 弹密码
- 🎨 style(design-system): cyber.css 新增 `.auth-chip` / `.auth-chip-group`(互斥单选胶囊),复用已有的 `--cyan` + `--hover-cyan` + `--focus-cyan` token,可被 DB/Redis 等认证方式复用

---

## [0.4.0] - 2026-06-10

### 新增
- ✨ feat(elasticsearch): 新增 Elasticsearch 完整支持 — Go sidecar 19 个 RPC 方法、Rust 透传、前端 ElasticsearchView.vue 四 Tab 视图(概览/搜索/索引/导入导出)
- ✨ feat(elasticsearch): DSL 查询编辑器 + 表格/JSON 双视图搜索结果 + 索引字段映射树形展示 + 集群健康仪表板

---

## [0.3.0] - 2026-06-06

### 新增
- ✨ feat(asset): 资产管理 CRUD — 完整对接 SQLite，新建/编辑/删除/收藏/搜索
- ✨ feat(ssh): 跳板机 (ProxyJump) 支持 — 通过跳板机连接目标主机，跳板机独立认证
- ✨ feat(ssh): 私钥「从剪贴板粘贴」按钮 — 支持从 Vault / 1Password 复制私钥
- ✨ feat(ai): AI 助手基础集成 — 支持 Claude / GPT，自然语言对话界面
- 🐛 fix(sidecar): Sidecar 路径解析 — 使用 current_exe() 替代 current_dir()，兼容开发和打包环境
- 🐛 fix(sidecar): Go Sidecar 编译目标修复 — GOOS=windows GOARCH=amd64
- ✨ feat(sftp): 文件操作 — 列目录、上传、下载、删除、重命名、新建目录
- ✨ feat(sftp): 断点续传支持
- ✨ feat(sftp): 文件搜索（glob 模式）
- ✨ feat(sftp): 权限修改（chmod 对话框）
- ✨ feat(sftp): 文件预览（文本 + 图片）
- ✨ feat(sftp): 右键上下文菜单
- ✨ feat(sftp): 面包屑路径导航
- ✨ feat(ssh): 终端 / SFTP 分栏可拖拽（默认 65:35,记忆到 localStorage,双击重置）
- ✨ feat(layout): 标签页右键菜单 + Ctrl/Cmd+W 关闭 + 鼠标中键关闭

### 修复
- 🐛 fix(ssh): 「测试连接」按钮不可用 —— 后端缺少 `test_ssh_connection` 命令
- 🐛 fix(sftp): 冷启动首次进入 SSH 标签,SFTP 报 "Session not found" —— SftpBrowser 等待 SSH connected=true 后再发 sftpList
- 🐛 fix(sftp): SFTP 缩窄后文件名列被压扁消失 —— name 列改为 `minmax(140px, 1fr)`,并加上 resize handle

### 改进
- 🎨 style(design-system): SSH 表单 host/port 比例收紧(端口固定 90px)
- 🎨 style(layout): 顶部"+"按钮克制化、状态栏增加 SFTP 计数、欢迎页 4 卡 + P0/P1 chip
- 🎨 style(layout): 状态栏时钟改 1s 间隔 HH:MM:SS,标签页关闭按钮默认半透明

---

## [0.2.0] - 2026-06-04

### 立项
- 🎉 **项目正式立项**(StarHub)
- 完成产品定位与目标用户分析
- 完整功能列表(280+ 子功能,带 P0/P1/P2/P3 优先级)

### 架构
- ✅ 整体架构定稿:5 层分层 + 三进程模型(Tauri 主进程 / WebView / Go Sidecar)
- ✅ 技术选型定稿:**Tauri 2 + Vue 3 + Rust + Go**
- ✅ 数据库驱动决策:Go Sidecar(从原 Node.js 升级,理由:静态二进制、PG/Redis 生态更强、与 Rust 同编译型语言)
- ✅ 通信协议:stdio JSON-RPC(Rust ↔ Go)
- ✅ 选型对比完成:Tauri vs Electron、Go vs Node、Go DB 驱动生态
- ✅ 数据模型:SQLite + 系统 Keyring
- ✅ 安全设计:三层信任边界、CSP、Keyring、审计日志
- ✅ 跨平台打包:Win/macOS/Linux + 代码签名
- ✅ MVP 周期 3-4 月、3 人团队、成本 40-50 万

### 文档
- 📋 技术方案文档 v0.2(14 章,49012 字节)
- 📐 架构图 HTML v0.2(10 章节,48303 字节)
  - 分层架构图、进程模型图、Mermaid 流程图
  - 三大数据流示例(SQL 查询、SSH 命令、AI 排障)
  - 模块卡片、数据模型 ER 图、路线图时间线
  - 性能指标、团队配置、风险与对策

### 工程
- MIT License 开源
- 仓库地址:https://github.com/dabaicai001/starhub

---

## 历史

- **v0.1 (2026-06-04)** — 初版,Sidecar 选用 Node.js(后改为 Go)
- **v0.0** — 内部调研
