/**
 * Browser StarHub navigation plugin(方案 P1):侧栏「工具」大类/子类导航 +
 * shell.overlay 实例操作页 + 右侧工具工作区列。
 *
 * 状态拆分:nav store(root scope)挂在 sidebar.navigation / shell.overlay
 * 上;资产列表与「当前子类 + 打开的资产实例」由 apply 持有的两份裸
 * source 承载,经各注册的 inject hooks 舱位下发、经注入回调写入——
 * one-handle-one-scope 约束(共享 handle 跨 scope 挂载抛错)与
 * session-maybe 无会话分支不下发注册侧 store 这两条规定,把工作区的
 * 共享状态都推到了 hooks 舱位范式(同 ui-agent-preset controller)。
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: the SlotMap rows of the target slots must be in the program for
// the register calls to type (declared by the slots' owning packages).
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: the connection service merge (ctx.get('connection') typing).
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { createStarHubAssets, createStarHubNavStore, createToolSelectionBridge } from './store.ts'
import { StarHubNav } from './StarHubNav.tsx'
import { StarHubOverlay } from './StarHubOverlay.tsx'
import { StarHubToolWorkspace } from './StarHubToolWorkspace.tsx'

/** Required services: the slot registry, the layout panel-action face, and the connection wire. */
export const inject = ['slots', 'layout', 'connection']

/**
 * Client plugin body: one root-scope store handle (sidebar + overlay) plus
 * the apply-owned selection bridge and asset-list holder across the four
 * registrations — the sidebar navigation, the overlay iframe layer, and the
 * two tool-workspace column seats (`workspace` for the no-session state,
 * `details.workspace` inside the session details panel). All ride
 * slots.inject, so each waits on its slot declaration and plugin unload
 * removes the pair.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  const navStore = createStarHubNavStore()
  const assets = createStarHubAssets()
  const selection = createToolSelectionBridge()
  ctx.slots.inject('sidebar.navigation', () => ctx.slots.register({
    name: 'sidebar.navigation',
    id: 'starhub-nav',
    order: 20,
    label: 'StarHub',
    store: navStore,
    inject: () => ({
      // Open (toggle) the docked StarHub tool workspace in the details
      // column — click a subcategory once to open, again to close.
      selectSubcategory: (key: string) => {
        selection.selectSubcategory(key)
        ctx.layout.toggleDetails()
      },
      hooks: { selection: selection.source },
    }),
  }, StarHubNav))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'starhub-overlay',
    order: 100,
    label: 'StarHub',
    store: navStore,
    inject: () => ({
      closeAsset: selection.closeAsset,
      hooks: { selection: selection.source },
    }),
  }, StarHubOverlay))
  const workspaceInject = () => ({
    // The connection wire face for syncing the current tool context to
    // host settings (Path B plan 4.3).
    api: (ctx.get('connection') as ConnectionHandle).api,
    openAsset: selection.openAsset,
    refreshAssets: assets.refresh,
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
}
