import type {
  ContentBlock as AcpContentBlock,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionUpdate,
  ToolCall,
  ToolCallUpdate,
} from '@agentclientprotocol/sdk'
import type { Context } from '@deepseek-ai/cordis'
import {
  agentEvents,
  Inbox,
  type Agent,
  type AgentCancelCause,
  type AgentDriverSelectionOptions,
  type AgentDriverSwitch,
  type AgentModelController,
  type AgentOptions,
  type AgentStatus,
  type CancelOptions,
  type InboxTarget,
} from '@deepseek-ai/dsh-agent'
import {
  BlockAssembler,
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  ReasoningEffortId,
  type ContentBlock,
  type StreamChunk,
  type TokenUsage,
} from '@deepseek-ai/dsh-llm'
import { CallId } from '@deepseek-ai/dsh-llm/brand'
import type {} from '@deepseek-ai/dsh-fs'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import { effectiveSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-permission-presets'
import {
  canonicalHeader,
  Session,
  type SessionId,
  type TurnEndReason,
  type UserMessage,
} from '@deepseek-ai/dsh-session'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-user-questions'
import { elicitForm } from './elicitation.ts'
import { AcpTerminals } from './terminals.ts'
import { invokedSkillNames } from '@deepseek-ai/dsh-tool-skill'
import { isUserInvocable, renderSkillContent } from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-commands'
import { SessionTitleProviderId } from '@deepseek-ai/dsh-session-title'
import type { AcpSessionDetails, AcpSessionState } from './diagnostic-types.ts'
import { diagnosticCapabilities } from './diagnostics.ts'
import { isAcpPermissionOption } from './catalog.ts'
import { environmentSecrets, redactAcpText } from './redaction.ts'
import { ACP_TOOL, type AcpToolDisplay } from './tool-presentation.ts'
import { projectAcpContent } from './content.ts'
import { TextRetainer } from '@deepseek-ai/dsh-output-retention'
import {
  AcpRuntime,
  AcpSelectionError,
  providerHost,
  type AcpProviderDefinition,
  type AcpRuntimeOptions,
  type AcpSelection,
  type AcpSessionStart,
} from './runtime.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Durable link from one DSH session lifecycle to its provider-owned ACP session. */
    'paperai/acp/session': {
      provider: string
      externalSessionId: string
      resumed: boolean
      host?: string
    }
    /**
     * The driver selection applied to the provider session — model, reasoning
     * effort, and boolean switches such as fast mode — recorded whenever it
     * changes, so every later model call is reconstructable from this log
     * alone. Log-only: not a surface event.
     */
    'paperai/acp/config': {
      provider: string
      model: string
      reasoningEffort?: string
      switches?: Record<string, boolean>
      configOptions?: Record<string, string | boolean>
    }
    /** Exact extra text supplied to an ACP prompt after the durable user inputs. */
    'paperai/acp/context': { provider: string; content: string[] }
    /** Human input returned to an ACP request, retained for model-request reconstruction. */
    'paperai/acp/answer': { provider: string; request: string; response: string }
    /** Filesystem and terminal exchanges returned to the provider's model loop. */
    'paperai/acp/client-request': { provider: string; method: string; request: string; response: string }
    /** Provider-owned status retained independently of DSH's local history and compaction. */
    'paperai/acp/state': { provider: string; state: AcpSessionState }
  }
}

/** The `paperai/acp/config` payload: the provider plus the runtime's applied selection. */
type AcpLoggedSelection = { provider: string } & AcpSelection

type Phase =
  | { kind: 'idle'; lastTurn: number }
  | { kind: 'maintenance'; abort: AbortController; lastTurn: number; wakeRequested: boolean }
  | { kind: 'running'; abort: AbortController; turn: number; wakeRequested: boolean }

type SandboxMode = NonNullable<ReturnType<typeof effectiveSandboxMode>>

const SANDBOX_MODE_RANK = {
  'read-only': 0,
  'workspace-write': 1,
  'danger-full-access': 2,
} as const satisfies Record<SandboxMode, number>

function tightensSandboxMode(before: SandboxMode, after: SandboxMode): boolean {
  return SANDBOX_MODE_RANK[after] < SANDBOX_MODE_RANK[before]
}

interface ToolProjection {
  terminalId?: string
  readonly callId: CallId
  name: string
  title: string
  resultWritten: boolean
  progressPending: boolean
  display: AcpToolDisplay
  images: ContentBlock[]
}

function errorText(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    const encoded: unknown = JSON.stringify(value)
    if (typeof encoded === 'string') return encoded
  } catch {
    if (value instanceof Error) return value.message
  }
  return typeof value === 'object' && value !== null ? Object.prototype.toString.call(value) : String(value)
}

function argumentsText(value: unknown): string {
  if (value === undefined) return '{}'
  try {
    const encoded: unknown = JSON.stringify(value)
    return typeof encoded === 'string' ? encoded : '{}'
  } catch {
    return JSON.stringify({ value: errorText(value) })
  }
}

function preferredOption(request: RequestPermissionRequest, kinds: readonly string[]): RequestPermissionResponse {
  const selected = kinds.flatMap(kind => request.options.filter(option => option.kind === kind))[0]
  return selected === undefined
    ? { outcome: { outcome: 'cancelled' } }
    : { outcome: { outcome: 'selected', optionId: selected.optionId } }
}

function permissionResponse(request: RequestPermissionRequest, outcome: ApprovalOutcome): RequestPermissionResponse {
  if (outcome === 'allowed-once') {
    return preferredOption(request, ['allow_once', 'allow_always'])
  }
  if (outcome === 'cancelled') return { outcome: { outcome: 'cancelled' } }
  return preferredOption(request, ['reject_once', 'reject_always'])
}

/** Per-turn projection of ACP updates into the canonical DSH transcript. */
class AcpTurnProjection {
  private readonly assembler = new BlockAssembler()
  private readonly chunkSeqs: number[] = []
  private readonly text: { type: 'text' | 'reasoning'; messageId: string | null; index: number; value: string }[] = []
  private lastText: (typeof this.text)[number] | undefined
  private readonly tools = new Map<string, ToolProjection>()
  private nextIndex = 0
  private pending = Promise.resolve()
  private failure: Error | undefined
  private progressTimer: ReturnType<typeof setTimeout> | undefined
  private finishing = false

  constructor(
    private readonly session: Session,
    private readonly provider: AcpProviderDefinition,
    private readonly model: () => string,
    private readonly turn: number,
    private readonly step: number,
    private readonly outputBytes: number,
    private readonly terminalOutput: (id: string) => string,
    private readonly content: (content: AcpContentBlock) => Promise<ContentBlock[]>,
    private readonly progressIntervalMs?: number,
  ) {}

  update(update: SessionUpdate): void {
    this.enqueue(() => this.apply(update))
  }

  private enqueue(operation: () => void | Promise<void>): void {
    this.pending = this.pending
      .then(async () => {
        if (this.failure === undefined) await operation()
      })
      .catch((error: unknown) => {
        this.failure = error instanceof Error ? error : new Error('ACP content projection failed', { cause: error })
      })
  }

