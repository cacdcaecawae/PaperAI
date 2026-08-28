/** Package-owned invariant companion for the document-engine Service Definition. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@paperai/document-engine'
export const name = 'paperai-document-engine-invariant'
export const inject = ['invariants']

// No runtime invariant: provider exclusivity is enforced by Cordis' single
// ctx.documentEngine seat.
const install: InvariantInstaller = () => {}

export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
