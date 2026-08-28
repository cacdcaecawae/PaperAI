/** Runtime invariants owned by the PaperAI workbench Host Remote. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

/** Cordis plugin name. */
export const name = 'paperai-workbench-service-invariant'
/** Invariant registry dependency. */
export const inject = ['invariants']

// No runtime invariant: the Remote is a projection over domain authorities
// and owns no independent durable state that can be cross-checked without
// duplicating those services.
const install: InvariantInstaller = () => {}

/** Register this package's invariant ownership companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@paperai/workbench-service', install))
