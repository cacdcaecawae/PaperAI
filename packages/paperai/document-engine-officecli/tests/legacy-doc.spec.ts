import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  SubprocessHandle,
  SubprocessOutputRead,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  convertLegacyDocument,
  isUsableTarget,
  LEGACY_DOC_CONVERTER_ASSET,
  LegacyDocConversionError,
  rethrowUnlessMissing,
  type LegacyDocConverterConfig,
} from '../src/legacy-doc.ts'

interface Reply {
  readonly stdout?: string
  readonly stderr?: string
  readonly exitCode?: number | null
  readonly signal?: NodeJS.Signals | null
  readonly stdoutLossy?: boolean
  readonly stderrLossy?: boolean
}

const roots: string[] = []

const config = (overrides: Partial<LegacyDocConverterConfig> = {}): LegacyDocConverterConfig => ({
  command: 'powershell.exe',
  timeoutMs: 10_000,
  outputMaxBytes: 4096,
  terminateGraceMs: 250,
  ...overrides,
})

const read = (text: string, lossy = false): SubprocessOutputRead => ({
  text,
  nextOffset: Buffer.byteLength(text),
  lossy,
})

const settledHandle = (reply: Reply): SubprocessHandle => ({
  pid: 202,
  stdin: undefined,
  stdout: undefined,
  stderr: undefined,
  collected: {
    stdout: { readFrom: () => read(reply.stdout ?? '', reply.stdoutLossy) },
    stderr: { readFrom: () => read(reply.stderr ?? '', reply.stderrLossy) },
  },
  done: Promise.resolve({
    exitCode: reply.exitCode === undefined ? 0 : reply.exitCode,
    signal: reply.signal ?? null,
  }),
  terminate: () => {},
  waitForExit: () => Promise.resolve(true),
})

async function paths() {
  const root = await mkdtemp(join(tmpdir(), 'paperai-legacy-doc-'))
  roots.push(root)
  const source = join(root, 'source.doc')
  const target = join(root, 'working.docx')
  await writeFile(source, 'immutable-source')
  return { root, source, target }
}

function runtime(options: {
  readonly resolve?: (command: string, signal?: AbortSignal) => Promise<string>
  readonly spawn?: (spec: SubprocessSpawnSpec) => SubprocessHandle
} = {}) {
  const calls: SubprocessSpawnSpec[] = []
  const resolveExecutable = vi.fn(async (command: string, _env?: Readonly<Record<string, string>>, signal?: AbortSignal) => (
    await (options.resolve?.(command, signal) ?? Promise.resolve(`C:\\Windows\\${command}`))
  ))
  const spawn = vi.fn((spec: SubprocessSpawnSpec) => {
    calls.push(spec)
    return options.spawn?.(spec) ?? settledHandle({})
  })
  return {
    calls,
    resolveExecutable,
    spawn,
    service: { resolveExecutable, spawn } as never,
  }
}

