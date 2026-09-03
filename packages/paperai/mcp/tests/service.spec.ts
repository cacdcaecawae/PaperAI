import type { IncomingMessage, ServerResponse } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { afterEach, describe, expect, it, vi } from 'vitest'
import PaperMcpService from '../src/index.ts'
import type { PaperMcpAgentIdentity, PaperMcpExportAdapter } from '../src/types.ts'
import { actor, fakeDomain, workspaceScope } from './helpers.ts'

let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
})

async function mountService(host: '127.0.0.1' | '0.0.0.0' = '0.0.0.0') {
  const ctx = context = new Context()
  const domain = fakeDomain()
  let route: WebRoute | undefined
  const unregister = vi.fn(() => { route = undefined })
  const register = vi.fn((next: WebRoute) => {
    route = next
    return unregister
  })
  ctx.provide('webServer', { host, port: 33_211, register } as never)
  ctx.provide('paperProjects', domain.dependencies.projects as never)
  ctx.provide('paperDocuments', domain.dependencies.documents as never)
  ctx.provide('paperTemplates', domain.dependencies.templates as never)
  ctx.provide('paperCommits', domain.dependencies.commits as never)
  await ctx.plugin(PaperMcpService, {
    routePath: '/paperai/mcp',
    serverName: 'paperai-domain',
    defaultNodesPerRead: 2,
    maxNodesPerRead: 3,
    maxMutationsPerCommit: 4,
  })
  return {
    ctx,
    register,
    unregister,
    route: () => route,
  }
}

function unauthorizedResponse() {
  const writeHead = vi.fn()
  const end = vi.fn()
  return {
    response: { writeHead, end } as unknown as ServerResponse,
    writeHead,
    end,
  }
}

