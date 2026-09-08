/** Invariant companion for the browser-owned ACP settings projection. */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
/** Cordis companion identity. */
export const name = 'paperai-ui-acp-invariant'
/** Diagnostic registry dependency. */
export const inject = ['invariants']
// No runtime invariant: no Host event stream owns browser forms; the ACP service checks provider and session ownership.
const install: InvariantInstaller = () => {}
/**
 * Register the companion for browser state that has no independent Host invariant.
 * @param ctx - owning diagnostic context.
 * @returns the registration disposer.
 */
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register('@paperai/ui-acp', install))
