import { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { describe, expect, it, vi } from 'vitest'
import { apply, inject, name } from '../src/invariant.ts'

describe('export-service invariant companion', () => {
  it('registers package ownership and returns its disposer', async () => {
    const dispose = vi.fn()
    const register = vi.fn((_packageName: string, _installer: InvariantInstaller) => dispose)
    const ctx = new Context()
    ctx.provide('invariants', { register } as never)
    expect(name).toBe('paperai-export-service-invariant')
    expect(inject).toEqual(['invariants'])
    expect(await apply(ctx)).toBe(dispose)
    expect(register).toHaveBeenCalledWith('@paperai/export-service', expect.any(Function))
    const installer = register.mock.calls[0]?.[1]
    if (installer === undefined) throw new Error('expected invariant installer registration')
    const fail = vi.fn((message: string): never => { throw new Error(message) })
    expect(installer(ctx, fail)).toBeUndefined()
    await ctx.fiber.dispose()
  })
})