describe('PaperMcpService', () => {
  it('registers one exact route and issues a loopback ACP descriptor', async () => {
    const harness = await mountService()
    expect(harness.register).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'exact',
      path: '/paperai/mcp',
    }))

    const lease = harness.ctx.paperMcp.issueDescriptor(actor, workspaceScope())
    expect(lease.descriptor).toMatchObject({
      type: 'http',
      name: 'paperai-domain',
      url: 'http://127.0.0.1:33211/paperai/mcp',
    })
    expect(lease.descriptor.headers).toHaveLength(1)
    expect(lease.descriptor.headers[0]?.name).toBe('Authorization')
    expect(lease.descriptor.headers[0]?.value).toMatch(/^Bearer /)
    expect(lease.actor).toEqual(actor)
    expect(lease.actor).not.toBe(actor)
    await lease.dispose()
    await lease.dispose()
  })

  it('rejects missing and revoked bearer tokens before MCP parsing', async () => {
    const harness = await mountService('127.0.0.1')
    const route = harness.route()
    if (route === undefined) throw new Error('expected registered MCP route')

    const missing = unauthorizedResponse()
    await route.handler({ headers: {} } as IncomingMessage, missing.response)
    expect(missing.writeHead).toHaveBeenCalledWith(401, expect.objectContaining({
      'cache-control': 'no-store',
    }))
    expect(missing.end).toHaveBeenCalledWith('unauthorized')

    const lease = harness.ctx.paperMcp.issueDescriptor(actor, workspaceScope())
    const authorization = lease.descriptor.headers[0]?.value
    await lease.dispose()
    const revoked = unauthorizedResponse()
    await route.handler({ headers: { authorization } } as IncomingMessage, revoked.response)
    expect(revoked.writeHead).toHaveBeenCalledWith(401, expect.any(Object))
  })

  it('requires durable local Agent identity before issuing credentials', async () => {
    const harness = await mountService()
    const invalid: PaperMcpAgentIdentity = {
      ...actor,
      client: 'codex',
      sessionId: '   ',
    }
    expect(() => harness.ctx.paperMcp.issueDescriptor(invalid, workspaceScope())).toThrow(/sessionId/)
    const { sessionId: _sessionId, ...missingSession } = actor
    expect(() => harness.ctx.paperMcp.issueDescriptor(
      missingSession as PaperMcpAgentIdentity,
      workspaceScope(),
    )).toThrow(/must be present/)
    expect(() => harness.ctx.paperMcp.issueDescriptor({
      ...actor,
      client: 'paperai',
    } as unknown as PaperMcpAgentIdentity, workspaceScope())).toThrow(/codex or claude/)
    expect(() => harness.ctx.paperMcp.issueDescriptor({
      ...actor,
      kind: 'human',
    } as unknown as PaperMcpAgentIdentity, workspaceScope())).toThrow(/must be an Agent/)
    expect(() => harness.ctx.paperMcp.issueDescriptor(actor, workspaceScope('  '))).toThrow(/workspaceRoot/)

    const { provider: _provider, model: _model, ...minimalActor } = actor
    const lease = harness.ctx.paperMcp.issueDescriptor(minimalActor, workspaceScope())
    expect(lease.actor).not.toHaveProperty('provider')
    expect(lease.actor).not.toHaveProperty('model')
    await lease.dispose()
  })

  it('updates model provenance only within the descriptor client and session', async () => {
    const harness = await mountService()
    const lease = harness.ctx.paperMcp.issueDescriptor(actor, workspaceScope())
    const switched: PaperMcpAgentIdentity = {
      ...actor,
      name: 'Codex Thesis Agent',
      model: 'gpt-5.7-codex',
      modelRevision: '2026-08-28',
      runId: 'run-model-switch',
    }

    const accepted = lease.updateActor(switched)
    expect(accepted).toEqual(switched)
    expect(accepted).not.toBe(switched)
    accepted.model = 'caller-mutated-copy'
    expect(lease.actor).toEqual(switched)
    expect(lease.actor).not.toBe(accepted)
    expect(() => lease.updateActor({ ...switched, client: 'claude' })).toThrow(/client cannot change/)
    expect(() => lease.updateActor({ ...switched, sessionId: 'another-session' })).toThrow(/sessionId cannot change/)
    expect(lease.actor).toEqual(switched)

    await lease.dispose()
    expect(() => lease.updateActor({ ...switched, model: 'gpt-5.8-codex' })).toThrow(/disposed/)
  })

  it('owns one reversible export-provider registration', async () => {
    const harness = await mountService()
    const first = { exportDocument: vi.fn() } as unknown as PaperMcpExportAdapter
    const second = { exportDocument: vi.fn() } as unknown as PaperMcpExportAdapter
    const dispose = harness.ctx.paperMcp.registerExportAdapter(first)
    expect(() => harness.ctx.paperMcp.registerExportAdapter(second)).toThrow(/already registered/)
    dispose()
    const disposeSecond = harness.ctx.paperMcp.registerExportAdapter(second)
    dispose()
    expect(() => harness.ctx.paperMcp.registerExportAdapter(first)).toThrow(/already registered/)
    disposeSecond()
  })

  it('unregisters its HTTP route when the plugin fiber is disposed', async () => {
    const harness = await mountService()
    const lease = harness.ctx.paperMcp.issueDescriptor(actor, workspaceScope())
    expect(harness.route()).toBeDefined()
    await harness.ctx.fiber.dispose()
    context = undefined
    expect(harness.unregister).toHaveBeenCalledOnce()
    expect(harness.route()).toBeUndefined()
    await lease.dispose()
  })

  it('rejects unsafe route and result-bound configuration', async () => {
    const ctx = context = new Context()
    const domain = fakeDomain()
    ctx.provide('webServer', {
      host: '127.0.0.1',
      port: 33_211,
      register: vi.fn(() => vi.fn()),
    } as never)
    ctx.provide('paperProjects', domain.dependencies.projects as never)
    ctx.provide('paperDocuments', domain.dependencies.documents as never)
    ctx.provide('paperTemplates', domain.dependencies.templates as never)
    ctx.provide('paperCommits', domain.dependencies.commits as never)

    await expect(ctx.plugin(PaperMcpService, { routePath: '/bad/' })).rejects.toThrow(/routePath/)
    await expect(ctx.plugin(PaperMcpService, {
      defaultNodesPerRead: 10,
      maxNodesPerRead: 2,
    })).rejects.toThrow(/must not exceed/)
    await expect(ctx.plugin(PaperMcpService, {
      maxMutationsPerCommit: 0,
    })).rejects.toThrow(/maxMutationsPerCommit/)
  })

  it('retains constructor defaults and refuses descriptors before WebServer listen', async () => {
    const ctx = context = new Context()
    const domain = fakeDomain()
    const register = vi.fn(() => vi.fn())
    ctx.provide('webServer', { host: '127.0.0.1', port: 0, register } as never)
    ctx.provide('paperProjects', domain.dependencies.projects as never)
    ctx.provide('paperDocuments', domain.dependencies.documents as never)
    ctx.provide('paperTemplates', domain.dependencies.templates as never)
    ctx.provide('paperCommits', domain.dependencies.commits as never)

    const service = new PaperMcpService(ctx, {})
    expect(register).toHaveBeenCalledWith(expect.objectContaining({
      path: '/api/paperai/mcp',
    }))
    expect(() => service.issueDescriptor(actor, workspaceScope())).toThrow(/must be listening/)
  })
})
