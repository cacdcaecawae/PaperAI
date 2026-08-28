import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { WorkspaceId, type Workspace } from '@deepseek-ai/dsh-workspace'
import type { ProjectId, ProjectRecord } from '@paperai/domain'
import PaperProjectService, { PAPERAI_CONTEXT_FILE } from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) {
    if (!root.startsWith(tmpdir())) throw new Error(`refusing to clean non-temporary path '${root}'`)
    await import('node:fs/promises').then(fs => fs.rm(root!, { recursive: true, force: true }))
  }
  root = undefined
})

describe('project-service real Loader composition', () => {
  it('boots from cordis.yml and creates a world-visible project through ctx.paperProjects', async () => {
    root = await mkdtemp(join(tmpdir(), 'paperai-project-loader-'))
    const projectRoot = join(root, 'thesis')
    const projects: ProjectRecord[] = []
    const workspaces = new Map<WorkspaceId, Workspace>()

    const repositoryPlugin = {
      name: 'test-paper-repository',
      apply(ctx: Context) {
        ctx.provide('paperRepository', {
          getProject: (id: ProjectId) => projects.find(project => project.id === id),
          listProjects: () => [...projects],
          putProject: async (record: ProjectRecord) => {
            projects.push(record)
            ctx.emit('domain/changed', {
              domain: 'paperai', table: 'projects', key: record.id, operation: 'put', value: record,
            })
          },
        } as never)
      },
    }
    const workspacePlugin = {
      name: 'test-workspace-registry',
      apply(ctx: Context) {
        ctx.provide('workspaceRegistry', {
          resolveByPath: async (path: string) => [...workspaces.values()].find(workspace => workspace.path === path),
          create: async (path: string, title?: string) => {
            const id = WorkspaceId('loader-workspace')
            const workspace = { id, path, title: title ?? path } as Workspace
            workspaces.set(id, workspace)
            return workspace
          },
          get: (id: WorkspaceId) => workspaces.get(id),
          delete: async (id: WorkspaceId) => workspaces.delete(id),
        } as never)
      },
    }

    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      '- id: repository',
      '  name: test-paper-repository',
      '- id: workspace',
      '  name: test-workspace-registry',
      '- id: projects',
      "  name: '@paperai/project-service'",
      '  config:',
      '    gitTimeoutMs: 5000',
      '',
    ].join('\n'))

    const ctx = new Context()
    context = ctx
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['test-paper-repository', repositoryPlugin],
      ['test-workspace-registry', workspacePlugin],
      ['@paperai/project-service', PaperProjectService],
    ])
    ctx.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        const plugin = modules.get(specifier)
        if (plugin === undefined) throw new Error(`unexpected Loader import: ${specifier}`)
        return plugin
      },
    } as unknown as NonNullable<typeof ctx.loader.internal>
    await ctx.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(configPath).href },
    })
    await ctx.loader.await()

    const result = await ctx.paperProjects.create({ rootPath: projectRoot, name: 'Loader 论文' })

    expect(result.project).toEqual(projects[0])
    expect(result.project.workspaceId).toBe('loader-workspace')
    expect(result.git.status).toBe('degraded')
    expect(await readFile(join(projectRoot, PAPERAI_CONTEXT_FILE), 'utf8')).toContain('## 当前目标')
    expect(ctx.workspaceRegistry.get(WorkspaceId(result.project.workspaceId))?.path).toBe(result.project.rootPath)
  })
})
