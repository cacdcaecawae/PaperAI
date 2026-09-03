/**
 * PaperAI peer Agent factories backed by the pinned Codex and Claude ACP
 * adapters. The factories publish ordinary DSH Sessions and Agents, while the
 * provider-owned loop remains inside the ACP process.
 *
 * @module @paperai/agent-acp
 */

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  emitAgentEvent,
  type AgentFactory,
  type AgentHandle,
  type CreateAgentOptions,
  type ResumeAgentOptions,
} from '@deepseek-ai/dsh-agent'
import { SessionPreparation, type SessionId } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { AcpAgent } from './agent.ts'
import type { AcpProviderDefinition, AcpRuntimeOptions } from './runtime.ts'
import type PaperMcpService from '@paperai/mcp'
import type { PaperMcpDescriptorLease } from '@paperai/mcp'

declare module '@deepseek-ai/cordis' {
  interface Context {
    paperAiAcpAgents: PaperAiAcpAgents
    paperMcp: PaperMcpService
  }
}

/** Optional launch override for one pinned local ACP adapter. */
export interface AcpProviderConfig {
  /** Executable override; defaults to the pinned adapter's discovered binary. */
  readonly command?: string
  /** Additional command-line arguments passed to the local ACP adapter. */
  readonly args?: string[]
  /** Provider-specific environment additions; values stay secret on wire surfaces. */
  readonly env?: Record<string, string>
  /** Optional provider credential injected only into the adapter process. */
  readonly apiKey?: string
  /** Optional provider API endpoint override consumed by the adapter. */
  readonly baseURL?: string
}

/** PaperAI ACP Agent plugin configuration. */
export interface Config {
  /** Local Codex ACP launch overrides. */
  readonly codex?: AcpProviderConfig
  /** Local Claude ACP launch overrides. */
  readonly claude?: AcpProviderConfig
}

/** Settings namespace rendered by the stock DSH settings UI. */
export const ACP_AGENT_SETTINGS_NAMESPACE = settingsNamespace('paperai-acp-agents')

const providerConfig: z<AcpProviderConfig> = z.object({
  command: z.string(),
  args: z.array(z.string()),
  env: z.dict(z.string()).role('secret'),
  apiKey: z.string().role('secret'),
  baseURL: z.string(),
})

/** Runtime and settings schema; credentials are structurally redacted on every wire surface. */
export const Config: z<Config> = z.object({
  codex: providerConfig,
  claude: providerConfig,
})

const CODEX: AcpProviderDefinition = {
  id: 'codex',
  name: 'Codex',
  packageName: '@agentclientprotocol/codex-acp',
  binName: 'codex-acp',
}

const CLAUDE: AcpProviderDefinition = {
  id: 'claude',
  name: 'Claude',
  packageName: '@agentclientprotocol/claude-agent-acp',
  binName: 'claude-agent-acp',
}

function configuredProvider(
  definition: AcpProviderDefinition,
  config: AcpProviderConfig | undefined,
): AcpProviderDefinition {
  if (config === undefined) return definition
  const env = {
    ...config.env,
    ...config.apiKey === undefined
      ? {}
      : definition.id === 'codex'
        ? { OPENAI_API_KEY: config.apiKey }
        : { ANTHROPIC_API_KEY: config.apiKey },
    ...config.baseURL === undefined
      ? {}
      : definition.id === 'codex'
        ? { OPENAI_BASE_URL: config.baseURL }
        : { ANTHROPIC_BASE_URL: config.baseURL },
  }
  return {
    ...definition,
    ...config.command === undefined ? {} : { command: config.command },
    ...config.args === undefined ? {} : { args: config.args },
    ...Object.keys(env).length === 0 ? {} : { env },
  }
}

function abortError(signal: AbortSignal, id: SessionId): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(`agent "${id}" creation aborted`, { cause: signal.reason })
}

async function raceAbort<T>(operation: PromiseLike<T> | T, signal: AbortSignal, id: SessionId): Promise<T> {
  if (signal.aborted) throw abortError(signal, id)
  const aborted = Promise.withResolvers<never>()
  const listener = (): void => { aborted.reject(abortError(signal, id)) }
  signal.addEventListener('abort', listener, { once: true })
  try {
    return await Promise.race([Promise.resolve(operation), aborted.promise])
  } finally {
    signal.removeEventListener('abort', listener)
  }
}

