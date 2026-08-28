import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle, SubprocessOutputRead, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { describe, expect, it, vi } from 'vitest'
import { TemplateAssetStore } from '../src/storage.ts'

describe('TemplateAssetStore', () => {
  it('requires an absolute root and accepts only bounded regular Word files', async () => {
    const ctx = context(() => processHandle())
    expect(() => store(ctx, 'relative')).toThrow('absolute path')
    const root = await mkdtemp(join(tmpdir(), 'paperai-assets-'))
    const assets = store(ctx, join(root, 'store'), { maxUploadBytes: 2 })
    const text = join(root, 'template.txt')
    const large = join(root, 'large.docx')
    const directory = join(root, 'directory.docx')
    await writeFile(text, 'x')
    await writeFile(large, 'xxx')
    await mkdir(directory)

    await expect(assets.importUpload(text)).rejects.toThrow('must use .doc or .docx')
    await expect(assets.importUpload(large)).rejects.toThrow('exceeds 2 bytes')
    await expect(assets.importUpload(directory)).rejects.toThrow('regular file')
    const aborted = new AbortController()
    aborted.abort(new Error('cancelled'))
    await expect(assets.importUpload(large, aborted.signal)).rejects.toThrow('cancelled')
  })

  it('publishes DOCX content once and detects corruption at an immutable path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'paperai-assets-'))
    const source = join(root, 'template.docx')
    await writeFile(source, 'docx-content')
    const assets = store(context(() => processHandle()), join(root, 'store'))

    const first = await assets.importUpload(source)
    const second = await assets.importUpload(source)
    expect(second).toEqual(first)
    await chmod(first.immutableSourcePath, 0o644)
    await writeFile(first.immutableSourcePath, 'corrupted')
    await expect(assets.importUpload(source)).rejects.toThrow('different bytes')
  })

  it('verifies built-in sizes, hashes, and normalized extensions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'paperai-assets-'))
    const source = join(root, 'template.doc')
    const normalized = join(root, 'template.docx')
    const wrongExtension = join(root, 'normalized.doc')
    await writeFile(source, 'source')
    await writeFile(normalized, 'normalized')
    await writeFile(wrongExtension, 'normalized')
    const assets = store(context(() => processHandle()), join(root, 'store'))
    const sourceAsset = manifestSource(source, 'source')
    const normalizedAsset = manifestNormalized(normalized, 'normalized')

    await expect(assets.importBuiltIn({ ...sourceAsset, sha256: 'bad' }, normalizedAsset)).rejects.toThrow('invalid SHA-256')
    await expect(assets.importBuiltIn({ ...sourceAsset, size: 2 }, normalizedAsset)).rejects.toThrow('does not match')
    await expect(assets.importBuiltIn(sourceAsset, { ...normalizedAsset, sha256: '0'.repeat(64) })).rejects.toThrow('does not match')
    await expect(assets.importBuiltIn(sourceAsset, { ...normalizedAsset, path: wrongExtension })).rejects.toThrow('must be DOCX')
    await expect(assets.importBuiltIn(sourceAsset, normalizedAsset)).resolves.toMatchObject({
      sourceSha256: sha256('source'),
      normalizedSha256: sha256('normalized'),
    })
  })

  it('reports disabled, failed, truncated, cancelled, and timed-out legacy conversion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'paperai-assets-'))
    const source = join(root, 'template.doc')
    await writeFile(source, 'legacy')
    await expect(store(context(() => processHandle()), join(root, 'disabled'), {
      wordComPowerShellCommand: '',
    }).importUpload(source)).rejects.toThrow('requires the Windows Word converter')

    await expect(store(context((spec) => {
      writeConverted(spec)
      return processHandle({ exitCode: 7, stderr: 'conversion failed' })
    }), join(root, 'failed')).importUpload(source)).rejects.toThrow('conversion failed')

    await expect(store(context((spec) => {
      writeConverted(spec)
      return processHandle({ exitCode: 8, omitCollectedStreams: true })
    }), join(root, 'failed-without-stderr')).importUpload(source)).rejects.toThrow('exit 8')

    await expect(store(context((spec) => {
      writeConverted(spec)
      return processHandle({ lossy: true })
    }), join(root, 'lossy')).importUpload(source)).rejects.toThrow('output exceeded')

    const cancelled = new AbortController()
    await expect(store(context((spec) => {
      writeConverted(spec)
      cancelled.abort('user cancelled')
      return processHandle()
    }), join(root, 'cancelled')).importUpload(source, cancelled.signal)).rejects.toThrow('user cancelled')

    const cancelledWithoutReason = new AbortController()
    await expect(store(context((spec) => {
      writeConverted(spec)
      cancelledWithoutReason.abort(null)
      return processHandle()
    }), join(root, 'cancelled-without-reason')).importUpload(source, cancelledWithoutReason.signal)).rejects.toThrow('template operation aborted')

    await expect(store(context((spec) => {
      writeConverted(spec)
      return processHandle({ delayMs: 10 })
    }), join(root, 'timeout'), { converterTimeoutMs: 1 }).importUpload(source)).rejects.toThrow('timed out')

    await expect(store(context(() => processHandle()), join(root, 'missing-output')).importUpload(source)).rejects.toThrow('ENOENT')

    await expect(store(context((spec) => {
      const outputPath = spec.argv.at(-1)
      if (outputPath === undefined) throw new Error('missing converter output path')
      mkdirSync(outputPath)
      return processHandle()
    }), join(root, 'invalid-output')).importUpload(source)).rejects.toThrow()
  })
})

