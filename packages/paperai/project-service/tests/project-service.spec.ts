import { access, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProjectId, type ProjectRecord } from '@paperai/domain'
import {
  PAPERAI_CONTEXT_FILE,
  PAPERAI_CONTEXT_TEMPLATE,
  PAPERAI_PROJECT_DIRECTORIES,
  PaperProjectService,
} from '../src/index.ts'
import { projectHarness } from './helpers.ts'

const temporaryRoots: string[] = []

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

async function temporaryRoot(label: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `paperai-project-${label}-`))
  temporaryRoots.push(path)
  return path
}

afterEach(async () => {
  for (const path of temporaryRoots.splice(0)) {
    if (!path.startsWith(tmpdir())) throw new Error(`refusing to clean non-temporary path '${path}'`)
    await import('node:fs/promises').then(fs => fs.rm(path, { recursive: true, force: true }))
  }
})

describe('PaperProjectService', () => {
  it('idempotently adopts a directory and preserves every existing file and record identity', async () => {
    const root = await temporaryRoot('idempotent')
    const context = '# 用户上下文\n\n不得覆盖。\n'
    await writeFile(join(root, PAPERAI_CONTEXT_FILE), context)
    await mkdir(join(root, 'figures'))
    await writeFile(join(root, 'figures', 'existing.svg'), '<svg/>')
    const harness = await projectHarness()
    const { service } = await harness.load()

    const first = await service.create({ rootPath: root, name: '硕士论文' })
    const second = await service.create({ rootPath: `${root}/.`, name: '不会改名' })

    expect(first.projectCreated).toBe(true)
    expect(second.projectCreated).toBe(false)
    expect(second.project).toEqual(first.project)
    expect(first.project.name).toBe('硕士论文')
    expect(first.contextFile).toBe('preserved')
    expect(second.contextFile).toBe('preserved')
    expect(first.git).toMatchObject({ status: 'degraded' })
    expect(await readFile(join(root, PAPERAI_CONTEXT_FILE), 'utf8')).toBe(context)
    expect(await readFile(join(root, 'figures', 'existing.svg'), 'utf8')).toBe('<svg/>')
    for (const relative of PAPERAI_PROJECT_DIRECTORIES) {
      expect((await stat(join(root, ...relative.split('/')))).isDirectory()).toBe(true)
    }
    expect(harness.createWorkspace).toHaveBeenCalledTimes(1)
    expect(harness.putProject).toHaveBeenCalledTimes(1)
    expect(harness.projects).toEqual([first.project])
    expect(service.get(first.project.id)).toEqual(first.project)
    expect(service.list()).toEqual([first.project])
    await expect(service.findByPath(root)).resolves.toEqual(first.project)
  })

  it('creates the complete layout, default name, context, and a safely initialized Git repository', async () => {
    const parent = await temporaryRoot('create')
    const root = join(parent, 'new-thesis')
    const calls: SubprocessSpawnSpec[] = []
    const subprocess = {
      resolveExecutable: vi.fn(async () => 'C:\\Program Files\\Git\\bin\\git.exe'),
      spawn: vi.fn((spec: SubprocessSpawnSpec) => {
        calls.push(spec)
        const probe = spec.argv.includes('rev-parse')
        return {
          collected: {
            stdout: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
            stderr: { readFrom: () => ({ text: probe ? 'not a repository' : '', nextOffset: 0, lossy: false }) },
          },
          done: Promise.resolve({ exitCode: probe ? 128 : 0, signal: null }),
        }
      }),
    }
    const harness = await projectHarness({ subprocess })
    const { service } = await harness.load({
      gitCommand: 'git',
      gitInitialBranch: 'main',
      gitTimeoutMs: 5_000,
      gitOutputMaxBytes: 8_192,
      gitTerminateGraceMs: 250,
    })

    const result = await service.create({ rootPath: root })

    expect(result.project.name).toBe(basename(root))
    expect(result.contextFile).toBe('created')
    expect(result.git).toEqual({ status: 'ready', state: 'initialized' })
    expect(await readFile(join(root, PAPERAI_CONTEXT_FILE), 'utf8')).toBe(PAPERAI_CONTEXT_TEMPLATE)
    expect(calls.map(call => call.argv)).toEqual([
      ['C:\\Program Files\\Git\\bin\\git.exe', 'rev-parse', '--show-toplevel'],
      ['C:\\Program Files\\Git\\bin\\git.exe', 'init', '--initial-branch', 'main'],
    ])
    expect(calls.every(call => call.cwd === result.project.rootPath)).toBe(true)
    expect(calls.every(call => call.graceMs === 250)).toBe(true)
    expect(calls.every(call => call.signal instanceof AbortSignal)).toBe(true)
    expect(calls.every(call => call.stdio.stdin === 'ignore')).toBe(true)
    expect(result.project.workspaceId).toBe('workspace-1')
  })

  it('rolls back its context, directories, and new workspace when repository publication fails', async () => {
    const root = await temporaryRoot('rollback')
    await writeFile(join(root, 'keep.txt'), 'user data')
    const harness = await projectHarness({ failPut: new Error('repository unavailable') })
    const { service } = await harness.load()

    await expect(service.create({ rootPath: root, name: '失败项目' }))
      .rejects.toThrow('repository unavailable')

    expect(await readFile(join(root, 'keep.txt'), 'utf8')).toBe('user data')
    await expect(access(join(root, PAPERAI_CONTEXT_FILE))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(join(root, 'documents'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(harness.deleteWorkspace).toHaveBeenCalledWith('workspace-1')
    expect(harness.workspaces.size).toBe(0)
    expect(harness.projects).toEqual([])
  })

  it('repairs a recreated workspace association while preserving project identity and name', async () => {
    const parent = await temporaryRoot('repair')
    const root = join(parent, 'canonical')
    const alias = join(parent, 'alias')
    await mkdir(root)
    await symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const prior: ProjectRecord = {
      id: ProjectId('project-stable'),
      workspaceId: 'workspace-gone',
      name: '已有名称',
      rootPath: alias,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
    const harness = await projectHarness({ projects: [prior] })
    const { service } = await harness.load()

    const result = await service.create({ rootPath: root, name: '忽略的新名称' })

    expect(result.projectCreated).toBe(false)
    expect(result.project).toMatchObject({
      id: prior.id,
      name: prior.name,
      createdAt: prior.createdAt,
      workspaceId: 'workspace-1',
      rootPath: root,
    })
    expect(result.project.updatedAt).not.toBe(prior.updatedAt)
    expect(harness.putProject).toHaveBeenCalledTimes(1)
  })

  it('fails loud on ambiguous records, blank intent, and invalid deployment limits', async () => {
    const parent = await temporaryRoot('invalid')
    const root = join(parent, 'canonical')
    const alias = join(parent, 'alias')
    await mkdir(root)
    await symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const record = (id: string, rootPath: string): ProjectRecord => ({
      id: ProjectId(id),
      workspaceId: `workspace-${id}`,
      name: id,
      rootPath,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
    const duplicates = await projectHarness({ projects: [record('one', root), record('two', alias)] })
    const { service } = await duplicates.load()
    await expect(service.create({ rootPath: root })).rejects.toThrow('multiple PaperAI project records')
    await expect(service.findByPath('   ')).rejects.toThrow('must not be blank')

    expect(() => new PaperProjectService(new Context(), { gitTimeoutMs: 0 }))
      .toThrow('gitTimeoutMs must be a positive safe integer')
    expect(() => new PaperProjectService(new Context())).not.toThrow()
    expect(() => new PaperProjectService(new Context(), {
      gitCommand: ' ',
    })).toThrow('gitCommand must not be blank')

    const blankName = await projectHarness()
    const loaded = await blankName.load()
    await expect(loaded.service.create({ rootPath: root, name: ' ' }))
      .rejects.toThrow('project name must not be blank')
  })

  it('reports both the initiating failure and a workspace rollback failure', async () => {
    const root = await temporaryRoot('aggregate')
    const harness = await projectHarness({
      failPut: new Error('repository failed'),
      failDelete: 'workspace cleanup failed',
    })
    const { service } = await harness.load()

    const failure = requireAggregate(await captureFailure(service.create({ rootPath: root })))

    expect(failure.message).toContain('rollback did not complete')
    expect(aggregateMessages(failure)).toEqual([
      'repository failed',
      'workspace cleanup failed',
    ])
  })

  it('treats a vanished newly-created workspace as an incomplete rollback', async () => {
    const root = await temporaryRoot('missing-workspace')
    const harness = await projectHarness({
      failPut: new Error('repository failed'),
      deleteReturnsFalse: true,
    })
    const { service } = await harness.load()

    const failure = requireAggregate(await captureFailure(service.create({ rootPath: root })))

    expect(aggregateMessages(failure)[1]).toContain('disappeared before rollback')
  })
})
