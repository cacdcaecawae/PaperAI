import { Context } from '@deepseek-ai/cordis'
import type {
  SubprocessHandle,
  SubprocessOutputRead,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { describe, expect, it, vi } from 'vitest'
import {
  ensureGitRepository,
  type GitInitializationConfig,
} from '../src/git.ts'

interface Reply {
  readonly exitCode?: number | null
  readonly signal?: NodeJS.Signals | null
  readonly stdout?: string
  readonly stderr?: string
  readonly lossy?: boolean
  readonly delayMs?: number
  readonly noCollectedReaders?: boolean
}

const config: GitInitializationConfig = {
  command: 'git',
  initialBranch: 'main',
  timeoutMs: 100,
  outputMaxBytes: 1_024,
  terminateGraceMs: 50,
}

function rejectWireValue(reason: unknown): Promise<never> {
  return new Promise((_resolve, reject) => {
    Reflect.apply(reject, undefined, [reason])
  })
}

function read(text: string, lossy = false): SubprocessOutputRead {
  return { text, nextOffset: Buffer.byteLength(text), lossy }
}

function handle(reply: Reply): SubprocessHandle {
  const outcome = {
    exitCode: reply.exitCode === undefined ? 0 : reply.exitCode,
    signal: reply.signal === undefined ? null : reply.signal,
  }
  return {
    pid: 42,
    stdin: undefined,
    stdout: undefined,
    stderr: undefined,
    collected: {
      ...(reply.noCollectedReaders === true
        ? {}
        : {
          stdout: { readFrom: () => read(reply.stdout ?? '', reply.lossy) },
          stderr: { readFrom: () => read(reply.stderr ?? '') },
        }),
    },
    done: reply.delayMs === undefined
      ? Promise.resolve(outcome)
      : new Promise(resolve => setTimeout(() => { resolve(outcome) }, reply.delayMs)),
    terminate: () => {},
    waitForExit: () => Promise.resolve(true),
  }
}

function fixture(replies: Reply[], resolve: () => Promise<string> = () => Promise.resolve('/bin/git')) {
  const ctx = new Context()
  const calls: SubprocessSpawnSpec[] = []
  ctx.provide('subprocess', {
    resolveExecutable: vi.fn(resolve),
    spawn: vi.fn((spec: SubprocessSpawnSpec) => {
      calls.push(spec)
      const reply = replies.shift()
      if (reply === undefined) throw new Error('unexpected Git command')
      return handle(reply)
    }),
  } as never)
  return { ctx, calls }
}

describe('Git initialization', () => {
  it('degrades when no subprocess Provider is available', async () => {
    await expect(ensureGitRepository(new Context(), '/project', config)).resolves.toEqual({
      status: 'degraded',
      detail: 'DSH subprocess Provider is unavailable; Git initialization was skipped',
    })
  })

  it('reuses an existing repository without running init', async () => {
    const { ctx, calls } = fixture([{ stdout: '/project\n' }])
    await expect(ensureGitRepository(ctx, '/project', config)).resolves.toEqual({
      status: 'ready',
      state: 'existing',
    })
    expect(calls).toHaveLength(1)

    const emptyReaders = fixture([{ noCollectedReaders: true }])
    await expect(ensureGitRepository(emptyReaders.ctx, '/project', config)).resolves.toEqual({
      status: 'ready',
      state: 'existing',
    })
  })

  it('initializes outside a repository and reports stderr on init failure', async () => {
    const success = fixture([{ exitCode: 128 }, { stdout: 'initialized' }])
    await expect(ensureGitRepository(success.ctx, '/project', config)).resolves.toEqual({
      status: 'ready',
      state: 'initialized',
    })
    expect(success.calls[1]?.argv).toEqual(['/bin/git', 'init', '--initial-branch', 'main'])

    const failed = fixture([{ exitCode: 128 }, { exitCode: 1, stderr: 'permission denied' }])
    await expect(ensureGitRepository(failed.ctx, '/project', config)).resolves.toEqual({
      status: 'degraded',
      detail: 'permission denied',
    })
  })

  it('reports probe and initialization timeout independently', async () => {
    const timeoutConfig = { ...config, timeoutMs: 1 }
    const probe = fixture([{ delayMs: 10 }])
    await expect(ensureGitRepository(probe.ctx, '/project', timeoutConfig)).resolves.toEqual({
      status: 'degraded',
      detail: 'Git repository probe timed out after 1 ms',
    })

    const init = fixture([{ exitCode: 128 }, { delayMs: 10 }])
    await expect(ensureGitRepository(init.ctx, '/project', timeoutConfig)).resolves.toEqual({
      status: 'degraded',
      detail: 'Git initialization timed out after 1 ms',
    })
  })

  it('does not initialize after a signalled probe and bounds collected output', async () => {
    const signalled = fixture([{ exitCode: null, signal: 'SIGTERM' }])
    await expect(ensureGitRepository(signalled.ctx, '/project', config)).resolves.toEqual({
      status: 'degraded',
      detail: 'Git stopped with signal SIGTERM',
    })
    expect(signalled.calls).toHaveLength(1)

    const lossy = fixture([{ lossy: true }])
    await expect(ensureGitRepository(lossy.ctx, '/project', config)).resolves.toEqual({
      status: 'degraded',
      detail: 'Git output exceeded 1024 bytes',
    })
  })

  it('normalizes executable-resolution and empty-output failures', async () => {
    const missing = fixture([], () => Promise.reject(new Error('git not found')))
    await expect(ensureGitRepository(missing.ctx, '/project', config)).resolves.toEqual({
      status: 'degraded',
      detail: 'git not found',
    })

    // Runtime Providers are not statically trusted; pin normalization of a non-Error rejection.
    const nonError = fixture([], () => rejectWireValue('offline'))
    await expect(ensureGitRepository(nonError.ctx, '/project', config)).resolves.toEqual({
      status: 'degraded',
      detail: 'offline',
    })

    const empty = fixture([{ exitCode: 128 }, { exitCode: 7 }])
    await expect(ensureGitRepository(empty.ctx, '/project', config)).resolves.toEqual({
      status: 'degraded',
      detail: 'Git exited with code 7',
    })
  })
})
