# Agent Note: StarHub 产物行剩余计数改开右侧 drawer

Status: implemented

[English](2026-08-22-starhub-produced-files-drawer.md) | 中文

## 问题

v0.91.0 让产物行的「+ N 个文件」剩余计数在 chip lane 下方行内展开完整改动清单。产品反馈否决了这个形态：长清单会把对话撑开,行内面板在收尾消息里读起来是杂物。需求是:行只保留标签和放得下的 chip,剩余计数按钮改成打开贴右边缘的 drawer,按新增/修改分组列出全部变更文件。同一次改造还要清掉 drawer 取代的 v0.92.0 残留:行内清单的 CSS class、locale key,以及第二行的「在文件夹中显示」按钮。

## 决策

**drawer 是 `ProducedFiles` 的局部 UI。** `ProducedFilesDrawer`(`packages/client/ui-deliverables/src/client/ProducedFilesDrawer.tsx`)接纯 props——entries、chip 共用的查看窗优先 `open`、可选的 `showInFolder`、`onClose`,以及从行组件透传的 `t` 席位——由 `ProducedFiles` 里一个 `useState<boolean>` 控制显隐。不新增 slot(slot 是跨包组合 API,drawer 是单个特性的局部展开)、不要 store、不碰 ctx、不 portal 到 `document.body`——`position: fixed` + `z-index: 900` 的层已经高于聊天流、低于全局 dialog(1000)与 toast(1100),对流内局部展开足够。

**呈现。** 遮罩(`--dsw-alias-bg-mask-1`)点击即关;面板贴 viewport 右缘,宽 `min(360px, calc(100vw - 48px))`,铺满视口高度,150ms 滑入(`prefers-reduced-motion` 下关闭动画)。头部是「本轮改动文件(共 N 个)」加 ×;正文按可折叠的新增(created)与修改分组列行,新增在上,每行显示完整路径与共享的 `Stats` +/- 行数;底栏仅在 loopback Host 报告 `canOpenPath` 时显示「在文件夹中显示」(与被删除的第二行按钮同一门禁)。行点击复用 chip 的打开器(`viewFile` 优先、`openFile` 兜底),且有意不自动关 drawer——壳内查看窗是独立 overlay,用户可继续浏览清单。全部样式走 `--dsw-*` token,无硬编码色值。

**无障碍。** `role="dialog"` + `aria-modal="true"` + `aria-labelledby`;打开时焦点落到 × 按钮;Esc 由 document 级监听关闭(遮罩可能持有焦点);Tab 经面板自身 `onKeyDown` 在面板按钮间循环;owner 的 `closeDrawer` 关闭后把焦点还给打开它的剩余计数按钮(`aria-haspopup="dialog"` 同步状态)。

**共享 `Stats` 抽提。** +/- 徽章移入 `ProducedStats.tsx`,chip 与 drawer 行共用一份实现,避免 `ProducedFiles` 与其 drawer 之间出现循环 import。

## 考虑过的替代方案

- **保留行内展开、只改样式。** 被产品反馈直接否决;本次的核心就是把流内面板从收尾消息里拿掉。
- **像 `Modal` 一样 portal 到 `document.body`。** Modal 的 portal 是为了让祖先层叠上下文里的吸顶控件不能压过遮罩。drawer 是聊天局部展开,选定 z-index 的 `position: fixed` 已经压过聊天流;portal 只会让这层脱离组件树而换不到任何行为。
- **为 drawer 新增 slot。** slot 是跨包组合 API;ui-deliverables 之外没有任何消费方渲染或替换这个面板,开 slot 等于发布一个无消费方的组合点。

## 后果

行的默认形态回到 标签 + ≤6 枚测量 chip + 剩余计数按钮;v0.91.0 的行内清单(`expanded` state,`.list` / `.listHead` / `.collapse` / `.listRow` / `.tagCreated` / `.tagModified` / `.listPath` / `.showFolder` 等 class,`produced.collapse` / `produced.listTitle` locale key)全部删除。`tests/produced-files-drawer.client.spec.tsx` 钉住分组顺序、行打开器、三条关闭路径、分组折叠、底栏门禁与焦点纪律;行规格改为断言「点 +N 开 drawer」。两个新源文件都在 per-file 100% 覆盖率门禁下。

同一 PR 顺带修复了 v0.92.0 memory 系列:memory-context 的 pre-step 门禁此前把「namespace 未写过」当作开启(现改为 explicit-true,与默认关一致);memory-sink 的 abort 检查在 `Promise.race` 里会输给立即 resolve 的 generate(现改为调用前检查);`tsconfig.base.json` 缺三个最新 starhub 包的显式 source-plane 映射(导致 vitest 把 `@deepseek-ai/dsh-starhub-memory-context` 解析到过期构建产物);`memory-sink/tsconfig.json` 缺对应 project reference;两个 memory 包与该系列触碰的 settings 文件现均达到 100% 覆盖率门禁。
