import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import type { DomainChanged } from '@deepseek-ai/dsh-storage-domain'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { ProjectId, type ProjectRecord } from '@paperai/domain'
import { describe, expect, it } from 'vitest'
import * as ProjectInvariant from '../src/invariant.ts'

const record: ProjectRecord = {
  id: ProjectId('project-1'),
  workspaceId: 'workspace-1',
  name: '论文',
  rootPath: '/papers/thesis',
  createdAt: '2026-08-28T00:00:00.000Z',
  updatedAt: '2026-08-28T00:00:00.000Z',
}
const deletedProjectChange: DomainChanged = {
  domain: 'paperai',
  table: 'projects',
  key: record.id,
  operation: 'deleted',
}

function change(overrides: Partial<DomainChanged> = {}): DomainChanged {
  return {
    domain: 'paperai',
    table: 'projects',
    key: record.id,
    operation: 'put',
    value: record,
    ...overrides,
  } as DomainChanged
}

async function setup(options: { project?: ProjectRecord; workspacePath?: string }) {
  const ctx = new Context()
  await ctx.plugin(InvariantRegistry)
  ctx.provide('paperProjects', {})
  ctx.provide('paperRepository', {
    getProject: () => options.project,
  })
  ctx.provide('workspaceRegistry', {
    get: (id: WorkspaceId) => id === WorkspaceId('workspace-1') && options.workspacePath !== undefined
      ? { id, path: options.workspacePath }
      : undefined,
  })
  const fiber = await ctx.plugin(ProjectInvariant)
  return { ctx, fiber }
}

describe('PaperAI project/workspace invariant', () => {
  it('accepts an aligned project and ignores unrelated or deleted changes', async () => {
    const { ctx, fiber } = await setup({ project: record, workspacePath: record.rootPath })
    expect(() => { ctx.emit('domain/changed', change()) }).not.toThrow()
    expect(() => { ctx.emit('domain/changed', change({ domain: 'other' })) }).not.toThrow()
    expect(() => { ctx.emit('domain/changed', change({ table: 'documents' })) }).not.toThrow()
    expect(() => { ctx.emit('domain/changed', deletedProjectChange) }).not.toThrow()

    await fiber.dispose()
    expect(() => { ctx.emit('domain/changed', change({ key: 'after-dispose' })) }).not.toThrow()
  })

  it('fails when the repository record, workspace, or canonical path diverges', async () => {
    const missingRecord = await setup({ workspacePath: record.rootPath })
    expect(() => { missingRecord.ctx.emit('domain/changed', change()) })
      .toThrow('without a readable repository record')

    const missingWorkspace = await setup({ project: record })
    expect(() => { missingWorkspace.ctx.emit('domain/changed', change()) })
      .toThrow('references missing workspace')

    const wrongPath = await setup({ project: record, workspacePath: '/other' })
    expect(() => { wrongPath.ctx.emit('domain/changed', change()) })
      .toThrow('does not match')
  })
})
