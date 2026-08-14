/**
 * Browser StarHub navigation plugin contributing one entry to the
 * conversation view slot without defining a service.
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: the 'conversation.view' SlotMap row (declared by the slot's
// owning package) must be in the program for the register call to type.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { StarHubTerminalView } from './StarHubTerminalView.tsx'

/** Required services: the slot registry. */
export const inject = ['slots']

/**
 * Client plugin body: register the StarHub terminal view tab. Registration
 * rides the slot service's inject wrapper, so it waits on the slot
 * declaration and plugin unload removes the tab.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'starhub-terminal',
    order: 20,
    label: '终端',
  }, StarHubTerminalView))
}
