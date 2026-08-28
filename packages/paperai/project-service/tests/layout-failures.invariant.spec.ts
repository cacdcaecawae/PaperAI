import { access, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'

type FaultMethod = 'mkdir' | 'open' | 'lstat' | 'readFile' | 'unlink' | 'rmdir'

interface Fault {
  readonly method: FaultMethod
  readonly pathIncludes: string
  readonly error: unknown
}

const faultState = vi.hoisted(() => ({ faults: [] as Fault[] }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const wrap = (method: FaultMethod, operation: (...args: unknown[]) => unknown) =>
    (...args: unknown[]) => {
      const path = String(args[0])
      const at = faultState.faults.findIndex(fault => fault.method === method && path.includes(fault.pathIncludes))
      if (at >= 0) {
        const [fault] = faultState.faults.splice(at, 1)
        throw fault?.error
      }
      return operation(...args)
    }
  return {
    ...actual,
    mkdir: wrap('mkdir', actual.mkdir as (...args: unknown[]) => unknown),
    open: wrap('open', actual.open as (...args: unknown[]) => unknown),
    lstat: wrap('lstat', actual.lstat as (...args: unknown[]) => unknown),
    readFile: wrap('readFile', actual.readFile as (...args: unknown[]) => unknown),
    unlink: wrap('unlink', actual.unlink as (...args: unknown[]) => unknown),
    rmdir: wrap('rmdir', actual.rmdir as (...args: unknown[]) => unknown),
  }
})

const roots: string[] = []

async function captureFailure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error: unknown) {
    return error
  }
  throw new Error('expected the operation to reject')
}

function requireAggregate(error: unknown): AggregateError {
  expect(error).toBeInstanceOf(AggregateError)
  if (!(error instanceof AggregateError)) throw new Error('expected AggregateError')
  return error
}

function aggregateMessages(error: AggregateError): string[] {
  return (error.errors as unknown[]).map(item => item instanceof Error ? item.message : String(item))
}

function systemError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code })
}

function fail(method: FaultMethod, pathIncludes: string, code: string): void {
  faultState.faults.push({ method, pathIncludes, error: systemError(`${method} failed`, code) })
}

async function root(label: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `paperai-layout-fault-${label}-`))
  roots.push(path)
  return path
}

afterEach(async () => {
  faultState.faults.length = 0
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  for (const path of roots.splice(0)) {
    if (!path.startsWith(tmpdir())) throw new Error(`refusing to clean non-temporary path '${path}'`)
    await actual.rm(path, { recursive: true, force: true })
  }
})

describe('project filesystem fault containment', () => {
  it('propagates unexpected directory and context-file creation failures after cleanup', async () => {
    const { prepareProjectLayout } = await import('../src/layout.ts')
    const directoryRoot = await root('mkdir')
    fail('mkdir', 'documents', 'EACCES')
    await expect(prepareProjectLayout(directoryRoot)).rejects.toThrow('mkdir failed')

    const contextRoot = await root('open')
    fail('open', 'PAPERAI.md', 'EACCES')
    await expect(prepareProjectLayout(contextRoot)).rejects.toThrow('open failed')
  })

  it('collects unexpected file and directory rollback failures', async () => {
    const { prepareProjectLayout } = await import('../src/layout.ts')
    const projectRoot = await root('rollback')
    const prepared = await prepareProjectLayout(join(projectRoot, 'project'))
    fail('lstat', 'PAPERAI.md', 'EACCES')
    fail('lstat', join('experiments', 'data'), 'EACCES')

    const failure = requireAggregate(await captureFailure(prepared.rollback()))

    expect(failure.errors as unknown[]).toHaveLength(2)
  })

  it('handles file-disappearance races and reports unexpected read and unlink failures', async () => {
    const { prepareProjectLayout } = await import('../src/layout.ts')

    const readMissingRoot = await root('read-missing')
    const readMissing = await prepareProjectLayout(join(readMissingRoot, 'project'))
    fail('readFile', 'PAPERAI.md', 'ENOENT')
    await expect(readMissing.rollback()).resolves.toBeUndefined()

    const unlinkMissingRoot = await root('unlink-missing')
    const unlinkMissing = await prepareProjectLayout(join(unlinkMissingRoot, 'project'))
    fail('unlink', 'PAPERAI.md', 'ENOENT')
    await expect(unlinkMissing.rollback()).resolves.toBeUndefined()

    const readFailedRoot = await root('read-failed')
    const readFailed = await prepareProjectLayout(join(readFailedRoot, 'project'))
    fail('readFile', 'PAPERAI.md', 'EACCES')
    await expect(readFailed.rollback()).rejects.toThrow('filesystem rollback did not complete')

    const unlinkFailedRoot = await root('unlink-failed')
    const unlinkFailed = await prepareProjectLayout(join(unlinkFailedRoot, 'project'))
    fail('unlink', 'PAPERAI.md', 'EACCES')
    await expect(unlinkFailed.rollback()).rejects.toThrow('filesystem rollback did not complete')
  })

  it('accepts benign directory races and reports an unexpected rmdir failure', async () => {
    const { prepareProjectLayout } = await import('../src/layout.ts')
    for (const code of ['ENOENT', 'ENOTEMPTY', 'EEXIST']) {
      const projectRoot = await root(`rmdir-${code}`)
      const prepared = await prepareProjectLayout(join(projectRoot, 'project'))
      fail('rmdir', join('experiments', 'data'), code)
      await expect(prepared.rollback()).resolves.toBeUndefined()
    }

    const failedRoot = await root('rmdir-failed')
    const failed = await prepareProjectLayout(join(failedRoot, 'project'))
    fail('rmdir', join('experiments', 'data'), 'EACCES')
    await expect(failed.rollback()).rejects.toThrow('filesystem rollback did not complete')
  })

  it('reports initialization and its cleanup failure together', async () => {
    const { prepareProjectLayout } = await import('../src/layout.ts')
    const projectRoot = await root('double-failure')
    fail('open', 'PAPERAI.md', 'EACCES')
    fail('rmdir', join('experiments', 'data'), 'EPERM')

    const failure = requireAggregate(await captureFailure(
      prepareProjectLayout(join(projectRoot, 'project')),
    ))

    expect(failure.message).toContain('initialization and rollback both failed')
    await expect(access(projectRoot)).resolves.toBeUndefined()
  })

  it('propagates filesystem rollback failure through the project transaction', async () => {
    const { default: PaperProjectService } = await import('../src/index.ts')
    const projectRoot = await root('service-rollback')
    const path = join(projectRoot, 'project')
    const ctx = new Context()
    ctx.provide('paperRepository', {
      listProjects: () => [],
      putProject: () => Promise.reject(new Error('repository failed')),
    } as never)
    ctx.provide('workspaceRegistry', {
      resolveByPath: () => Promise.resolve(undefined),
      create: () => Promise.resolve({ id: 'workspace-1', path }),
      delete: () => Promise.resolve(true),
    } as never)
    await ctx.plugin(PaperProjectService)
    fail('rmdir', join('experiments', 'data'), 'EACCES')

    const failure = requireAggregate(await captureFailure(ctx.paperProjects.create({ rootPath: path })))

    expect(aggregateMessages(failure)).toContain(
      'PaperAI project filesystem rollback did not complete',
    )
  })
})
