/**
 * Browser StarHub navigation plugin: footer-action section rows plus the
 * full-frame overlay iframe layer, sharing one nav store handle.
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: the SlotMap rows of both target slots must be in the program for
// the register calls to type (declared by the slots' owning packages).
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { createStarHubNavStore } from './store.ts'
import { StarHubNav } from './StarHubNav.tsx'
import { StarHubOverlay } from './StarHubOverlay.tsx'

/** Required services: the slot registry. */
export const inject = ['slots']

/**
 * Client plugin body: one shared nav store handle across two registrations —
 * the section rows in `sidebar.footer.action` and the iframe layer in
 * `shell.overlay`. Both ride slots.inject, so each waits on the slot
 * declaration and plugin unload removes the pair.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  const store = createStarHubNavStore()
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'starhub-nav',
    order: 20,
    label: 'StarHub',
    store,
  }, StarHubNav))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'starhub-overlay',
    order: 100,
    label: 'StarHub',
    store,
  }, StarHubOverlay))
}