  private async apply(update: SessionUpdate): Promise<void> {
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
      case 'agent_thought_chunk':
        for (const block of await this.content(update.content)) {
          if (block.type === 'text')
            this.delta(
              update.sessionUpdate === 'agent_thought_chunk' ? 'reasoning' : 'text',
              block.text,
              update.messageId ?? null,
            )
          else {
            this.lastText = undefined
            const index = this.nextIndex++
            this.push({ type: 'block-start', index, blockType: block.type })
            this.push({ type: 'block-end', index, block })
          }
        }
        return
      case 'tool_call':
      case 'tool_call_update':
        this.lastText = undefined
        await this.tool(update)
        return
      case 'usage_update':
        if (Number.isFinite(update.size) && update.size > 0) {
          this.session.append('request/context', {
            provider: this.provider.id,
            model: this.model(),
            contextWindow: update.size,
          })
        }
        return
      default:
        return
    }
  }

  async finish(response: PromptResponse, interrupted: boolean): Promise<void> {
    this.finishing = true
    clearTimeout(this.progressTimer)
    await this.pending
    this.flushToolProgress()
    interrupted ||= this.failure !== undefined
    for (const state of this.text) {
      const block: ContentBlock = { type: state.type, text: state.value }
      this.push({ type: 'block-end', index: state.index, block })
    }
    const usage = this.usage(response)
    if (usage !== undefined) this.push({ type: 'usage', usage })
    this.push({
      type: 'finish',
      reason:
        interrupted || response.stopReason === 'cancelled'
          ? { kind: 'aborted', failure: { message: 'ACP prompt cancelled', code: 'ACP_CANCELLED' } }
          : response.stopReason === 'max_tokens'
            ? { kind: 'max-tokens' }
            : { kind: 'stop' },
    })
    const content = interrupted ? this.assembler.interruptedBlocks() : this.assembler.blocks()
    if (content.length === 0 && interrupted && this.failure === undefined) return
    this.session.append(
      'assistant/message',
      {
        turn: this.turn,
        step: this.step,
        message: createAssistantMessage({
          content,
          source: { provider: this.provider.id, model: this.model() },
        }),
        ...(usage === undefined ? {} : { usage }),
        ...(interrupted ? { interrupted: true as const } : {}),
      },
      { surfaceOp: 'append', sourceEventSeqs: this.chunkSeqs },
    )
    if (this.failure !== undefined) throw this.failure
  }

  private delta(type: 'text' | 'reasoning', value: string, messageId: string | null): void {
    if (value === '') return
    let state = this.lastText
    if (state === undefined || state.type !== type || state.messageId !== messageId) {
      state = { type, messageId, index: this.nextIndex++, value: '' }
      this.text.push(state)
      this.lastText = state
      this.push({ type: 'block-start', index: state.index, blockType: type })
    }
    state.value += value
    this.push(
      type === 'text'
        ? { type: 'text-delta', index: state.index, text: value }
        : { type: 'reasoning-delta', index: state.index, text: value },
    )
  }

  private push(chunk: StreamChunk): void {
    this.chunkSeqs.push(
      this.session.append('assistant/chunk', {
        turn: this.turn,
        step: this.step,
        chunk,
      }).seq,
    )
    this.assembler.push(chunk)
  }

  private async tool(update: ToolCall | ToolCallUpdate): Promise<void> {
    const id = update.toolCallId
    let projected = this.tools.get(id)
    const first = projected === undefined
    if (projected === undefined) {
      const name = update.name?.trim() || update.kind || 'acp-tool'
      projected = {
        callId: CallId(id),
        name,
        title: update.title?.trim() || name,
        resultWritten: false,
        progressPending: false,
        images: [],
        display: {
          name,
          title: update.title?.trim() || name,
          kind: update.kind ?? 'other',
          status: update.status ?? 'pending',
          input: update.rawInput ?? {},
          output: '',
          truncated: false,
          diffs: [],
          locations: [],
        },
      }
      this.tools.set(id, projected)
    } else {
      if (projected.resultWritten) return
      projected.name = update.name?.trim() || projected.name
      projected.title = update.title?.trim() || projected.title
    }
    const display = projected.display
    const previousStatus = display.status
    display.name = projected.name
    display.title = projected.title
    display.kind = update.kind ?? display.kind
    display.status = update.status ?? display.status
    if (update.rawInput !== undefined) display.input = update.rawInput
    if (update.locations != null)
      display.locations = update.locations.map(location => ({
        path: location.path,
        ...(location.line == null ? {} : { line: location.line }),
      }))
    // Codex owns these terminals and streams their output through metadata, without client terminal callbacks.
    const terminalInfo = update._meta?.terminal_info
    if (typeof terminalInfo === 'object' && terminalInfo !== null && 'terminal_id' in terminalInfo && terminalInfo.terminal_id === id)
      projected.terminalId = id
    if (update.content != null) {
      display.diffs = update.content.flatMap(content =>
        content.type === 'diff'
          ? [{ path: content.path, oldText: content.oldText ?? null, newText: content.newText }]
          : [],
      )
      const blocks: ContentBlock[] = []
      for (const content of update.content) {
        if (content.type === 'content') blocks.push(...(await this.content(content.content)))
        else if (content.type === 'terminal')
          blocks.push({ type: 'text', text: content.terminalId === projected.terminalId ? display.output : this.terminalOutput(content.terminalId) })
      }
      display.output = blocks.flatMap(block => (block.type === 'text' ? [block.text] : [])).join('\n')
      projected.images = blocks.filter(block => block.type === 'image')
    }
    const terminalDelta = update._meta?.terminal_output_delta
    if (typeof terminalDelta === 'object' && terminalDelta !== null
      && 'terminal_id' in terminalDelta && terminalDelta.terminal_id === id
      && 'data' in terminalDelta && typeof terminalDelta.data === 'string') display.output += terminalDelta.data
    if (update.rawOutput !== undefined)
      display.output = typeof update.rawOutput === 'string' ? update.rawOutput : errorText(update.rawOutput)
    const output = new TextRetainer({ maxBytes: this.outputBytes, kind: 'tail' })
    output.push(display.output)
    const retained = output.finish()
    display.output = retained.text
    display.truncated =
      retained.truncated || (update.rawOutput === undefined && update.content == null && display.truncated)
    projected.progressPending = true
    if (first || previousStatus !== display.status) this.writeToolProgress(projected, first)
    else if (!this.finishing && this.progressTimer === undefined && this.progressIntervalMs !== undefined) {
      this.progressTimer = setTimeout(() => {
        this.progressTimer = undefined
        this.enqueue(() => { this.flushToolProgress() })
      }, this.progressIntervalMs)
    }
    if (projected.resultWritten || (update.status !== 'completed' && update.status !== 'failed')) return
    projected.resultWritten = true
    const isError = update.status === 'failed'
    this.session.append(
      'tool/result',
      {
        turn: this.turn,
        step: this.step,
        message: createToolResultMessage({
          callId: projected.callId,
          content: [
            { type: 'text', text: display.output || `${projected.title}: ${update.status}` },
            ...projected.images,
          ],
          isError,
        }),
        ...(isError ? { error: { name: 'AcpToolError', code: 'ACP_TOOL_FAILED' } } : {}),
        meta: {
          source: 'acp',
          title: projected.title,
          provider: this.provider.id,
        },
      },
      { surfaceOp: 'append' },
    )
  }

  private flushToolProgress(): void {
    for (const tool of this.tools.values()) if (tool.progressPending) this.writeToolProgress(tool, false)
  }

  private writeToolProgress(tool: ToolProjection, first: boolean): void {
    this.session.append(first ? 'tool/call' : 'tool/progress', {
      turn: this.turn,
      step: this.step,
      callId: tool.callId,
      name: ACP_TOOL,
      arguments: argumentsText(tool.display),
    })
    tool.progressPending = false
  }

  private usage(response: PromptResponse): TokenUsage | undefined {
    const usage = response.usage
    if (usage === undefined || usage === null) return undefined
    return {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      ...(usage.cachedReadTokens === undefined || usage.cachedReadTokens === null
        ? {}
        : { cacheReadTokens: usage.cachedReadTokens }),
      ...(usage.cachedWriteTokens === undefined || usage.cachedWriteTokens === null
        ? {}
        : { cacheWriteTokens: usage.cachedWriteTokens }),
      ...(usage.thoughtTokens === undefined || usage.thoughtTokens === null
        ? {}
        : { reasoningTokens: usage.thoughtTokens }),
    }
  }
}

