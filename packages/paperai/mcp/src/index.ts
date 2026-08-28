/**
 * PaperAI Host MCP plugin. It mounts an authenticated Streamable HTTP route
 * on the DSH WebServer and issues Agent-scoped ACP descriptors for that route.
 * @module @paperai/mcp
 */

import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Context, Service } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import z from '@deepseek-ai/schemastery'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type {} from '@paperai/commit-service'
import type {} from '@paperai/document-service'
import type { ActorIdentity } from '@paperai/domain'
import type {} from '@paperai/project-service'
import type {} from '@paperai/template-service'
import { createPaperMcpServer } from './server.ts'
import type {
  PaperMcpAgentIdentity,
  PaperMcpDependencies,
  PaperMcpDescriptorLease,
  PaperMcpExportAdapter,
  PaperMcpHttpServerDescriptor,
  PaperMcpToolLimits,
} from './types.ts'

export { createPaperMcpServer, PAPERAI_MCP_TOOL_NAMES } from './server.ts'
export type {
  PaperMcpAgentIdentity,
  PaperMcpDependencies,
  PaperMcpDescriptorLease,
  PaperMcpExportAdapter,
  PaperMcpExportRequest,
  PaperMcpExportResult,
  PaperMcpHttpServerDescriptor,
  PaperMcpToolLimits,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    paperMcp: PaperMcpService
  }
}

/** PaperAI MCP route and model-facing result bounds. */
export interface Config {
  /** Exact DSH WebServer path used by Streamable HTTP MCP. */
  routePath?: string
  /** MCP descriptor name shown to local Agents. */
  serverName?: string
  /** Default semantic nodes returned by one read call. */
  defaultNodesPerRead?: number
  /** Maximum semantic nodes returned by one read call. */
  maxNodesPerRead?: number
  /** Maximum ordered mutations accepted by one document commit. */
  maxMutationsPerCommit?: number
}

interface ResolvedConfig extends PaperMcpToolLimits {
  readonly routePath: string
  readonly serverName: string
}

const DEFAULT_ROUTE_PATH = '/api/paperai/mcp'
const DEFAULT_SERVER_NAME = 'paperai'
const DEFAULT_NODES_PER_READ = 80
const MAX_NODES_PER_READ = 200
const MAX_MUTATIONS_PER_COMMIT = 64
const TOKEN_BYTES = 32

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`paperai-mcp: ${name} must be a positive safe integer`)
  }
  return value
}

function nonBlank(value: string, name: string): string {
  const trimmed = value.trim()
  if (trimmed.length === 0) throw new Error(`paperai-mcp: ${name} must not be blank`)
  return trimmed
}

function routePath(value: string): string {
  const path = nonBlank(value, 'routePath')
  if (!path.startsWith('/') || path === '/' || path.endsWith('/') || path.includes('?') || path.includes('#')) {
    throw new Error('paperai-mcp: routePath must be an absolute non-root pathname without a trailing slash, query, or fragment')
  }
  return path
}

function resolveConfig(config: Config): ResolvedConfig {
  const defaultNodesPerRead = positiveSafeInteger(
    config.defaultNodesPerRead ?? DEFAULT_NODES_PER_READ,
    'defaultNodesPerRead',
  )
  const maxNodesPerRead = positiveSafeInteger(
    config.maxNodesPerRead ?? MAX_NODES_PER_READ,
    'maxNodesPerRead',
  )
  if (defaultNodesPerRead > maxNodesPerRead) {
    throw new Error('paperai-mcp: defaultNodesPerRead must not exceed maxNodesPerRead')
  }
  return {
    routePath: routePath(config.routePath ?? DEFAULT_ROUTE_PATH),
    serverName: nonBlank(config.serverName ?? DEFAULT_SERVER_NAME, 'serverName'),
    defaultNodesPerRead,
    maxNodesPerRead,
    maxMutationsPerCommit: positiveSafeInteger(
      config.maxMutationsPerCommit ?? MAX_MUTATIONS_PER_COMMIT,
      'maxMutationsPerCommit',
    ),
  }
}

function validateActor(actor: ActorIdentity): PaperMcpAgentIdentity {
  if (actor.kind !== 'agent') throw new Error('paperai-mcp: descriptor actor must be an Agent')
  if (actor.client !== 'codex' && actor.client !== 'claude') {
    throw new Error('paperai-mcp: descriptor actor client must be codex or claude')
  }
  if (actor.sessionId === undefined) {
    throw new Error('paperai-mcp: actor.sessionId must be present')
  }
  nonBlank(actor.name, 'actor.name')
  nonBlank(actor.sessionId, 'actor.sessionId')
  if (actor.provider !== undefined) nonBlank(actor.provider, 'actor.provider')
  if (actor.model !== undefined) nonBlank(actor.model, 'actor.model')
  if (actor.modelRevision !== undefined) nonBlank(actor.modelRevision, 'actor.modelRevision')
  if (actor.runId !== undefined) nonBlank(actor.runId, 'actor.runId')
  return {
    kind: 'agent',
    name: actor.name,
    client: actor.client,
    sessionId: actor.sessionId,
    ...(actor.provider === undefined ? {} : { provider: actor.provider }),
    ...(actor.model === undefined ? {} : { model: actor.model }),
    ...(actor.modelRevision === undefined ? {} : { modelRevision: actor.modelRevision }),
    ...(actor.runId === undefined ? {} : { runId: actor.runId }),
  }
}

function bearerToken(request: IncomingMessage): string | undefined {
  const authorization = request.headers.authorization
  if (authorization === undefined) return undefined
  const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(authorization)
  return match?.[1]
}

