import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { afterEach, describe, expect, it, vi } from 'vitest'
import PaperMcpService from '../src/index.ts'
import { actor, fakeDomain, workspaceScope } from './helpers.ts'

let context: Context | undefined
let temporaryDirectory: string | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (temporaryDirectory !== undefined) {
    if (!temporaryDirectory.startsWith(tmpdir())) {
      throw new Error(`refusing to clean non-temporary path '${temporaryDirectory}'`)
    }
    await rm(temporaryDirectory, { recursive: true, force: true })
    temporaryDirectory = undefined
  }
})

describe('PaperAI MCP real Loader composition', () => {
  it('boots from cordis.yml and issues a descriptor over the registered Host route', async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'paperai-mcp-loader-'))
    const configPath = join(temporaryDirectory, 'cordis.yml')
    await writeFile(configPath, [
      '- id: host-services',
      '  name: test-paperai-host-services',
      '- id: paperai-mcp',
      "  name: '@paperai/mcp'",
      '  config:',
      '    routePath: /loader/paperai/mcp',
      '    serverName: paperai-loader',
      '    defaultNodesPerRead: 2',
      '    maxNodesPerRead: 3',
      '    maxMutationsPerCommit: 4',
      '',
    ].join('\n'))

    const domain = fakeDomain()
    let route: WebRoute | undefined
    const unregister = vi.fn(() => { route = undefined })
    const hostServices = {
      name: 'test-paperai-host-services',
      apply(ctx: Context) {
        ctx.provide('webServer', {
          host: '127.0.0.1',
          port: 34_567,
          register(next: WebRoute) {
            route = next
            return unregister
          },
        } as never)
        ctx.provide('paperProjects', domain.dependencies.projects as never)
        ctx.provide('paperDocuments', domain.dependencies.documents as never)
        ctx.provide('paperTemplates', domain.dependencies.templates as never)
        ctx.provide('paperCommits', domain.dependencies.commits as never)
      },
    }

    const ctx = context = new Context()
    ctx.baseUrl = pathToFileURL(temporaryDirectory).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['test-paperai-host-services', hostServices],
      ['@paperai/mcp', PaperMcpService],
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

    expect(route).toMatchObject({ kind: 'exact', path: '/loader/paperai/mcp' })
    const lease = ctx.paperMcp.issueDescriptor(actor, workspaceScope())
    expect(lease.descriptor).toMatchObject({
      type: 'http',
      name: 'paperai-loader',
      url: 'http://127.0.0.1:34567/loader/paperai/mcp',
    })
    await lease.dispose()

    await ctx.fiber.dispose()
    context = undefined
    expect(unregister).toHaveBeenCalledOnce()
    expect(route).toBeUndefined()
  })
})
