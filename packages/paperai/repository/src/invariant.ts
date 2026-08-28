/** Package-owned invariant companion for the PaperAI repository. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@paperai/repository'
export const name = 'paperai-repository-invariant'
export const inject = ['invariants']

// No runtime invariant: the service keeps no cache beside storage-domain's
// authoritative tables; storage-domain owns durable/memory divergence checks.
const install: InvariantInstaller = () => {}

export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
