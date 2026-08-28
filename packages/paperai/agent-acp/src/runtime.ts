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
  SessionUpdate,
} from '@agentclientprotocol/sdk'
import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import { modelStateFromConfigOptions, type AcpModelState } from './catalog.ts'

const moduleRequire = createRequire(import.meta.url)
const SESSION_STEERING_METHOD = '_session/steering'

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

/** One managed ACP process and protocol connection. */
export class AcpRuntime {
  private process: SubprocessHandle | undefined
  private connection: ClientConnection | undefined
  private externalSessionId: string | undefined
  private modelState: AcpModelState = { models: [] }
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

  /** Whether the connected provider currently has a prompt that can accept steering. */
  get canSteer(): boolean {
    return this.steeringSupported && this.promptActive && !this.closed
  }

  /**
   * Spawn, initialize, and create or resume the provider-owned session.
   * @param previousExternalSessionId Provider session id to resume, or `undefined` to create a session.
   * @param signal Cancels process startup and ACP initialization requests.
   * @returns Initialization metadata and the model selector advertised by the active session.
   */
  async start(previousExternalSessionId: string | undefined, signal: AbortSignal): Promise<AcpSessionStart> {
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
      signal,
      env: {
        ...this.provider.env,
        ...this.provider.id === 'codex' ? { INITIAL_AGENT_MODE: 'agent' } : {},
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
            this.callbacks.modelChanged(this.currentModel)
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
        } finally {
          this.replaying = false
        }
        return {
          externalSessionId: previousExternalSessionId,
          resumed: true,
          initialized,
          models: this.modelState,
        }
      }

      const created = await connection.agent.request(acp.methods.agent.session.new, {
        cwd: this.cwd,
        mcpServers,
        _meta: { paperaiSession: true },
      }, { cancellationSignal: signal })
      this.externalSessionId = created.sessionId
      this.modelState = modelStateFromConfigOptions(created.configOptions)
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
   * @param signal Cancels the ACP prompt request.
   * @returns The provider response after already-read session updates reach the callback.
   */
  async prompt(prompt: readonly ContentBlock[], signal: AbortSignal): Promise<PromptResponse> {
    const connection = this.requireConnection()
    const sessionId = this.requireSessionId()
    this.promptActive = true
    try {
      const response = await connection.agent.request(acp.methods.agent.session.prompt, {
        sessionId,
        prompt: [...prompt],
      }, { cancellationSignal: signal })
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
   * Switch the model selector advertised by this exact ACP session.
   * @param model An id from the session's advertised model list.
   * @returns The model id reported after the provider applies the selection.
   */
  async selectModel(model: string): Promise<string> {
    const state = this.modelState
    if (state.configId === undefined || !state.models.some(option => option.id === model)) {
      throw new Error(`${this.provider.name} did not advertise model "${model}"`)
    }
    const response = await this.requireConnection().agent.request(acp.methods.agent.session.setConfigOption, {
      sessionId: this.requireSessionId(),
      configId: state.configId,
      value: model,
    })
    this.modelState = modelStateFromConfigOptions(response.configOptions)
    this.callbacks.modelChanged(this.currentModel)
    return this.currentModel
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