/** DSH Agent implementation whose model/tool loop lives in a local ACP process. */
export class AcpAgent implements Agent {
  readonly inbox: Inbox
  /** Agent-owned registration scope disposed when the ACP Agent closes. */
  readonly scope: Scope
  readonly ctx: Context
  readonly options: AgentOptions
  readonly modelController: AgentModelController
  private phase: Phase
  private activityDone: Promise<void> = Promise.resolve()
  private runtime: AcpRuntime | undefined
  private imageInput = false
  private activeProjection: AcpTurnProjection | undefined
  private readonly steeringTasks = new Set<Promise<void>>()
  private lifecycleSignal: AbortSignal | undefined
  private runtimeGeneration: AbortController | undefined
  private runtimeNeedsRestart = false
  private modeSync: Promise<void> = Promise.resolve()
  private modelOperationTail: Promise<void> = Promise.resolve()
  private modelOperationsPending = 0
  private modelOperationWakeRequested = false
  private closing = false
  private observedSandboxMode: SandboxMode
  // Permission maintenance spans running -> idle -> maintenance. Keep its
  // deferred wake outside Phase so no idle microtask can start the old mode.
  private permissionTransition: { wakeRequested: boolean } | undefined
  private pendingSessionLink:
    | {
      provider: string
      externalSessionId: string
      resumed: boolean
      host?: string
    }
    | undefined
  /** Selection observed before the DSH Session was live; flushed by {@link commitSessionLink}. */
  private pendingSelection: AcpLoggedSelection | undefined
  private sessionLive = false
  private nativeCommands: readonly import('@agentclientprotocol/sdk').AvailableCommand[] = []
  private readonly commandRegistrations: (() => void)[] = []
  private providerState: AcpSessionState

  constructor(
    private readonly hostCtx: Context,
    readonly id: SessionId,
    readonly session: Session,
    readonly provider: AcpProviderDefinition,
    private readonly runtimeOptions: AcpRuntimeOptions = {},
    private readonly modelChanged: (model: string) => void = () => {},
  ) {
    this.options = { provider: provider.id }
    this.providerState = session.events
      .filter(event => event.type === 'paperai/acp/state')
      .findLast(event => event.data.provider === provider.id)?.data.state ?? {
      commands: [],
      plans: [],
      compactions: [],
      title: null,
      updatedAt: null,
      usage: null,
      stopReason: null,
    }
    const dispatch = agentEvents(hostCtx, this)
    this.inbox = new Inbox(session, {
      inserted: (message) => {
        dispatch.emit('agent/inbox/inserted', { message })
      },
      discarded: (message) => {
        dispatch.emit('agent/inbox/discarded', { message })
      },
      claimed: (message, turn) => {
        dispatch.emit('agent/inbox/claimed', { message, turn })
      },
    })
    const lastTurn = session.events.findLast(event => event.type === 'turn/start')?.data.turn ?? 0
    this.phase = { kind: 'idle', lastTurn }
    this.observedSandboxMode = this.currentSandboxMode()
    this.scope = createScope(hostCtx, this)
    this.ctx = this.scope.ctx.extend({ agent: this })
    this.providerUpdate({
      sessionUpdate: 'available_commands_update',
      availableCommands: this.providerState.commands.map(command => ({
        name: command.name,
        description: command.description,
        ...(command.hint === null ? {} : { input: { hint: command.hint } }),
      })),
    })
    this.ctx.on('permission/preset-apply', ({ sandbox, signal }, next) =>
      this.transitionSandboxMode(sandbox, signal, next),
    )
    this.ctx.on('session/event', (subject, event) => {
      if (subject !== this.session || event.type !== 'sandbox/mode') return
      const previous = this.observedSandboxMode
      this.observedSandboxMode = event.data.mode
      if (this.phase.kind === 'running' && tightensSandboxMode(previous, event.data.mode)) {
        this.cancel({ kind: 'hook', reason: 'sandbox mode tightened during the active turn' }, { keepInbox: true })
        return
      }
      this.scheduleSandboxModeSync()
    })
    const currentModel = (): string => this.runtime?.currentModel ?? 'default'
    const currentReasoningEffort = (): string | undefined => this.runtime?.currentReasoningEffort
    const switches = (): readonly AgentDriverSwitch[] | undefined => {
      const advertised = this.runtime?.switches ?? []
      return advertised.length === 0
        ? undefined
        : advertised.map(entry => ({
          id: entry.configId,
          name: entry.name,
          ...(entry.description === undefined ? {} : { description: entry.description }),
          enabled: entry.enabled,
        }))
    }
    this.modelController = {
      provider: { id: provider.id, name: provider.name },
      get currentModel() {
        return currentModel()
      },
      get currentReasoningEffort() {
        return currentReasoningEffort()
      },
      get switches() {
        return switches()
      },
      listModels: async () => await this.withModelRuntime(runtime => [...runtime.models.models]),
      selectModel: async (model: string, options?: AgentDriverSelectionOptions) =>
        await this.withModelRuntime(async (runtime) => {
          try {
            return await runtime.selectModel(model, options)
          } catch (error: unknown) {
            // A provider session left part-way between two selections holds a
            // state no log describes: the next operation rebuilds the runtime,
            // which re-reads and records what the provider actually applies.
            if (error instanceof AcpSelectionError && !error.restored && this.runtime === runtime) {
              this.runtimeNeedsRestart = true
            }
            throw error
          }
        }),
      inputModalities: () => Promise.resolve(this.imageInput ? ['text', 'image'] : ['text']),
    }
  }

  get status(): AgentStatus {
    return this.phase.kind === 'running' ? 'running' : 'idle'
  }

  /** Provider identity of this independently owned conversation, when initialized. */
  get externalSessionId(): string | undefined {
    return this.runtime?.sessionId
  }

  /**
   * Read configuration from the active ACP runtime.
   * @returns provider capabilities and currently advertised options.
   */
  details(): AcpSessionDetails {
    const runtime = this.requireRuntime()
    return {
      provider: this.provider.id,
      name: this.provider.name,
      externalSessionId: runtime.sessionId ?? null,
      connected: this.connected,
      capabilities:
        diagnosticCapabilities({ protocolVersion: 1, agentCapabilities: runtime.capabilities ?? {} }).capabilities ??
        {},
      options: runtime.configuration.map(option => ({
        id: option.id,
        name: option.name,
        description: option.description ?? null,
        category: option.category ?? null,
        value: option.currentValue,
        editable: !isAcpPermissionOption(option),
        choices:
          option.type === 'boolean'
            ? []
            : [
              ...(option.options
                .flatMap(entry => ('options' in entry ? entry.options : [entry]))
                .some(entry => entry.value === option.currentValue)
                ? []
                : [{ value: option.currentValue, name: option.currentValue }]),
              ...option.options
                .flatMap(entry => ('options' in entry ? entry.options : [entry]))
                .map(entry => ({ value: entry.value, name: entry.name })),
            ],
      })),
      state: this.providerState,
    }
  }

