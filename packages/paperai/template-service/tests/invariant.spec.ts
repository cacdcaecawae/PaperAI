import { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { describe, expect, it, vi } from 'vitest'
import { apply, inject, name } from '../src/invariant.ts'

describe('template-service invariant companion', () => {
  it('reserves the package name through the invariant registry', async () => {
    const ctx = new Context()
    const dispose = vi.fn()
    const register = vi.fn((_packageName: string, _installer: InvariantInstaller) => dispose)
    ctx.provide('invariants', { register } as never)

    expect(name).toBe('paperai-template-service-invariant')
    expect(inject).toEqual(['invariants'])
    await expect(apply(ctx)).resolves.toBe(dispose)
    expect(register).toHaveBeenCalledWith('@paperai/template-service', expect.any(Function))
    const call = register.mock.calls[0]
    expect(call).toBeDefined()
    if (call === undefined) throw new Error('expected invariant registration')
    const install = call[1]
    expect(install).toBeTypeOf('function')
    await install(ctx, (message) => { throw new Error(message) })
    await ctx.fiber.dispose()
  })
})
