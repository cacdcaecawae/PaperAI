import { realpath } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import type { Workspace, WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { WorkspaceId as brandWorkspaceId } from '@deepseek-ai/dsh-workspace'
import type { ProjectId, ProjectRecord } from '@paperai/domain'
import { vi } from 'vitest'
import PaperProjectService, { type Config } from '../src/index.ts'

export interface ProjectHarnessOptions {
  readonly failPut?: Error
  readonly failDelete?: unknown
  readonly deleteReturnsFalse?: boolean
  readonly projects?: ProjectRecord[]
  readonly subprocess?: object
}

/** Test composition with observable repository and DSH workspace operations. */
export async function projectHarness(options: ProjectHarnessOptions = {}) {
  const ctx = new Context()
  const projects = [...(options.projects ?? [])]
  const workspaces = new Map<WorkspaceId, Workspace>()
  let workspaceSequence = 0

  const putProject = vi.fn(async (record: ProjectRecord) => {
    if (options.failPut !== undefined) throw options.failPut
    const at = projects.findIndex(project => project.id === record.id)
    if (at < 0) projects.push(record)
    else projects[at] = record
    ctx.emit('domain/changed', {
      domain: 'paperai',
      table: 'projects',
      key: record.id,
      operation: 'put',
      value: record,
    })
  })
  ctx.provide('paperRepository', {
    getProject: (id: ProjectId) => projects.find(project => project.id === id),
    listProjects: () => [...projects],
    putProject,
  } as never)

  const create = vi.fn(async (path: string, title?: string) => {
    const canonical = await realpath(path)
    const existing = [...workspaces.values()].find(workspace => workspace.path === canonical)
    if (existing !== undefined) return existing
    workspaceSequence += 1
    const id = brandWorkspaceId(`workspace-${workspaceSequence}`)
    const now = new Date().toISOString()
    const workspace: Workspace = {
      id,
      path: canonical,
      title: title ?? canonical,
      createdAt: now,
      updatedAt: now,
      sessionIds: [],
      setTitle: () => Promise.resolve(),
      attachSession: () => Promise.resolve(),
      insertSessionBefore: () => Promise.resolve(),
      detachSession: () => Promise.resolve(),
      status: () => Promise.resolve('ok'),
    }
    workspaces.set(id, workspace)
    return workspace
  })
  const resolveByPath = vi.fn(async (path: string) => {
    const canonical = await realpath(path)
    return [...workspaces.values()].find(workspace => workspace.path === canonical)
  })
  const deleteWorkspace = vi.fn(async (id: WorkspaceId) => {
    if (options.failDelete !== undefined) throw options.failDelete
    if (options.deleteReturnsFalse === true) return false
    return workspaces.delete(id)
  })
  ctx.provide('workspaceRegistry', {
    create,
    resolveByPath,
    delete: deleteWorkspace,
    get: (id: WorkspaceId) => workspaces.get(id),
    list: () => [...workspaces.values()],
  } as never)
  if (options.subprocess !== undefined) ctx.provide('subprocess', options.subprocess as never)

  const load = async (config: Config = {}) => {
    const fiber = await ctx.plugin(PaperProjectService, config)
    return { fiber, service: ctx.paperProjects }
  }
  return {
    ctx,
    projects,
    workspaces,
    putProject,
    createWorkspace: create,
    resolveByPath,
    deleteWorkspace,
    load,
  }
}