class ProviderFactory implements AgentFactory {
  constructor(
    private readonly owner: PaperAiAcpAgents,
    readonly provider: AcpProviderDefinition,
  ) {}

  createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> {
    const preparation = SessionPreparation.create(this.owner.hostCtx.sessions.prepare(options.sessionId, {
      ...options.seed === undefined ? {} : { seed: options.seed },
      ...options.meta === undefined ? {} : { meta: options.meta },
    }))
    return this.owner.publish(ownerCtx, this.owner.resolveProvider(this.provider), preparation, options)
  }

  async resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle> {
    const persistence = this.owner.hostCtx.get('sessionPersistence')
    if (persistence === undefined) {
      throw new Error('cannot resume ACP Agent: session persistence is not configured')
    }
    const preparation = await this.preparePersisted(persistence, options)
    return this.owner.publish(ownerCtx, this.owner.resolveProvider(this.provider), preparation, options)
  }

  private async preparePersisted(
    persistence: SessionPersistence,
    options: ResumeAgentOptions,
  ): Promise<SessionPreparation> {
    return await persistence.prepare(options.resumeSessionId, options.signal)
  }
}

/** Owns the two exact ACP factory routes and every lifecycle they create. */
export class PaperAiAcpAgents extends Service {
  static inject = ['agents', 'sessions', 'subprocess', 'fs', 'sandboxPolicy', 'paperMcp']

  private accepting = true
  private readonly teardown = new AbortController()
  private readonly live = new Set<(ownerTriggered?: boolean) => Promise<void>>()
  private configSource: () => Config