  /** A currently open provider conversation; a cached handshake or retired process is not a connection. */
  get connected(): boolean {
    return !this.closing && this.runtime?.connected === true
  }

  /**
   * Serialize a provider option change with model selection and verify the standing sandbox mode.
   * @param id - advertised option id.
   * @param value - selected value.
   */
  async selectConfigOption(id: string, value: string | boolean): Promise<void> {
    await this.withModelRuntime(async (runtime) => {
      try {
        await runtime.selectConfigOption(id, value)
      } catch (error: unknown) {
        if (error instanceof AcpSelectionError && !error.restored) this.runtimeNeedsRestart = true
        throw error
      }
      await this.syncSandboxMode()
    })
  }

  /**
   * Import provider replay into an unused local conversation without changing another conversation's draft.
   * @param externalId - provider conversation selected for this new local session.
   * @param caller - user cancellation.
   */
  async importHistory(externalId: string, caller: AbortSignal): Promise<void> {
    await this.withModelRuntime(async (runtime) => {
      if (this.session.events.some(event => event.type === 'turn/start') || this.inbox.hasPending)
        throw new Error('只能向尚未开始对话的新会话导入历史')
      let importedTurns = 0
      await this.runMaintenance(async (signal) => {
        const originalLength = this.session.events.length
        const updates = await runtime.importHistory(
          externalId,
          this.currentSandboxMode(),
          AbortSignal.any([signal, caller]),
        )
        if (this.session.events.length !== originalLength) throw new Error('导入期间本地会话已改变，请重新导入')
        const replaySession = Session.create(this.id, this.session.events, this.session.header)
        const replayStart = replaySession.events.length
        const sequenceOffset = replayStart - originalLength
        let projection: AcpTurnProjection | undefined
        let users: AcpContentBlock[] = []
        let userId: string | null = null
        const finish = async (): Promise<void> => {
          if (projection === undefined) return
          await projection.finish({ stopReason: 'end_turn' }, false)
          replaySession.append('step/end', { turn: importedTurns, step: 1 })
          replaySession.append('turn/end', { turn: importedTurns, reason: { kind: 'completed' } })
          projection = undefined
        }
        const start = async (): Promise<AcpTurnProjection> => {
          if (projection !== undefined) return projection
          importedTurns += 1
          replaySession.append('turn/start', { turn: importedTurns })
          replaySession.append('step/start', { turn: importedTurns, step: 1 })
          if (users.length > 0) {
            const content: ContentBlock[] = []
            for (const block of users)
              content.push(...(await projectAcpContent(this.hostCtx, replaySession, this.provider.id, block)))
            replaySession.append('user/message', createUserMessage({ content, source: { kind: 'user' } }), {
              surfaceOp: 'append',
            })
            users = []
          }
          return (projection = new AcpTurnProjection(
            replaySession,
            this.provider,
            () => 'unknown',
            importedTurns,
            1,
            this.runtimeOptions.terminalLimits?.outputBytes ?? 65_536,
            id => runtime.terminalOutput(id),
            content => projectAcpContent(this.hostCtx, replaySession, this.provider.id, content),
          ))
        }
        for (const update of updates) {
          if (update.sessionUpdate === 'user_message_chunk') {
            if (users.length > 0 && (update.messageId ?? null) !== userId) await start()
            await finish()
            userId = update.messageId ?? null
            users.push(update.content)
            continue
          }
          if (
            ['agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update'].includes(
              update.sessionUpdate,
            )
          )
            (await start()).update(update)
        }
        if (users.length > 0) await start()
        await finish()
        signal.throwIfAborted()
        caller.throwIfAborted()
        if (this.session.events.length !== originalLength) throw new Error('导入期间本地会话已改变，请重新导入')
        for (const event of replaySession.events.slice(replayStart)) {
          if (event.type === 'user/message') this.session.append(event.type, event.data, { surfaceOp: 'append' })
          else if (event.type === 'assistant/message')
            this.session.append(event.type, event.data, {
              surfaceOp: 'append',
              ...(event.sourceEventSeqs === undefined
                ? {}
                : { sourceEventSeqs: event.sourceEventSeqs.map(seq => seq - sequenceOffset) }),
            })
          else if (event.type === 'tool/result') this.session.append(event.type, event.data, { surfaceOp: 'append' })
          else this.session.append(event.type, event.data)
        }
        for (const update of updates)
          if (
            ![
              'user_message_chunk',
              'agent_message_chunk',
              'agent_thought_chunk',
              'tool_call',
              'tool_call_update',
            ].includes(update.sessionUpdate)
          )
            this.providerUpdate(update)
        this.session.append('paperai/acp/session', {
          provider: this.provider.id,
          externalSessionId: externalId,
          resumed: true,
          host: providerHost(this.provider),
        })
        this.recordSelection()
      }).catch((error: unknown) => {
        this.runtimeNeedsRestart = true
        throw error
      })
      if (this.phase.kind === 'idle') this.phase.lastTurn = importedTurns
    })
  }

  /**
   * Connect the provider-owned session before this Agent is published.
   * @param signal Cancels provider process startup and ACP initialization.
   * @returns the initialized provider session and its advertised model metadata.
   */
  async start(signal: AbortSignal): Promise<AcpSessionStart> {
    this.lifecycleSignal = signal
    const previousExternalSessionId = this.previousExternalSessionId()
    const { runtime, lifetimeSignal } = this.createRuntime(signal)
    const started = await runtime.start(
      previousExternalSessionId,
      this.currentSandboxMode(),
      signal,
      this.providerSessionIsReplaceable(),
      lifetimeSignal,
    )
    this.applyRuntimeStart(started)
    if (previousExternalSessionId !== started.externalSessionId || !started.resumed) {
      this.pendingSessionLink = {
        provider: this.provider.id,
        externalSessionId: started.externalSessionId,
        resumed: started.resumed,
        host: providerHost(this.provider),
      }
    }
    return started
  }

  /**
   * Persist the provider session link and the applied driver selection only
   * after the DSH Session is live; later selection changes append directly.
   */
  commitSessionLink(): void {
    this.sessionLive = true
    if (this.pendingSessionLink !== undefined) {
      this.session.append('paperai/acp/session', this.pendingSessionLink)
      this.pendingSessionLink = undefined
    }
    if (this.pendingSelection !== undefined) {
      this.appendSelection(this.pendingSelection)
      this.pendingSelection = undefined
    }
    this.recordProviderState()
    if (this.providerState.title !== null)
      this.providerUpdate({ sessionUpdate: 'session_info_update', title: this.providerState.title })
  }

  /**
   * Record the selection the provider session now applies. Model-visible ⟺
   * logged: effort and switches change the provider's model calls, so the
   * DSH log carries them beside the model instead of relying on provider state.
   */
  private recordSelection(): void {
    const runtime = this.runtime
    if (runtime === undefined) return
    const selection: AcpLoggedSelection = { provider: this.provider.id, ...runtime.selection }
    if (!this.sessionLive) {
      this.pendingSelection = selection
      return
    }
    this.appendSelection(selection)
  }

