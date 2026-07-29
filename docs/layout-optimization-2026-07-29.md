# StarHub 布局优化方案(2026-07-29)

> **状态**:方案稿(v0),等用户过完再开改。
> **范围**:CyberLayout + 8 个 View + 3 个内嵌(SshTerminal/SftpPanel/TransferDock) + 3 个 Dashboard + 5+ 弹窗,共 18 个模块。
> **原则**:只调"用得稳不稳"的部分,不动设计语言(token 体系、字体、颜色基调、动效曲线全部保留)。
> **本文档阅读路径**:先看 §0 摘要 + §2 原则定方向 → 翻 §3 全局级调整看技术底座 → 按 §4 逐模块过 → 收口看 §5 实施路线和 §6 风险点。

---

## 0. TL;DR

starhub 的设计系统**已经成熟**——token 集中、组件类齐全、字号/间距/圆角阶分明、状态色语义统一、动效曲线统一。**真正缺的**不是"加规范",而是四件具体事:

1. **断点系统 + 容器宽度 token** —— 当前 260px sidebar / 30px statusbar / 52px titlebar 全部硬编码常量,小窗口(< 1280px)会挤;中等窗口(1280-1600)留白浪费;无响应式策略文档。
2. **动效收敛** —— `.cyber-panel` 顶部液体流动灯带每 2.8s 跑一次,所有 panel 同时亮会"屏幕闪烁";`.cyber-card` hover 上抬 4px + 投影 + 颜色变,大量卡片同屏(欢迎页)累加明显;`.cyber-btn` hover 上抬 2px,全站按钮都有。
3. **两级 Tab 视觉冲突** —— DbView 的"路由 tab(打开哪个连接)"+"sub-tab(打开的表/SQL 结果)"视觉样式类似,容易混淆哪个是顶层哪个是子层。
4. **装饰层开销** —— 欢迎页叠了三层背景(极光 A + 极光 B + 栅格遮罩 + 粒子),GPU 渲染开销大,且和主内容抢视觉焦点。

本文档按"**信息层级 / 区块分布与留白 / 操作动线 / 响应式适配**"四维过 18 个模块,每条调整讲清**为什么**。

---

## 1. 现状摸底(基于实际代码)

### 1.1 已有体系(基础扎实)

| 项 | 状态 | 位置 |
|---|---|---|
| 颜色 token | 完整,深浅双主题 | `src/styles/cyber.css:10-281` |
| 玻璃 / 阴影 token | 完整,4 档 | cyber.css:83-88 |
| 状态色 token | online/connecting/offline/error/warning/info 全有 | cyber.css:100-109 |
| 组件类 | 50+ 类集中维护 | `docs/设计系统.md:79-136` |
| 字号阶 | 8 档,10-32px | 设计系统 §3 |
| 间距阶 | 8 节奏,4/8/12/16/**20**/24/32/48 | 设计系统 §4(注:20 违反"不允许中间值"原则) |
| 圆角阶 | 4/6/8/12/16 | 设计系统 §4 |
| 动效曲线 / 时长 | 统一 `cubic-bezier(0.4, 0, 0.2, 1)`,3 档时长 | 设计系统 §4 |
| 数据库子色 | 8 类(MySQL/PG/SQLite/CH/ES/Redis/Kafka/NSQ)双主题 | cyber.css:63-78 |
| 必备动画 | pulse/shimmer/glow/float + 路由/tab/list/dialog 过渡 + stagger + skeleton + count-pop | 设计系统 §5 |

### 1.2 关键观察(代码层)

1. **`CyberLayout.vue` 关键常量** — `MENUBAR_PADDING_X = 12`;sidebar 引用 `SIDEBAR_COLLAPSED_WIDTH`(store);`isMac/isLinux/modKey` 跨平台修饰键判断。
2. **拖拽手柄** — `SidebarHandle / ResizableSidebarHandle / RightPanelHandle` 三件;`TransferDock` 自身可拖动换位(pointer events,position 持久化)。
3. **Tab 拖出** — 用 Pointer Events 自实现(`tabDragState` + `detachArmed`),不用 HTML5 DnD(Tauri Windows 拦截)。
4. **快捷键** — `Ctrl+K` 搜索 / `Ctrl+B` 切 sidebar / `Ctrl+Shift+B` 切 right panel / `Ctrl+J` AI / `Ctrl+,` 设置 / `Esc` 关闭浮层。
5. **响应式策略** — **无文档、无断点定义、无 `useBreakpoint` 类 hook**;所有断点靠组件内 `window.innerWidth` 监听或无监听。
6. **Welcome 页背景层** — 三层叠加:`.welcome-aurora-a` / `.welcome-aurora-b` / `.welcome-grid-overlay` / `.welcome-particle`(`pointer-events: none`),CSS 关键帧 + filter blur。
7. **DashboardCard hover** — `translateY(-2px)` + `box-shadow: var(--glow-soft)` + 顶部颜色条变化(cyber.css 的 4px 上抬版)。
8. **DbView 两级 tab** — 路由级 tab(打开连接) + sub-tab(打开的表/SQL 结果),都用 `.cyber-tab` 样式。

