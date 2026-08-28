import type { IncomingMessage, ServerResponse } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const transportState = vi.hoisted(() => ({
  instances: [] as Array<{
    close: ReturnType<typeof vi.fn>
    handleRequest: ReturnType<typeof vi.fn>
  }>,
}))

const serverState = vi.hoisted(() => ({
  create: vi.fn(),
}))

vi.mock('@modelcontextprotocol/sdk/server/streamableHttp.js', () => ({
  StreamableHTTPServerTransport: class {
    readonly close = vi.fn(async () => undefined)
    readonly handleRequest = vi.fn(async () => undefined)

    constructor() {
      transportState.instances.push(this)
    }
  },
}))

vi.mock('../src/server.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/server.ts')>()
  return { ...original, createPaperMcpServer: serverState.create }
})

import PaperMcpService from '../src/index.ts'
import type { PaperMcpAgentIdentity, PaperMcpDependencies } from '../src/types.ts'
import { actor, document, fakeDomain } from './helpers.ts'

let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
})

beforeEach(() => {
  transportState.instances.length = 0
  serverState.create.mockReset()
})

async function mountRoute() {
  const ctx = context = new Context()
  const domain = fakeDomain()
  let route: WebRoute | undefined
  ctx.provide('webServer', {
    host: '127.0.0.1',
    port: 33_211,
    register(next: WebRoute) {
      route = next
      return () => { route = undefined }
    },
  } as never)
  ctx.provide('paperProjects', domain.dependencies.projects as never)
  ctx.provide('paperDocuments', domain.dependencies.documents as never)
  ctx.provide('paperTemplates', domain.dependencies.templates as never)
  ctx.provide('paperCommits', domain.dependencies.commits as never)
  await ctx.plugin(PaperMcpService)
  const lease = ctx.paperMcp.issueDescriptor(actor)
  const registered = route
  if (registered === undefined) throw new Error('expected PaperAI MCP route')
  return { ctx, domain, lease, route: registered }
}

function responseHarness() {
  let closeListener: (() => void) | undefined
  const response = {
    once(event: string, listener: () => void) {
      if (event === 'close') closeListener = listener
      return response
    },
  } as unknown as ServerResponse
  return {
    response,
    close() {
      if (closeListener === undefined) throw new Error('close listener was not registered')
      closeListener()
    },
  }
}

describe('PaperAI MCP authenticated HTTP route', () => {
  it('uses the current lease model for mutations after an ACP model switch', async () => {
    const selectedActors: PaperMcpAgentIdentity[] = []
    const connect = vi.fn(async () => undefined)
    const close = vi.fn(async () => undefined)
    serverState.create.mockImplementation((
      _dependencies: PaperMcpDependencies,
      selectedActor: PaperMcpAgentIdentity,
    ) => {
      selectedActors.push(structuredClone(selectedActor))
      return { connect, close }
    })
    const harness = await mountRoute()
    const switched: PaperMcpAgentIdentity = {
      ...actor,
      model: 'gpt-5.7-codex',
      modelRevision: '2026-08-28',
      runId: 'run-model-switch',
    }
    harness.lease.updateActor(switched)
    const response = responseHarness()
    const authorization = harness.lease.descriptor.headers[0]?.value

    await harness.route.handler(
      { headers: { authorization } } as IncomingMessage,
      response.response,
    )
    const selectedActor = selectedActors[0]
    if (selectedActor === undefined) throw new Error('expected request-scoped Agent identity')
    expect(selectedActor).toEqual(switched)

    const actual = await vi.importActual<typeof import('../src/server.ts')>('../src/server.ts')
    const mutationServer = actual.createPaperMcpServer(
      harness.domain.dependencies,
      selectedActor,
      {
        defaultNodesPerRead: 2,
        maxNodesPerRead: 3,
        maxMutationsPerCommit: 4,
      },
    )
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await mutationServer.connect(serverTransport)
    const mutationClient = new Client({ name: 'paperai-model-switch-test', version: '1' })
    await mutationClient.connect(clientTransport)
    try {
      const result = await mutationClient.callTool({
        name: 'paperai_commit_document',
        arguments: {
          documentId: document.id,
          baseCommitId: document.headCommitId,
          message: 'Record the switched model',
          mutations: [{ type: 'milestone', label: 'model-switched' }],
        },
      })
      expect(result.isError).not.toBe(true)
      expect(harness.domain.submit).toHaveBeenLastCalledWith(expect.objectContaining({
        actor: switched,
      }))
    } finally {
      await mutationClient.close()
      await mutationServer.close()
    }

    response.close()
    await vi.waitFor(() => {
      expect(close).toHaveBeenCalledOnce()
    })
    await harness.lease.dispose()
  })

  it('builds a request-scoped server and reports both teardown failures', async () => {
    const connect = vi.fn(async () => undefined)
    const close = vi.fn(async () => { throw 'server close failed' })
    serverState.create.mockReturnValue({ connect, close })
    const harness = await mountRoute()
    const response = responseHarness()
    const authorization = harness.lease.descriptor.headers[0]?.value

    await harness.route.handler({ headers: { authorization } } as IncomingMessage, response.response)

    const transport = transportState.instances[0]
    if (transport === undefined) throw new Error('expected request transport')
    transport.close.mockRejectedValueOnce(new Error('transport close failed'))
    expect(serverState.create).toHaveBeenCalledWith(
      expect.objectContaining({
        projects: harness.domain.dependencies.projects,
        documents: harness.domain.dependencies.documents,
      }),
      actor,
      expect.objectContaining({
        defaultNodesPerRead: 80,
        maxNodesPerRead: 200,
        maxMutationsPerCommit: 64,
      }),
      undefined,
    )
    expect(connect).toHaveBeenCalledWith(transport)
    expect(transport.handleRequest).toHaveBeenCalledWith(
      expect.objectContaining({ headers: { authorization } }),
      response.response,
    )

    const warn = vi.spyOn(harness.ctx.logger, 'warn')
    response.close()
    response.close()
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledTimes(2)
    })
    expect(warn.mock.calls[0]?.[0]).toBeInstanceOf(Error)
    expect(warn.mock.calls[1]?.[0]).toEqual(new Error('server close failed'))
    await harness.lease.dispose()
  })

  it('closes request resources before propagating an MCP transport failure', async () => {
    const expected = new Error('MCP request failed')
    const connect = vi.fn(async () => undefined)
    const close = vi.fn(async () => undefined)
    serverState.create.mockReturnValue({ connect, close })
    const harness = await mountRoute()
    const transportFailure = transportState.instances[0]
    expect(transportFailure).toBeUndefined()
    const response = responseHarness()
    const authorization = harness.lease.descriptor.headers[0]?.value

    const requestPromise = harness.route.handler(
      { headers: { authorization } } as IncomingMessage,
      response.response,
    )
    const transport = transportState.instances[0]
    if (transport === undefined) throw new Error('expected request transport')
    transport.handleRequest.mockRejectedValueOnce(expected)

    await expect(requestPromise).rejects.toBe(expected)
    expect(transport.close).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
    await harness.lease.dispose()
  })
})