interface HandleOptions {
  exitCode?: number
  stderr?: string
  lossy?: boolean
  delayMs?: number
  omitCollectedStreams?: boolean
}

function processHandle(options: HandleOptions = {}): SubprocessHandle {
  const output = (text: string, lossy = false): SubprocessOutputRead => ({
    text,
    nextOffset: Buffer.byteLength(text),
    lossy,
  })
  return {
    pid: 1,
    stdin: undefined,
    stdout: undefined,
    stderr: undefined,
    collected: options.omitCollectedStreams === true
      ? {}
      : {
        stdout: { readFrom: () => output('', options.lossy) },
        stderr: { readFrom: () => output(options.stderr ?? '') },
      },
    done: options.delayMs === undefined
      ? Promise.resolve({ exitCode: options.exitCode ?? 0, signal: null })
      : new Promise((resolve) => {
        setTimeout(() => {
          resolve({ exitCode: options.exitCode ?? 0, signal: null })
        }, options.delayMs)
      }),
    terminate: () => {},
    waitForExit: () => Promise.resolve(true),
  }
}

function context(spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle): Context {
  const ctx = new Context()
  ctx.provide('subprocess', {
    resolveExecutable: vi.fn(async (command: string) => command),
    spawn: vi.fn(spawn),
  } as never)
  return ctx
}

function store(
  ctx: Context,
  storageRoot: string,
  overrides: Partial<ConstructorParameters<typeof TemplateAssetStore>[1]> = {},
): TemplateAssetStore {
  return new TemplateAssetStore(ctx, {
    storageRoot,
    maxUploadBytes: 1024,
    converterTimeoutMs: 10_000,
    converterOutputMaxBytes: 1024,
    converterTerminateGraceMs: 100,
    wordComPowerShellCommand: 'powershell.exe',
    ...overrides,
  })
}

function writeConverted(spec: SubprocessSpawnSpec): void {
  const outputPath = spec.argv.at(-1)
  if (outputPath === undefined) throw new Error('missing converter output path')
  writeFileSync(outputPath, 'converted')
}

function manifestSource(path: string, content: string) {
  return {
    path,
    originalFileName: 'template.doc',
    sha256: sha256(content),
    size: Buffer.byteLength(content),
  }
}

function manifestNormalized(path: string, content: string) {
  return {
    path,
    sha256: sha256(content),
    size: Buffer.byteLength(content),
  }
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}
