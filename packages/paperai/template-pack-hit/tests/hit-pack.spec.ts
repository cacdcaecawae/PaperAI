import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, HIT_TEMPLATE_PACK } from '../src/index.ts'

let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
})

describe('HIT template pack', () => {
  it('pins every original DOC and normalized DOCX to its manifest digest', async () => {
    expect(HIT_TEMPLATE_PACK).toMatchObject({
      id: 'hit-master-thesis',
      name: 'HIT 硕士毕设',
      version: 'provided-snapshot-2026-08-28',
    })
    expect(HIT_TEMPLATE_PACK.members.map(member => [member.id, member.usage, member.appliesToRoles])).toEqual([
      ['proposal', 'form-template', ['proposal']],
      ['midterm', 'form-template', ['midterm']],
      ['thesis-format', 'format-reference', ['manuscript']],
    ])
    for (const member of HIT_TEMPLATE_PACK.members) {
      const source = await readFile(member.source.path)
      const normalized = await readFile(member.normalized.path)
      expect(source.byteLength).toBe(member.source.size)
      expect(normalized.byteLength).toBe(member.normalized.size)
      expect(sha256(source)).toBe(member.source.sha256)
      expect(sha256(normalized)).toBe(member.normalized.sha256)
    }
  })

  it('registers and disposes through the owning plugin fiber', async () => {
    ctx = new Context()
    const dispose = vi.fn()
    const registerPack = vi.fn(() => dispose)
    ctx.provide('paperTemplates', { registerPack } as never)

    apply(ctx)
    expect(registerPack).toHaveBeenCalledWith(HIT_TEMPLATE_PACK)
    await ctx.fiber.dispose()
    expect(dispose).toHaveBeenCalledOnce()
    ctx = undefined
  })
})

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}