  private appendSelection(selection: AcpLoggedSelection): void {
    const last = this.session.events.findLast(event => event.type === 'paperai/acp/config')?.data
    if (last !== undefined && JSON.stringify(last) === JSON.stringify(selection)) return
    this.session.append('paperai/acp/config', selection)
  }

  /**
   * Serialize the Session's current sandbox preset into the active provider session.
   * @param signal Optional cancellation for startup or pre-prompt synchronization.
   */
  async syncSandboxMode(signal?: AbortSignal): Promise<void> {
    await this.syncSandboxModeTo(this.currentSandboxMode(), signal)
  }

  private async syncSandboxModeTo(mode: SandboxMode, signal?: AbortSignal): Promise<void> {
    const runtime = this.requireRuntime()
    const generation = this.runtimeGeneration
    const lifecycleSignal = this.lifecycleSignal
    if (generation === undefined || lifecycleSignal === undefined) {
      throw new Error(`${this.provider.name} ACP lifecycle is unavailable`)
    }
    const operationSignal = AbortSignal.any([
      lifecycleSignal,
      generation.signal,
      ...(signal === undefined ? [] : [signal]),
    ])
    // A failed synchronization invalidates the current runtime at its observer;
    // later requests must still reach a replacement runtime instead of inheriting
    // the rejected promise as a permanent queue head.
    const operation = this.modeSync
      .catch(() => undefined)
      .then(async () => {
        if (this.runtime !== runtime || this.runtimeGeneration !== generation) return
        operationSignal.throwIfAborted()
        await runtime.selectSandboxMode(mode, operationSignal)
      })
    this.modeSync = operation
    await operation
  }

  private async transitionSandboxMode<T>(target: SandboxMode, signal: AbortSignal, next: () => Promise<T>): Promise<T> {
    if (this.permissionTransition !== undefined) {
      throw new Error(`${this.provider.name} ACP permission transition is already active`)
    }
    const reservation = { wakeRequested: false }
    this.permissionTransition = reservation
    try {
      signal.throwIfAborted()
      if (this.phase.kind === 'running') {
        this.cancel({ kind: 'hook', reason: 'permission preset changed during the active turn' }, { keepInbox: true })
        await this.whenIdle()
      }
      signal.throwIfAborted()
      return await this.runMaintenance(async (maintenanceSignal) => {
        const transitionSignal = AbortSignal.any([signal, maintenanceSignal])
        try {
          await this.runtimeForSandboxMode(target, transitionSignal)
          await this.syncSandboxModeTo(target, transitionSignal)
          transitionSignal.throwIfAborted()
          return await next()
        } catch (error: unknown) {
          this.runtimeGeneration?.abort(error)
          this.runtimeNeedsRestart = true
          this.runtime?.cancel()
          throw error
        }
      })
    } finally {
      if (this.permissionTransition === reservation) this.permissionTransition = undefined
      // Re-enter normal wake arbitration only after the provider and DSH
      // permission state have either committed together or both failed.
      if (reservation.wakeRequested && this.inbox.hasPending) this.wake()
    }
  }

  send(message: UserMessage, target: InboxTarget, wakeup: boolean): void {
    this.inbox.splice(target, Infinity, 0, [message])
    if (wakeup) this.wake()
  }

  followup(message: UserMessage): void {
    this.send(message, 'next-turn', true)
  }

  steer(message: UserMessage): void {
    const phase = this.phase
    const runtime = this.runtime
    this.send(message, 'next-step', true)
    if (phase.kind !== 'running' || runtime === undefined || !runtime.canSteer) return
    const task = this.forwardSteering(message, phase, runtime)
    this.steeringTasks.add(task)
    void task.finally(() => {
      this.steeringTasks.delete(task)
    })
  }

  inject(message: UserMessage): void {
    this.send(message, 'next-step', false)
  }

  cancel(cause: AgentCancelCause, options: CancelOptions = {}): void {
    if (!options.keepInbox) this.inbox.clear()
    if (this.phase.kind === 'idle') return
    this.runtimeNeedsRestart = true
    this.runtime?.cancel()
    this.runtimeGeneration?.abort(cause)
    this.phase.abort.abort(cause)
  }

