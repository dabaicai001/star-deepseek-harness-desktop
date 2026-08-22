/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-starhub-memory-sink`.
 *
 * Empty companion: turn-stopping is a fire-and-forget listener; the durable
 * write goes through `starhub/memory.write` (sdk-transport → Rust ai_memory_add),
 * and the LLM extraction call is owned by the apply() function under test.
 * No package-owned runtime invariant to assert.
 *
 * @module @deepseek-ai/dsh-starhub-memory-sink/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-starhub-memory-sink'

/** Cordis companion plugin name. */
export const name = 'starhub-memory-sink-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: turn-stopping is a fire-and-forget listener; the
 * durable write goes through `starhub/memory.write` (sdk-transport → Rust
 * ai_memory_add), and the LLM extraction is owned by apply() under test.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
