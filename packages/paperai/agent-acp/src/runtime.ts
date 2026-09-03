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
import {
  modelStateFromConfigOptions, type AcpEffortState, type AcpModelState, type AcpSwitchState,
} from './catalog.ts'

/** The selection a provider session applies: model plus the advertised effort and switch values. */
export interface AcpSelection {
  readonly model: string
  readonly reasoningEffort?: string
  readonly switches?: Readonly<Record<string, boolean>>
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
    ...effort === undefined ? {} : { reasoningEffort: effort },
    ...state.switches.length === 0
      ? {}
      : { switches: Object.fromEntries(state.switches.map(entry => [entry.configId, entry.enabled])) },
  }
}

function sameSelection(left: AcpSelection, right: AcpSelection): boolean {
  const key = (selection: AcpSelection): string => JSON.stringify([
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
} as const satisfies Record<AcpProviderDefinition['id'], Record<AcpSandboxMode, string>>

function nativePermissionMode(provider: AcpProviderDefinition['id'], mode: AcpSandboxMode): string {
  return NATIVE_PERMISSION_MODES[provider][mode]
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
  readonly name: string
  readonly packageName: string
  readonly binName: string
  readonly command?: string
  readonly args?: readonly string[]
  readonly env?: Readonly<Record<string, string>>
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
}

/** Optional inputs forwarded when the provider-owned ACP session is created or resumed. */
export interface AcpRuntimeOptions {
  readonly mcpServers?: readonly McpServer[]
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
 * @returns The capability declaration sent during ACP initialization.
 */
export function paperAiClientCapabilities(): ClientCapabilities {
  return {
    fs: { readTextFile: true, writeTextFile: true },
    session: { configOptions: { boolean: {} } },
    plan: {},
  }
}

function resolveLaunch(definition: AcpProviderDefinition): readonly string[] {
  if (definition.command !== undefined) return [definition.command, ...(definition.args ?? [])]
  const packagePath = moduleRequire.resolve(`${definition.packageName}/package.json`)
  const manifest = moduleRequire(packagePath) as { bin?: string | Record<string, string> }
  const relative = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[definition.binName]
  if (relative === undefined) {
    throw new Error(`${definition.packageName} does not expose ${definition.binName}`)
  }
  return [process.execPath, join(dirname(packagePath), relative)]
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
  /** Depth of running `selectModel` transactions; provider notifications stay internal while positive. */
  private selectionDepth = 0
  private modeState: SessionModeState | undefined
  private replaying = false
  private steeringSupported = false
  private promptActive = false
  private closed = false

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
    return selectionOf(this.modelState)
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
    signal.throwIfAborted()
    const argv = resolveLaunch(this.provider)
    const process = this.process = this.ctx.subprocess.spawn({
      argv,
      cwd: this.cwd,
      stdio: {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: { maxBytes: 64 * 1024 },
      },
      graceMs: 2_000,
      signal: lifetimeSignal,
      env: {
        ...this.provider.env,
        ...this.provider.id === 'codex'
          ? { INITIAL_AGENT_MODE: nativePermissionMode(this.provider.id, sandboxMode) }
          : {},
      },
    })
    if (process.stdin === undefined || process.stdout === undefined) {
      process.terminate()
      throw new Error(`${this.provider.name} ACP process did not expose piped stdio`)
    }
    const stream = acp.ndJsonStream(
      Writable.toWeb(process.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(process.stdout) as ReadableStream<Uint8Array>,
    )
    const app = acp.client({ name: 'PaperAI' })
      .onRequest(acp.methods.client.session.requestPermission, context => (
        this.callbacks.permission(context.params, String(context.requestId))
      ))
      .onRequest(acp.methods.client.fs.readTextFile, async context => ({
        content: await this.callbacks.readTextFile(context.params.path, context.signal),
      }))
      .onRequest(acp.methods.client.fs.writeTextFile, async (context) => {
        await this.callbacks.writeTextFile(context.params.path, context.params.content, context.signal)
        return {}
      })
      .onNotification(acp.methods.client.session.update, (context) => {
        if (!this.replaying && context.params.sessionId === this.externalSessionId) {
          if (context.params.update.sessionUpdate === 'config_option_update') {
            this.modelState = modelStateFromConfigOptions(context.params.update.configOptions)
            this.modelStateChanged()
          }
          if (context.params.update.sessionUpdate === 'current_mode_update' && this.modeState !== undefined) {
            this.modeState = {
              ...this.modeState,
              currentModeId: context.params.update.currentModeId,
            }
            this.callbacks.modeChanged()
          }
          this.callbacks.update(context.params.update)
        }
      })
    const connection = this.connection = app.connect(stream)
    void process.done.then((outcome) => {
      if (this.closed) return
      const detail = stderrText(process)
      connection.close(new Error(
        `${this.provider.name} ACP exited (${String(outcome.exitCode ?? outcome.signal)})${detail === '' ? '' : `: ${detail}`}`,
      ))
    }, (error: unknown) => { connection.close(error) })

    try {
      const initialized = await connection.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: paperAiClientCapabilities(),
        clientInfo: { name: 'PaperAI', title: 'PaperAI', version: '0.1.0' },
      }, { cancellationSignal: signal })
      if (initialized.protocolVersion !== acp.PROTOCOL_VERSION) {
        throw new Error(`unsupported ACP protocol ${String(initialized.protocolVersion)}`)
      }
      const steering = initialized._meta?.['steering']
      this.steeringSupported = typeof steering === 'object'
        && steering !== null
        && 'supported' in steering
        && steering.supported === true
      const mcpServers = [...(this.options.mcpServers ?? [])]
      if (previousExternalSessionId !== undefined && initialized.agentCapabilities?.loadSession === true) {
        this.externalSessionId = previousExternalSessionId
        this.replaying = true
        try {
          const loaded = await connection.agent.request(acp.methods.agent.session.load, {
            sessionId: previousExternalSessionId,
            cwd: this.cwd,
            mcpServers,
          }, { cancellationSignal: signal })
          this.modelState = modelStateFromConfigOptions(loaded.configOptions)
          this.modeState = loaded.modes ?? undefined
        } catch (error: unknown) {
          signal.throwIfAborted()
          if (!replaceFailedLoad) throw error
          this.externalSessionId = undefined
          this.modelState = { models: [], switches: [] }
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

      const created = await connection.agent.request(acp.methods.agent.session.new, {
        cwd: this.cwd,
        mcpServers,
        _meta: { paperaiSession: true },
      }, { cancellationSignal: signal })
      this.externalSessionId = created.sessionId
      this.modelState = modelStateFromConfigOptions(created.configOptions)
      this.modeState = created.modes ?? undefined
      await this.selectSandboxMode(sandboxMode, signal)
      return {
        externalSessionId: created.sessionId,
        resumed: false,
        initialized,
        models: this.modelState,
      }
    } catch (error: unknown) {
      const detail = stderrText(process)
      await this.close()
      throw new Error(
        `${this.provider.name} ACP failed to start: ${error instanceof Error ? error.message : String(error)}${detail === '' ? '' : `: ${detail}`}`,
        { cause: error },
      )
    }
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
      await new Promise<void>((resolve) => { setImmediate(resolve) })
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
    >(SESSION_STEERING_METHOD, {
      sessionId: this.requireSessionId(),
      prompt: [...prompt],
      _meta: { steering: { idleBehavior: 'promptRequired' } },
    }, { cancellationSignal: signal })
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
   * @returns The model id reported after the provider applies the selection.
   * @throws when the provider does not advertise the model, effort, or switch named.
   * @throws AcpSelectionError when the provider rejects a step.
   */
  async selectModel(model: string, options: AgentDriverSelectionOptions = {}): Promise<string> {
    const before = this.modelState
    if (before.configId === undefined || !before.models.some(option => option.id === model)) {
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
      if (previous === undefined) errors.push(new Error(`${this.provider.name} advertised no previous model to restore`))
      else await attempt(() => this.applyConfigOption(configId, previous))
    }
    const effort = this.modelState.effort
    if (target.reasoningEffort !== undefined && effort?.current !== target.reasoningEffort) {
      if (effort === undefined || !effort.efforts.some(level => level.id === target.reasoningEffort)) {
        errors.push(new Error(
          `${this.provider.name} no longer advertises reasoning effort "${target.reasoningEffort}" for the restored model`,
        ))
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
      ...typeof value === 'boolean' ? { type: 'boolean' as const, value } : { value },
    })
    this.modelState = modelStateFromConfigOptions(response.configOptions)
  }

  /**
   * Apply the DSH sandbox preset through the provider's advertised native ACP mode.
   * @param sandboxMode Current DSH sandbox preset for this Session.
   * @param signal Optional cancellation for startup or publication synchronization.
   * @throws when the pinned provider does not advertise the required native mode.
   */
  async selectSandboxMode(sandboxMode: AcpSandboxMode, signal?: AbortSignal): Promise<void> {
    const target = nativePermissionMode(this.provider.id, sandboxMode)
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
      await raceAbort(this.requireConnection().agent.request(
        acp.methods.agent.session.setMode,
        params,
        { cancellationSignal: signal },
      ), signal)
    }
    this.modeState = { ...state, currentModeId: target }
  }

  /** Close the protocol and terminate the complete managed process tree. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const connection = this.connection
    const process = this.process
    connection?.close()
    process?.stdin?.end()
    process?.terminate()
    if (process !== undefined) await process.waitForExit()
    this.connection = undefined
    this.process = undefined
    this.modeState = undefined
    this.promptActive = false
    this.steeringSupported = false
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
