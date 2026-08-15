/**
 * Browser StarHub navigation plugin: primary sidebar navigation rows plus the
 * full-frame overlay iframe layer, sharing one nav store handle. Phase 0
 * (Path B) additionally registers an in-shell `conversation.view` tab that
 * renders StarHub tool UI directly in the shell React tree (no iframe) and
 * talks to the desktop backend through top-frame Tauri IPC.
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: the SlotMap rows of both target slots must be in the program for
// the register calls to type (declared by the slots' owning packages).
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { createStarHubNavStore } from './store.ts'
import { createStarHubAssetStore } from './asset-store.ts'
import { StarHubNav } from './StarHubNav.tsx'
import { StarHubOverlay } from './StarHubOverlay.tsx'
import { StarHubToolWorkspace } from './StarHubToolWorkspace.tsx'

/** Required services: the slot registry. */
export const inject = ['slots']

/**
 * Client plugin body: one shared nav store handle across two registrations —
 * the section rows in `sidebar.navigation` and the iframe layer in
 * `shell.overlay`. Both ride slots.inject, so each waits on the slot
 * declaration and plugin unload removes the pair. Phase 0 (Path B) adds the
 * in-shell `conversation.view` tab sharing a separate asset store handle.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  const store = createStarHubNavStore()
  ctx.slots.inject('sidebar.navigation', () => ctx.slots.register({
    name: 'sidebar.navigation',
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
  const assetStore = createStarHubAssetStore()
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'starhub-tools',
    order: 30,
    label: 'StarHub 工具',
    store: assetStore,
  }, StarHubToolWorkspace))
}