---

## 2. 优化原则(四维)

### 2.1 信息层级(visual hierarchy)

**目标**:让用户在任何窗口尺寸下,3 秒内定位当前"是什么"和"能做什么"。

- **3 档视觉权重**
  - 一级(主操作/当前状态):主色 `--cyan` 或渐变 `--grad-primary`,字号 `text-md` ~ `text-lg`。
  - 二级(标题/分组):`--text` 文字,字号 `text-sm` ~ `text-base`,配合 `font-weight: 600`。
  - 三级(辅助/标签/计数):`--text-2` / `--muted`,字号 `text-xs` ~ `text-sm`,`font-family: JetBrains Mono`(数据感)。
- **同屏颜色数 ≤ 3 种**(主色 + 1 个状态色 + 1 个强调色),超出则改用透明度区分。
- **关键 CTA 永远单一** —— 一个工作区同一时刻只允许 1 个"主按钮"使用 `--grad-primary` 渐变填充,其他用 `.cyber-btn-secondary` 描边。

### 2.2 留白(white space)

**目标**:让"信息密度高"和"喘得过气"兼得。

- **4 级密度规约**(新增,见 §3.1 token)
  - **紧凑**(terminal / SQL 编辑器 / 命令面板):padding 8/12,行高 1.4。
  - **标准**(列表 / 表单 / 卡片网格):padding 16,行高 1.5。
  - **舒展**(欢迎页 / 空状态 / 详情页):padding 24/32,行高 1.6。
  - **沉浸**(全屏终端 / 弹窗 / 模态):padding 0 或 16,无外距。
- **节与节之间 ≥ 24px**(用 `--space-section: 24px`)。
- **同组内 ≤ 8px**(用 `--space-inline: 8px`),不混用。
- **左右页边距统一 24px**(`--space-page-x: 24px`),小窗口降到 16px。

### 2.3 操作动线(UX flow)

**目标**:让"主操作 ≤ 2 步完成",键盘可达,无死路。

- **Z 形阅读路径** — 顶栏(全局)→ 主区(主操作)→ 右侧 / 底部(辅助)。不要把"主操作"塞在右下角。
- **CTA 永远在视线终点** — 主按钮放主区右下(`align-self: flex-end`)或顶部工具栏最右,符合"读完后做决定"的人因。
- **键盘可达 = 全键盘覆盖** — 每个交互元素都要有 `:focus-visible` 青色光环(`--focus-cyan`),Tab 顺序遵循视觉顺序(不要用 `tabindex > 0` 跳序)。
- **危险操作二次确认** — 删除 / 断开 / 强杀进程 走 `v-dialog` 弹窗确认,主按钮用 `.cyber-btn-danger`(已有)。
- **取消 / 撤销随手可达** — 弹窗 Esc 关闭 + 顶部"撤销"按钮 5s 内可点。

### 2.4 响应式适配(breakpoint)

**目标**:1280×800 是设计基线,1280 以下降级而非"挤",1600+ 拉宽不浪费。

