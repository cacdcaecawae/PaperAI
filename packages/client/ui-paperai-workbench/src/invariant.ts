/** Package-owned invariant companion for `@paperai/ui-workbench`. */
/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@paperai/ui-workbench'

/** Cordis companion plugin name. */
export const name = 'paperai-ui-workbench-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: browser-local Remote projections and active tabs emit
 * no Host Cordis events. Slot disposal, stale resource and node rejection,
 * node-level commit publication, and generated Remote mounting are covered by
 * the package lifecycle tests.
 */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
