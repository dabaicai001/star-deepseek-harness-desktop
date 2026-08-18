import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as DomainEventsInvariant from '../src/invariant.ts'

describe('domain-events invariant companion', () => {
  it('removes its registry contribution when its fiber is disposed (HMR safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    const fiber = await ctx.plugin(DomainEventsInvariant)

    expect(() => {
      ctx.invariants.register('@deepseek-ai/dsh-starhub-domain-events', () => {})
    }).toThrow(/already registered/)

    await fiber.dispose()
    await expect(ctx.plugin(DomainEventsInvariant).await()).resolves.toBeDefined()
    await ctx.fiber.dispose()
  })
})
