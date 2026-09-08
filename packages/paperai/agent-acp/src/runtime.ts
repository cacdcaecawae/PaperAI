import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'
import type {
  ClientCapabilities,
  ClientConnection,
  ContentBlock,
  InitializeResponse,
  McpServer,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionModeState,
  SessionUpdate,
} from '@agentclientprotocol/sdk'
import type { Context } from '@deepseek-ai/cordis'
import type { effectiveSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import type { AgentDriverSelectionOptions } from '@deepseek-ai/dsh-agent'
import type { AcpTerminals, AcpTerminalLimits } from './terminals.ts'
import { manageAcp } from './management.ts'
import type { AcpManagementRequest, AcpManagementResult } from './diagnostic-types.ts'
import { environmentSecrets, redactAcpText } from './redaction.ts'
import { negotiateMcp } from './mcp.ts'
import { sshLaunch, forwardedPort, type AcpSshConfig } from './ssh.ts'
import { TextRetainer } from '@deepseek-ai/dsh-output-retention'
import { isAcpPermissionOption, modelStateFromConfigOptions, type AcpEffortState, type AcpModelState, type AcpSwitchState } from './catalog.ts'

/** The selection a provider session applies: model plus the advertised effort and switch values. */
export interface AcpSelection {
  readonly model: string
  readonly reasoningEffort?: string
  readonly switches?: Readonly<Record<string, boolean>>
  readonly configOptions?: Readonly<Record<string, string | boolean>>
}

/**
 * A selection the provider rejected part-way. `restored` reports whether every
 * step that had already taken effect was put back, so the provider session
 * again applies the selection it had before; when it is false the session
 * holds a state no log describes and must be rebuilt before further use.
 */
export class AcpSelectionError extends Error {
  /** True when the provider session is back at its previous selection. */
  readonly restored: boolean
  /** Failures raised while putting earlier steps back, in restore order. */
  readonly restoreErrors: readonly unknown[]

  constructor(provider: string, cause: unknown, restored: boolean, restoreErrors: readonly unknown[]) {
    super(
      restored
        ? `${provider} rejected the selection; the previous selection was restored`
        : `${provider} rejected the selection and the previous selection could not be fully restored`,
      { cause },
    )
    this.name = 'AcpSelectionError'
    this.restored = restored
    this.restoreErrors = restoreErrors
  }
}

/** The steps a selection applied so far: what to drive back toward the pre-transaction selection. */
interface AppliedSteps {
  model?: { readonly configId: string; readonly previous: string | undefined }
  effort?: { readonly configId: string }
  readonly switches: Set<string>
}

function selectionOf(state: AcpModelState): AcpSelection {
  const effort = state.effort?.current
  return {
    model: state.currentModel ?? state.models[0]?.id ?? 'default',
    ...(effort === undefined ? {} : { reasoningEffort: effort }),
    ...(state.switches.length === 0
      ? {}
      : { switches: Object.fromEntries(state.switches.map(entry => [entry.configId, entry.enabled])) }),
  }
}

function sameSelection(left: AcpSelection, right: AcpSelection): boolean {
  const key = (selection: AcpSelection): string =>
    JSON.stringify([
      selection.model,
      selection.reasoningEffort ?? null,
      Object.entries(selection.switches ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    ])
  return key(left) === key(right)
}

const moduleRequire = createRequire(import.meta.url)
const SESSION_STEERING_METHOD = '_session/steering'

type AcpSandboxMode = NonNullable<ReturnType<typeof effectiveSandboxMode>>

const NATIVE_PERMISSION_MODES = {
  codex: {
    'read-only': 'read-only',
    'workspace-write': 'agent',
    'danger-full-access': 'agent-full-access',
  },
  claude: {
    'read-only': 'plan',
    'workspace-write': 'acceptEdits',
    'danger-full-access': 'bypassPermissions',
  },
} as const satisfies Record<string, Record<AcpSandboxMode, string>>

function nativePermissionMode(provider: AcpProviderDefinition, mode: AcpSandboxMode): string | undefined {
  const template = provider.template ?? provider.id
  return (
    provider.permissionModes?.[mode] ??
    (template === 'codex' || template === 'claude' ? NATIVE_PERMISSION_MODES[template][mode] : undefined)
  )
}

type AcpSteeringResponse =
  | { readonly outcome: 'injected' }
  | { readonly outcome: 'promptRequired'; readonly reason?: string }
  | { readonly outcome: 'startedNewTurn' }
  | { readonly outcome: 'failed' }

/** Result normalized from the provider-owned ACP steering extension. */
export type AcpSteeringOutcome = 'injected' | 'prompt-required' | 'started-new-turn'

/** One pinned local ACP adapter exposed as a peer PaperAI Agent. */
export interface AcpProviderDefinition {
  readonly id: 'codex' | 'claude'
  readonly template?: string
  readonly enabled?: boolean
  readonly permissionModes?: Readonly<Record<string, string>>
  readonly name: string
  readonly packageName: string
  readonly binName: string
  readonly command?: string
  readonly args?: readonly string[]
  readonly env?: Readonly<Record<string, string>>
  readonly personalPrompt?: string
  readonly language?: string
  readonly ssh?: AcpSshConfig
}

/**
 * Identify the execution host whose private history owns an external session id.
 * @param provider - resolved local or SSH launch configuration.
 * @returns stable host identity without credentials or private key paths.
 */
export function providerHost(provider: AcpProviderDefinition): string {
  const ssh = provider.ssh
  return ssh === undefined ? 'local' : JSON.stringify([ssh.host, ssh.user ?? null, ssh.port ?? null, ssh.cwd])
}

/** Runtime callbacks owned by the DSH Agent projection. */
export interface AcpRuntimeCallbacks {
  readonly update: (update: SessionUpdate) => void
  readonly modelChanged: (model: string) => void
  readonly modeChanged: () => void
  readonly readTextFile: (path: string, signal: AbortSignal) => Promise<string>
  readonly writeTextFile: (path: string, content: string, signal: AbortSignal) => Promise<void>
  readonly permission: (
    request: RequestPermissionRequest,
    requestId: string,
  ) => Promise<RequestPermissionResponse> | RequestPermissionResponse
  readonly elicit?: (
    request: acp.CreateElicitationRequest,
    signal: AbortSignal,
  ) => Promise<acp.CreateElicitationResponse>
  readonly clientRequest?: (method: string, request: unknown, response: unknown) => void
  readonly terminals?: AcpTerminals
  readonly operationSignal?: (signal: AbortSignal) => AbortSignal
  readonly connectionChanged?: () => void
}

/** Callbacks for isolated initialization and account operations with no project authority. */
export const ISOLATED_ACP_CALLBACKS: AcpRuntimeCallbacks = {
  update: () => {}, modelChanged: () => {}, modeChanged: () => {},
  readTextFile: () => Promise.reject(new Error('Isolated ACP operations cannot read project files')),
  writeTextFile: () => Promise.reject(new Error('Isolated ACP operations cannot write project files')),
  permission: () => ({ outcome: { outcome: 'cancelled' } }),
}

/** Optional inputs forwarded when the provider-owned ACP session is created or resumed. */
export interface AcpRuntimeOptions {
  readonly mcpServers?: readonly McpServer[]
  readonly terminalLimits?: AcpTerminalLimits
  readonly promptSucceeded?: () => void
  readonly processGraceMs?: number
  readonly startupStage?: (stage: 'spawn' | 'initialize' | 'load' | 'new' | 'permissions') => void
}

/** Provider session metadata available after ACP initialization completes. */
export interface AcpSessionStart {
  readonly externalSessionId: string
  readonly resumed: boolean
  readonly initialized: InitializeResponse
  readonly models: AcpModelState
}

/**
 * Report the client capabilities PaperAI implements for local ACP adapters.
 * @param elicitation - whether this runtime owns a form-question callback.
 * @param terminal - whether this runtime owns confined terminal processes.
 * @returns The capability declaration sent during ACP initialization.
 */
export function paperAiClientCapabilities(elicitation = false, terminal = false): ClientCapabilities {
  return {
    fs: { readTextFile: true, writeTextFile: true },
    session: { configOptions: { boolean: {} }, compaction: {} },
    plan: {},
    ...(elicitation ? { elicitation: { form: {} } } : {}),
    ...(terminal ? { terminal: true } : {}),
  }
}

/**
 * Resolve the explicit process argument vector without executing it.
 * @param definition - configured instance or bundled adapter.
 * @returns executable followed by argument values, preserving spaces and quoting literally.
 */
export function resolveLaunch(definition: AcpProviderDefinition): readonly [string, ...string[]] {
  if (definition.command !== undefined) return [definition.command, ...(definition.args ?? [])]
  const packagePath = moduleRequire.resolve(`${definition.packageName}/package.json`)
  const manifest = moduleRequire(packagePath) as { bin?: string | Record<string, string> }
  const relative = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[definition.binName]
  if (relative === undefined) {
    throw new Error(`${definition.packageName} does not expose ${definition.binName}`)
  }
  return [process.execPath, join(dirname(packagePath), relative), ...(definition.args ?? [])]
}

/**
 * Resolve an adapter installation without executing its CLI.
 * @param definition - pinned adapter or explicit command override.
 * @returns executable and pinned version; an override has no inferred package version.
 */
export function discoverAdapter(definition: AcpProviderDefinition): {
  executable: string
  adapterVersion: string | null
} {
  if (definition.ssh !== undefined)
    return { executable: `${definition.ssh.host}:${definition.command ?? definition.binName}`, adapterVersion: null }
  const argv = resolveLaunch(definition)
  const manifest =
    definition.command === undefined
      ? (moduleRequire(`${definition.packageName}/package.json`) as { version: string })
      : undefined
  return { executable: argv[0], adapterVersion: manifest?.version ?? null }
}

function stderrText(process: SubprocessHandle): string {
  return process.collected.stderr?.readFrom(0).text.trim() ?? ''
}

async function raceAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  const aborted = Promise.withResolvers<never>()
  const onAbort = (): void => {
    try {
      signal.throwIfAborted()
    } catch (error: unknown) {
      aborted.reject(error)
    }
  }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    return await Promise.race([operation, aborted.promise])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/** One managed ACP process and protocol connection. */
export class AcpRuntime {
  private process: SubprocessHandle | undefined
  private connection: ClientConnection | undefined
  private externalSessionId: string | undefined
  private modelState: AcpModelState = { models: [], switches: [] }
  private optionsState: readonly SessionConfigOption[] = []
  private initialized: InitializeResponse | undefined
  /** Depth of running `selectModel` transactions; provider notifications stay internal while positive. */
  private selectionDepth = 0
  private modeState: SessionModeState | undefined
  private replaying = false
  private steeringSupported = false
  private promptActive = false
  private closed = false
  private closing: Promise<void> | undefined
  private sessionClosing: Promise<void> | undefined
  private readonly earlyMetadata = new Map<string, { sessionId: string; update: SessionUpdate }>()
  private readonly sshStderr = new TextRetainer({ kind: 'tail', maxBytes: 65_536 })
  private forwardedServers: readonly McpServer[] | undefined
  private importing: SessionUpdate[] | undefined

  constructor(
    private readonly ctx: Context,
    readonly provider: AcpProviderDefinition,
    private readonly cwd: string,
    private readonly callbacks: AcpRuntimeCallbacks,
    private readonly options: AcpRuntimeOptions = {},
  ) {}

  /** Latest model selector state advertised by the active ACP session. */
  get models(): AcpModelState {
    return this.modelState
  }

  /** Selected model id, falling back to the first advertised model and then `default`. */
  get currentModel(): string {
    return this.modelState.currentModel ?? this.modelState.models[0]?.id ?? 'default'
  }

  /** Applied reasoning effort id, when the provider advertises an effort selector. */
  get currentReasoningEffort(): string | undefined {
    return this.modelState.effort?.current
  }

  /** Boolean session switches the provider advertises, such as fast mode. */
  get switches(): readonly AcpSwitchState[] {
    return this.modelState.switches
  }

  /** The complete selection the provider session applies right now. */
  get selection(): AcpSelection {
    return {
      ...selectionOf(this.modelState),
      ...(this.optionsState.some(
        option =>
          option.type === 'select' &&
          option.id !== this.modelState.configId &&
          option.id !== this.modelState.effort?.configId,
      )
        ? {
          configOptions: Object.fromEntries(
            this.optionsState
              .filter(
                option =>
                  option.type === 'select' &&
                    option.id !== this.modelState.configId &&
                    option.id !== this.modelState.effort?.configId,
              )
              .map(option => [option.id, option.currentValue]),
          ),
        }
        : {}),
    }
  }

  /** Latest provider-declared configuration, including general select and collaboration options. */
  get configuration(): readonly SessionConfigOption[] {
    return this.optionsState
  }

  /** Protocol capabilities of this process generation. */
  get capabilities(): InitializeResponse['agentCapabilities'] {
    return this.initialized?.agentCapabilities
  }

  /** ACP conversation identity owned by this process. */
  get sessionId(): string | undefined {
    return this.externalSessionId
  }

  /** Whether the provider session still has a live transport. Probes never set a session identity. */
  get connected(): boolean {
    return (
      !this.closed &&
      this.externalSessionId !== undefined &&
      this.connection !== undefined &&
      !this.connection.signal.aborted
    )
  }

  /** Whether the connected provider currently has a prompt that can accept steering. */
  get canSteer(): boolean {
    return this.steeringSupported && this.promptActive && !this.closed
  }

  /**
   * Spawn, initialize, and create or resume the provider-owned session.
   * @param previousExternalSessionId Provider session id to resume, or `undefined` to create a session.
   * @param sandboxMode DSH sandbox preset that the provider session must enforce before startup completes.
   * @param signal Cancels process startup and ACP initialization requests.
   * @param replaceFailedLoad Whether a rejected load may create a replacement provider session.
   * Callers may enable it only when no provider conversation history exists.
   * @param lifetimeSignal Closes the provider process when this runtime generation is retired.
   * @returns Initialization metadata and the model selector advertised by the active session.
   * @throws When initialization, a non-replaceable load, session creation, or native-mode synchronization fails.
   */
  async start(
    previousExternalSessionId: string | undefined,
    sandboxMode: AcpSandboxMode,
    signal: AbortSignal,
    replaceFailedLoad = false,
    lifetimeSignal: AbortSignal = signal,
  ): Promise<AcpSessionStart> {
    try {
      const initialized = await this.connect(sandboxMode, signal, lifetimeSignal)
      const connection = this.requireConnection()
      if (
        this.provider.ssh !== undefined &&
        this.forwardedServers?.length &&
        initialized.agentCapabilities?.mcpCapabilities?.http !== true
      )
        throw new Error('Remote ACP requires HTTP MCP support for the forwarded PaperAI endpoint')
      const mcpServers = negotiateMcp(
        this.forwardedServers ?? this.options.mcpServers ?? [],
        initialized.agentCapabilities,
      )
      if (previousExternalSessionId !== undefined) {
        this.externalSessionId = previousExternalSessionId
        this.replaying = true
        try {
          const capabilities = initialized.agentCapabilities
          const method =
            capabilities?.sessionCapabilities?.resume != null
              ? acp.methods.agent.session.resume
              : capabilities?.loadSession === true
                ? acp.methods.agent.session.load
                : undefined
          if (method === undefined) {
            throw new Error('the provider cannot resume or load this conversation; its history cannot be replaced')
          }
          this.options.startupStage?.('load')
          const loaded = await connection.agent.request(
            method,
            {
              sessionId: previousExternalSessionId,
              cwd: this.provider.ssh?.cwd ?? this.cwd,
              ...(capabilities?.sessionCapabilities?.additionalDirectories == null
                ? {}
                : { additionalDirectories: [] }),
              mcpServers,
            },
            { cancellationSignal: signal },
          )
          this.updateConfiguration(loaded.configOptions)
          this.modeState = loaded.modes ?? undefined
        } catch (error: unknown) {
          signal.throwIfAborted()
          if (!replaceFailedLoad) throw error
          this.externalSessionId = undefined
          this.modelState = { models: [], switches: [] }
          this.optionsState = []
          this.modeState = undefined
        } finally {
          this.replaying = false
        }
        if (this.externalSessionId !== undefined) {
          await this.selectSandboxMode(sandboxMode, signal)
          return {
            externalSessionId: previousExternalSessionId,
            resumed: true,
            initialized,
            models: this.modelState,
          }
        }
      }

      this.options.startupStage?.('new')
      const created = await connection.agent.request(
        acp.methods.agent.session.new,
        {
          cwd: this.provider.ssh?.cwd ?? this.cwd,
          mcpServers,
          _meta: { paperaiSession: true },
        },
        { cancellationSignal: signal },
      )
      this.externalSessionId = created.sessionId
      this.updateConfiguration(created.configOptions)
      this.modeState = created.modes ?? undefined
      for (const { sessionId, update } of this.earlyMetadata.values()) {
        if (sessionId === created.sessionId) this.sessionUpdate(update)
      }
      this.earlyMetadata.clear()
      await this.selectSandboxMode(sandboxMode, signal)
      return {
        externalSessionId: created.sessionId,
        resumed: false,
        initialized,
        models: this.modelState,
      }
    } catch (error: unknown) {
      const detail = this.process === undefined ? '' : stderrText(this.process) + this.sshStderr.finish().text
      await this.close()
      throw new Error(
        redactAcpText(
          `${this.provider.name} ACP failed to start: ${error instanceof Error ? error.message : String(error)}${detail === '' ? '' : `: ${detail}`}`,
          environmentSecrets(this.provider.env),
        ),
        { cause: error },
      )
    }
  }

  /**
   * Initialize a management connection without creating a conversation or granting project access.
   * @param signal - cancellation for discovery, authentication, or history management.
   * @returns the advertised protocol, authentication methods, and capabilities.
   */
  async initialize(signal: AbortSignal): Promise<InitializeResponse> {
    try {
      return await this.connect('read-only', signal, signal)
    } catch (error: unknown) {
      await this.close()
      throw error
    }
  }

  /**
   * Apply an account or provider-history operation after initialization.
   * @param request - explicit capability-gated action.
   * @param signal - operation cancellation.
   * @returns non-secret history or routing metadata.
   */
  async manage(request: AcpManagementRequest, signal: AbortSignal): Promise<AcpManagementResult> {
    if (this.initialized === undefined) throw new Error('ACP connection has not initialized')
    return await manageAcp(this.requireConnection().agent, this.initialized, request, signal)
  }

  /**
   * Load an external history into this idle connection, buffering replay until the load succeeds.
   * @param id - external conversation selected by the user.
   * @param mode - standing PaperAI permission mode.
   * @param signal - import lifetime.
   * @returns replay updates in arrival order; an unsupported load leaves the existing conversation selected.
   */
  async importHistory(id: string, mode: AcpSandboxMode, signal: AbortSignal): Promise<SessionUpdate[]> {
    if (this.capabilities?.loadSession !== true) throw new Error('此渠道未声明可导入正文的 session/load 能力')
    if (this.promptActive || this.importing !== undefined) throw new Error('请在空闲会话中导入历史')
    const previous = {
      id: this.externalSessionId,
      options: this.optionsState,
      models: this.modelState,
      modes: this.modeState,
    }
    const replay = (this.importing = [])
    this.externalSessionId = id
    try {
      const loaded = await this.requireConnection().agent.request(
        acp.methods.agent.session.load,
        {
          sessionId: id,
          cwd: this.provider.ssh?.cwd ?? this.cwd,
          ...(this.capabilities.sessionCapabilities?.additionalDirectories == null
            ? {}
            : { additionalDirectories: [] }),
          mcpServers: negotiateMcp(this.forwardedServers ?? this.options.mcpServers ?? [], this.capabilities),
        },
        { cancellationSignal: signal },
      )
      await new Promise<void>(resolve => setImmediate(resolve))
      this.updateConfiguration(loaded.configOptions)
      this.modeState = loaded.modes ?? undefined
      await this.selectSandboxMode(mode, signal)
      signal.throwIfAborted()
      if (previous.id !== undefined && previous.id !== id) await this.releaseSession(previous.id)
      return replay
    } catch (error: unknown) {
      this.externalSessionId = previous.id
      this.optionsState = previous.options
      this.modelState = previous.models
      this.modeState = previous.modes
      throw error
    } finally {
      this.importing = undefined
    }
  }

  private async connect(
    sandboxMode: AcpSandboxMode,
    signal: AbortSignal,
    lifetimeSignal: AbortSignal,
  ): Promise<InitializeResponse> {
    signal.throwIfAborted()
    this.options.startupStage?.('spawn')
    const sshConfig = this.provider.ssh
    const ssh = sshConfig === undefined ? undefined : sshLaunch(sshConfig, this.options.mcpServers ?? [])
    const argv = ssh?.argv ?? resolveLaunch(this.provider)
    const env = {
      ...this.provider.env,
      ...((this.provider.template ?? this.provider.id) === 'codex'
        ? { INITIAL_AGENT_MODE: nativePermissionMode(this.provider, sandboxMode) ?? 'read-only' }
        : {}),
    }
    const process = (this.process = this.ctx.subprocess.spawn({
      argv,
      cwd: this.cwd,
      stdio: {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: ssh === undefined ? { maxBytes: 64 * 1024 } : 'pipe',
      },
      graceMs: this.options.processGraceMs ?? 2_000,
      signal: lifetimeSignal,
      env: ssh === undefined ? env : {},
    }))
    if (process.stdin === undefined || process.stdout === undefined) {
      process.terminate()
      throw new Error(`${this.provider.name} ACP process did not expose piped stdio`)
    }
    if (ssh !== undefined && sshConfig !== undefined) {
      process.stderr?.on('data', (chunk: Buffer) => {
        this.sshStderr.push(chunk)
      })
      const remotePort =
        ssh.localPort === undefined
          ? undefined
          : await forwardedPort(process, ssh.localPort, signal, () => this.sshStderr.finish().text)
      this.forwardedServers = (this.options.mcpServers ?? []).map((server) => {
        if (remotePort === undefined || !('url' in server)) return server
        const url = new URL(server.url)
        url.port = String(remotePort)
        return { ...server, url: url.href }
      })
      process.stdin.write(
        `${JSON.stringify({ command: this.provider.command ?? this.provider.binName, args: this.provider.args ?? [], cwd: sshConfig.cwd, env, graceMs: this.options.processGraceMs ?? 2_000 })}\n`,
      )
    }
    const stream = acp.ndJsonStream(
      Writable.toWeb(process.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(process.stdout) as ReadableStream<Uint8Array>,
    )
    const app = acp
      .client({ name: 'PaperAI' })
      .onRequest(acp.methods.client.session.requestPermission, context =>
        this.ownsSession(context.params.sessionId)
          ? this.callbacks.permission(context.params, String(context.requestId))
          : { outcome: { outcome: 'cancelled' } },
      )
      .onRequest(acp.methods.client.fs.readTextFile, context =>
        this.reply('fs/read_text_file', context.params, async () => {
          if (this.provider.ssh !== undefined)
            throw new Error('Remote ACP clients cannot read files through the local filesystem callback')
          this.assertSession(context.params.sessionId)
          const { path, line, limit } = context.params
          const content = await this.callbacks.readTextFile(path, context.signal)
          if (line == null && limit == null) return { content }
          const start = (line ?? 1) - 1
          return {
            content: content
              .split(/\r?\n/)
              .slice(start, limit == null ? undefined : start + limit)
              .join('\n'),
          }
        }),
      )
      .onRequest(acp.methods.client.fs.writeTextFile, context =>
        this.reply('fs/write_text_file', context.params, async () => {
          if (this.provider.ssh !== undefined)
            throw new Error('Remote ACP clients cannot write files through the local filesystem callback')
          this.assertSession(context.params.sessionId)
          await this.callbacks.writeTextFile(context.params.path, context.params.content, context.signal)
          return {}
        }),
      )
      .onRequest(acp.methods.client.elicitation.create, async (context) => {
        const request = context.params
        if (!('sessionId' in request) || typeof request.sessionId !== 'string' || !this.ownsSession(request.sessionId))
          return { action: 'cancel' }
        return (await this.callbacks.elicit?.(request, context.signal)) ?? { action: 'decline' }
      })
      .onRequest(acp.methods.client.terminal.create, context =>
        this.reply('terminal/create', context.params, async () => {
          this.assertSession(context.params.sessionId)
          const terminals = this.requireTerminals()
          const terminalId = await terminals.create(
            context.params,
            this.callbacks.operationSignal?.(context.signal) ?? context.signal,
          )
          return { terminalId }
        }),
      )
      .onRequest(acp.methods.client.terminal.output, context =>
        this.reply('terminal/output', context.params, () => {
          this.assertSession(context.params.sessionId)
          return this.requireTerminals().output(context.params.terminalId)
        }),
      )
      .onRequest(acp.methods.client.terminal.waitForExit, context =>
        this.reply('terminal/wait_for_exit', context.params, async () => {
          this.assertSession(context.params.sessionId)
          return await this.requireTerminals().wait(context.params.terminalId, context.signal)
        }),
      )
      .onRequest(acp.methods.client.terminal.kill, context =>
        this.reply('terminal/kill', context.params, async () => {
          this.assertSession(context.params.sessionId)
          await this.requireTerminals().kill(context.params.terminalId)
          return {}
        }),
      )
      .onRequest(acp.methods.client.terminal.release, context =>
        this.reply('terminal/release', context.params, async () => {
          this.assertSession(context.params.sessionId)
          await this.requireTerminals().release(context.params.terminalId)
          return {}
        }),
      )
      .onNotification(acp.methods.client.session.update, (context) => {
        if (this.importing !== undefined && context.params.sessionId === this.externalSessionId) {
          this.importing.push(context.params.update)
          return
        }
        const kind = context.params.update.sessionUpdate
        if (
          this.externalSessionId === undefined &&
          ['config_option_update', 'current_mode_update', 'available_commands_update', 'session_info_update'].includes(
            kind,
          )
        ) {
          this.earlyMetadata.set(kind, context.params)
        }
        if (
          context.params.sessionId === this.externalSessionId &&
          (!this.replaying ||
            [
              'config_option_update',
              'current_mode_update',
              'available_commands_update',
              'session_info_update',
            ].includes(kind))
        ) {
          this.sessionUpdate(context.params.update)
        }
      })
    const connection = (this.connection = app.connect(stream))
    connection.signal.addEventListener(
      'abort',
      () => {
        this.callbacks.connectionChanged?.()
      },
      { once: true },
    )
    void process.done.then(
      (outcome) => {
        if (this.closed) return
        const detail = stderrText(process) + this.sshStderr.finish().text
        connection.close(
          new Error(
            redactAcpText(
              `${this.provider.name} ACP exited (${String(outcome.exitCode ?? outcome.signal)})${detail === '' ? '' : `: ${detail}`}`,
              environmentSecrets(this.provider.env),
            ),
          ),
        )
      },
      (error: unknown) => {
        connection.close(error)
      },
    )

    this.options.startupStage?.('initialize')
    const initialized = await connection.agent.request(
      acp.methods.agent.initialize,
      {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {
          ...paperAiClientCapabilities(this.callbacks.elicit !== undefined, this.callbacks.terminals !== undefined),
          ...(this.provider.ssh === undefined
            ? {}
            : { fs: { readTextFile: false, writeTextFile: false }, terminal: false }),
        },
        clientInfo: { name: 'PaperAI', title: 'PaperAI', version: '0.1.0' },
      },
      { cancellationSignal: signal },
    )
    if (initialized.protocolVersion !== acp.PROTOCOL_VERSION) {
      throw new Error(`unsupported ACP protocol ${String(initialized.protocolVersion)}`)
    }
    const steering = initialized._meta?.['steering']
    this.initialized = initialized
    this.steeringSupported =
      typeof steering === 'object' && steering !== null && 'supported' in steering && steering.supported === true
    return initialized
  }

  private async reply<T>(method: string, request: unknown, operation: () => Promise<T> | T): Promise<T> {
    let response: T
    try {
      response = await operation()
    } catch (error: unknown) {
      this.callbacks.clientRequest?.(method, request, {
        error: redactAcpText(
          error instanceof Error ? error.message : String(error),
          environmentSecrets(this.provider.env),
        ),
      })
      throw error
    }
    this.callbacks.clientRequest?.(method, request, response)
    return response
  }

  private sessionUpdate(update: SessionUpdate): void {
    if (update.sessionUpdate === 'config_option_update') {
      this.updateConfiguration(update.configOptions)
      this.modelStateChanged()
    }
    if (update.sessionUpdate === 'current_mode_update' && this.modeState !== undefined) {
      this.modeState = { ...this.modeState, currentModeId: update.currentModeId }
      this.callbacks.modeChanged()
    }
    this.callbacks.update(update)
  }

  private ownsSession(id: string): boolean {
    return !this.closed && id === this.externalSessionId
  }

  private requireTerminals(): AcpTerminals {
    const terminals = this.callbacks.terminals
    if (terminals === undefined) throw new Error('ACP terminal capability is unavailable')
    return terminals
  }

  /**
   * Snapshot output for a provider-owned terminal reference before its release.
   * @param id - terminal id from this connection's tool content.
   * @returns bounded output retained by the terminal owner.
   */
  terminalOutput(id: string): string {
    return this.requireTerminals().displayOutput(id)
  }

  private assertSession(id: string): void {
    if (!this.ownsSession(id)) throw new Error('ACP callback does not belong to this active session')
  }

  /**
   * Send one prompt while projecting notifications through the registered callback.
   * @param prompt Content blocks to send to the active provider session.
   * @returns The provider response after already-read session updates reach the callback.
   */
  async prompt(prompt: readonly ContentBlock[]): Promise<PromptResponse> {
    const connection = this.requireConnection()
    const sessionId = this.requireSessionId()
    this.promptActive = true
    try {
      const response = await connection.agent.request(acp.methods.agent.session.prompt, {
        sessionId,
        prompt: [...prompt],
      })
      // The ACP SDK dispatches responses independently from preceding
      // notifications. Let already-read updates reach the projection before the
      // prompt completion closes it.
      await new Promise<void>((resolve) => {
        setImmediate(resolve)
      })
      if (response.stopReason !== 'cancelled') this.options.promptSucceeded?.()
      return response
    } finally {
      this.promptActive = false
    }
  }

  /**
   * Inject content into the provider's active prompt through the capability it
   * advertised during ACP initialization.
   * @param prompt - content to inject into the running provider turn.
   * @param signal - cancellation owned by the current DSH turn.
   * @returns whether the provider injected it or had already gone idle.
   */
  async steer(prompt: readonly ContentBlock[], signal: AbortSignal): Promise<AcpSteeringOutcome> {
    if (!this.canSteer) return 'prompt-required'
    const response = await this.requireConnection().agent.request<
      AcpSteeringResponse,
      {
        sessionId: string
        prompt: ContentBlock[]
        _meta: { steering: { idleBehavior: 'promptRequired' } }
      }
    >(
      SESSION_STEERING_METHOD,
      {
        sessionId: this.requireSessionId(),
        prompt: [...prompt],
        _meta: { steering: { idleBehavior: 'promptRequired' } },
      },
      { cancellationSignal: signal },
    )
    if (response.outcome === 'injected') return 'injected'
    if (response.outcome === 'promptRequired') return 'prompt-required'
    if (response.outcome === 'startedNewTurn') return 'started-new-turn'
    throw new Error(`${this.provider.name} ACP steering request failed`)
  }

  /** Notify the external Agent that its current prompt was cancelled. */
  cancel(): void {
    const connection = this.connection
    const sessionId = this.externalSessionId
    if (connection === undefined || sessionId === undefined || connection.signal.aborted) return
    void connection.agent.notify(acp.methods.agent.session.cancel, { sessionId }).catch(() => undefined)
  }

  /**
   * Switch the model selector advertised by this exact ACP session, then apply
   * the requested reasoning effort and switches through the provider's own
   * config options, as one transaction. Everything the current advertisement
   * can answer is validated before any provider call; the model is applied
   * first because providers re-advertise effort levels per model, and the
   * effort is validated again against that re-advertisement. Provider
   * config notifications that arrive during the transaction update the
   * runtime's own state only; observers hear one change when the transaction
   * ends. When the provider rejects a step, every step that already took
   * effect is put back in dependency order — switches, then the model, then
   * the effort on the restored model — with every restore attempted even
   * after one fails; the resulting {@link AcpSelectionError} reports whether
   * the session is back at its previous selection.
   * @param model An id from the session's advertised model list.
   * @param options Optional effort and switch values; omitted values stay as advertised.
   * @param allowUnlisted Whether an explicit custom model entry may be validated by the provider.
   * @returns The model id reported after the provider applies the selection.
   * @throws when the provider does not advertise the model, effort, or switch named.
   * @throws AcpSelectionError when the provider rejects a step.
   */
  async selectModel(model: string, options: AgentDriverSelectionOptions = {}, allowUnlisted = false): Promise<string> {
    const before = this.modelState
    if (
      before.configId === undefined ||
      model.trim() === '' ||
      (!allowUnlisted && !before.models.some(option => option.id === model))
    ) {
      throw new Error(`${this.provider.name} did not advertise model "${model}"`)
    }
    const modelChanges = model !== before.currentModel
    if (!modelChanges && options.reasoningEffort !== undefined) this.assertEffortAdvertised(options.reasoningEffort)
    const switches = Object.entries(options.switches ?? {})
    for (const [id] of switches) this.assertSwitchAdvertised(id)

    const previous = selectionOf(before)
    const applied: AppliedSteps = { switches: new Set() }
    this.selectionDepth += 1
    try {
      if (modelChanges) {
        await this.applyConfigOption(before.configId, model)
        applied.model = { configId: before.configId, previous: before.currentModel }
      }
      if (options.reasoningEffort !== undefined) {
        const effort = this.assertEffortAdvertised(options.reasoningEffort)
        if (options.reasoningEffort !== effort.current) {
          await this.applyConfigOption(effort.configId, options.reasoningEffort)
          applied.effort = { configId: effort.configId }
        }
      }
      for (const [id, enabled] of switches) {
        const current = this.assertSwitchAdvertised(id)
        if (current.enabled === enabled) continue
        await this.applyConfigOption(id, enabled)
        applied.switches.add(id)
      }
    } catch (error: unknown) {
      const restoreErrors = await this.restoreSelection(previous, applied)
      const restored = restoreErrors.length === 0 && sameSelection(this.selection, previous)
      this.selectionDepth -= 1
      // A restored session publishes its (unchanged) selection so observers
      // that saw the provider's notifications settle; an unrestored one stays
      // silent for the rebuild that re-reads the provider's real state.
      if (restored) this.publishSelection()
      throw new AcpSelectionError(this.provider.name, error, restored, restoreErrors)
    }
    this.selectionDepth -= 1
    this.publishSelection()
    return this.currentModel
  }

  /**
   * Drive the provider session back to the selection it applied before the
   * transaction — not merely undo the explicit steps, because a model switch
   * implicitly re-advertises the effort and may change switch availability.
   * Dependency order: explicit switch changes, then the model, then the
   * effort the previous model carried, then any switch the model switch
   * changed on its own. Every step is attempted; the failures come back for
   * the caller's verdict.
   */
  private async restoreSelection(target: AcpSelection, applied: AppliedSteps): Promise<unknown[]> {
    const errors: unknown[] = []
    const attempt = async (step: () => Promise<void>): Promise<void> => {
      try {
        await step()
      } catch (error: unknown) {
        errors.push(error)
      }
    }
    const restoreSwitch = async (id: string): Promise<void> => {
      const enabled = target.switches?.[id]
      const current = this.modelState.switches.find(entry => entry.configId === id)
      if (enabled === undefined || current === undefined || current.enabled === enabled) return
      await attempt(() => this.applyConfigOption(id, enabled))
    }
    for (const id of applied.switches.keys()) await restoreSwitch(id)
    if (applied.model !== undefined) {
      const { configId, previous } = applied.model
      if (previous === undefined)
        errors.push(new Error(`${this.provider.name} advertised no previous model to restore`))
      else await attempt(() => this.applyConfigOption(configId, previous))
    }
    const effort = this.modelState.effort
    if (target.reasoningEffort !== undefined && effort?.current !== target.reasoningEffort) {
      if (effort === undefined || !effort.efforts.some(level => level.id === target.reasoningEffort)) {
        errors.push(
          new Error(
            `${this.provider.name} no longer advertises reasoning effort "${target.reasoningEffort}" for the restored model`,
          ),
        )
      } else {
        await attempt(() => this.applyConfigOption(effort.configId, target.reasoningEffort as string))
      }
    }
    for (const id of Object.keys(target.switches ?? {})) await restoreSwitch(id)
    return errors
  }

  /** A provider config notification: observers hear it now, or once the running selection ends. */
  private modelStateChanged(): void {
    if (this.selectionDepth === 0) this.publishSelection()
  }

  private publishSelection(): void {
    this.callbacks.modelChanged(this.currentModel)
  }

  private assertEffortAdvertised(effortId: string): AcpEffortState {
    const effort = this.modelState.effort
    if (effort === undefined || !effort.efforts.some(level => level.id === effortId)) {
      throw new Error(`${this.provider.name} did not advertise reasoning effort "${effortId}"`)
    }
    return effort
  }

  private assertSwitchAdvertised(id: string): AcpSwitchState {
    const current = this.modelState.switches.find(entry => entry.configId === id)
    if (current === undefined) throw new Error(`${this.provider.name} did not advertise switch "${id}"`)
    return current
  }

  private async applyConfigOption(configId: string, value: string | boolean): Promise<void> {
    const response = await this.requireConnection().agent.request(acp.methods.agent.session.setConfigOption, {
      sessionId: this.requireSessionId(),
      configId,
      ...(typeof value === 'boolean' ? { type: 'boolean' as const, value } : { value }),
    })
    this.updateConfiguration(response.configOptions)
  }

  private updateConfiguration(options: readonly SessionConfigOption[] | null | undefined): void {
    this.optionsState = options ?? []
    this.modelState = modelStateFromConfigOptions(options)
  }

  /**
   * Apply one currently advertised general session option.
   * @param id - ACP config option id, excluding native permission controls.
   * @param value - advertised select value or boolean.
   * @returns after the provider has confirmed the complete resulting configuration.
   */
  async selectConfigOption(id: string, value: string | boolean): Promise<void> {
    const option = this.optionsState.find(entry => entry.id === id)
    if (option === undefined || isAcpPermissionOption(option))
      throw new Error(`ACP option ${id} is unavailable or belongs to the permission selector`)
    if (option.category === 'model' && typeof value === 'string') {
      await this.selectModel(value, {}, true)
      return
    }
    if (
      option.type === 'boolean'
        ? typeof value !== 'boolean'
        : typeof value !== 'string' ||
          !option.options
            .flatMap(entry => ('options' in entry ? entry.options : [entry]))
            .some(entry => entry.value === value)
    ) {
      throw new Error(`ACP option ${id} did not advertise the selected value`)
    }
    this.selectionDepth += 1
    try {
      await this.applyConfigOption(id, value)
    } catch (error: unknown) {
      const restoreErrors: unknown[] = []
      try {
        await this.applyConfigOption(id, option.currentValue)
      } catch (restoreError: unknown) {
        restoreErrors.push(restoreError)
      }
      const restored =
        restoreErrors.length === 0 &&
        this.optionsState.find(entry => entry.id === id)?.currentValue === option.currentValue
      if (restored) this.publishSelection()
      throw new AcpSelectionError(this.provider.name, error, restored, restoreErrors)
    } finally {
      this.selectionDepth -= 1
    }
    this.publishSelection()
  }

  /**
   * Apply the DSH sandbox preset through the provider's advertised native ACP mode.
   * @param sandboxMode Current DSH sandbox preset for this Session.
   * @param signal Optional cancellation for startup or publication synchronization.
   * @throws when the pinned provider does not advertise the required native mode.
   */
  async selectSandboxMode(sandboxMode: AcpSandboxMode, signal?: AbortSignal): Promise<void> {
    this.options.startupStage?.('permissions')
    const target = nativePermissionMode(this.provider, sandboxMode)
    if (target === undefined) {
      if (sandboxMode === 'danger-full-access') return
      throw new Error(
        `${this.provider.name} needs a verified native permission mode for ${sandboxMode}; configure its permissionModes before using it`,
      )
    }
    const state = this.modeState
    if (state === undefined || !state.availableModes.some(mode => mode.id === target)) {
      throw new Error(
        `${this.provider.name} ACP did not advertise required mode "${target}" for sandbox mode "${sandboxMode}"`,
      )
    }
    if (state.currentModeId === target) return
    const params = { sessionId: this.requireSessionId(), modeId: target }
    if (signal === undefined) {
      await this.requireConnection().agent.request(acp.methods.agent.session.setMode, params)
    } else {
      await raceAbort(
        this.requireConnection().agent.request(acp.methods.agent.session.setMode, params, {
          cancellationSignal: signal,
        }),
        signal,
      )
    }
    this.modeState = { ...state, currentModeId: target }
  }

  /** Release the provider conversation when supported; forced process teardown remains bounded. */
  closeSession(): Promise<void> {
    return (this.sessionClosing ??=
      this.externalSessionId === undefined ? Promise.resolve() : this.releaseSession(this.externalSessionId))
  }

  private async releaseSession(id: string): Promise<void> {
    const connection = this.connection
    if (connection === undefined || connection.signal.aborted || this.capabilities?.sessionCapabilities?.close == null)
      return
    const signal = AbortSignal.timeout(this.options.processGraceMs ?? 2_000)
    try {
      await raceAbort(
        connection.agent.request(acp.methods.agent.session.close, { sessionId: id }, { cancellationSignal: signal }),
        signal,
      )
    } catch {
      /* A rejected, disconnected, or timed-out session/close is followed by process-tree teardown. */
    }
  }

  /** Close the protocol and await the same complete process-tree teardown for every caller. */
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      await this.closeSession()
      this.closed = true
      const process = this.process
      this.connection?.close()
      process?.stdin?.end()
      process?.terminate()
      try {
        await this.callbacks.terminals?.close()
      } finally {
        if (process !== undefined) await process.waitForExit()
        this.connection = undefined
        this.process = undefined
        this.modeState = undefined
        this.promptActive = false
        this.steeringSupported = false
      }
    })())
  }

  private requireConnection(): ClientConnection {
    if (this.connection === undefined || this.connection.signal.aborted) {
      throw new Error(`${this.provider.name} ACP connection is not active`)
    }
    return this.connection
  }

  private requireSessionId(): string {
    if (this.externalSessionId === undefined) throw new Error(`${this.provider.name} ACP session is not active`)
    return this.externalSessionId
  }
}

export type { ContentBlock, McpServer, SessionConfigOption, SessionUpdate }
