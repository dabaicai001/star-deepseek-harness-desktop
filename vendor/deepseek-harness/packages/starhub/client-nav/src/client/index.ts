/**
 * Browser StarHub navigation plugin(方案 P1):侧栏「工具」大类/子类导航 +
 * shell.overlay 实例操作页 + 右侧工具工作区列,共享一个 store handle。
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
import { createStarHubStore } from './store.ts'
import { StarHubNav } from './StarHubNav.tsx'
import { StarHubOverlay } from './StarHubOverlay.tsx'
import { StarHubToolWorkspace } from './StarHubToolWorkspace.tsx'

/** Required services: the slot registry, the layout panel-action face, and the connection wire. */
export const inject = ['slots', 'layout', 'connection']

/**
 * Client plugin body: one shared store handle across all four registrations —
 * the sidebar navigation, the overlay iframe layer, and the two tool-workspace
 * column seats (`workspace` for the no-session state, `details.workspace`
 * inside the session details panel). All ride slots.inject, so each waits on
 * its slot declaration and plugin unload removes the pair.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  const store = createStarHubStore()
  ctx.slots.inject('sidebar.navigation', () => ctx.slots.register({
    name: 'sidebar.navigation',
    id: 'starhub-nav',
    order: 20,
    label: 'StarHub',
    store,
    inject: () => ({
      // Open (toggle) the docked StarHub tool workspace in the details
      // column — click a subcategory once to open, again to close.
      openWorkspace: () => { ctx.layout.toggleDetails() },
    }),
  }, StarHubNav))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'starhub-overlay',
    order: 100,
    label: 'StarHub',
    store,
  }, StarHubOverlay))
  ctx.slots.inject('workspace', () => ctx.slots.register({
    name: 'workspace',
    store,
    inject: () => ({
      // The connection wire face for syncing the current tool context to
      // host settings (Path B plan 4.3).
      api: (ctx.get('connection') as ConnectionHandle).api,
    }),
  }, StarHubToolWorkspace))
  ctx.slots.inject('details.workspace', () => ctx.slots.register({
    name: 'details.workspace',
    store,
    inject: () => ({
      api: (ctx.get('connection') as ConnectionHandle).api,
    }),
  }, StarHubToolWorkspace))
}
