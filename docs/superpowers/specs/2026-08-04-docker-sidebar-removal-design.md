# 删除 Docker 视图中间容器列表面板 — 设计文档

日期:2026-08-04
状态:已获用户批准(方案:删除 + 补日志联动)

## 背景

v0.40.0 起 Docker 资产树已 DB 化,左栏资产树可直接展开容器/镜像对象树。Docker 视图内嵌的 `.docker-sidebar` 中间面板(标题 "Docker",含连接状态、容器列表 Running/Stopped 分组)与左栏资产树功能重复,用户要求删除。

## 现状分析(探索结论)

- 面板非独立组件,内嵌于 `src/views/DockerView.vue` 模板 592-688 行(`.docker-sidebar` 块)。
- 状态为组件内 ref:`sidebarCollapsed` / `sidebarWidth` / `sidebarDragging`(72-74 行),无持久化。
- 容器列表点击 → `selectContainer()`(298-302 行):`dockerStore.selectContainer(id)` + `selectedTab='logs'` + `loadContainerLogs(id, '200')`。
- 隐藏耦合:88-90 行 `watch(selectedTab)` 切 exec 时强制 `sidebarCollapsed = true`。
- 选中/打开主路径已走资产树:`AssetTree.onNodeSelect` → `objectTree.selectObject` → `openAssetTab` + `dispatchObjectSelection` → `DockerView.applyObjectSelection`(395-402 行)直接写 `dockerStore.selectedContainerId`,不经过面板。
- 全局无其他 `docker-sidebar` 引用,无孤儿引用风险。

## 设计

### 删除范围(全部在 `src/views/DockerView.vue`,另加 i18n)

1. 模板 592-688 行整个 `.docker-sidebar` 块(含收起按钮、连接状态、容器列表、`ResizableSidebarHandle`)。
2. 三个 sidebar ref(72-74 行)。
3. exec 强制折叠 watch(88-90 行)。
4. `selectContainer()`(298-302 行,仅面板调用)。
5. `.docker-sidebar` / `.collapsed` / `.dragging` 相关样式(约 1006-1040 行)。
6. `ResizableSidebarHandle` import(组件本体保留,其他视图仍在用)。
7. i18n 清理:`docker.sidebarCollapse` / `docker.sidebarExpand`(zh/en 两份,仅此处使用)。

### 行为补偿(用户已批准)

在 `applyObjectSelection` 的 `docker-container` 分支补上 `selectedTab='logs'` + `loadContainerLogs(containerId, '200')`,使资产树选中容器的体验与旧面板一致(选中即加载日志并切到 logs tab)。

### 不动的部分

`dockerStore` / `objectTree` / `assetRouting` / `AssetTree*` 一律不动;右上独立刷新按钮保留。

## 验证

1. `npm run build`(vue-tsc + vite)。
2. AGENTS.md 7.3 节真实布局回归:`npm run dev` + 浏览器 1280×800,检查 Docker 视图布局(无中间面板、右侧详情区占满)、资产树点容器 → 选中 + 日志加载 + logs tab、exec tab 正常、无 console error。
3. 版本号按 6.5.1 规则递增修订版(0.40.0 → 0.40.1),同步七处,CHANGELOG 记录。
