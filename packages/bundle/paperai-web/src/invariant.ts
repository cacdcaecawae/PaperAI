/**
 * Package-owned invariant companion for the PaperAI profile bundle.
 * @module @paperai/bundle-web/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@paperai/bundle-web'

/** Cordis companion plugin name. */
export const name = 'paperai-web-bundle-invariant'
/** Service required before the companion can register. */
export const inject = ['invariants']

// No runtime invariant: static patch rows own no mutable runtime relation;
// every inserted plugin carries its own package invariant.
const install: InvariantInstaller = () => {}

/** Register this package's intentionally empty invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
