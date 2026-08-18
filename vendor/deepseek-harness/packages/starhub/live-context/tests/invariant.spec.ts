import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as LiveContextInvariant from '../src/invariant.ts'

describe('live-context invariant companion', () => {
  it('removes its registry contribution when its fiber is disposed (HMR safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    const fiber = await ctx.plugin(LiveContextInvariant)

    expect(() => {
      ctx.invariants.register('@deepseek-ai/dsh-starhub-live-context', () => {})
    }).toThrow(/already registered/)

    await fiber.dispose()
    await expect(ctx.plugin(LiveContextInvariant).await()).resolves.toBeDefined()
    await ctx.fiber.dispose()
  })
})
