/**
 * PaperAI peer Agent factories backed by the pinned Codex and Claude ACP
 * adapters. The factories publish ordinary DSH Sessions and Agents, while the
 * provider-owned loop remains inside the ACP process.
 *
 * @module @paperai/agent-acp
 */

import { randomUUID } from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, posix, relative } from 'node:path'
import { hostname } from 'node:os'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { Context, Service } from '@deepseek-ai/cordis'
import { ACP_TEMPLATES, AcpProviderConfigSchema, resolveProviders, type AcpConfig } from './providers.ts'
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
import { AcpDiagnostics } from './diagnostics.ts'
import type {
  AcpCatalogEntry,
  AcpDiagnostic,
  AcpManagementRequest,
  AcpManagementResult,
  AcpSessionDetails,
} from './diagnostic-types.ts'
import {
  AcpRuntime,
  ISOLATED_ACP_CALLBACKS,
  providerHost,
  resolveLaunch,
  type AcpProviderDefinition,
  type AcpRuntimeOptions,
} from './runtime.ts'
import { installationRoot, managedInstallation, installAdapter, uninstallAdapter } from './installations.ts'
import { environmentSecrets, redactAcpText } from './redaction.ts'
import type PaperMcpService from '@paperai/mcp'
import type { PaperMcpDescriptorLease } from '@paperai/mcp'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-tools'
import { ACP_TOOL, presentAcpCall, presentAcpResult } from './tool-presentation.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    paperAiAcpAgents: PaperAiAcpAgents
    paperMcp: PaperMcpService
  }
}

/** ACP instance directory and deployment limits. */
export type Config = AcpConfig
export type { AcpProviderConfig } from './providers.ts'
/** Validated runtime configuration and structurally redacted settings schema. */
export const Config: z<Config> = z.object({
  probeTimeoutMs: z.number().min(1).default(15_000),
  failureCooldownMs: z.number().min(1).default(120_000),
  startupTimeoutMs: z.number().min(1).default(60_000),
  probeConcurrency: z.number().min(1).max(8).step(1).default(2),
  terminalLimit: z.number().min(1).step(1).default(16),
  terminalOutputBytes: z.number().min(1).step(1).default(65_536),
  processGraceMs: z.number().min(1).step(1).default(2_000),
  managementTimeoutMs: z.number().min(1).default(300_000),
  installTimeoutMs: z.number().min(1).default(600_000),
  installationDirectory: z.string(),
  providers: z.dict(AcpProviderConfigSchema),
})
/** Shared settings namespace for ACP launch credentials and instance preferences. */
export const ACP_AGENT_SETTINGS_NAMESPACE = settingsNamespace('paperai-acp-agents')

function abortError(signal: AbortSignal, id: SessionId): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(`agent "${id}" creation aborted`, { cause: signal.reason })
}

