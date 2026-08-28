/**
 * Package-owned invariant companion for the immutable PaperAI vocabulary.
 * @module @paperai/domain/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@paperai/domain'

/** Cordis companion plugin name. */
export const name = 'paperai-domain-invariant'
/** Service required before the companion can register. */
export const inject = ['invariants']

// No runtime invariant: the package owns immutable data contracts but no live relation.
const install: InvariantInstaller = () => {}

/** Register this package's intentionally empty invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