async function conversionError(promise: Promise<unknown>): Promise<LegacyDocConversionError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(LegacyDocConversionError)
    return error as LegacyDocConversionError
  }
  throw new Error('Expected legacy conversion to fail')
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('legacy Word normalization', () => {
  it('pins read-only Word open and independent DOCX save semantics in the packaged program', async () => {
    const program = await readFile(LEGACY_DOC_CONVERTER_ASSET, 'utf8')
    expect(program).toContain('$document = $word.Documents.Open($SourcePath, $false, $true, $false)')
    expect(program).toContain('$document.SaveAs2($OutputPath, 16)')
    expect(program).toContain('PAPERAI_WORD_COM_UNAVAILABLE:')
    expect(program).not.toMatch(/\$document\.Save\(\)/u)
  })

  it('runs the packaged script directly and preserves the source', async () => {
    const { root, source, target } = await paths()
    const subprocess = runtime({
      spawn: (_spec) => {
        writeFileSync(target, 'independent-docx')
        return settledHandle({ stdout: 'converted' })
      },
    })

    await expect(convertLegacyDocument(subprocess.service, config(), source, target, undefined, 'win32'))
      .resolves.toEqual({ status: 'normalized' })
    await expect(readFile(source, 'utf8')).resolves.toBe('immutable-source')
    await expect(readFile(target, 'utf8')).resolves.toBe('independent-docx')
    expect(subprocess.resolveExecutable).toHaveBeenCalledWith('powershell.exe', undefined, undefined)
    expect(subprocess.calls[0]).toMatchObject({
      cwd: root,
      graceMs: 250,
      env: {},
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 4096 },
        stderr: { maxBytes: 4096 },
      },
    })
    expect(subprocess.calls[0]?.argv).toEqual(expect.arrayContaining([
      'C:\\Windows\\powershell.exe',
      '-NoProfile',
      '-NonInteractive',
      '-File',
      source,
      target,
    ]))
    expect(subprocess.calls[0]?.argv.some(argument => argument.endsWith('convert-legacy-doc.ps1'))).toBe(true)
  })

  it('reports unsupported and disabled deployments without spawning', async () => {
    const { source, target } = await paths()
    const subprocess = runtime()
    await expect(convertLegacyDocument(subprocess.service, config(), source, target, undefined, 'linux'))
      .resolves.toEqual({
        status: 'degraded',
        detail: 'Legacy .doc conversion requires Windows and Microsoft Word; current platform is linux',
      })
    await expect(convertLegacyDocument(subprocess.service, config({ command: false }), source, target, undefined, 'win32'))
      .resolves.toMatchObject({ status: 'degraded' })
    await expect(convertLegacyDocument(subprocess.service, config({ command: '' }), source, target, undefined, 'win32'))
      .resolves.toMatchObject({ status: 'degraded' })
    expect(subprocess.resolveExecutable).not.toHaveBeenCalled()
    expect(subprocess.spawn).not.toHaveBeenCalled()
  })

  it('uses the Windows default and degrades when PowerShell cannot resolve', async () => {
    const { source, target } = await paths()
    const subprocess = runtime({ resolve: async () => { throw new Error('not on PATH') } })
    await expect(convertLegacyDocument(subprocess.service, config({ command: undefined }), source, target, undefined, 'win32'))
      .resolves.toEqual({
        status: 'degraded',
        detail: "Legacy .doc conversion cannot start PowerShell 'powershell.exe': not on PATH",
      })
    expect(subprocess.resolveExecutable).toHaveBeenCalledWith('powershell.exe', undefined, undefined)

    const thrownString = runtime({ resolve: async () => { throw 'missing executable' } })
    const degraded = await convertLegacyDocument(thrownString.service, config(), source, target, undefined, 'win32')
    expect(degraded.status).toBe('degraded')
    if (degraded.status === 'degraded') expect(degraded.detail).toContain('missing executable')
  })

  it('degrades for unavailable Word COM and removes partial output', async () => {
    const cases: Reply[] = [
      { exitCode: 42, stderr: 'registration missing' },
      { exitCode: 1, stderr: 'PAPERAI_WORD_COM_UNAVAILABLE:' },
    ]
    for (const reply of cases) {
      const { source, target } = await paths()
      const subprocess = runtime({
        spawn: () => {
          writeFileSync(target, 'partial')
          return settledHandle(reply)
        },
      })
      await expect(convertLegacyDocument(subprocess.service, config(), source, target, undefined, 'win32'))
        .resolves.toMatchObject({ status: 'degraded' })
      await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  })

  it('classifies caller cancellation before lookup and during lookup', async () => {
    const { source, target } = await paths()
    const before = new AbortController()
    before.abort('stop before lookup')
    const beforeError = await conversionError(
      convertLegacyDocument(runtime().service, config(), source, target, before.signal, 'win32'),
    )
    expect(beforeError.code).toBe('CANCELLED')
    expect(beforeError.message).toContain('stop before lookup')

    const during = new AbortController()
    const subprocess = runtime({
      resolve: async () => {
        during.abort(new Error('stop during lookup'))
        throw new Error('lookup interrupted')
      },
    })
    const duringError = await conversionError(
      convertLegacyDocument(subprocess.service, config(), source, target, during.signal, 'win32'),
    )
    expect(duringError.code).toBe('CANCELLED')
    expect(duringError.message).toContain('stop during lookup')
  })

  it('classifies cancellation and timeout after spawn and removes partial output', async () => {
    const cancelled = await paths()
    const controller = new AbortController()
    const cancellationRuntime = runtime({
      spawn: () => {
        writeFileSync(cancelled.target, 'partial')
        controller.abort()
        return settledHandle({ exitCode: null, signal: 'SIGTERM' })
      },
    })
    await expect(convertLegacyDocument(
      cancellationRuntime.service,
      config(),
      cancelled.source,
      cancelled.target,
      controller.signal,
      'win32',
    )).rejects.toMatchObject({ code: 'CANCELLED' })
    await expect(stat(cancelled.target)).rejects.toMatchObject({ code: 'ENOENT' })

    const timedOut = await paths()
    const timeoutRuntime = runtime({
      spawn: (spec) => {
        writeFileSync(timedOut.target, 'partial')
        return {
          ...settledHandle({}),
          done: new Promise(resolveDone => spec.signal?.addEventListener('abort', () => {
            resolveDone({ exitCode: null, signal: 'SIGTERM' })
          }, { once: true })),
        }
      },
    })
    await expect(convertLegacyDocument(timeoutRuntime.service, config({ timeoutMs: 1 }), timedOut.source, timedOut.target, undefined, 'win32'))
      .rejects.toMatchObject({ code: 'TIMED_OUT' })
    await expect(stat(timedOut.target)).rejects.toMatchObject({ code: 'ENOENT' })

    const cancelledDuringFailure = await paths()
    const failedController = new AbortController()
    const cancelledRuntime = runtime({ spawn: () => {
      failedController.abort(17)
      throw new Error('spawn interrupted')
    } })
    const cancelledError = await conversionError(convertLegacyDocument(
      cancelledRuntime.service,
      config(),
      cancelledDuringFailure.source,
      cancelledDuringFailure.target,
      failedController.signal,
      'win32',
    ))
    expect(cancelledError.code).toBe('CANCELLED')
    expect(cancelledError.message).toContain('caller cancellation')

    const rejectedOnTimeout = await paths()
    const timeoutRejectionRuntime = runtime({
      spawn: spec => ({
        ...settledHandle({}),
        done: new Promise((_resolve, reject) => spec.signal?.addEventListener('abort', () => {
          reject(new Error('terminated on deadline'))
        }, { once: true })),
      }),
    })
    const timeoutError = await conversionError(convertLegacyDocument(
      timeoutRejectionRuntime.service,
      config({ timeoutMs: 1 }),
      rejectedOnTimeout.source,
      rejectedOnTimeout.target,
      undefined,
      'win32',
    ))
    expect(timeoutError.code).toBe('TIMED_OUT')
    expect(timeoutError.cause).toBeInstanceOf(Error)
  })

  it('rejects truncated output from either stream and cleans the target', async () => {
    for (const reply of [{ stdoutLossy: true }, { stderrLossy: true }]) {
      const { source, target } = await paths()
      const subprocess = runtime({
        spawn: () => {
          writeFileSync(target, 'partial')
          return settledHandle(reply)
        },
      })
      await expect(convertLegacyDocument(subprocess.service, config(), source, target, undefined, 'win32'))
        .rejects.toMatchObject({ code: 'OUTPUT_TRUNCATED' })
      await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  })

  it('reports non-zero, signalled, and spawn failures with useful diagnostics', async () => {
    const replies: Reply[] = [
      { exitCode: 7, stderr: 'conversion rejected' },
      { exitCode: null, signal: 'SIGKILL' },
    ]
    for (const reply of replies) {
      const { source, target } = await paths()
      const subprocess = runtime({ spawn: () => settledHandle(reply) })
      await expect(convertLegacyDocument(subprocess.service, config(), source, target, undefined, 'win32'))
        .rejects.toMatchObject({ code: 'PROCESS_FAILED' })
    }

    const rejected = await paths()
    const subprocess = runtime({ spawn: () => { throw new Error('spawn rejected') } })
    const rejectedError = await conversionError(
      convertLegacyDocument(subprocess.service, config(), rejected.source, rejected.target, undefined, 'win32'),
    )
    expect(rejectedError.code).toBe('PROCESS_FAILED')
    expect(rejectedError.cause).toBeInstanceOf(Error)
  })

  it('rejects unsafe path and output states without overwriting an existing target', async () => {
    const { root, source, target } = await paths()
    const subprocess = runtime()
    await expect(convertLegacyDocument(subprocess.service, config(), join(root, 'source.txt'), target, undefined, 'win32'))
      .rejects.toMatchObject({ code: 'TARGET_INVALID' })
    await expect(convertLegacyDocument(subprocess.service, config(), source, join(root, 'target.doc'), undefined, 'win32'))
      .rejects.toMatchObject({ code: 'TARGET_INVALID' })
    await expect(convertLegacyDocument(subprocess.service, config(), join(root, 'same.doc'), join(root, 'same.doc'), undefined, 'win32'))
      .rejects.toMatchObject({ code: 'TARGET_INVALID' })

    await writeFile(target, 'existing')
    await expect(convertLegacyDocument(subprocess.service, config(), source, target, undefined, 'win32'))
      .rejects.toMatchObject({ code: 'TARGET_INVALID' })
    await expect(readFile(target, 'utf8')).resolves.toBe('existing')
  })

  it('rejects missing, empty, and non-regular converter output', async () => {
    const missing = await paths()
    await expect(convertLegacyDocument(runtime().service, config(), missing.source, missing.target, undefined, 'win32'))
      .rejects.toMatchObject({ code: 'TARGET_INVALID' })

    const empty = await paths()
    const emptyRuntime = runtime({ spawn: () => {
      writeFileSync(empty.target, '')
      return settledHandle({})
    } })
    await expect(convertLegacyDocument(emptyRuntime.service, config(), empty.source, empty.target, undefined, 'win32'))
      .rejects.toMatchObject({ code: 'TARGET_INVALID' })

    const directory = await paths()
    const directoryRuntime = runtime({ spawn: () => {
      mkdirSync(directory.target)
      return settledHandle({})
    } })
    await expect(convertLegacyDocument(directoryRuntime.service, config(), directory.source, directory.target, undefined, 'win32'))
      .rejects.toBeInstanceOf(AggregateError)

    const absentReaders = await paths()
    const noReadersRuntime = runtime({ spawn: () => {
      writeFileSync(absentReaders.target, 'docx')
      return { ...settledHandle({}), collected: {} }
    } })
    await expect(convertLegacyDocument(noReadersRuntime.service, config(), absentReaders.source, absentReaders.target, undefined, 'win32'))
      .resolves.toEqual({ status: 'normalized' })
  })

  it('propagates target lookup failures and cleanup failures without hiding the primary result', async () => {
    expect(() => { rethrowUnlessMissing({ code: 'ENOENT' }) }).not.toThrow()
    const lookupFailure = Object.assign(new Error('lookup failed'), { code: 'ENOTDIR' })
    expect(() => { rethrowUnlessMissing(lookupFailure) }).toThrow(lookupFailure)

    const degraded = await paths()
    const degradedRuntime = runtime({ spawn: () => {
      mkdirSync(degraded.target)
      return settledHandle({ exitCode: 42 })
    } })
    try {
      await convertLegacyDocument(degradedRuntime.service, config(), degraded.source, degraded.target, undefined, 'win32')
      expect.unreachable('cleanup should fail for a directory target')
    } catch (error) {
      expect((error as NodeJS.ErrnoException).code).toMatch(/EISDIR|EPERM/u)
    }
  })

  it('accepts only non-empty regular non-link output metadata', () => {
    expect(isUsableTarget({ isFile: () => true, isSymbolicLink: () => false, size: 1 })).toBe(true)
    expect(isUsableTarget({ isFile: () => false, isSymbolicLink: () => false, size: 1 })).toBe(false)
    expect(isUsableTarget({ isFile: () => true, isSymbolicLink: () => true, size: 1 })).toBe(false)
    expect(isUsableTarget({ isFile: () => true, isSymbolicLink: () => false, size: 0 })).toBe(false)
  })

  it('retains stable error identity', () => {
    const cause = new Error('root cause')
    const error = new LegacyDocConversionError('PROCESS_FAILED', 'conversion failed', { cause })
    expect(error).toMatchObject({
      name: 'LegacyDocConversionError',
      code: 'PROCESS_FAILED',
      message: 'conversion failed',
      cause,
    })
  })
})
