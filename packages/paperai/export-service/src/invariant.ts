/** Package-owned invariant companion for `@paperai/export-service`. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@paperai/export-service'

/** Cordis companion plugin name. */
export const name = 'paperai-export-service-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

// No runtime invariant: a successful export has no independent mutable
// projection. The returned commit, report, and output file are produced by one
// operation, while commit-head integrity remains owned by commit-service.
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying runtime invariants.
 * @returns the installed registration's disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