- **断点定义**(新增,见 §3.3)
  - `xs`:≤ 1024px(窄屏,典型 13" 笔记本)
  - `sm`:1024-1280px(标准,14" 笔记本)
  - `md`:1280-1600px(设计基线,15-16" 笔记本 / 1080p)
  - `lg`:1600-1920px(宽屏,24" 显示器)
  - `xl`:≥ 1920px(超大屏,4K)
- **降级策略** — 不是简单"缩小",而是"隐藏次要 / 折叠次要 / 合并次要":
  - `xs` → 侧栏默认折叠、状态栏合并、欢迎页背景层降到 1 层。
  - `sm` → 侧栏可手动展开;欢迎页正常。
  - `md` → 设计基线,所有功能正常。
  - `lg`/`xl` → 内容容器固定最大宽度,左右留白加大。
- **窗口控制** — titlebar 自定义按钮(最小化/最大化/关闭)在 < 1200px 时仅显示关闭按钮 + 折叠按钮,其余藏入右键菜单(避免按钮挤掉搜索框)。

---

## 3. 全局级调整(动这些地方全站生效)

### 3.1 Token 增补(在 `cyber.css` `:root` 块加)

```css
/* 容器宽度 token —— 取代硬编码的 260/30/52 等 */
--layout-titlebar-h: 52px;          /* 已有,统一命名 */
--layout-menubar-h: 40px;
--layout-statusbar-h: 32px;         /* 原 30,微调到 32 容纳 2 行小字 */
--layout-sidebar-w: 280px;          /* 原 260,加 20 让树节点宽一点 */
--layout-sidebar-w-collapsed: 56px;
--layout-rightpanel-rail-w: 56px;   /* 已有,统一命名 */
--layout-content-max-w: 1440px;     /* 大屏内容不无限拉宽 */

/* 断点 token(仅文档用,实际响应式走 CSS @media) */
--bp-xs: 1024px;
--bp-sm: 1280px;
--bp-md: 1600px;
--bp-lg: 1920px;

/* 间距规约 token —— 4 级密度 */
--space-inline: 8px;          /* 同组内 */
--space-section: 24px;        /* 节与节 */
--space-page-x: 24px;         /* 页左右 */
--space-page-x-narrow: 16px;  /* 小窗口 */
--space-page-y: 24px;
--space-page-y-narrow: 16px;

/* 玻璃分级 —— 现在 3 档太粗,补 1 档 */
--chrome-glass-deep: rgba(6, 10, 16, 0.92);  /* statusbar / detached window */
--chrome-glass-strong: rgba(8, 13, 20, 0.82); /* titlebar(已有) */
--chrome-glass: rgba(12, 19, 29, 0.68);       /* menubar(已有) */
--chrome-glass-soft: rgba(16, 24, 34, 0.58);  /* sidebar / right rail(已有) */
--chrome-glass-faint: rgba(20, 28, 38, 0.42); /* dock / floating */

/* 动效收敛 token —— 单独给"装饰性动效"开关 */
--anim-decor: 1;              /* 装饰层液体灯带/极光 0 = 关 1 = 开 */
                              /* 用户在 Settings > Appearance 可关 */
```

**理由**:
- 容器宽度从硬编码常量 → token,改一处全站生效。
- 间距 token 化让"密度"可统一调控(整站切"紧凑模式"只动 token)。
- 玻璃 5 档够细,不同位置用不同档(状态栏最重、dock 最轻)。
- 装饰动效可关 —— 给"性能敏感"用户(老机器、大数据表格)一个开关,默认开。

### 3.2 组件类增补(在 `cyber.css` 集中加)

| 类名 | 用途 | 关键样式 |
|---|---|---|
| `.cyber-stack` | 垂直堆叠容器,统一间距 | `display: flex; flex-direction: column; gap: var(--space-section)` |
| `.cyber-cluster` | 水平/垂直紧凑组,统一间距 | `display: flex; gap: var(--space-inline); align-items: center` |
| `.cyber-pane` | 带 header 的内部面板(替代裸 `<section>`) | `display: flex; flex-direction: column; border-radius: 12; overflow: hidden;` |
| `.cyber-pane-header` | pane 标题区(替代裸 `<header>`) | `padding: 12 16; border-bottom: 1px solid var(--line-2);` |
| `.cyber-pane-body` | pane 内容区 | `flex: 1; padding: 16; overflow: auto;` |
| `.cyber-section` | 节容器,带 section-header | 复合 .cyber-stack + section-header |
| `.cyber-divider` | 统一分割线 | `height: 1px; background: var(--line-2); margin: var(--space-section) 0;` |
| `.cyber-meta` | 辅助元信息(灰字小字) | `color: var(--muted); font-size: 11; font-family: 'JetBrains Mono';` |
| `.cyber-key` | 键值对的"键"(用于详情面板) | `color: var(--text-2); font-size: 12;` |
| `.cyber-value` | 键值对的"值" | `color: var(--text); font-size: 13; font-family: 'JetBrains Mono';` |
| `.focus-ring` | 通用焦点环(给非 cyber-btn 元素用) | `:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--focus-cyan); }` |

**理由**:
- 把"间距"和"层级结构"抽成组件类,让组件只引用 class,符合 AGENTS.md 4.4 规范。
- `.focus-ring` 解决"非按钮元素(div/span/li)无焦点指示"问题(键盘可达性的基础)。
- `.cyber-key/.cyber-value` 解决"详情面板一行行写 key/value 样式"到处复制的问题(右栏、AI Plan 详情都用得到)。

### 3.3 断点系统(CSS 媒体查询 + JS hook)

**CSS 端**:
```css
/* @media 模板,组件按需引用 */
@media (max-width: 1024px) { /* xs */ }
@media (min-width: 1025px) and (max-width: 1280px) { /* sm */ }
@media (min-width: 1281px) and (max-width: 1600px) { /* md - 基线 */ }
@media (min-width: 1601px) { /* lg */ }
@media (min-width: 1921px) { /* xl */ }
```

**JS 端**(在 `src/composables/useBreakpoint.ts` 新建):
```ts
export function useBreakpoint() {
  // 返回 { name: 'xs' | 'sm' | 'md' | 'lg' | 'xl', width, height, isNarrow, isWide }
  // 监听 window resize 200ms 节流
}
```

**理由**:断点用 token + composable 双通道,组件既可以走 CSS `@media` 也可以用响应式布局(条件渲染/折叠)。`useBreakpoint` 用在"响应式逻辑"(如 `xs` 时不渲染欢迎页背景层)。

### 3.4 全局动效收敛(优先级 P1)

| 当前 | 调整 | 理由 |
|---|---|---|
| `.cyber-panel::before/::after` 液体灯带 2.8s 循环 | 加 `prefers-reduced-motion` 媒体查询关闭;加 `var(--anim-decor, 1)` 控制;`.cyber-pane` 不带灯带 | 大量 panel 同屏闪烁,视觉噪音 |
| `.cyber-card:hover` 上抬 4px + 投影 | 改 2px 上抬,投影从 `--shadow-soft` 改 `--glow-soft`(更轻) | 10+ 卡片同屏,4px 累加明显 |
| `.cyber-btn:hover` 上抬 2px | 去掉 translateY,只保留 `box-shadow: var(--glow-cyan)` | 按钮 hover 已经是渐变 + 光带扫过,加位移过度 |
| Welcome 页极光 2 层 + 粒子 30 个 | 极光改 1 层 + radial mask,粒子改 12 个(`.welcome-particle:nth-child(n+13) { display: none }`) | 渲染开销大,视觉抢戏 |
| DashboardCard 顶部颜色条 hover 变 | 改用底部 1px 提示条(`.detail-chevron` 已有) | 顶部色变 + 上抬 + 投影 = 3 个动效叠加 |

**理由**:动效是"信息密度的反面" —— 信息密度已经高了,装饰动效就该收敛。`prefers-reduced-motion` 是无障碍硬要求。

### 3.5 间距规约清理(全站搜索替换)

| 错误 | 改成 | 涉及位置(估算) |
|---|---|---|
| `gap: 6px` | `gap: 8px` 或 `gap: 4px` | tree-item、rail-tab、card-header |
| `padding: 20px` | `padding: 16px` 或 `padding: 24px` | dashboard-card、welcome-*(设计系统说"不允许中间值") |
| `padding: 10px` | `padding: 12px` 或 `padding: 8px` | cyber-card subtitle、card-icon |
| `padding: 14px` | `padding: 16px` | tree-item padding-left |

**理由**:8 节奏是设计系统明文规则,但代码里散落着中间值,批量修一次让节奏感回来。

---

## 4. 逐模块建议

### A. CyberLayout(主壳,详写)

**现状**:`titlebar 52 + menubar 40 + [sidebar 260 + workspace] + statusbar 30`;自定义 titlebar 含窗口控件(min/max/close)、搜索框、新建按钮、设置、头像、用户菜单;menubar 含 Home/Assets/SSH/DB/Docker/AI 入口 + tab-strip;TransferDock / CommandPalette / NotificationCenter 全局浮动。

**关键调整**:

1. **statusbar 30 → 32px**(token `layout-statusbar-h: 32px`)
   - 6 项信息(version / N SSH / N DB / N Docker / N Agent / time)挤 30px 高,11px 文字撑满;32px 让 12px 文字也能容下,可读性 +10%。
   - 理由:状态栏是"次要信息展示",但当窗口特别小(1366×768)它是用户唯一能看全局状态的地方,不能糊。

2. **menubar 入口从 6 个收成 5 个**
   - 当前 `Home | Assets | SSH | DB | Docker | AI` 6 个 + tabs 一起,1280px 宽时 tabs 几乎不可见。
   - 把 `Home`(欢迎页)合并到 Assets 旁的下拉里(欢迎页本来就在 tabs 为空时显示,menubar 不需要入口);或改成图标 + tooltip(`.welcome-btn-kbd` 已有类似模式)。
   - 理由:menubar 是"全局导航",应该突出"现在打开的是什么",而不是"有什么可以打开"。

3. **titlebar 窗口控件自适应**(`< 1200px` 隐藏 min/max,只留 close)
   - 当前 titlebar 5+ 按钮(搜索 + +新建 + 设置 + 头像 + 窗口 3 按钮)+ 平台修饰键提示,小窗口会挤。
   - 改:窗口宽 < 1200px 时只显示 close;min/max 进"窗口菜单"(系统菜单或右键 titlebar)。
   - 理由:titlebar 是"品牌区",应该留白;窗口控件是 OS 概念,不该抢主品牌的视觉位。

4. **侧栏折叠态 + 记忆**
   - 当前 `Ctrl+B` 折叠,fold 后宽度 56px(icon-only),但有用户反馈"折叠了又自动展开"(keep-alive tab 切换时)。
   - 改:折叠态宽度统一走 token `layout-sidebar-w-collapsed: 56px`;折叠态的 icon 排布标准化(用 `.connection-icon` 已有模式);折叠态的记忆绑 assetStore(资产多时不要自动展)。
   - 理由:折叠态是"省空间",不是"次要状态"。

5. **tab-strip 横滚指示器**
   - 当前 tabs 多了会横滚,但 scrollbar 默认隐藏 → 用户不知道还有。
   - 改:左右两端加渐变遮罩(`.cyber-tab-strip-fade-l/r`)+ 滚动到边缘时给"还剩 N 个"提示。
   - 理由:tab 是"上下文",上下文丢失对开发者是大事。

6. **欢迎页装饰层收敛**(`< 1280px` 关闭)
   - 极光 + 栅格 + 粒子三层 → 小窗口只保留栅格遮罩(用 `useBreakpoint` 条件渲染)。
   - 理由:装饰层在小窗口下纯粹是"在主内容下叠了 3 层模糊",无意义。

### B1. AiView(AI 助手,详写)

**现状**:路由 `/ai/:id?`,独立 AI 工作区。布局:消息流(主区) + 底部输入框(固定) + AI 当前 Agent badge(消息流顶部) + Planner 计划卡(消息流末尾) + 确认卡(输入框上方) + @/# mention 菜单(输入框弹层) + 上下文 token 提示(输入框内)。`@` 唤起 Agent 列表,`#` 唤起 能力/资产列表。`Ctrl+J` 全局唤起。

**关键调整**:

1. **AI Plan 状态条提到顶部工具栏**
   - 当前 Plan 状态卡在消息流末尾(每次 plan 状态变都跳到底部)。
   - 改:在 workspace 顶部加一条 `.ai-plan-status-bar`,显示当前 plan 名 / step / 完成度,与消息流中的"展开详情"区分。
   - 理由:Plan 是"任务进度",进度条应该在顶部而不是混在消息中。

2. **确认卡 dock 区固定在输入框上方**(`ai-action-dock` 已有)
   - 当前代码已有 `ai-action-dock`,但需要确认它真的"不随历史消息滚走"——检查 `position: sticky` 是否生效。
   - 改:加 `--anim-decor: 0` 时禁用 dock 背景动效。
   - 理由:确认是"中断操作",必须随时可达。

3. **mention 菜单分层**
   - 当前 `@` 和 `#` 混在一个下拉,资产多了会卡。
   - 改:`@` 只显示 Agent;`#` 二级菜单(能力 / 资产)用 sub-popover,左箭头进入、右箭头退出。
   - 理由:5 个能力 + N 个资产混在一起视觉混乱。

4. **消息流分隔加强**
   - 当前消息用 `ai-message-segmented` 已有,但 user/assistant 之间的视觉差异不够(都是 panel)。
   - 改:user 消息右对齐 + 青色左边条 2px;assistant 消息左对齐 + 紫色左边条 2px(等宽 token 已有)。
   - 理由:长对话滚起来要能一眼区分"我说的"和"AI 说的"。

5. **空状态("你是新用户")**
   - 当前"应用 Prompt 引导"按钮在 input 上方(`.ai-composer-guide`),挺好。
   - 加:空消息流时(新会话)显示 4 个推荐场景卡片(诊断 / 改 / 传 / MCP),点击自动填模板。
   - 理由:新用户最大的痛点是"不知道能干嘛"。

### B2. DbView(数据库,数据密集代表,详写)

**现状**:`/db/{mysql|postgresql|clickhouse}/:id` 共用 DbView。布局:左侧 sidebar(库/表树,260px,可调) + workspace(SQL 编辑器 + sub-tab + 结果区) + RightPanel(可关,56px rail + 内容)。sub-tab 体系:table tab(单表 data/structure 切换) + sql tab(单次查询结果) + sql-editor tab(共享编辑器,带分页)。5 个 dialog:ColumnList / IndexList / CreateTableDDL / NewTable / Rename。

**关键调整**:

1. **两级 tab 视觉差异化**
   - 路由 tab(顶部)用 `.cyber-tab` 当前样式,表示"打开的连接"——保留。
   - sub-tab(workspace 内部)用新样式 `.cyber-subtab`(小一号、底色更浅、激活条 1px 而非 2px)。
   - 理由:层级要一眼可分,不然用户在 5+ sub-tab 里迷路。

2. **SQL 编辑器高度拖拽加刻度**
   - 当前编辑器高度可拖,但无视觉刻度。
   - 改:拖拽时显示当前高度(80 / 120 / 180 / 240 / 320px 5 档),snap 到 8 节奏倍数。
   - 理由:自由拖拽最后结果"奇数高度"很多,跟 8 节奏冲突。

3. **RightPanel 在 DbView 默认开 + 内容分级**
   - 当前 `usePersistentPanelState('db', true)` 已默认开,但内容是 AI Chat。
   - 改:RightPanel 顶部 tab 区分"AI Chat" / "Schema Diff" / "Query History";前两者共用 56px rail。
   - 理由:DbView 用户高频需要"对比 schema"和"查历史 SQL",不应让用户开 AI。

4. **库/表树节点加 meta**
   - 当前树节点 `db` / `table` 只有名字。
   - 改:库节点加 `.badge`(表数 / 大小);表节点加 `.badge`(行数估算 + 索引数)。
   - 理由:树是"资产目录",meta 帮助用户快速判断"哪张表该看"。

5. **空状态(库列表为空 / 树加载失败)**
   - 当前用 `notify.notify(...)` 弹通知,容易错过。
   - 改:树区域空状态用 `.empty-state`(已有组件类),含"重试"按钮 + "新建连接"按钮。
   - 理由:失败应该有"现场提示",不能只靠右下角通知。

6. **导出进度遮罩独立化**
   - 当前 `exportProgress` 遮罩用 `v-overlay`(默认 Vuetify),和 cyber 风格不太搭。
   - 改:用 `.cyber-panel` + 进度条,显示"已拉 N / 共 M · 写文件 X%"。
   - 理由:大数据导出是 30s+ 长操作,遮罩应该稳。

### B3. RedisView

**现状**:`/db/redis/:id` 独立 view。布局:键列表(库 + 键名 + TTL + 类型) + 详情(key/value/类型/TTL)+ 命令输入(底部)。

**关键调整**:

1. **键列表加前缀分组** — 输入框旁加"按前缀分组"开关,展开/折叠;分组用 `·` 分隔符浅色显示。
2. **详情区二进制/JSON 自动识别** — 当前需手动切类型(`.cyber-tabs`),加自动识别 + 切换历史。
3. **命令历史侧栏** — 输入框上方加"最近 N 条命令"下拉,回车执行历史命令。

### B4. ElasticsearchView

**现状**:`/db/elasticsearch/:id`。布局:索引树 + DSL 编辑器 + 结果(表格 / JSON 切换)。

**关键调整**:

1. **DSL 模板面板** — 左侧树下加"模板"区(match / term / range / aggregation 6+ 模板),点击插入。
2. **结果区加"分片/耗时"图** — 每次查询的 took / shards / hits 统计在结果顶部。
3. **索引 mapping 视图** — 新 tab 显示 mapping(字段名 + 类型 + 是否可分词),与数据 tab 并列。

### B5. DockerView

**现状**:`/docker/:id`。布局:容器列表 + 详情(Logs / Inspect / Stats / Exec 4 tab)。

**关键调整**:

1. **容器列表批量操作栏** — 多选 + "停止/启动/删除/导出"操作,顶部工具栏。
2. **Exec tab 状态条** — 终端底部加"已连 · 输入延迟 Xms"状态,出错显示红条 + 断线重连。
3. **镜像 tab 加 tag 列表展开** — 镜像行点击展开 tag 列表(当前可能平铺)。

### B6. BrokerView(Kafka/NSQ)

**现状**:`/broker/:id`。布局:Topic 列表 + Consumer Group 详情 + Partition 状态。

**关键调整**:

1. **消费图可视化** — Consumer → Topic → Partition 用节点图(ECharts 已有),hover 高亮 lag。
2. **lag 告警标红** — lag > 阈值时行变红 + 顶部 banner("N 个分区 lag 超限")。
3. **消息预览(peek)** — Topic 详情加"看最新 N 条消息",只读、不消费 offset。

### B7. ExcelView

**现状**:`/excel/:id`。布局:Univer 工作簿 + sidebar(工作表 / 图表) + 顶部 ribbon。**视觉走 Office 调色板(`--excel-*` token)**,与 cyber 主壳共存。

**关键调整**:

1. **保持现有** —— 这是项目里最"成熟"的页面,Office 调色板隔离干净,无需大改。
2. **ribbon 与 cyber 顶栏融合** —— 当前 ribbon 是 Office 风格,和主壳顶栏分两段;优化:ribbon 自身 token 化(已部分做),让 ribbon 顶部和主壳 menubar 视觉对齐(同高 40px,同 `chrome-glass` 背景)。
3. **大数据集导入进度** — 已有 `exportProgress` 模式,镜像到 import。

### B8. SettingsView

**现状**:`/settings` 路由。布局:左侧 tab 导航(`general | appearance | ai | audit | alert | about` 6 个,横向排) + 右侧内容。

**关键调整**:

1. **tab 从横向改竖向**
   - 当前 6 个 tab 横向排,1280px 宽时挤;>6 个 tab 时直接破。
   - 改:左侧 200px 竖向 tab(`.cyber-tab` 竖排变体),右侧 1220px 内容,和 `RightPanel` rail 类似。
   - 理由:Settings 是"配置中心",结构稳定,竖向更稳。

2. **表单分组(accordion)**
   - 当前表单是平铺(API key / baseUrl / model 紧挨着),长。
   - 改:用 `<details>` 或自定义 accordion,默认展开第一个,其他折叠。
   - 理由:用户多数只关心 1-2 个分组,其他折叠。

3. **保存/取消 CTA 固定在右下**
   - 当前每个 tab 自己的"保存"按钮,位置不统一。
   - 改:Settings 底部固定操作栏(只在有未保存改动时出现),"保存"主按钮 + "放弃"次按钮 + 成功提示 toast。
   - 理由:操作一致性。

4. **AI 子页拆分**
   - 当前 AI tab 含 4 个子区(API / Skills / MCP / Command Whitelist),挤在一起。
   - 改:AI tab 内部再分 4 个 sub-tab,或在左侧 tab 加 `ai / ai-skills / ai-mcp`。
   - 理由:AI 配置已经独立成体系。

### C1. SshTerminal

**现状**:`/ssh/:id`。布局:xterm 全屏 + 顶部工具栏(连接信息 / 搜索 / 快捷命令 / 字体大小 / 重连)+ 底部状态(已连 / 输入延迟)。

**关键调整**:

1. **快捷命令图标下拉**(v0.36 已修,确认)—— 检查是否真的持久化。
2. **工具栏分组** — 连接信息(只读)| 搜索 | 快捷命令 | 字体 | 重连;视觉上用 `.cyber-divider` 分。
3. **底部状态加"已发送字节 / 接收字节"** —— 长任务时显示流量,辅助判断连接健康。

### C2. SftpPanel

**现状**:三栏(远端树 + 传输中 + 本地) + 顶部工具栏(上传/下载/同步/刷新)。

**关键调整**:

1. **列宽智能调整** — 当前可拖,但拖完不记忆;改:记忆到 localStorage,下次进自动恢复。
2. **传输任务可视化** — 当前 TransferDock 聚合显示,本视图内也应该有"传输中"列表(`.transfer-dock` 已抽出来)。
3. **右键菜单规约** — 文件/文件夹右键统一(查看 / 编辑 / 重命名 / 删 / 属性),用 `.context-menu` 已有组件。

### C3. TransferDock

**现状**:右下角 pill + 展开面板,显示所有 SFTP 传输任务(进度 / 速度 / 状态)。

**关键调整**:

1. **pill 可拖动换位**(已有)—— 确认 position 持久化。
2. **任务完成自动折叠** —— N 秒无活动自动收起 panel;有错误时强制保留。
3. **限速/暂停(per-task)** —— 大文件传输可单独限速(已经在 store 里有概念,UI 补)。

### D. Dashboard 卡片(欢迎页 + DbDashboard / SshDashboard / DockerDashboard)

**现状**:欢迎页 metric-card(资产指标) + feature-card(模块入口) + recent-row(最近使用);DbDashboard 列出表 + 最近查询;SshDashboard 主机状态;DockerDashboard 容器状态。

**关键调整**:

1. **hover 动效收敛**(已在 §3.4 提到)。
2. **metric-card 数字滚动** —— 已有 `cyber-count-pop`,但要确认"数字变化时弹跳放大"在 stagger 完成后才触发,避免入场时弹。
3. **feature-card 加"使用次数"** —— 当前只有 name + count(模块下资产数),加"今天我用过 N 次"个人化。
4. **recent-row 加类型筛选** —— 当前显示所有类型,可按 SSH/DB/Docker/Excel 过滤。
5. **DbDashboard 表格行加右键** —— 跳到对应 tab/连接。

### E. 弹窗(NewConnectionDialog / AiAgentDialog / ColumnListDialog / IndexListDialog / CreateTableDDL / NewTable / Rename / Broadcast / HostKeyConfirm / KbInteractive / AlertDialog / Settings 各 dialog)

**现状**:均用 `v-dialog` + `cyber-panel` + `cyber-dialog` 弹性动画 + `max-width: 520`(部分 640 / 920)。

**关键调整**:

1. **max-width 增档到 4 级**
   - `xs`:360(简单确认)
   - `sm`:520(标准表单,已有)
   - `md`:720(复杂表单 / 双列表)
   - `lg`:920(详情展示 / 大表格)
   - 当前 max-width 散落,统一收口。

2. **Footer 固定底部**
   - 当前 dialog footer 有的有有的没,有的贴底有的贴内容。
   - 改:统一用 `v-card-actions`,固定底部 + `background: var(--bg-modal-footer)`(已有 token)。

3. **危险操作二次确认**
   - 删除资产 / 删除表 / 断开 SSH 这种,用 `.cyber-btn-danger` 触发 confirm 子 dialog,而不是 inline confirm。

4. **表单双列规约**
   - 短字段(host/port/username)双列,长字段(password/sql)单列 + 全宽。
   - 改:新增 `.form-row` `.form-row-split` 类。

5. **键盘可达**
   - 所有 dialog 打开时自动 focus 第一个 input;Esc 关闭;Enter 提交(在非 textarea)。

---

## 5. 实施路线(优先级 + 风险)

### 5.1 三批走

| 批 | 范围 | 工期估算 | 风险 |
|---|---|---|---|
| **P0(基础底座)** | §3.1-3.3 token + 组件类 + 断点;§3.4 全局动效收敛;§3.5 间距规约清理 | 1-2 天 | 低(token 调整可控,token 改完主壳会变,跑一遍 dev 验) |
| **P1(主壳 + 高频页)** | §A CyberLayout;§B2 DbView;§B1 AiView;§B8 SettingsView;§C1 SshTerminal;§C2 SftpPanel | 3-4 天 | 中(DbView / AiView 是核心,改动大,要回归真实布局) |
| **P2(剩余页 + 弹窗 + 细节)** | §B3-B7 其他 5 个 view;§C3 TransferDock;§D Dashboard;§E 弹窗;§3.4 欢迎页装饰收敛 | 3-4 天 | 中(数量多,但单页改动小) |

总工期:约 7-10 天工作量(可拆给 1-2 人并行)。

### 5.2 验证方式(每批必做)

1. **真机 Tauri 跑 dev** —— `npm run sidecar:build && npm run tauri:dev`。
2. **断点 5 档全跑** —— 1024 / 1280 / 1600 / 1920 / 2560 五个宽度,记录 layout 是否按预期降级。
3. **回归 8 个核心动线**:
   - 新建 SSH 连接 → 打开终端 → 分屏 → 关闭
   - 打开 MySQL 连接 → 跑 SQL → 导出 Excel
   - 打开 AI tab → @ 选 Agent → 选 # 资产 → 跑 plan
   - 拖出 tab 为独立窗口 → 关闭独立窗口(tab 送回)
   - 切换深浅主题
   - 切换主色(青/紫/绿/橙)
   - 拖动 sidebar / right panel 改变宽度
   - 拖动 TransferDock 换位
4. **键盘可达** —— 拔鼠标,只靠 Tab + Enter + Esc 走完上面 8 条。
5. **a11y quick check** —— `prefers-reduced-motion: reduce` 打开,装饰动效应全部关闭。

### 5.3 风险点(必须提前知会)

| 风险 | 说明 | 缓解 |
|---|---|---|
| 间距规约清理会改 100+ 处 | 视觉差异 2-3px,可能让用户感觉"没改但变了" | 改前截图、改后截图、diff 给用户看 |
| 装饰动效收敛有人喜欢 | 设计师/老用户可能喜欢"会动"的感觉 | 留 `var(--anim-decor)` 开关,默认开,Settings 可关 |
| 断点改动影响所有 dialog | dialog max-width 调整会让某些 dialog 内容重排 | 增档而非改档,4 档全保留 |
| 两级 tab 改样式会动 DbView 视觉重心 | DbView 用户量大,改动需要 1-2 天灰度 | 先在 mock workspace 试,用户认可再 merge |
| AI 视图 plan 状态条改顶部会动 scroll 锚点 | 当前有 captureScrollAnchor 处理,改动要测 | 改动时跑 `npm run test:ai-scroll` 单测 |
| 响应式改动在 Tauri 真实窗口才能验 | 浏览器 dev 改 width 跟 Tauri 窗口有差异 | 5 档断点必须在 Tauri 跑,不能只看 dev |

---

## 6. 待用户决策(动手前先对一下)

1. **整体方向** —— 这套方案大方向对吗?有没有"不该动的地方"(比如某个页面用户特别喜欢现状)?
2. **P0/P1/P2 顺序** —— 三批走 OK 吗?还是要先做某个特定页?
3. **动效收敛阈值** —— 装饰动效默认开/关?给开关好还是默认收敛好?
4. **响应式** —— 5 档断点 OK 吗?要不要简化成 3 档(xs/sm/md)?
5. **layout-statusbar-h 30→32** —— 改 2px 影响小,但 32 是新 token 名(原来没起名),用户接受吗?
6. **间距 token 命名** —— `--space-inline/section/page-x` 这套命名 OK 吗?有没有项目内已有约定?
7. **D 风险点** —— §5.3 列的 6 个,有没有要追加的?
8. **是否一次性出 P0 PR** —— 还是先看 P0 diff 再决定 P1?

---

*文档作者:Mavis,2026-07-29。*
*配套:本方案改完后需同步更新 `docs/设计系统.md`(加 token / 组件类 / 断点章节)和 `AGENTS.md`(开发约定加响应式策略)。*