/** Authenticated PaperAI MCP route and descriptor registry. */
export class PaperMcpService extends Service {
  static inject = ['webServer', 'paperProjects', 'paperDocuments', 'paperTemplates', 'paperCommits']
  static Config: z<Config> = z.object({
    routePath: z.string().default(DEFAULT_ROUTE_PATH),
    serverName: z.string().default(DEFAULT_SERVER_NAME),
    defaultNodesPerRead: z.number().default(DEFAULT_NODES_PER_READ),
    maxNodesPerRead: z.number().default(MAX_NODES_PER_READ),
    maxMutationsPerCommit: z.number().default(MAX_MUTATIONS_PER_COMMIT),
  })

  private readonly config: ResolvedConfig
  private readonly actors = new Map<string, PaperMcpAgentIdentity>()
  private exportAdapter: PaperMcpExportAdapter | undefined

  /**
   * @param ctx - Cordis context carrying the WebServer and PaperAI services.
   * @param config - Route and bounded tool-result settings.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'paperMcp')
    this.config = resolveConfig(config)
    const route: WebRoute = {
      kind: 'exact',
      path: this.config.routePath,
      handler: (request, response) => this.handleRequest(request, response),
    }
    ctx.effect(() => ctx.webServer.register(route), 'paperai-mcp: Streamable HTTP route')
  }

  /**
   * Issue one revocable HTTP descriptor bound to one Agent client and session.
   * The caller must retain and dispose the lease with the ACP Agent session.
   * @param actor - Local Codex or Claude identity recorded on every commit.
   * @returns the ACP-compatible descriptor and its idempotent disposer.
   */
  issueDescriptor(actor: PaperMcpAgentIdentity): PaperMcpDescriptorLease {
    let currentActor = validateActor(actor)
    const token = randomBytes(TOKEN_BYTES).toString('base64url')
    let active = true
    const disposeEffect = this.ctx.effect(() => {
      this.actors.set(token, currentActor)
      return () => {
        active = false
        this.actors.delete(token)
      }
    }, 'paperai-mcp: Agent descriptor lease')
    let disposal: Promise<void> | undefined
    const descriptor: PaperMcpHttpServerDescriptor = {
      type: 'http',
      name: this.config.serverName,
      url: this.descriptorUrl(),
      headers: [{ name: 'Authorization', value: `Bearer ${token}` }],
    }
    return {
      descriptor,
      get actor() {
        return structuredClone(currentActor)
      },
      updateActor: (nextActor) => {
        if (!active) throw new Error('paperai-mcp: descriptor lease is disposed')
        const next = validateActor(nextActor)
        if (next.client !== currentActor.client) {
          throw new Error('paperai-mcp: descriptor lease client cannot change')
        }
        if (next.sessionId !== currentActor.sessionId) {
          throw new Error('paperai-mcp: descriptor lease sessionId cannot change')
        }
        currentActor = next
        this.actors.set(token, currentActor)
        return structuredClone(currentActor)
      },
      dispose: () => {
        if (disposal !== undefined) return disposal
        if (!active) return Promise.resolve()
        active = false
        this.actors.delete(token)
        disposal = Promise.resolve(disposeEffect())
        return disposal
      },
    }
  }

  /**
   * Register the sole provider for file-producing export tools. The caller
   * must retain the returned disposer through a Cordis effect.
   * @param adapter - Provider that checks publication and records a commit.
   * @returns a disposer that hides the export tool for future connections.
   */
  registerExportAdapter(adapter: PaperMcpExportAdapter): () => void {
    if (this.exportAdapter !== undefined) {
      throw new Error('paperai-mcp: an export adapter is already registered')
    }
    this.exportAdapter = adapter
    return () => {
      if (this.exportAdapter === adapter) this.exportAdapter = undefined
    }
  }

  private dependencies(): PaperMcpDependencies {
    return {
      projects: this.ctx.paperProjects,
      documents: this.ctx.paperDocuments,
      templates: this.ctx.paperTemplates,
      commits: this.ctx.paperCommits,
    }
  }

  private descriptorUrl(): string {
    const port = this.ctx.webServer.port
    if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
      throw new Error('paperai-mcp: WebServer must be listening before issuing a descriptor')
    }
    const host = this.ctx.webServer.host === '0.0.0.0' ? '127.0.0.1' : this.ctx.webServer.host
    return `http://${host}:${port}${this.config.routePath}`
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const token = bearerToken(request)
    const actor = token === undefined ? undefined : this.actors.get(token)
    if (actor === undefined) {
      response.writeHead(401, {
        'cache-control': 'no-store',
        'www-authenticate': 'Bearer realm="paperai-mcp"',
      })
      response.end('unauthorized')
      return
    }

    const server = createPaperMcpServer(
      this.dependencies(),
      structuredClone(actor),
      this.config,
      this.exportAdapter,
    )
    const transport = new StreamableHTTPServerTransport({})
    let closing: Promise<void> | undefined
    const close = (): Promise<void> => {
      if (closing !== undefined) return closing
      closing = Promise.allSettled([transport.close(), server.close()]).then((outcomes) => {
        for (const outcome of outcomes) {
          if (outcome.status === 'rejected') {
            this.ctx.logger.warn(
              outcome.reason instanceof Error
                ? outcome.reason
                : new Error(String(outcome.reason)),
            )
          }
        }
      })
      return closing
    }
    response.once('close', () => {
      void close()
    })
    try {
      await server.connect(transport as Transport)
      await transport.handleRequest(request, response)
    } catch (error) {
      await close()
      throw error
    }
  }
}

export default PaperMcpService
