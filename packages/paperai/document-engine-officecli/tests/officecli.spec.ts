import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  SubprocessHandle,
  SubprocessOutputRead,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OfficeCliDocumentEngine, OfficeCliError, officeCliBin } from '../src/index.ts'

interface Reply {
  stdout?: string
  stderr?: string
  exitCode?: number | null
  lossy?: boolean
}

const read = (text: string, lossy = false): SubprocessOutputRead => ({
  text,
  nextOffset: Buffer.byteLength(text),
  lossy,
})

const handle = (reply: Reply): SubprocessHandle => ({
  pid: 101,
  stdin: undefined,
  stdout: undefined,
  stderr: undefined,
  collected: {
    stdout: { readFrom: () => read(reply.stdout ?? '', reply.lossy) },
    stderr: { readFrom: () => read(reply.stderr ?? '') },
  },
  done: Promise.resolve({
    exitCode: reply.exitCode === undefined ? 0 : reply.exitCode,
    signal: reply.exitCode === null ? 'SIGTERM' : null,
  }),
  terminate: () => {},
  waitForExit: () => Promise.resolve(true),
})

function fixture(respond: (spec: SubprocessSpawnSpec) => Reply) {
  const ctx = new Context()
  const calls: SubprocessSpawnSpec[] = []
  ctx.provide('subprocess', {
    resolveExecutable: vi.fn(async (command: string) => `C:\\bin\\${command}.exe`),
    spawn: vi.fn((spec: SubprocessSpawnSpec) => {
      calls.push(spec)
      return handle(respond(spec))
    }),
  } as never)
  const engine = new OfficeCliDocumentEngine(ctx, {
    command: 'officecli',
    timeoutMs: 10_000,
    outputMaxBytes: 1_000_000,
    terminateGraceMs: 1_000,
  })
  return { ctx, calls, engine }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('OfficeCliDocumentEngine', () => {
  it('reports health through the managed subprocess seam', async () => {
    const ready = fixture(() => ({ stdout: 'officecli 1.0.145\n' }))
    await expect(ready.engine.health()).resolves.toMatchObject({ status: 'ready', version: '1.0.145' })
    expect(ready.calls[0]?.argv).toEqual(['C:\\bin\\officecli.exe', '--version'])
    expect(ready.calls[0]?.env).toMatchObject({
      OFFICECLI_NO_AUTO_UPDATE: '1',
      OFFICECLI_RESIDENT_FLUSH: 'each',
    })

    const unavailable = fixture(() => ({ stderr: 'native load failed', exitCode: 1 }))
    await expect(unavailable.engine.health()).resolves.toEqual({
      status: 'unavailable',
      detail: 'native load failed',
    })
  })

  it('parses nested Office paths and closes the resident document handle', async () => {
    const { calls, engine } = fixture(spec => spec.argv.includes('text')
      ? { stdout: '[/document/body/p[1]] 第一段\n[/document/body/tbl[1]/tr[1]/tc[1]/p[1]] 单元格\nnoise' }
      : {})
    await expect(engine.readTextNodes('D:\\paper.docx')).resolves.toEqual([
      { officePath: '/document/body/p[1]', text: '第一段', kind: 'paragraph' },
      { officePath: '/document/body/tbl[1]/tr[1]/tc[1]/p[1]', text: '单元格', kind: 'table' },
    ])
    expect(calls.map(call => call.argv.slice(1, 3))).toEqual([
      ['view', 'D:\\paper.docx'],
      ['close', 'D:\\paper.docx'],
    ])
  })

  it('ignores malformed text records and classifies non-paragraph nodes', async () => {
    const { engine } = fixture(spec => spec.argv.includes('text')
      ? { stdout: '[bad] ignored\n[/document/body/sdt[1]] field\n[/unterminated\n' }
      : {})
    await expect(engine.readTextNodes('paper.docx')).resolves.toEqual([
      { officePath: '/document/body/sdt[1]', text: 'field', kind: 'unknown' },
    ])
  })

  it('applies one ordered mutation batch, saves once, then closes', async () => {
    const { calls, engine } = fixture(() => ({}))
    await engine.applyMutations('D:\\paper.docx', [
      { type: 'replace-text', officePath: '/document/body/p[1]', text: '新文本' },
      { type: 'insert-paragraph', text: '新增', style: 'Heading 1', after: '/document/body/p[1]' },
      { type: 'remove', officePath: '/document/body/p[3]' },
    ])
    expect(calls.map(call => call.argv.slice(1))).toEqual([
      ['set', 'D:\\paper.docx', '/document/body/p[1]', '--prop', 'text=新文本', '--json'],
      ['add', 'D:\\paper.docx', '/body', '--type', 'paragraph', '--prop', 'text=新增', '--prop', 'style=Heading 1', '--after', '/document/body/p[1]', '--json'],
      ['remove', 'D:\\paper.docx', '/document/body/p[3]', '--json'],
      ['save', 'D:\\paper.docx', '--json'],
      ['close', 'D:\\paper.docx', '--json'],
    ])
  })

  it('parses preview, inspection, and validation envelopes', async () => {
    const { engine } = fixture((spec) => {
      if (spec.argv.includes('html')) return { stdout: '<article>论文</article>' }
      if (spec.argv.includes('get')) return { stdout: '{"data":{"style":"正文"}}' }
      if (spec.argv.includes('validate')) return { stdout: '{"data":{"success":true,"issues":[]}}' }
      return {}
    })
    await expect(engine.previewHtml('paper.docx')).resolves.toBe('<article>论文</article>')
    await expect(engine.inspect('paper.docx', '/document/body/p[1]', 3)).resolves.toEqual({ style: '正文' })
    await expect(engine.validate('paper.docx')).resolves.toEqual({
      success: true,
      details: { success: true, issues: [] },
    })
  })

  it('uses validation exit status when no declared success exists', async () => {
    const empty = fixture(spec => spec.argv.includes('validate') ? { stderr: 'invalid', exitCode: 1 } : {})
    await expect(empty.engine.validate('paper.docx')).resolves.toEqual({
      success: false,
      details: { stderr: 'invalid' },
    })
    const primitiveData = fixture(spec => spec.argv.includes('get') ? { stdout: '{"data":null,"success":true}' } : {})
    await expect(primitiveData.engine.inspect('paper.docx', '/document')).resolves.toEqual({ data: null, success: true })
  })

  it('fails explicitly on truncated or malformed engine output', async () => {
    const truncated = fixture(spec => spec.argv.includes('html')
      ? { stdout: '<article>', lossy: true }
      : {})
    await expect(truncated.engine.previewHtml('paper.docx')).rejects.toThrow(OfficeCliError)

    const malformed = fixture(spec => spec.argv.includes('get')
      ? { stdout: 'not json' }
      : {})
    await expect(malformed.engine.inspect('paper.docx', '/document/body/p[1]')).rejects
      .toThrow('OfficeCLI returned invalid JSON')
  })

  it('rejects invalid deployment limits before publishing a usable Provider', () => {
    const ctx = new Context()
    expect(() => new OfficeCliDocumentEngine(ctx, {
      command: 'officecli',
      timeoutMs: 0,
      outputMaxBytes: 1,
      terminateGraceMs: 1,
    })).toThrow('timeoutMs must be a positive safe integer')
    expect(() => new OfficeCliDocumentEngine(new Context(), { timeoutMs: Number.NaN })).toThrow('timeoutMs must be a positive safe integer')
    expect(() => new OfficeCliDocumentEngine(new Context(), { cleanupTimeoutMs: 0 }))
      .toThrow('cleanupTimeoutMs must be a positive safe integer')
  })

  it('resolves every supported OfficeCLI manifest bin form', () => {
    expect(officeCliBin({ bin: 'cli.js' })).toBe('cli.js')
    expect(officeCliBin({ bin: { officecli: 'bin/officecli.js' } })).toBe('bin/officecli.js')
    expect(() => officeCliBin({ bin: {} })).toThrow('declares no officecli binary')
  })

  it('normalizes legacy converter configuration through Schemastery', () => {
    expect(OfficeCliDocumentEngine.Config({})).toMatchObject({
      cleanupTimeoutMs: 5_000,
      legacyDocTimeoutMs: 120_000,
      legacyDocOutputMaxBytes: 1024 * 1024,
      legacyDocTerminateGraceMs: 5_000,
    })
    expect(OfficeCliDocumentEngine.Config({ legacyDocPowerShellCommand: false }).legacyDocPowerShellCommand).toBe(false)
    expect(OfficeCliDocumentEngine.Config({ legacyDocPowerShellCommand: 'pwsh.exe' }).legacyDocPowerShellCommand).toBe('pwsh.exe')
    expect(() => OfficeCliDocumentEngine.Config({ legacyDocPowerShellCommand: 7 } as never)).toThrow()
  })

  it('uses the packaged launcher and caches executable resolution', async () => {
    const ctx = new Context()
    const calls: SubprocessSpawnSpec[] = []
    const resolveExecutable = vi.fn(async (command: string) => command)
    ctx.provide('subprocess', {
      resolveExecutable,
      spawn: (spec: SubprocessSpawnSpec) => {
        calls.push(spec)
        return handle({ stdout: 'officecli\n' })
      },
    } as never)
    const engine = new OfficeCliDocumentEngine(ctx, {})
    await engine.health()
    await engine.health()
    expect(resolveExecutable).toHaveBeenCalledTimes(1)
    expect(calls[0]?.argv[0]).toBe(process.execPath)
    expect(calls[0]?.argv[1]).toMatch(/officecli/u)
  })

  it('normalizes legacy documents through the structural engine extension', async () => {
    const root = await mkdtemp(join(tmpdir(), 'paperai-officecli-method-'))
    const source = join(root, 'source.doc')
    const target = join(root, 'target.docx')
    await writeFile(source, 'source')
    try {
      const { calls, engine } = fixture((spec) => {
        if (spec.argv.some(argument => argument.endsWith('convert-legacy-doc.ps1'))) writeFileSync(target, 'docx')
        return {}
      })
      await expect(engine.normalizeLegacyDocument(source, target)).resolves.toEqual({ status: 'normalized' })
      await expect(readFile(source, 'utf8')).resolves.toBe('source')
      expect(calls.at(-1)?.argv).toContain(target)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports empty health output and thrown non-Error diagnostics', async () => {
    const empty = fixture(() => ({ stdout: '   ' }))
    await expect(empty.engine.health()).resolves.toMatchObject({ status: 'ready' })
    const failed = fixture(() => ({ stderr: '', exitCode: 5 }))
    await expect(failed.engine.health()).resolves.toEqual({
      status: 'unavailable',
      detail: 'OfficeCLI returned a non-zero status',
    })

    const ctx = new Context()
    ctx.provide('subprocess', {
      resolveExecutable: async () => { throw 'resolution failed' },
      spawn: vi.fn(),
    } as never)
    const engine = new OfficeCliDocumentEngine(ctx, {})
    await expect(engine.health()).resolves.toEqual({ status: 'unavailable', detail: 'resolution failed' })

    const errorCtx = new Context()
    errorCtx.provide('subprocess', {
      resolveExecutable: async () => { throw new Error('executable lookup failed') },
      spawn: vi.fn(),
    } as never)
    const errorEngine = new OfficeCliDocumentEngine(errorCtx, {})
    await expect(errorEngine.health()).resolves.toEqual({ status: 'unavailable', detail: 'executable lookup failed' })
  })

  it('applies optional insertion positions independently', async () => {
    const { calls, engine } = fixture(() => ({}))
    await engine.applyMutations('paper.docx', [
      { type: 'insert-paragraph', text: 'positioned', before: '/document/body/p[2]', index: 1 },
    ])
    expect(calls[0]?.argv).toEqual([
      'C:\\bin\\officecli.exe',
      'add',
      'paper.docx',
      '/body',
      '--type',
      'paragraph',
      '--prop',
      'text=positioned',
      '--before',
      '/document/body/p[2]',
      '--index',
      '1',
      '--json',
    ])
  })

  it('classifies OfficeCLI cancellation, timeout, and non-zero failures', async () => {
    const cancellation = new AbortController()
    const cancelledCtx = new Context()
    cancelledCtx.provide('subprocess', {
      resolveExecutable: async (command: string) => command,
      spawn: (_spec: SubprocessSpawnSpec) => {
        cancellation.abort()
        return handle({ exitCode: null })
      },
    } as never)
    const cancelled = new OfficeCliDocumentEngine(cancelledCtx, { command: 'officecli' })
    await expect(cancelled.previewHtml('paper.docx', cancellation.signal)).rejects.toThrow('cancelled')

    const timeoutCtx = new Context()
    timeoutCtx.provide('subprocess', {
      resolveExecutable: async (command: string) => command,
      spawn: (spec: SubprocessSpawnSpec) => spec.argv.includes('close')
        ? handle({})
        : {
          ...handle({}),
          done: new Promise(resolveDone => spec.signal?.addEventListener('abort', () => {
            resolveDone({ exitCode: null, signal: 'SIGTERM' })
          }, { once: true })),
        },
    } as never)
    const timedOut = new OfficeCliDocumentEngine(timeoutCtx, { command: 'officecli', timeoutMs: 1 })
    await expect(timedOut.previewHtml('paper.docx')).rejects.toThrow('timed out')

    for (const stderr of ['failed explicitly', '']) {
      const failed = fixture(spec => spec.argv.includes('html') ? { exitCode: 3, stderr } : {})
      await expect(failed.engine.previewHtml('paper.docx')).rejects.toThrow(
        stderr === '' ? 'exit code 3' : stderr,
      )
    }
  })

  it('closes inspection, mutation, and validation with a fresh signal after caller cancellation', async () => {
    const operations = [
      (engine: OfficeCliDocumentEngine, signal: AbortSignal) =>
        engine.inspect('paper.docx', '/document/body/p[1]', 2, signal),
      (engine: OfficeCliDocumentEngine, signal: AbortSignal) =>
        engine.applyMutations('paper.docx', [
          { type: 'replace-text', officePath: '/document/body/p[1]', text: 'changed' },
        ], signal),
      (engine: OfficeCliDocumentEngine, signal: AbortSignal) => engine.validate('paper.docx', signal),
    ]

    for (const operation of operations) {
      const controller = new AbortController()
      const calls: SubprocessSpawnSpec[] = []
      let cleanupSignal: AbortSignal | undefined
      const ctx = new Context()
      ctx.provide('subprocess', {
        resolveExecutable: async (command: string) => command,
        spawn: (spec: SubprocessSpawnSpec) => {
          calls.push(spec)
          if (spec.argv.includes('close')) {
            cleanupSignal = spec.signal
            return handle({})
          }
          controller.abort(new Error('caller cancelled'))
          return handle({ exitCode: null })
        },
      } as never)
      const engine = new OfficeCliDocumentEngine(ctx, {
        command: 'officecli',
        cleanupTimeoutMs: 25,
      })

      await expect(operation(engine, controller.signal)).rejects.toThrow('cancelled')
      expect(calls.at(-1)?.argv).toContain('close')
      expect(cleanupSignal).toBeDefined()
      expect(cleanupSignal).not.toBe(controller.signal)
      expect(cleanupSignal?.aborted).toBe(false)
    }
  })

  it('bounds independent close cleanup without replacing the caller cancellation', async () => {
    const controller = new AbortController()
    let cleanupSignal: AbortSignal | undefined
    const ctx = new Context()
    ctx.provide('subprocess', {
      resolveExecutable: async (command: string) => command,
      spawn: (spec: SubprocessSpawnSpec) => {
        if (!spec.argv.includes('close')) {
          controller.abort(new Error('caller cancelled'))
          return handle({ exitCode: null })
        }
        cleanupSignal = spec.signal
        return {
          ...handle({}),
          done: new Promise(resolveDone => spec.signal?.addEventListener('abort', () => {
            resolveDone({ exitCode: null, signal: 'SIGTERM' })
          }, { once: true })),
        }
      },
    } as never)
    const warning = vi.spyOn(ctx.logger, 'warn')
    const engine = new OfficeCliDocumentEngine(ctx, {
      command: 'officecli',
      cleanupTimeoutMs: 1,
    })

    await expect(engine.inspect('paper.docx', '/document', 1, controller.signal))
      .rejects.toThrow('cancelled')
    expect(cleanupSignal?.aborted).toBe(true)
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('timed out after 1 ms'))
  })

  it('handles absent readers, stderr truncation, and close failures', async () => {
    const noReadersCtx = new Context()
    noReadersCtx.provide('subprocess', {
      resolveExecutable: async (command: string) => command,
      spawn: () => ({ ...handle({}), collected: {} }),
    } as never)
    const noReaders = new OfficeCliDocumentEngine(noReadersCtx, { command: 'officecli' })
    await expect(noReaders.previewHtml('paper.docx')).resolves.toBe('')

    const stderrLossyCtx = new Context()
    stderrLossyCtx.provide('subprocess', {
      resolveExecutable: async (command: string) => command,
      spawn: () => ({
        ...handle({}),
        collected: {
          stdout: { readFrom: () => read('') },
          stderr: { readFrom: () => read('truncated', true) },
        },
      }),
    } as never)
    const stderrLossy = new OfficeCliDocumentEngine(stderrLossyCtx, { command: 'officecli' })
    await expect(stderrLossy.previewHtml('paper.docx')).rejects.toThrow('output exceeded')

    const closeFailure = fixture(spec => spec.argv.includes('close') ? { lossy: true } : { stdout: '<p />' })
    const warning = vi.spyOn(closeFailure.ctx.logger, 'warn')
    await expect(closeFailure.engine.previewHtml('paper.docx')).resolves.toBe('<p />')
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('could not close'))
  })

  it('serializes overlapping operations and releases only the current lease tail', async () => {
    const ctx = new Context()
    let releaseFirst: (() => void) | undefined
    let viewCount = 0
    const calls: string[][] = []
    ctx.provide('subprocess', {
      resolveExecutable: async (command: string) => command,
      spawn: (spec: SubprocessSpawnSpec) => {
        calls.push([...spec.argv])
        if (spec.argv.includes('html') && viewCount++ === 0) {
          return {
            ...handle({ stdout: 'first' }),
            done: new Promise((resolveDone) => {
              releaseFirst = () => { resolveDone({ exitCode: 0, signal: null }) }
            }),
          }
        }
        return handle({ stdout: spec.argv.includes('html') ? 'second' : '' })
      },
    } as never)
    const engine = new OfficeCliDocumentEngine(ctx, { command: 'officecli' })
    const first = engine.previewHtml('same.docx')
    const second = engine.previewHtml('same.docx')
    await vi.waitFor(() => { expect(releaseFirst).toBeTypeOf('function') })
    expect(calls.filter(argv => argv.includes('html'))).toHaveLength(1)
    releaseFirst?.()
    await expect(Promise.all([first, second])).resolves.toEqual(['first', 'second'])
  })
})
