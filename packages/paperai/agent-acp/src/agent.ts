import type {
  ContentBlock as AcpContentBlock,
  PlanEntry,
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
  type ContentBlock,
  type StreamChunk,
  type TokenUsage,
} from '@deepseek-ai/dsh-llm'
import { CallId } from '@deepseek-ai/dsh-llm/brand'
import type {} from '@deepseek-ai/dsh-fs'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import { effectiveSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { canonicalHeader, type Session, type SessionId, type TurnEndReason, type UserMessage } from '@deepseek-ai/dsh-session'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-user-approval'
import { AcpRuntime, type AcpProviderDefinition, type AcpRuntimeOptions } from './runtime.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Durable link from one DSH session lifecycle to its provider-owned ACP session. */
    'paperai/acp/session': {
      provider: 'codex' | 'claude'
      externalSessionId: string
      resumed: boolean
    }
  }
}

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
  readonly callId: CallId
  name: string
  title: string
  resultWritten: boolean
}

function errorText(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    const encoded: unknown = JSON.stringify(value)
    if (typeof encoded === 'string') return encoded
  } catch {
    if (value instanceof Error) return value.message
  }
  return typeof value === 'object' && value !== null
    ? Object.prototype.toString.call(value)
    : String(value)
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

function preferredOption(
  request: RequestPermissionRequest,
  kinds: readonly string[],
): RequestPermissionResponse {
  const selected = kinds.flatMap(kind => request.options.filter(option => option.kind === kind))[0]
  return selected === undefined
    ? { outcome: { outcome: 'cancelled' } }
    : { outcome: { outcome: 'selected', optionId: selected.optionId } }
}