  /** Dependency-complete context inherited by provider factories and Agents. */
  get hostCtx(): Context {
    return this.ctx
  }

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'paperAiAcpAgents')
    this.configSource = () => config
    const codex = new ProviderFactory(this, configuredProvider(CODEX, config.codex))
    const claude = new ProviderFactory(this, configuredProvider(CLAUDE, config.claude))

    ctx.effect(() => () => this.disposeFactories(), 'paperAiAcpAgents.lifecycles()')
    ctx.effect(() => ctx.agents.registerFactory('codex', codex), 'paperAiAcpAgents.codex()')
    ctx.effect(() => ctx.agents.registerFactory('claude', claude), 'paperAiAcpAgents.claude()')
    installSettingsSection(ctx, ACP_AGENT_SETTINGS_NAMESPACE, Config, config, {
      setSource: (source) => { this.configSource = source },
      onChange: () => {},
    })
  }

  /**
   * Resolve secrets and endpoint overrides at session creation time.
   * @param definition - pinned provider definition to combine with the current settings.
   * @returns the provider definition with current command, credential, and endpoint overrides applied.
   */
  resolveProvider(definition: AcpProviderDefinition): AcpProviderDefinition {
    const config = this.configSource()[definition.id]
    return configuredProvider(definition, config)
  }

  /**
   * Complete setup, atomically publish the DSH lifecycle, and return its owner capability.
   * @param ownerCtx - active Context whose lifetime owns the published Agent and Session.
   * @param provider - configured ACP provider definition to launch.
   * @param preparation - exclusive prepared Session consumed and disposed by this call.
   * @param options - create or resume options, including cancellation, model selection, and setup.
   * @returns the Agent handle after startup, setup, Session entry, and Agent entry complete.
   * @throws when ownership, cancellation, ACP startup, model selection, or setup fails; partial resources are disposed before rejection.
   */
  async publish(
    ownerCtx: Context,
    provider: AcpProviderDefinition,
    preparation: SessionPreparation,
    options: CreateAgentOptions | ResumeAgentOptions,
  ): Promise<AgentHandle> {
    const session = preparation.session
    const id = session.id
    let agent: AcpAgent | undefined
    let mcpLease: PaperMcpDescriptorLease | undefined
    let detachSession: (() => void) | undefined
    let detachAgent: (() => void) | undefined
    let unfollowOwner: (() => Promise<void> | void) | undefined
    let disposing: Promise<void> | undefined
    const abort = new AbortController()
    const callerSignal = options.signal
    const onCallerAbort = (): void => { abort.abort(abortError(callerSignal as AbortSignal, id)) }
    const onFactoryAbort = (): void => { abort.abort(this.teardown.signal.reason) }
    const dispose = (ownerTriggered = false): Promise<void> => (disposing ??= (async () => {
      abort.abort(new Error(`agent "${id}" lifecycle disposed`))
      callerSignal?.removeEventListener('abort', onCallerAbort)
      this.teardown.signal.removeEventListener('abort', onFactoryAbort)
      try {
        await agent?.close()
      } finally {
        try {
          await mcpLease?.dispose()
        } finally {
          try {
            detachAgent?.()
          } finally {
            detachSession?.()
            this.live.delete(dispose)
            if (!ownerTriggered) await unfollowOwner?.()
          }
        }
      }
    })())

    try {
      ownerCtx.fiber.assertActive()
      if (!this.accepting) throw new Error('PaperAI ACP Agent factories are not active')
      if (callerSignal?.aborted === true) throw abortError(callerSignal, id)
      callerSignal?.addEventListener('abort', onCallerAbort, { once: true })
      this.teardown.signal.addEventListener('abort', onFactoryAbort, { once: true })
      this.live.add(dispose)
      unfollowOwner = ownerCtx.effect(() => () => {
        if (disposing !== undefined) return
        abort.abort(new Error(`agent "${id}" owner disposed`))
        return dispose(true)
      }, `paperAiAcpAgents.lifecycle(${id})`)

      const runId = randomUUID()
      // The lease carries the session's workspace and live sandbox mode so
      // the MCP tools stay inside this session's project and refuse mutations
      // under read-only, the same fence the ACP file callbacks enforce.
      mcpLease = this.ctx.paperMcp.issueDescriptor({
        kind: 'agent',
        name: provider.name,
        client: provider.id,
        provider: provider.id,
        sessionId: String(id),
        runId,
      }, {
        workspaceRoot: this.ctx.sandboxPolicy.resolve({ session }).workspaceRoot,
        sandboxMode: () => this.ctx.sandboxPolicy.resolve({ session }).mode,
      })
      const runtimeOptions: AcpRuntimeOptions = {
        mcpServers: [mcpLease.descriptor],
      }
      agent = new AcpAgent(this.ctx, id, session, provider, runtimeOptions, (model) => {
        const lease = mcpLease
        if (lease === undefined) return
        lease.updateActor({
          ...lease.actor,
          model,
          runId,
        })
      })
      await raceAbort(agent.start(abort.signal), abort.signal, id)
      const requestedModel = options.agentOptions?.model
      if (requestedModel !== undefined && requestedModel !== agent.modelController.currentModel) {
        await raceAbort(agent.modelController.selectModel(requestedModel), abort.signal, id)
      }
      const setupCommit = await raceAbort(options.setup?.(agent.ctx), abort.signal, id)
      setupCommit?.commit()
      await raceAbort(agent.syncSandboxMode(abort.signal), abort.signal, id)

      detachSession = agent.ctx.sessions.enter(session)
      agent.ctx.sessions.announce(session)
      agent.commitSessionLink()
      detachAgent = this.ctx.agents.enter(agent, ownerCtx.agent)
      this.ctx.agents.announce(agent)
      emitAgentEvent(this.ctx, agent, 'agent/session-start', {
        source: 'resumeSessionId' in options ? 'resume' : 'startup',
      })

      callerSignal?.removeEventListener('abort', onCallerAbort)
      return { agent, dispose }
    } catch (error: unknown) {
      await dispose()
      throw error
    } finally {
      preparation[Symbol.dispose]()
    }
  }

  private async disposeFactories(): Promise<void> {
    if (!this.accepting) return
    this.accepting = false
    this.teardown.abort(new Error('PaperAI ACP Agent factories unloaded'))
    await Promise.all([...this.live].map(dispose => dispose()))
  }
}

export { AcpAgent } from './agent.ts'
export { modelStateFromConfigOptions } from './catalog.ts'
export type { AcpModelState } from './catalog.ts'
export { AcpSelectionError, paperAiClientCapabilities } from './runtime.ts'
export type { AcpProviderDefinition, AcpRuntimeOptions, AcpSelection } from './runtime.ts'

export default PaperAiAcpAgents