  async whenIdle(): Promise<void> {
    while (true) {
      const activity = this.activityDone
      await activity
      const steering = [...this.steeringTasks]
      if (steering.length > 0) await Promise.allSettled(steering)
      if (activity === this.activityDone && this.steeringTasks.size === 0) return
    }
  }

  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.phase.kind !== 'idle') throw new Error(`agent "${this.id}" already has active work`)
    const done = Promise.withResolvers<void>()
    const phase: Phase = {
      kind: 'maintenance',
      abort: new AbortController(),
      lastTurn: this.phase.lastTurn,
      wakeRequested: false,
    }
    this.phase = phase
    this.activityDone = done.promise
    return (async () => {
      try {
        return await task(phase.abort.signal)
      } finally {
        this.phase = { kind: 'idle', lastTurn: phase.lastTurn }
        if (phase.wakeRequested && this.inbox.hasPending) this.wake()
        done.resolve()
      }
    })()
  }

  /** Stop accepting work and release the provider conversation before its process is retired. */
  async closeProviderSession(): Promise<void> {
    this.closing = true
    this.cancel({ kind: 'disposed' })
    await this.runtime?.closeSession()
  }

  /** Close the provider process and the Agent-owned scope. */
  async close(): Promise<void> {
    this.closing = true
    const pendingModelOperations = this.modelOperationTail
    this.cancel({ kind: 'disposed' })
    await this.whenIdle()
    await pendingModelOperations
    await this.whenIdle()
    this.runtimeGeneration?.abort(new Error(`agent "${this.id}" lifecycle closed`))
    const pendingModeSync = this.modeSync
    await this.runtime?.close()
    await pendingModeSync.catch(() => undefined)
    await this.scope.dispose()
  }

  private wake(): void {
    if (this.closing) return
    if (this.permissionTransition !== undefined) {
      this.permissionTransition.wakeRequested = true
      return
    }
    if (this.modelOperationsPending > 0) {
      this.modelOperationWakeRequested = true
      return
    }
    if (this.phase.kind !== 'idle') {
      this.phase.wakeRequested = true
      return
    }
    const done = Promise.withResolvers<void>()
    this.activityDone = done.promise
    const phase: Phase = {
      kind: 'running',
      abort: new AbortController(),
      turn: this.phase.lastTurn,
      wakeRequested: false,
    }
    this.setPhase(phase)
    this.hostCtx.agents.withInitiator(this, () => this.drive()).then(done.resolve, done.reject)
  }

  private async drive(): Promise<void> {
    try {
      while (this.inbox.hasPending && this.phase.kind === 'running' && !this.phase.abort.signal.aborted) {
        if (this.modelOperationsPending > 0) {
          this.modelOperationWakeRequested = true
          return
        }
        await this.turn()
      }
    } catch {
      // Turn-level failures are logged and emitted at their exact boundary.
    } finally {
      if (this.phase.kind === 'running') {
        const { turn, wakeRequested } = this.phase
        this.setPhase({ kind: 'idle', lastTurn: turn })
        if (wakeRequested && this.inbox.hasPending) this.wake()
      }
    }
  }

  private async turn(): Promise<void> {
    if (this.phase.kind !== 'running') return
    const phase = this.phase
    const turn = phase.turn + 1
    phase.turn = turn
    const step = 1
    const signal = phase.abort.signal
    let reason: TurnEndReason = { kind: 'completed' }
    let openedStep = false
    this.session.append('turn/start', { turn })
    try {
      const claimed = this.inbox.claim('next-turn', turn)
      if (claimed.length === 0) return
      this.session.append('step/start', { turn, step })
      openedStep = true
      for (const message of claimed) this.session.append('user/message', message, { surfaceOp: 'append' })
      const runtime = await this.runtimeForTurn(signal)
      await this.syncSandboxMode(signal)
      const selection = runtime.selection
      const model = selection.model
      const previous = this.session.requestHeader()
      const header = canonicalHeader({
        config: {
          provider: this.provider.id,
          model,
          ...(selection.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: ReasoningEffortId(selection.reasoningEffort) }),
        },
      })
      this.session.append('request/header', {
        header,
        reason: previous === undefined ? 'initial' : 'change',
      })
      this.session.append('request/context', { provider: this.provider.id, model })

      const projection = (this.activeProjection = new AcpTurnProjection(
        this.session,
        this.provider,
        () => this.modelController.currentModel,
        turn,
        step,
        this.runtimeOptions.terminalLimits?.outputBytes ?? 65_536,
        id => runtime.terminalOutput(id),
        content => projectAcpContent(this.hostCtx, this.session, this.provider.id, content),
        this.runtimeOptions.toolProgressIntervalMs,
      ))
      let response: PromptResponse | undefined
      try {
        const prompt = await this.promptBlocks(claimed, signal)
        signal.throwIfAborted()
        response = await runtime.prompt(prompt)
        this.providerState = { ...this.providerState, stopReason: response.stopReason }
        this.recordProviderState()
      } finally {
        const interrupted = signal.aborted || response?.stopReason === 'cancelled'
        this.activeProjection = undefined
        await projection.finish(response ?? { stopReason: 'cancelled' }, interrupted || response === undefined)
      }
      if (response.stopReason === 'max_tokens') reason = { kind: 'max-tokens' }
      if (signal.aborted || response.stopReason === 'cancelled') {
        reason = { kind: 'aborted', reason: this.cancelCause(signal.reason) }
      }
    } catch (error: unknown) {
      if (signal.aborted) {
        reason = { kind: 'aborted', reason: this.cancelCause(signal.reason) }
      } else {
        const message = redactAcpText(
          error instanceof Error ? error.message : String(error),
          environmentSecrets(this.provider.env),
        )
        reason = {
          kind: 'error',
          error: { message, code: 'ACP_ERROR' },
        }
        agentEvents(this.hostCtx, this).emit('agent/error', { turn, step, error: new Error(message) })
      }
    } finally {
      if (openedStep) this.session.append('step/end', { turn, step })
      this.session.append('turn/end', { turn, reason })
    }
  }

  private setPhase(next: Phase): void {
    const before = this.status
    this.phase = next
    if (before !== this.status) agentEvents(this.hostCtx, this).emit('agent/status', { status: this.status })
  }

  private async promptBlocks(messages: readonly UserMessage[], signal: AbortSignal): Promise<AcpContentBlock[]> {
    const blocks: AcpContentBlock[] = []
    const context: string[] = []
    const firstBlock = messages[0]?.content[0]
    const leadingToken = firstBlock?.type === 'text' ? firstBlock.text.split(/\s/u, 1)[0] : undefined
    const nativeCommand =
      messages.length === 1 && this.nativeCommands.some(command => leadingToken === `/${command.name}`)
    if (!nativeCommand) {
      if (this.provider.language?.trim()) context.push(`Preferred response language: ${this.provider.language}`)
      if (this.provider.personalPrompt?.trim()) context.push(this.provider.personalPrompt)
      const skills = this.ctx.get('skills')
      if (skills !== undefined) {
        for (const name of invokedSkillNames(messages)) {
          const skill = await skills.get(name, { cwd: this.session.header.cwd, signal, scope: this })
          signal.throwIfAborted()
          if (skill !== undefined && isUserInvocable(skill)) context.push(renderSkillContent(skill))
        }
      }
    }
    for (const message of messages) {
      for (const block of message.content) {
        if (block.type === 'text' || block.type === 'reasoning') {
          blocks.push({ type: 'text', text: block.text })
          continue
        }
        if (block.type === 'image') {
          if (!this.imageInput) throw new Error(`${this.provider.name} does not advertise ACP image input`)
          const attachments = this.hostCtx.get('attachments')
          if (attachments === undefined) throw new Error('image input is unavailable: no attachment store is mounted')
          const stored = await attachments.readImage(block.attachment, signal)
          blocks.push({
            type: 'image',
            data: Buffer.from(stored.data).toString('base64'),
            mimeType: stored.ref.mediaType,
          })
          continue
        }
        throw new Error(`${this.provider.name} cannot accept this input content type: ${block.type}`)
      }
    }
    if (context.length > 0) {
      this.session.append('paperai/acp/context', { provider: this.provider.id, content: context })
      blocks.push(...context.map(text => ({ type: 'text' as const, text })))
    }
    return blocks
  }

  private providerUpdate(update: SessionUpdate): void {
    if (update.sessionUpdate === 'available_commands_update') {
      this.nativeCommands = [...new Map(update.availableCommands.map(command => [command.name, command])).values()]
      this.providerState = {
        ...this.providerState,
        commands: this.nativeCommands.map(command => ({
          name: command.name,
          description: command.description,
          hint: command.input?.hint ?? null,
        })),
      }
      for (const dispose of this.commandRegistrations.splice(0)) dispose()
      const commands = this.ctx.get('commands')
      if (commands !== undefined)
        for (const command of this.nativeCommands) {
          this.commandRegistrations.push(
            commands.register({
              name: `acp-${/^[a-z][a-z0-9_-]*$/u.test(command.name) && !command.name.startsWith('encoded-') ? command.name : `encoded-${Buffer.from(command.name).toString('hex')}`}`,
              description: `${this.provider.name} · /${command.name} — ${command.description}`,
              ...(command.input == null
                ? {}
                : { input: { hint: command.input.hint.trim() || '参数', images: this.imageInput } }),
              handler: ({ rawInput, attachments, signal }) => {
                signal.throwIfAborted()
                this.send(
                  createUserMessage({
                    content: [{ type: 'text', text: `/${command.name}${rawInput}` }, ...attachments],
                    source: { kind: 'user' },
                  }),
                  'next-turn',
                  true,
                )
                return { kind: 'success' }
              },
            }),
          )
        }
    }
    if (update.sessionUpdate === 'session_info_update') {
      this.providerState = {
        ...this.providerState,
        ...(update.title === undefined ? {} : { title: update.title }),
        ...(update.updatedAt === undefined ? {} : { updatedAt: update.updatedAt }),
      }
      const title = update.title?.trim()
      const previous = this.session.events.findLast(event => event.type === 'session/title')?.data
      if (this.sessionLive && title && previous?.source.kind !== 'user' && previous?.title !== title) {
        this.session.append('session/title', {
          title,
          source: { kind: 'provider', provider: SessionTitleProviderId(`acp:${this.provider.id}`) },
          messageSeqs: [],
        })
      }
    }
    if (update.sessionUpdate === 'usage_update')
      this.providerState = {
        ...this.providerState,
        usage: {
          used: update.used,
          size: update.size,
          cost: update.cost == null ? null : { amount: update.cost.amount, currency: update.cost.currency },
        },
      }
    if (update.sessionUpdate === 'compaction_update') {
      const prior = this.providerState.compactions.find(entry => entry.id === update.compactionId)
      const entry = {
        id: update.compactionId,
        status: update.status,
        summary:
          update.summary == null
            ? (prior?.summary ?? '')
            : update.summary
              .map(content => (content.type === 'text' ? content.text : `[${content.type}]`))
              .join('\n'),
        error: update.error ?? null,
      }
      this.providerState = {
        ...this.providerState,
        compactions: [...this.providerState.compactions.filter(entry => entry.id !== update.compactionId), entry],
      }
    }
    if (update.sessionUpdate === 'compaction_summary_chunk') {
      this.providerState = {
        ...this.providerState,
        compactions: this.providerState.compactions.map(entry =>
          entry.id !== update.compactionId || entry.status !== 'in_progress'
            ? entry
            : {
              ...entry,
              summary:
                  entry.summary + (update.content.type === 'text' ? update.content.text : `[${update.content.type}]`),
            },
        ),
      }
    }
    if (
      update.sessionUpdate === 'plan' ||
      update.sessionUpdate === 'plan_update' ||
      update.sessionUpdate === 'plan_removed'
    ) {
      const id =
        update.sessionUpdate === 'plan'
          ? 'default'
          : update.sessionUpdate === 'plan_update'
            ? update.plan.planId
            : update.planId
      const remaining = this.providerState.plans.filter(plan => plan.id !== id)
      if (update.sessionUpdate !== 'plan_removed') {
        const plan = update.sessionUpdate === 'plan' ? { type: 'items' as const, entries: update.entries } : update.plan
        const seen = new Set<string>()
        const entries =
          plan.type === 'items'
            ? plan.entries.flatMap((entry) => {
              const content = entry.content.trim()
              if (content === '' || seen.has(content)) return []
              seen.add(content)
              return [{ content, status: entry.status }]
            })
            : []
        remaining.push({
          id,
          text: plan.type === 'markdown' ? plan.content : plan.type === 'file' ? plan.uri : '',
          entries,
        })
      }
      this.providerState = { ...this.providerState, plans: remaining }
      if (this.sessionLive)
        this.session.append('todo/write', {
          todos: remaining.flatMap(plan =>
            plan.entries.map(entry => ({
              ...entry,
              content: remaining.length > 1 ? `[${plan.id}] ${entry.content}` : entry.content,
            })),
          ),
        })
    }
    if (
      [
        'available_commands_update',
        'session_info_update',
        'usage_update',
        'compaction_update',
        'compaction_summary_chunk',
        'plan',
        'plan_update',
        'plan_removed',
      ].includes(update.sessionUpdate)
    ) {
      this.recordProviderState()
    }
    this.activeProjection?.update(update)
  }

  private recordProviderState(): void {
    if (this.sessionLive) {
      this.session.append('paperai/acp/state', { provider: this.provider.id, state: this.providerState })
      this.hostCtx.emit('paperai/acp-changed', this.id)
    }
  }

  private async readTextFile(path: string, signal: AbortSignal): Promise<string> {
    const target = await this.hostCtx.fs.resolve(path, {
      cwd: this.session.header.cwd ?? process.cwd(),
      signal,
    })
    return await this.hostCtx.fs.readText(target, signal)
  }

  private async writeTextFile(path: string, content: string, signal: AbortSignal): Promise<void> {
    const target = await this.hostCtx.fs.resolve(path, {
      cwd: this.session.header.cwd ?? process.cwd(),
      signal,
    })
    await this.hostCtx.fs.writeText(
      target,
      content,
      undefined,
      signal,
      this.hostCtx.sandboxPolicy.resolve({ session: this.session }),
    )
  }

  private fileOperationSignal(
    lifecycleSignal: AbortSignal,
    generationSignal: AbortSignal,
    requestSignal: AbortSignal,
  ): AbortSignal {
    const activitySignal = this.phase.kind === 'idle' ? undefined : this.phase.abort.signal
    return AbortSignal.any([
      lifecycleSignal,
      generationSignal,
      requestSignal,
      ...(activitySignal === undefined ? [] : [activitySignal]),
    ])
  }

  private createRuntime(lifecycleSignal: AbortSignal): {
    runtime: AcpRuntime
    lifetimeSignal: AbortSignal
  } {
    const userQuestions = this.hostCtx.get('userQuestions')
    const generation = new AbortController()
    this.runtimeGeneration = generation
    this.modeSync = Promise.resolve()
    const runtime = new AcpRuntime(
      this.hostCtx,
      this.provider,
      this.session.header.cwd ?? process.cwd(),
      {
        update: (update) => {
          this.providerUpdate(update)
        },
        modelChanged: (model) => {
          this.modelChanged(model)
          this.recordSelection()
          if (this.sessionLive) this.hostCtx.emit('paperai/acp-changed', this.id)
        },
        modeChanged: () => {
          this.scheduleSandboxModeSync()
        },
        connectionChanged: () => {
          if (this.sessionLive) this.hostCtx.emit('paperai/acp-changed', this.id)
        },
        clientRequest: (method, request, response) => {
          if (!this.sessionLive || lifecycleSignal.aborted || generation.signal.aborted)
            throw new Error('ACP request belongs to a closed session')
          this.session.append('paperai/acp/client-request', {
            provider: this.provider.id,
            method,
            request: JSON.stringify(request),
            response: JSON.stringify(response),
          })
        },
        readTextFile: (path, requestSignal) =>
          this.readTextFile(path, this.fileOperationSignal(lifecycleSignal, generation.signal, requestSignal)),
        writeTextFile: (path, content, requestSignal) =>
          this.writeTextFile(
            path,
            content,
            this.fileOperationSignal(lifecycleSignal, generation.signal, requestSignal),
          ),
        permission: (request, requestId) => this.permission(request, requestId),
        ...(this.runtimeOptions.terminalLimits === undefined || this.provider.ssh !== undefined
          ? {}
          : {
            terminals: new AcpTerminals(
              this.hostCtx,
              this.session.header.cwd ?? process.cwd(),
              () => this.hostCtx.sandboxPolicy.resolve({ session: this.session }),
              this.runtimeOptions.terminalLimits,
            ),
            operationSignal: (requestSignal: AbortSignal) =>
              this.fileOperationSignal(lifecycleSignal, generation.signal, requestSignal),
          }),
        ...(userQuestions === undefined
          ? {}
          : {
            elicit: async (request, requestSignal) => {
              const signal = this.fileOperationSignal(lifecycleSignal, generation.signal, requestSignal)
              const response = await elicitForm(
                request,
                questions => userQuestions.ask({ questions, agent: this, signal }),
                signal,
              )
              if (this.sessionLive && !lifecycleSignal.aborted && !generation.signal.aborted)
                this.session.append('paperai/acp/answer', {
                  provider: this.provider.id,
                  request: JSON.stringify(request),
                  response: JSON.stringify(response),
                })
              return response
            },
          }),
      },
      this.runtimeOptions,
    )
    this.runtime = runtime
    return {
      runtime,
      lifetimeSignal: lifecycleSignal,
    }
  }

  private withModelRuntime<T>(operation: (runtime: AcpRuntime) => Promise<T> | T): Promise<T> {
    if (this.closing) {
      return Promise.reject(new Error(`${this.provider.name} ACP Agent lifecycle is closed`))
    }
    this.modelOperationsPending += 1
    const result = this.modelOperationTail.then(async () => {
      if (!this.needsRuntimeRestart()) return await operation(this.requireRuntime())
      await this.whenIdle()
      if (!this.needsRuntimeRestart()) return await operation(this.requireRuntime())
      return await this.runMaintenance(async (signal) => {
        const runtime = await this.runtimeForSandboxMode(this.currentSandboxMode(), signal)
        await this.syncSandboxMode(signal)
        return await operation(runtime)
      })
    })
    this.modelOperationTail = result.then(
      () => {
        this.finishModelOperation()
      },
      () => {
        this.finishModelOperation()
      },
    )
    return result
  }

  private finishModelOperation(): void {
    this.modelOperationsPending -= 1
    if (this.modelOperationsPending !== 0) return
    const wakeRequested = this.modelOperationWakeRequested
    this.modelOperationWakeRequested = false
    if (wakeRequested && this.inbox.hasPending) this.wake()
  }

  private needsRuntimeRestart(): boolean {
    return this.runtimeNeedsRestart
  }

  private async runtimeForTurn(signal: AbortSignal): Promise<AcpRuntime> {
    return await this.runtimeForSandboxMode(this.currentSandboxMode(), signal)
  }

  private async runtimeForSandboxMode(mode: SandboxMode, signal: AbortSignal): Promise<AcpRuntime> {
    if (!this.runtimeNeedsRestart) return this.requireRuntime()
    const lifecycleSignal = this.lifecycleSignal
    if (lifecycleSignal === undefined) throw new Error(`${this.provider.name} ACP lifecycle is unavailable`)
    const previousExternalSessionId = this.previousExternalSessionId()
    const previousRuntime = this.runtime
    const pendingModeSync = this.modeSync
    await previousRuntime?.close()
    await pendingModeSync.catch(() => undefined)
    signal.throwIfAborted()
    const { runtime, lifetimeSignal } = this.createRuntime(lifecycleSignal)
    try {
      const started = await runtime.start(
        previousExternalSessionId,
        mode,
        AbortSignal.any([lifecycleSignal, signal]),
        this.providerSessionIsReplaceable(),
        lifetimeSignal,
      )
      this.applyRuntimeStart(started)
      if (previousExternalSessionId !== started.externalSessionId || !started.resumed) {
        this.session.append('paperai/acp/session', {
          provider: this.provider.id,
          externalSessionId: started.externalSessionId,
          resumed: started.resumed,
          host: providerHost(this.provider),
        })
      }
      this.runtimeNeedsRestart = false
      return runtime
    } catch (error: unknown) {
      this.runtimeGeneration?.abort(error)
      await runtime.close()
      this.runtime = undefined
      throw error
    }
  }

  private previousExternalSessionId(): string | undefined {
    const inherited = this.session.header.seedLength ?? 0
    for (let index = this.session.events.length - 1; index >= inherited; index -= 1) {
      const event = this.session.events[index]
      if (event?.type === 'paperai/acp/session' && event.data.provider === this.provider.id) {
        if ((event.data.host ?? 'local') !== providerHost(this.provider))
          throw new Error('此 ACP 历史属于另一个运行主机；请恢复原主机配置后继续')
        return event.data.externalSessionId
      }
    }
    if (this.session.header.parentSession !== undefined && !this.providerSessionIsReplaceable()) {
      throw new Error(
        `${this.provider.name} cannot fork at this history position; the parent ACP session must remain isolated`,
      )
    }
    return undefined
  }

  private providerSessionIsReplaceable(): boolean {
    return !this.session.events.some(event => event.type === 'turn/start' || event.type === 'user/message')
  }

  private applyRuntimeStart(started: Awaited<ReturnType<AcpRuntime['start']>>): void {
    this.modelChanged(this.requireRuntime().currentModel)
    this.recordSelection()
    this.imageInput = started.initialized.agentCapabilities?.promptCapabilities?.image === true
  }

  private currentSandboxMode(): SandboxMode {
    return this.hostCtx.sandboxPolicy.resolve({ session: this.session }).mode
  }

  private async observeSandboxModeChange(): Promise<void> {
    const runtime = this.runtime
    const generation = this.runtimeGeneration
    const lifecycleSignal = this.lifecycleSignal
    try {
      await this.syncSandboxMode()
    } catch (error: unknown) {
      if (
        generation?.signal.aborted === true ||
        lifecycleSignal?.aborted === true ||
        runtime !== this.runtime ||
        generation !== this.runtimeGeneration
      )
        return
      if (runtime !== undefined && this.runtime === runtime) {
        generation?.abort(error)
        this.runtimeNeedsRestart = true
        runtime.cancel()
      }
      throw error
    }
  }

  private scheduleSandboxModeSync(): void {
    void this.observeSandboxModeChange().catch((error: unknown) => {
      this.hostCtx.logger.warn(
        `${this.provider.name} ACP failed to restore the Session sandbox mode: ${errorText(error)}`,
      )
    })
  }

  private async forwardSteering(
    message: UserMessage,
    phase: Extract<Phase, { kind: 'running' }>,
    runtime: AcpRuntime,
  ): Promise<void> {
    try {
      const outcome = await runtime.steer(await this.promptBlocks([message], phase.abort.signal), phase.abort.signal)
      if (outcome === 'injected') {
        const claimed = this.inbox.claimMessage(message.id, phase.turn)
        if (claimed !== undefined) {
          this.session.append('user/message', claimed, { surfaceOp: 'append' })
        }
        return
      }
      // Codex ACP 1.x may win the idle race by starting a detached turn even
      // though PaperAI requested host-owned fallback. Stop that unprojected
      // turn; the still-pending inbox item will run through the normal prompt
      // lifecycle next.
      if (outcome === 'started-new-turn') runtime.cancel()
    } catch {
      // The durable next-step item remains pending. The ordinary driver claims
      // it after the active prompt settles, so steering transport failures do
      // not lose user input or invent a second transcript message.
    }
  }

  private async permission(request: RequestPermissionRequest, _requestId: string): Promise<RequestPermissionResponse> {
    const sandbox = effectiveSandboxMode(this.session.events)
    if (sandbox === 'danger-full-access') {
      return preferredOption(request, ['allow_always', 'allow_once'])
    }
    if (sandbox === 'read-only') {
      return preferredOption(request, ['reject_always', 'reject_once'])
    }
    const approval = this.hostCtx.get('approval')
    if (approval === undefined) return preferredOption(request, ['reject_once', 'reject_always'])
    const toolName = request.toolCall.name?.trim() || request.toolCall.kind || 'acp-tool'
    const detail =
      request.toolCall.rawInput === undefined
        ? (request.toolCall.title ?? undefined)
        : `${request.toolCall.title ?? toolName}: ${argumentsText(request.toolCall.rawInput)}`
    const outcome = await approval.request({
      agent: this,
      toolName,
      callId: CallId(request.toolCall.toolCallId),
      ...(detail === undefined ? {} : { reason: detail }),
      ...(this.phase.kind === 'running' ? { signal: this.phase.abort.signal } : {}),
    })
    return permissionResponse(request, outcome)
  }

  private cancelCause(value: unknown): AgentCancelCause {
    if (typeof value === 'object' && value !== null && 'kind' in value) return value as AgentCancelCause
    return { kind: 'user' }
  }

  private requireRuntime(): AcpRuntime {
    if (this.runtime === undefined) throw new Error(`${this.provider.name} ACP runtime is not connected`)
    return this.runtime
  }
}
