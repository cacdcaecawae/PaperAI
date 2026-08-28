import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@paperai/agent-acp'

export const name = 'paperai-agent-acp-invariant'
export const inject = ['invariants']

const install: InvariantInstaller = Object.assign(
  (ctx: Context, fail: (message: string) => never) => {
    if (!ctx.agents.hasFactoryRoute('codex')) fail('Codex ACP Agent factory route is missing')
    if (!ctx.agents.hasFactoryRoute('claude')) fail('Claude ACP Agent factory route is missing')
  },
  { inject: ['agents'] },
)

export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
