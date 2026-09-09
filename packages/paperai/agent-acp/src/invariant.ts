import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@paperai/agent-acp'

export const name = 'paperai-agent-acp-invariant'
export const inject = ['invariants']

// No runtime invariant: provider connection state is private to each factory; Agent/session ownership is checked by the core invariant.
const install: InvariantInstaller = () => {}

export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
