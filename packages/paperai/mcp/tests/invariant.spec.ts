import { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { describe, expect, it, vi } from 'vitest'
import { apply, inject, name } from '../src/invariant.ts'

describe('PaperAI MCP invariant companion', () => {
  it('reserves the package name through the invariant registry', async () => {
    const ctx = new Context()
    const dispose = vi.fn()
    const register = vi.fn((_packageName: string, _installer: InvariantInstaller) => dispose)
    ctx.provide('invariants', { register } as never)

    expect(name).toBe('paperai-mcp-invariant')
    expect(inject).toEqual(['invariants'])
    await expect(apply(ctx)).resolves.toBe(dispose)
    expect(register).toHaveBeenCalledWith('@paperai/mcp', expect.any(Function))
    const install = register.mock.calls[0]?.[1]
    if (install === undefined) throw new Error('expected invariant installer registration')
    const fail = vi.fn((message: string): never => { throw new Error(message) })
    expect(install(ctx, fail)).toBeUndefined()
    await ctx.fiber.dispose()
  })
})
