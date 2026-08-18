/**
 * Browser StarHub navigation plugin(方案 P1,重构版):侧栏「工具」大类/子类
 * 导航 + shell.overlay(连接对话框)+ 右侧工具工作区列 + dsh
 * 设置面板的 StarHub 分区。
 *
 * 状态拆分:nav store(root scope,仅大类展开态)挂在 sidebar.navigation
 * 上;资产列表、「当前子类 + 当前资产」与连接对话框开关由
 * apply 持有的三份裸 source 承载,经各注册的 inject hooks 舱位下发、经
 * 注入回调写入——one-handle-one-scope 约束(共享 handle 跨 scope 挂载抛错)
 * 与 session-maybe 无会话分支不下发注册侧 store 这两条规定,把共享状态都
 * 推到了 hooks 舱位范式(同 ui-agent-preset controller)。
 *
 * 资产实例操作页不再用整幅 overlay 盖住 dsh 主壳:点击资产行经
 * openNewPage(tauri.ts)在桌面端开独立 webview 窗口(label 走
 * capability 的 starhub-* glob,embed 页在新窗口里保有 IPC 授权),
 * 浏览器预览退化为新标签页。选择桥仍记录当前资产(instanceId/
 * routePrefix),供工具上下文(AI 注入)同步使用。
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: the SlotMap rows of the target slots must be in the program for
// the register calls to type (declared by the slots' owning packages).
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: the connection service merge (ctx.get('connection') typing).
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { IConversation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ISessions, IWorkspaces } from '@deepseek-ai/dsh-client-runtime/client'
import type { InputTriggerServiceContract } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { createStarHubAssetSource } from './asset-source.ts'
import { createAskAiHandler, createOpenAssetHandler, focusShellConversation, subscribeHostEvents } from './host-events.ts'
import {
  createConnectionManagerOverlay, createDbWorkbench, createDockerWorkbench, createSshTerminalOverlay,
  createStarHubAssets, createStarHubNavStore, createToolSelectionBridge,
} from './store.ts'
import { assetInstanceUrl, isDatabaseAsset, isDockerAsset, isSshTerminalAsset, routeNameForAsset, STARHUB_SUBCATEGORIES, type StarHubAsset } from './sections.ts'
import { focusWindowByKey, openNewPage } from './tauri.ts'
import { StarHubNav } from './StarHubNav.tsx'
import { StarHubOverlay } from './StarHubOverlay.tsx'
import { StarHubToolWorkspace } from './StarHubToolWorkspace.tsx'
import { AboutTab } from './settings/about.tsx'
import { AiTab } from './settings/ai.tsx'
import { AlertTab } from './settings/alert.tsx'
import { AuditTab } from './settings/audit.tsx'
import { PluginsTab } from './settings/plugins.tsx'

/**
 * Required services: the slot registry, the layout panel-action face, the
 * connection wire, the input-trigger pipeline (for the `@` source) and the
 * session/workspace/conversation services (for `starhub://ask-ai`).
 */
export const inject = ['slots', 'layout', 'connection', 'inputTriggers', 'sessions', 'workspaces', 'conversation']

