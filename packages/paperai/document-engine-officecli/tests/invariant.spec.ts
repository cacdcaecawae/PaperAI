import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  apply,
  converterAssetIssue,
  verifyConverterAsset,
} from '../src/invariant.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('OfficeCLI package invariant', () => {
  it('accepts a regular converter asset and diagnoses invalid paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'paperai-officecli-invariant-'))
    roots.push(root)
    const asset = join(root, 'converter.ps1')
    await writeFile(asset, 'exit 0')
    await expect(converterAssetIssue(asset)).resolves.toBeUndefined()
    await expect(converterAssetIssue(root)).resolves.toContain('not a regular file')
    await expect(converterAssetIssue(join(root, 'missing.ps1'))).resolves.toContain('unavailable')

    const fail = vi.fn((message: string): never => { throw new Error(message) })
    await expect(verifyConverterAsset(asset, fail)).resolves.toBeUndefined()
    expect(fail).not.toHaveBeenCalled()
    await expect(verifyConverterAsset(root, fail)).rejects.toThrow('not a regular file')
  })

  it('registers the package-owned installer and validates the packaged asset', async () => {
    let installer: InvariantInstaller | undefined
    const dispose = vi.fn()
    const register = vi.fn((_packageName: string, candidate: InvariantInstaller) => {
      installer = candidate
      return dispose
    })
    const ctx = { invariants: { register } } as unknown as Context
    await expect(apply(ctx)).resolves.toBe(dispose)
    expect(register).toHaveBeenCalledWith('@paperai/document-engine-officecli', expect.any(Function))
    await expect(installer?.(ctx, (message) => { throw new Error(message) })).resolves.toBeUndefined()
  })
})
