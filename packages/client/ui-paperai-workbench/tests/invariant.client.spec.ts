import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as WorkbenchInvariant from '../src/invariant.ts'

describe('PaperAI workbench invariant companion', () => {
  it('registers the explained empty installer and keeps the node half inert', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await expect(ctx.plugin(WorkbenchInvariant).await()).resolves.toBeDefined()
    const { apply } = await import('../src/index.ts')
    apply(ctx)
    expect(() =>{  apply(ctx, { retainedPreviews: 0 }) }).toThrow(/positive integer/)
    await ctx.fiber.dispose()
  })
})