/**
 * Client plugin body: one root-scope store handle (sidebar) plus the
 * apply-owned selection bridge, asset-list holder, and connection-dialog
 * holder across the registrations — the sidebar navigation, the overlay
 * dialog layer, the two tool-workspace column seats (`workspace` for the
 * no-session state, `details.workspace` inside the session details
 * panel), and the dsh settings dialog's StarHub section. All ride
 * slots.inject, so each waits on its slot declaration and plugin unload
 * removes the contribution.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  const navStore = createStarHubNavStore()
  const assets = createStarHubAssets()
  const selection = createToolSelectionBridge()
  const connectionManager = createConnectionManagerOverlay()
  const sshTerminal = createSshTerminalOverlay()
  const dbWorkbench = createDbWorkbench()
  const dockerWorkbench = createDockerWorkbench()
  // 服务面:注入数组已声明依赖,读取必然非空;conversation 在预填时退化处理。
  const connection = ctx.get('connection') as ConnectionHandle
  const inputTriggers = ctx.get('inputTriggers') as InputTriggerServiceContract
  const sessions = ctx.get('sessions') as ISessions
  const workspaces = ctx.get('workspaces') as IWorkspaces
  const conversation = ctx.get('conversation') as IConversation | undefined
  /** 打开资产实例操作页:记录选择桥(供 AI 工具上下文)后按类型分派——
   *  需求 5(数据库 React 化):MySQL/PG/CH 走壳内 DbWorkbench(React native);
   *  Redis/ES 在各自 React 工作台落地前回落 Vue embed(避免被 MySQL 风格
   *  DbWorkbench 错误呈现);SSH 终端走壳内 SshTerminalOverlay;其余资产
   *  维持 openNewPage 独立窗口(Vue embed)。 */
  const openAssetPage = (asset: StarHubAsset): void => {
    selection.openAsset(asset)
    const fullAsset = assets.source.getSnapshot().assets.find((item) => item.id === asset.id)
    const route = routeNameForAsset(asset)
    // DbWorkbench 是 SQL 方言工作台,仅承接 mysql/postgresql/clickhouse;
    // redis/es/broker 等非 SQL 类型不得进入(见 sections.ts NATIVE_ROUTE_NAMES 注释)。
    if (isDatabaseAsset(asset) && (route === 'db-mysql' || route === 'db-postgresql' || route === 'db-clickhouse')) {
      if (fullAsset !== undefined) dbWorkbench.open(fullAsset)
      return
    }
    if (isSshTerminalAsset(asset)) {
      if (fullAsset !== undefined) sshTerminal.open(fullAsset)
      return
    }
    if (isDockerAsset(asset)) {
      if (fullAsset !== undefined) dockerWorkbench.open(fullAsset)
      return
    }
    const sel = selection.source.getSnapshot()
    if (sel.routePrefix === null || sel.instanceId === null) return
    // 窗口 label 携带资产 id 作为 key,供 starhub://open-asset 的 focus 复用。
    openNewPage(assetInstanceUrl(sel.routePrefix, sel.instanceId), asset.name, asset.id)
      // 开窗失败(如 IPC 未授权)打日志,不阻断主壳交互
      .catch((e: unknown) => { console.error('打开资产页面失败:', e) })
  }
  /** 右键「新窗口打开」子类段页:embed 入口不带资产 id,停在段空态页。 */
  const openSubcategoryPage = (key: string): void => {
    const sub = STARHUB_SUBCATEGORIES.find(s => s.key === key)
    if (sub === undefined) return
    openNewPage(`/starhub/index.html?embed=1&route=${encodeURIComponent(sub.routePrefix)}`, sub.label)
      .catch((e: unknown) => { console.error('打开工具段页失败:', e) })
  }
  ctx.slots.inject('sidebar.navigation', () => ctx.slots.register({
    name: 'sidebar.navigation',
    id: 'starhub-nav',
    order: 20,
    label: 'StarHub',
    store: navStore,
    inject: () => ({
      // 子类点击:切到不同子类只换内容、保证右侧工作区列打开;重复点击
      // 当前子类才 toggle 收起(修:切子类误收起右侧栏)。
      selectSubcategory: (key: string) => {
        const same = selection.source.getSnapshot().subcategory === key
        selection.selectSubcategory(key)
        if (same) ctx.layout.toggleDetails()
        else ctx.layout.openDetails()
      },
      openSubcategoryPage,
      hooks: { selection: selection.source },
    }),
  }, StarHubNav))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'starhub-overlay',
    order: 100,
    label: 'StarHub',
    inject: () => ({
      openConnectionManager: () => connectionManager.open(),
      closeConnectionManager: connectionManager.close,
      closeSshTerminal: sshTerminal.close,
      closeDbWorkbench: dbWorkbench.close,
      closeDockerWorkbench: dockerWorkbench.close,
      refreshAssets: assets.refresh,
      hooks: {
        connectionManager: connectionManager.source,
        sshTerminal: sshTerminal.source,
        dbWorkbench: dbWorkbench.source,
        dockerWorkbench: dockerWorkbench.source,
      },
    }),
  }, StarHubOverlay))
  const workspaceInject = () => ({
    // The connection wire face for syncing the current tool context to
    // host settings (Path B plan 4.3).
    api: connection.api,
    openAsset: openAssetPage,
    refreshAssets: assets.refresh,
    openConnectionManager: connectionManager.open,
    // 右侧栏「AI 助手」:聚焦(或新建)壳内 AI 会话。
    openAiAssistant: () => focusShellConversation(sessions, workspaces, conversation),
    hooks: { selection: selection.source, assets: assets.source },
  })
  // 两座工作区席位都不声明注册侧 store:session-maybe 无会话分支不下发
  // useStore,资产/选择状态全部由上面的 hooks 舱位供给。
  ctx.slots.inject('workspace', () => ctx.slots.register({
    name: 'workspace',
    inject: workspaceInject,
  }, StarHubToolWorkspace))
  ctx.slots.inject('details.workspace', () => ctx.slots.register({
    name: 'details.workspace',
    inject: workspaceInject,
  }, StarHubToolWorkspace))
  // 契约 §6.1:`@` 资产 source(ui-input-trigger 流水线);pick 轻绑定上下文,
  // 不切窗口。ctx.effect 保证 HMR 卸载时反注册 source。
  ctx.effect(
    () => inputTriggers.registerSource(createStarHubAssetSource({ api: connection.api, assets, selection })),
    'starhub: @ asset source',
  )
  // 契约 §6.2-6.3:监听 Tauri 宿主事件(open-asset / ask-ai);订阅经
  // ctx.effect 注册,dispose 卸载监听(HMR 安全)。
  ctx.effect(() => subscribeHostEvents({
    onOpenAsset: createOpenAssetHandler({
      assets,
      openAssetPage,
      focusWindow: focusWindowByKey,
    }),
    onAskAi: createAskAiHandler({
      api: connection.api,
      selection,
      sessions,
      workspaces,
      conversation,
    }),
  }), 'starhub: tauri host events')
  // 设置融入底部设置齿轮:dsh 设置面板侧栏的 StarHub 可展开分组(点击
  // 分组头展开/收起,点子项右侧直渲对应 tab——两列,无内部嵌套列)。
  // group='starhub' 由 ui-settings-general 的 SettingsRoot 渲染为折叠分组;
  // 5 个子 section 分别直渲 AI/插件/审计/告警/关于。order 30 起排在
  // 通用(0)/模型(10)/插件(15)/Agent 预设(20)之后。
  const starhubTabs: ReadonlyArray<{
    id: string; order: number; label: string; component: () => JSX.Element
  }> = [
    { id: 'starhub-ai', order: 30, label: 'AI 助手', component: AiTab },
    { id: 'starhub-plugins', order: 31, label: '插件', component: PluginsTab },
    { id: 'starhub-audit', order: 32, label: '审计日志', component: AuditTab },
    { id: 'starhub-alert', order: 33, label: '告警规则', component: AlertTab },
    { id: 'starhub-about', order: 34, label: '关于', component: AboutTab },
  ]
  for (const tab of starhubTabs) {
    ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section',
      id: tab.id,
      order: tab.order,
      label: tab.label,
      group: 'starhub',
      groupLabel: 'StarHub',
    }, tab.component))
  }
}