function permissionResponse(
  request: RequestPermissionRequest,
  outcome: ApprovalOutcome,
): RequestPermissionResponse {
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
  private readonly text = new Map<'text' | 'reasoning', { index: number; value: string }>()
  private readonly tools = new Map<string, ToolProjection>()
  private nextIndex = 0

  constructor(
    private readonly session: Session,
    private readonly provider: AcpProviderDefinition,
    private readonly model: () => string,
    private readonly turn: number,
    private readonly step: number,
  ) {}

  update(update: SessionUpdate): void {
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        if (update.content.type === 'text') this.delta('text', update.content.text)
        return
      case 'agent_thought_chunk':
        if (update.content.type === 'text') this.delta('reasoning', update.content.text)
        return
      case 'tool_call':
      case 'tool_call_update':
        this.tool(update)
        return
      case 'plan':
        this.plan(update.entries)
        return
      case 'plan_update':
        if (update.plan.type === 'items') this.plan(update.plan.entries)
        return
      case 'plan_removed':
        this.session.append('todo/write', { todos: [] })
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

  finish(response: PromptResponse, interrupted: boolean): void {
    for (const [type, state] of this.text) {
      const block: ContentBlock = { type, text: state.value }
      this.push({ type: 'block-end', index: state.index, block })
    }
    const usage = this.usage(response)
    if (usage !== undefined) this.push({ type: 'usage', usage })
    this.push({
      type: 'finish',
      reason: interrupted || response.stopReason === 'cancelled'
        ? { kind: 'aborted', failure: { message: 'ACP prompt cancelled', code: 'ACP_CANCELLED' } }
        : response.stopReason === 'max_tokens'
          ? { kind: 'max-tokens' }
          : { kind: 'stop' },
    })
    const content = interrupted ? this.assembler.interruptedBlocks() : this.assembler.blocks()
    if (content.length === 0 && interrupted) return
    this.session.append('assistant/message', {
      turn: this.turn,
      step: this.step,
      message: createAssistantMessage({
        content,
        source: { provider: this.provider.id, model: this.model() },
      }),
      ...usage === undefined ? {} : { usage },
      ...interrupted ? { interrupted: true as const } : {},
    }, { surfaceOp: 'append', sourceEventSeqs: this.chunkSeqs })
  }

  private delta(type: 'text' | 'reasoning', value: string): void {
    if (value === '') return
    let state = this.text.get(type)
    if (state === undefined) {
      state = { index: this.nextIndex++, value: '' }
      this.text.set(type, state)
      this.push({ type: 'block-start', index: state.index, blockType: type })
    }
    state.value += value
    this.push(type === 'text'
      ? { type: 'text-delta', index: state.index, text: value }
      : { type: 'reasoning-delta', index: state.index, text: value })
  }

  private push(chunk: StreamChunk): void {
    this.chunkSeqs.push(this.session.append('assistant/chunk', {
      turn: this.turn,
      step: this.step,
      chunk,
    }).seq)
    this.assembler.push(chunk)
  }

  private tool(update: ToolCall | ToolCallUpdate): void {
    const id = update.toolCallId
    let projected = this.tools.get(id)
    if (projected === undefined) {
      const name = update.name?.trim() || update.kind || 'acp-tool'
      projected = {
        callId: CallId(id),
        name,
        title: update.title?.trim() || name,
        resultWritten: false,
      }
      this.tools.set(id, projected)
      this.session.append('tool/call', {
        turn: this.turn,
        step: this.step,
        callId: projected.callId,
        name: projected.name,
        arguments: argumentsText(update.rawInput),
      })
    } else {
      projected.name = update.name?.trim() || projected.name
      projected.title = update.title?.trim() || projected.title
    }
    if (projected.resultWritten || (update.status !== 'completed' && update.status !== 'failed')) return
    projected.resultWritten = true
    const isError = update.status === 'failed'
    const output = update.rawOutput ?? update.content ?? `${projected.title}: ${update.status}`
    this.session.append('tool/result', {
      turn: this.turn,
      step: this.step,
      message: createToolResultMessage({
        callId: projected.callId,
        content: [{ type: 'text', text: errorText(output) }],
        isError,
      }),
      ...isError ? { error: { name: 'AcpToolError', code: 'ACP_TOOL_FAILED' } } : {},
      meta: {
        source: 'acp',
        title: projected.title,
        provider: this.provider.id,
      },
    }, { surfaceOp: 'append' })
  }

  private plan(entries: readonly PlanEntry[]): void {
    const seen = new Set<string>()
    const todos = entries.flatMap((entry) => {
      const content = entry.content.trim()
      if (content === '' || seen.has(content)) return []
      seen.add(content)
      return [{ content, status: entry.status }]
    })
    this.session.append('todo/write', { todos })
  }

  private usage(response: PromptResponse): TokenUsage | undefined {
    const usage = response.usage
    if (usage === undefined || usage === null) return undefined
    return {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      ...usage.cachedReadTokens === undefined || usage.cachedReadTokens === null
        ? {}
        : { cacheReadTokens: usage.cachedReadTokens },
      ...usage.cachedWriteTokens === undefined || usage.cachedWriteTokens === null
        ? {}
        : { cacheWriteTokens: usage.cachedWriteTokens },
      ...usage.thoughtTokens === undefined || usage.thoughtTokens === null
        ? {}
        : { reasoningTokens: usage.thoughtTokens },
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
  private observedSandboxMode: SandboxMode
  private pendingSessionLink: {
    provider: 'codex' | 'claude'
    externalSessionId: string
    resumed: boolean
  } | undefined

  constructor(
    private readonly hostCtx: Context,
    readonly id: SessionId,
    readonly session: Session,
    readonly provider: AcpProviderDefinition,
    private readonly runtimeOptions: AcpRuntimeOptions = {},
    private readonly modelChanged: (model: string) => void = () => {},
  ) {
    this.options = { provider: provider.id }
    const dispatch = agentEvents(hostCtx, this)
    this.inbox = new Inbox(session, {
      inserted: (message) => { dispatch.emit('agent/inbox/inserted', { message }) },
      discarded: (message) => { dispatch.emit('agent/inbox/discarded', { message }) },
      claimed: (message, turn) => { dispatch.emit('agent/inbox/claimed', { message, turn }) },
    })
    const lastTurn = session.events.findLast(event => event.type === 'turn/start')?.data.turn ?? 0
    this.phase = { kind: 'idle', lastTurn }
    this.observedSandboxMode = this.currentSandboxMode()
    this.scope = createScope(hostCtx, this)
    this.ctx = this.scope.ctx.extend({ agent: this })
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
    this.modelController = {
      provider: { id: provider.id, name: provider.name },
      get currentModel() { return currentModel() },
      listModels: () => Promise.resolve([...this.requireRuntime().models.models]),
      selectModel: async (model: string) => await this.requireRuntime().selectModel(model),
      inputModalities: () => Promise.resolve(this.imageInput ? ['text', 'image'] : ['text']),
    }
  }

  get status(): AgentStatus {
    return this.phase.kind === 'running' ? 'running' : 'idle'
  }

  /**
   * Connect the provider-owned session before this Agent is published.
   * @param signal Cancels provider process startup and ACP initialization.
   */
  async start(signal: AbortSignal): Promise<void> {
    this.lifecycleSignal = signal
    const previousExternalSessionId = this.previousExternalSessionId()
    const runtime = this.createRuntime(signal)
    const started = await runtime.start(
      previousExternalSessionId,
      this.currentSandboxMode(),
      signal,
      this.providerSessionIsReplaceable(),
    )
    this.applyRuntimeStart(started)
    if (previousExternalSessionId !== started.externalSessionId || !started.resumed) {
      this.pendingSessionLink = {
        provider: this.provider.id,
        externalSessionId: started.externalSessionId,
        resumed: started.resumed,
      }
    }
  }

  /** Persist the provider session link only after the DSH Session is live. */
  commitSessionLink(): void {
    if (this.pendingSessionLink === undefined) return
    this.session.append('paperai/acp/session', this.pendingSessionLink)
    this.pendingSessionLink = undefined
  }

  /**
   * Serialize the Session's current sandbox preset into the active provider session.
   * @param signal Optional cancellation for startup or pre-prompt synchronization.
   */
  async syncSandboxMode(signal?: AbortSignal): Promise<void> {
    const runtime = this.requireRuntime()
    const generation = this.runtimeGeneration
    const lifecycleSignal = this.lifecycleSignal
    if (generation === undefined || lifecycleSignal === undefined) {
      throw new Error(`${this.provider.name} ACP lifecycle is unavailable`)
    }
    const mode = this.currentSandboxMode()
    const operationSignal = AbortSignal.any([
      lifecycleSignal,
      generation.signal,
      ...signal === undefined ? [] : [signal],
    ])
    // A failed synchronization invalidates the current runtime at its observer;
    // later requests must still reach a replacement runtime instead of inheriting
    // the rejected promise as a permanent queue head.
    const operation = this.modeSync.catch(() => undefined).then(async () => {
      if (this.runtime !== runtime || this.runtimeGeneration !== generation) return
      operationSignal.throwIfAborted()
      await runtime.selectSandboxMode(mode, operationSignal)
    })
    this.modeSync = operation
    await operation
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
    void task.finally(() => { this.steeringTasks.delete(task) })
  }

  inject(message: UserMessage): void {
    this.send(message, 'next-step', false)
  }

  cancel(cause: AgentCancelCause, options: CancelOptions = {}): void {
    if (!options.keepInbox) this.inbox.clear()
    if (this.phase.kind === 'idle') return
    this.runtimeGeneration?.abort(cause)
    this.runtimeNeedsRestart = true
    this.runtime?.cancel()
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

  /** Close the provider process and the Agent-owned scope. */
  async close(): Promise<void> {
    this.cancel({ kind: 'disposed' })
    await this.whenIdle()
    this.runtimeGeneration?.abort(new Error(`agent "${this.id}" lifecycle closed`))
    const pendingModeSync = this.modeSync
    await this.runtime?.close()
    await pendingModeSync.catch(() => undefined)
    await this.scope.dispose()
  }

  private wake(): void {
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
      while (this.inbox.hasPending
        && this.phase.kind === 'running'
        && !this.phase.abort.signal.aborted) await this.turn()
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
      const model = this.modelController.currentModel
      const previous = this.session.requestHeader()
      const header = canonicalHeader({ config: { provider: this.provider.id, model } })
      this.session.append('request/header', {
        header,
        reason: previous === undefined ? 'initial' : 'change',
      })
      this.session.append('request/context', { provider: this.provider.id, model })

      const projection = this.activeProjection = new AcpTurnProjection(
        this.session,
        this.provider,
        () => this.modelController.currentModel,
        turn,
        step,
      )
      let response: PromptResponse | undefined
      try {
        const runtime = await this.runtimeForTurn(signal)
        await this.syncSandboxMode(signal)
        response = await runtime.prompt(await this.promptBlocks(claimed, signal), signal)
      } finally {
        const interrupted = signal.aborted || response?.stopReason === 'cancelled'
        if (response !== undefined) projection.finish(response, interrupted)
        this.activeProjection = undefined
      }
      if (response.stopReason === 'max_tokens') reason = { kind: 'max-tokens' }
      if (signal.aborted || response.stopReason === 'cancelled') {
        reason = { kind: 'aborted', reason: this.cancelCause(signal.reason) }
      }
    } catch (error: unknown) {
      if (signal.aborted) {
        reason = { kind: 'aborted', reason: this.cancelCause(signal.reason) }
      } else {
        reason = {
          kind: 'error',
          error: { message: error instanceof Error ? error.message : String(error), code: 'ACP_ERROR' },
        }
        agentEvents(this.hostCtx, this).emit('agent/error', { turn, step, error })
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
        blocks.push({ type: 'text', text: errorText(block) })
      }
    }
    return blocks
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
      ...activitySignal === undefined ? [] : [activitySignal],
    ])
  }

  private createRuntime(lifecycleSignal: AbortSignal): AcpRuntime {
    const generation = new AbortController()
    this.runtimeGeneration = generation
    this.modeSync = Promise.resolve()
    const runtime = new AcpRuntime(
      this.hostCtx,
      this.provider,
      this.session.header.cwd ?? process.cwd(),
      {
        update: update => this.activeProjection?.update(update),
        modelChanged: (model) => { this.modelChanged(model) },
        modeChanged: () => { this.scheduleSandboxModeSync() },
        readTextFile: (path, requestSignal) => this.readTextFile(
          path,
          this.fileOperationSignal(lifecycleSignal, generation.signal, requestSignal),
        ),
        writeTextFile: (path, content, requestSignal) => this.writeTextFile(
          path,
          content,
          this.fileOperationSignal(lifecycleSignal, generation.signal, requestSignal),
        ),
        permission: (request, requestId) => this.permission(request, requestId),
      },
      this.runtimeOptions,
    )
    this.runtime = runtime
    return runtime
  }

  private async runtimeForTurn(signal: AbortSignal): Promise<AcpRuntime> {
    if (!this.runtimeNeedsRestart) return this.requireRuntime()
    const lifecycleSignal = this.lifecycleSignal
    if (lifecycleSignal === undefined) throw new Error(`${this.provider.name} ACP lifecycle is unavailable`)
    const previousExternalSessionId = this.previousExternalSessionId()
    const previousRuntime = this.runtime
    const pendingModeSync = this.modeSync
    await previousRuntime?.close()
    await pendingModeSync.catch(() => undefined)
    signal.throwIfAborted()
    const runtime = this.createRuntime(lifecycleSignal)
    try {
      const started = await runtime.start(
        previousExternalSessionId,
        this.currentSandboxMode(),
        AbortSignal.any([lifecycleSignal, signal]),
        this.providerSessionIsReplaceable(),
      )
      this.applyRuntimeStart(started)
      if (previousExternalSessionId !== started.externalSessionId || !started.resumed) {
        this.session.append('paperai/acp/session', {
          provider: this.provider.id,
          externalSessionId: started.externalSessionId,
          resumed: started.resumed,
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
    for (let index = this.session.events.length - 1; index >= 0; index -= 1) {
      const event = this.session.events[index]
      if (event?.type === 'paperai/acp/session' && event.data.provider === this.provider.id) {
        return event.data.externalSessionId
      }
    }
    return undefined
  }

  private providerSessionIsReplaceable(): boolean {
    return !this.session.events.some(event => (
      event.type === 'turn/start' || event.type === 'user/message'
    ))
  }

  private applyRuntimeStart(started: Awaited<ReturnType<AcpRuntime['start']>>): void {
    this.modelChanged(this.requireRuntime().currentModel)
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
      if (generation?.signal.aborted === true
        || lifecycleSignal?.aborted === true
        || runtime !== this.runtime
        || generation !== this.runtimeGeneration) return
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

  private async permission(
    request: RequestPermissionRequest,
    _requestId: string,
  ): Promise<RequestPermissionResponse> {
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
    const detail = request.toolCall.rawInput === undefined
      ? request.toolCall.title ?? undefined
      : `${request.toolCall.title ?? toolName}: ${argumentsText(request.toolCall.rawInput)}`
    const outcome = await approval.request({
      agent: this,
      toolName,
      callId: CallId(request.toolCall.toolCallId),
      ...detail === undefined ? {} : { reason: detail },
      ...this.phase.kind === 'running' ? { signal: this.phase.abort.signal } : {},
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