async function raceAbort<T>(operation: PromiseLike<T> | T, signal: AbortSignal, id: SessionId): Promise<T> {
  if (signal.aborted) throw abortError(signal, id)
  const aborted = Promise.withResolvers<never>()
  const listener = (): void => {
    aborted.reject(abortError(signal, id))
  }
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
    const preparation = SessionPreparation.create(
      this.owner.hostCtx.sessions.prepare(options.sessionId, {
        ...(options.seed === undefined ? {} : { seed: options.seed }),
        ...(options.meta === undefined ? {} : { meta: options.meta }),
      }),
    )
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
  private readonly diagnostics: AcpDiagnostics
  private readonly routes = new Map<string, () => void>()
  private syncPresets: () => void = () => {}
  private readonly operations = new Map<string, { kind: string; abort: AbortController; done: Promise<unknown> }>()
  private readonly operationOutput = new Map<string, string>()
  private readonly activeAgents = new Map<SessionId, AcpAgent>()
  private readonly starting = new Map<
    SessionId,
    { provider: AcpProviderDefinition; abort: AbortController; stage: string; began: number }
  >()
  private providerRevisions = new Map<string, string>()

  /** Dependency-complete context inherited by provider factories and Agents. */
  get hostCtx(): Context {
    return this.ctx
  }

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'paperAiAcpAgents')
    this.configSource = () => config
    this.diagnostics = new AcpDiagnostics(ctx)
    ctx.effect(() => () => this.diagnostics.dispose(), 'paperAiAcpAgents.diagnostics()')
    ctx.effect(() => () => this.disposeFactories(), 'paperAiAcpAgents.lifecycles()')
    ctx.effect(
      () => async () => {
        for (const operation of this.operations.values()) operation.abort.abort(new Error('ACP management closed'))
        await Promise.allSettled([...this.operations.values()].map(operation => operation.done))
      },
      'paperAiAcpAgents.management()',
    )
    this.syncRoutes()
    ctx.inject(['tools'], (scope) => {
      scope.effect(
        () => scope.tools.registerPresenter(ACP_TOOL, { presentCall: presentAcpCall, presentResult: presentAcpResult }),
        'paperai-acp: external tool presentation',
      )
    })
    ctx.inject(['agentPresets'], (presetCtx) => {
      const registrations = new Map<string, { key: string; dispose: () => void }>()
      const composition = join(
        dirname(createRequire(import.meta.url).resolve('@paperai/agent-acp/package.json')),
        'config',
        'agent.cordis.yml',
      )
      this.syncPresets = () => {
        const providers = this.providers()
        for (const [id, registered] of registrations) {
          if (
            providers.some(
              provider => provider.id === id && registered.key === JSON.stringify([provider.name, provider.enabled]),
            )
          )
            continue
          registered.dispose()
          registrations.delete(id)
        }
        for (const provider of providers) {
          if (registrations.has(provider.id)) continue
          const dispose = presetCtx.effect(
            () =>
              presetCtx.agentPresets.register({
                id: provider.id,
                name: provider.name,
                trust: 'system',
                path: composition,
                factoryRoute: provider.id,
                ...(provider.enabled ? {} : { broken: '此 ACP 渠道尚未启用，请在 ACP 设置中配置并启用。' }),
              }),
            `paperAiAcpAgents.preset(${provider.id})`,
          )
          registrations.set(provider.id, {
            key: JSON.stringify([provider.name, provider.enabled]),
            dispose: () => {
              void dispose()
            },
          })
        }
      }
      presetCtx.effect(() => () => {
        this.syncPresets = () => {}
      })
      this.syncPresets()
    })
    installSettingsSection(ctx, ACP_AGENT_SETTINGS_NAMESPACE, Config, config, {
      setSource: (source) => {
        this.configSource = source
      },
      onChange: () => {
        this.syncRoutes()
        this.syncPresets()
      },
      validate: (value) => {
        resolveProviders(value)
      },
    })
  }

  private syncRoutes(): void {
    const providers = this.providers()
    for (const [id, previous] of this.providerRevisions) {
      if (previous === JSON.stringify(providers.find(provider => provider.id === id))) continue
      this.cancelOperation(id)
    }
    this.providerRevisions = new Map(providers.map(provider => [provider.id, JSON.stringify(provider)]))
    const enabled = providers.filter(provider => provider.enabled)
    for (const [id, dispose] of this.routes) {
      if (enabled.some(provider => provider.id === id)) continue
      dispose()
      this.routes.delete(id)
    }
    for (const provider of enabled) {
      if (this.routes.has(provider.id)) continue
      const dispose = this.ctx.effect(
        () => this.ctx.agents.registerFactory(provider.id, new ProviderFactory(this, provider)),
        `paperAiAcpAgents.route(${provider.id})`,
      )
      this.routes.set(provider.id, () => {
        void dispose()
      })
    }
  }

  /**
   * Resolve the full configured directory without granting project capabilities.
   * @returns built-in templates and independently configured instances.
   */
  providers(): readonly AcpProviderDefinition[] {
    return resolveProviders(this.configSource())
  }

  /**
   * Resolve secrets and endpoint overrides at session creation time.
   * @param definition - pinned provider definition to combine with the current settings.
   * @returns the provider definition with current command, credential, and endpoint overrides applied.
   */
  resolveProvider(definition: AcpProviderDefinition): AcpProviderDefinition {
    const provider = this.providers().find(entry => entry.id === definition.id)
    if (provider === undefined || !provider.enabled)
      throw new Error(`ACP instance ${definition.id} is unavailable or disabled`)
    return this.installedProvider(provider)
  }

  private installedProvider(provider: AcpProviderDefinition): AcpProviderDefinition {
    if (provider.ssh !== undefined) return provider
    const config = this.configSource()
    return (
      managedInstallation(
        installationRoot(config.installationDirectory),
        provider,
        config.providers?.[provider.id]?.command !== undefined,
      )?.provider ?? provider
    )
  }

  /**
   * Read installation and cached catalogs without spawning any adapter.
   * @returns metadata for both configured providers, independent from live model selection.
   */
  diagnosticStatus(): readonly AcpDiagnostic[] {
    return this.providers().map((provider) => {
      let diagnostic: AcpDiagnostic
      try {
        diagnostic = this.diagnostics.read(this.installedProvider(provider))
      } catch {
        diagnostic = { ...this.diagnostics.read(provider), executable: null, status: 'error', error: 'unavailable' }
      }
      return { ...diagnostic, connected: this.isConnected(provider.id) }
    })
  }

  private isConnected(provider: string): boolean {
    return [...this.activeAgents.values()].some(agent => agent.provider.id === provider && agent.connected)
  }

  /**
   * Inspect the current Host's executable directory without downloading or authenticating.
   * @param signal - optional cancellation for executable lookups.
   * @returns all channel instances, including disabled and unavailable templates.
   */
  async catalog(signal?: AbortSignal): Promise<readonly AcpCatalogEntry[]> {
    return await Promise.all(
      this.providers().map(async (provider): Promise<AcpCatalogEntry> => {
        const template = ACP_TEMPLATES.find(entry => entry.id === provider.template)
        const find = async (command: string): Promise<string | null> => {
          if (provider.ssh !== undefined) return null
          try {
            return await this.ctx.subprocess.resolveExecutable(command, installed?.provider.env ?? provider.env, signal)
          } catch {
            signal?.throwIfAborted()
            return null
          }
        }
        let installed: ReturnType<typeof managedInstallation>
        let launch: readonly string[] = []
        let unavailable = false
        try {
          const config = this.configSource()
          installed =
            provider.ssh === undefined
              ? managedInstallation(
                installationRoot(config.installationDirectory),
                provider,
                config.providers?.[provider.id]?.command !== undefined,
              )
              : undefined
          launch = resolveLaunch(installed?.provider ?? provider)
        } catch {
          unavailable = true
        }
        const [adapter, cli] = await Promise.all([
          launch[0] === undefined ? Promise.resolve(null) : find(launch[0]),
          template === undefined ? Promise.resolve(null) : find(template.cli),
        ])
        const observed = this.diagnostics.read(installed?.provider ?? provider)
        const diagnostic: AcpDiagnostic = unavailable
          ? { ...observed, executable: null, status: 'error', error: 'unavailable' }
          : observed
        const startup = [...this.starting.values()].find(entry => entry.provider.id === provider.id)
        return {
          id: provider.id,
          name: provider.name,
          template: provider.template ?? 'custom',
          enabled: provider.enabled === true,
          connected: this.isConnected(provider.id),
          startup: startup === undefined ? null : { stage: startup.stage, elapsedMs: Date.now() - startup.began },
          host: provider.ssh?.host ?? hostname(),
          command: provider.command ?? provider.binName,
          args: provider.args ?? [],
          adapter:
            provider.ssh === undefined
              ? adapter === process.execPath && launch[1] !== undefined
                ? launch[1]
                : adapter
              : diagnostic.status === 'ready'
                ? diagnostic.executable
                : null,
          cli,
          source:
            provider.ssh !== undefined
              ? 'remote'
              : installed !== undefined
                ? 'managed'
                : provider.command === undefined
                  ? 'bundled'
                  : 'external',
          documentation: template?.url ?? null,
          login: template?.login ?? null,
          installable: provider.ssh === undefined && template?.packageName !== undefined,
          diagnostic: installed === undefined ? diagnostic : { ...diagnostic, adapterVersion: installed.version },
          busy:
            this.operations.get(provider.id)?.kind ??
            (startup !== undefined ? 'connecting' : this.diagnostics.isProbing(provider.id) ? 'probe' : null),
          output: this.operationOutput.get(provider.id) ?? null,
        }
      }),
    )
  }

  /**
   * Run a prompt-free probe with shared failure cooldown and process teardown.
   * @param provider - installed peer Agent to inspect.
   * @param force - explicit retry bypassing failure cooldown.
   * @returns observed ACP metadata, including a cached model preview.
   */
  probe(provider: string, force: boolean): Promise<AcpDiagnostic> {
    const config = this.configSource()
    const definition = this.providers().find(entry => entry.id === provider)
    if (definition === undefined) throw new Error(`Unknown ACP instance: ${provider}`)
    return this.diagnostics.probe(
      this.installedProvider(definition),
      {
        probeTimeoutMs: config.probeTimeoutMs ?? 15_000,
        failureCooldownMs: config.failureCooldownMs ?? 120_000,
        concurrency: config.probeConcurrency ?? 2,
      },
      force,
    )
  }

  /**
   * Cancel an outstanding channel diagnostic.
   * @param provider - configured channel id.
   */
  cancelOperation(provider: string): void {
    this.diagnostics.cancel(provider)
    this.operations.get(provider)?.abort.abort(new Error('ACP 操作已取消'))
    for (const entry of this.starting.values())
      if (entry.provider.id === provider) entry.abort.abort(new Error('ACP 连接已取消'))
  }

  /**
   * Read controls from the current runtime without connecting an idle history entry.
   * @param id - PaperAI session identity.
   * @returns exact provider controls, or null for another Agent driver.
   */
  sessionDetails(id: SessionId): AcpSessionDetails | null {
    return this.activeAgents.get(id)?.details() ?? null
  }

  /**
   * Find a local conversation already linked to this provider's external history.
   * @param provider - supported ACP channel.
   * @param externalId - external session id.
   * @param signal - caller cancellation.
   * @param except - new blank local session excluded during import admission.
   * @returns existing local id, or null.
   */
  async linkedSession(
    provider: string,
    externalId: string,
    signal?: AbortSignal,
    except?: SessionId,
  ): Promise<SessionId | null> {
    const definition = this.providers().find(entry => entry.id === provider)
    if (definition === undefined) throw new Error('ACP 渠道不存在')
    const matches = (
      events: readonly import('@deepseek-ai/dsh-session').SessionEvent[],
      inherited: number,
    ): boolean => {
      const association = events
        .slice(inherited)
        .filter(event => event.type === 'paperai/acp/session')
        .findLast(event => event.data.provider === provider)?.data
      return association?.externalSessionId === externalId && (association.host ?? 'local') === providerHost(definition)
    }
    for (const [id, agent] of this.activeAgents)
      if (id !== except && matches(agent.session.events, agent.session.header.seedLength ?? 0)) return id
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) return null
    // ponytail: explicit imports scan stored logs; add a persisted index if history size makes this operation slow.
    for (const header of await persistence.list(signal)) {
      if (
        header.id === except ||
        this.activeAgents.has(header.id) ||
        (header.agentPreset !== undefined && header.agentPreset !== provider)
      )
        continue
      const stored = await persistence.inspect(header.id, signal)
      if (matches(stored.events, header.seedLength ?? 0)) return header.id
    }
    return null
  }

  /**
   * Import provider history into a newly created local conversation with the same working directory.
   * @param id - unused local session.
   * @param externalId - provider history id.
   * @param cwd - directory from the selected history entry.
   * @param caller - import cancellation.
   * @returns the existing or newly linked local session id.
   */
  async importHistory(id: SessionId, externalId: string, cwd: string, caller?: AbortSignal): Promise<SessionId> {
    const agent = this.activeAgents.get(id)
    if (agent === undefined) throw new Error('请先创建此渠道的新会话')
    return await this.operate(agent.provider.id, 'import', caller, async (_provider, signal) => {
      const target = agent.provider.ssh?.cwd ?? agent.session.header.cwd
      if (
        target === undefined ||
        (agent.provider.ssh === undefined
          ? !isAbsolute(cwd) || relative(target, cwd) !== ''
          : !posix.isAbsolute(cwd) || posix.relative(target, cwd) !== '')
      )
        throw new Error('外部历史的工作目录与此会话不一致')
      const existing = await this.linkedSession(agent.provider.id, externalId, signal, id)
      if (existing !== null) return existing
      await agent.importHistory(externalId, signal)
      return id
    })
  }

  /**
   * Apply a declared ACP session option to its exact active Agent.
   * @param id - current PaperAI session identity.
   * @param option - advertised option id.
   * @param value - selected string or boolean value.
   */
  async selectOption(id: SessionId, option: string, value: string | boolean): Promise<void> {
    const agent = this.activeAgents.get(id)
    if (agent === undefined) throw new Error('此会话当前没有活动 ACP 连接')
    if (agent.status !== 'idle') throw new Error('请等待本轮结束后再修改会话选项')
    await agent.selectConfigOption(option, value)
  }

  private async operate<T>(
    id: string,
    kind: string,
    caller: AbortSignal | undefined,
    action: (provider: AcpProviderDefinition, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.operations.has(id)) throw new Error('此渠道已有操作正在进行')
    const provider = this.providers().find(entry => entry.id === id)
    if (provider === undefined) throw new Error('ACP 渠道不存在')
    const abort = new AbortController()
    const signal = AbortSignal.any([abort.signal, this.teardown.signal, ...(caller === undefined ? [] : [caller])])
    const config = this.configSource()
    const timer = setTimeout(
      () => {
        abort.abort(new Error('ACP 操作超时'))
      },
      kind === 'install' ? (config.installTimeoutMs ?? 600_000) : (config.managementTimeoutMs ?? 300_000),
    )
    this.operationOutput.delete(id)
    const done = Promise.resolve().then(async () => {
      signal.throwIfAborted()
      return await action(provider, signal)
    })
    this.operations.set(id, { kind, abort, done })
    try {
      return await done
    } catch (error: unknown) {
      throw new Error(
        redactAcpText(error instanceof Error ? error.message : String(error), environmentSecrets(provider.env)),
      )
    } finally {
      clearTimeout(timer)
      this.operations.delete(id)
    }
  }

  /**
   * Run a capability-gated account, routing, or provider-history action independently of conversations.
   * @param provider - configured channel id.
   * @param request - explicit management action.
   * @param signal - caller cancellation.
   * @returns non-secret management response fields.
   */
  async manage(provider: string, request: AcpManagementRequest, signal?: AbortSignal): Promise<AcpManagementResult> {
    return await this.operate(provider, request.kind, signal, async (definition, operationSignal) => {
      if (
        request.kind === 'delete' &&
        [...this.activeAgents.values()].some(
          agent => agent.provider.id === provider && agent.externalSessionId === request.sessionId,
        )
      )
        throw new Error('请先关闭此渠道的活动会话，再删除外部历史')
      const directory = await mkdtemp(join(tmpdir(), 'paperai-acp-manage-'))
      const runtime = new AcpRuntime(this.ctx, this.installedProvider(definition), directory, ISOLATED_ACP_CALLBACKS)
      try {
        await runtime.initialize(operationSignal)
        return await runtime.manage(request, operationSignal)
      } catch (error: unknown) {
        throw new Error(
          redactAcpText(String(error), request.kind === 'set-provider' ? Object.values(request.headers) : []),
        )
      } finally {
        try {
          await runtime.close()
        } finally {
          await rm(directory, { recursive: true, force: true })
        }
      }
    })
  }

  /**
   * Install, update, or uninstall one declared template inside the managed installation root.
   * @param provider - configured instance id.
   * @param action - installation action; uninstall never targets external commands.
   * @param signal - caller cancellation.
   */
  async install(provider: string, action: 'install' | 'uninstall', signal?: AbortSignal): Promise<void> {
    await this.operate(provider, action, signal, async (definition, operationSignal) => {
      if (definition.ssh !== undefined) throw new Error('请在 SSH 主机上安装或更新 CLI；本机托管安装不会修改远程主机')
      if (
        [...this.activeAgents.values()].some(agent => agent.provider.id === provider) ||
        [...this.starting.values()].some(entry => entry.provider.id === provider)
      )
        throw new Error('请先关闭此渠道的活动会话，再更改安装')
      const template = ACP_TEMPLATES.find(entry => entry.id === definition.template)
      if (template === undefined) throw new Error('自定义命令请在运行主机手动安装')
      const config = this.configSource()
      const root = installationRoot(config.installationDirectory)
      if (action === 'uninstall') await uninstallAdapter(root, definition)
      else
        await installAdapter(
          this.ctx,
          root,
          definition,
          template,
          {
            outputBytes: config.terminalOutputBytes ?? 65_536,
            graceMs: config.processGraceMs ?? 2_000,
          },
          operationSignal,
          (output) => {
            this.operationOutput.set(provider, redactAcpText(output, environmentSecrets(definition.env)))
          },
        )
    })
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
    const startup = { provider, abort, stage: 'spawn', began: Date.now() }
    this.starting.set(id, startup)
    const startupTimer = setTimeout(() => {
      abort.abort(new Error(`${provider.name} ACP startup timed out`))
    }, this.configSource().startupTimeoutMs ?? 60_000)
    const callerSignal = options.signal
    const onCallerAbort = (): void => {
      abort.abort(abortError(callerSignal as AbortSignal, id))
    }
    const onFactoryAbort = (): void => {
      abort.abort(this.teardown.signal.reason)
    }
    const dispose = (ownerTriggered = false): Promise<void> =>
      (disposing ??= (async () => {
        await agent?.closeProviderSession()
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
              this.activeAgents.delete(id)
              this.ctx.emit('paperai/acp-changed', id)
              if (!ownerTriggered) await unfollowOwner?.()
            }
          }
        }
      })())

    try {
      ownerCtx.fiber.assertActive()
      if (!this.accepting) throw new Error('PaperAI ACP Agent factories are not active')
      if (this.operations.has(provider.id)) throw new Error('此 ACP 渠道正在执行管理操作，请完成后再连接')
      if (callerSignal?.aborted === true) throw abortError(callerSignal, id)
      callerSignal?.addEventListener('abort', onCallerAbort, { once: true })
      this.teardown.signal.addEventListener('abort', onFactoryAbort, { once: true })
      this.live.add(dispose)
      unfollowOwner = ownerCtx.effect(
        () => () => {
          if (disposing !== undefined) return
          abort.abort(new Error(`agent "${id}" owner disposed`))
          return dispose(true)
        },
        `paperAiAcpAgents.lifecycle(${id})`,
      )

      const runId = randomUUID()
      // The lease carries the session's workspace and live sandbox mode so
      // the MCP tools stay inside this session's project and refuse mutations
      // under read-only, the same fence the ACP file callbacks enforce.
      mcpLease = this.ctx.paperMcp.issueDescriptor(
        {
          kind: 'agent',
          name: provider.name,
          client: provider.id,
          provider: provider.id,
          sessionId: String(id),
          runId,
        },
        {
          workspaceRoot: this.ctx.sandboxPolicy.resolve({ session }).workspaceRoot,
          sandboxMode: () => this.ctx.sandboxPolicy.resolve({ session }).mode,
        },
      )
      const runtimeOptions: AcpRuntimeOptions = {
        mcpServers: [mcpLease.descriptor],
        processGraceMs: this.configSource().processGraceMs ?? 2_000,
        startupStage: (stage) => {
          if (this.starting.get(id) !== startup) return
          startup.stage = stage
          this.ctx.emit('paperai/acp-changed', id)
        },
        promptSucceeded: () => {
          this.diagnostics.promptSucceeded(provider)
        },
        terminalLimits: {
          maxTerminals: this.configSource().terminalLimit ?? 16,
          outputBytes: this.configSource().terminalOutputBytes ?? 65_536,
          graceMs: this.configSource().processGraceMs ?? 2_000,
        },
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
      const startedAt = Date.now()
      const started = await raceAbort(agent.start(abort.signal), abort.signal, id)
      this.diagnostics.remember(provider, started, Date.now() - startedAt)
      const defaults = 'resumeSessionId' in options ? undefined : this.configSource().providers?.[provider.id]
      const requestedModel = options.agentOptions?.model ?? ('resumeSessionId' in options ? undefined : defaults?.model)
      if (requestedModel !== undefined || defaults?.reasoningEffort !== undefined || defaults?.switches !== undefined) {
        await raceAbort(
          agent.modelController.selectModel(requestedModel ?? agent.modelController.currentModel, {
            ...(defaults?.reasoningEffort === undefined ? {} : { reasoningEffort: defaults.reasoningEffort }),
            ...(defaults?.switches === undefined ? {} : { switches: defaults.switches }),
          }),
          abort.signal,
          id,
        )
      }
      for (const [key, value] of Object.entries(defaults?.configOptions ?? {}))
        await raceAbort(agent.selectConfigOption(key, value), abort.signal, id)
      const setupCommit = await raceAbort(options.setup?.(agent.ctx), abort.signal, id)
      setupCommit?.commit()
      await raceAbort(agent.syncSandboxMode(abort.signal), abort.signal, id)

      detachSession = agent.ctx.sessions.enter(session)
      agent.ctx.sessions.announce(session)
      agent.commitSessionLink()
      detachAgent = this.ctx.agents.enter(agent, ownerCtx.agent)
      this.ctx.agents.announce(agent)
      this.activeAgents.set(id, agent)
      this.ctx.emit('paperai/acp-changed', id)
      emitAgentEvent(this.ctx, agent, 'agent/session-start', {
        source: 'resumeSessionId' in options ? 'resume' : 'startup',
      })

      callerSignal?.removeEventListener('abort', onCallerAbort)
      return { agent, dispose }
    } catch (error: unknown) {
      await dispose()
      throw error
    } finally {
      clearTimeout(startupTimer)
      this.starting.delete(id)
      this.ctx.emit('paperai/acp-changed', id)
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
