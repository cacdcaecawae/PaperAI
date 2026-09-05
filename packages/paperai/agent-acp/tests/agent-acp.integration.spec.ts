import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { Context, Service } from '@deepseek-ai/cordis'
import AgentRegistry, { type AgentHandle } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SandboxedFileSystem from '@deepseek-ai/dsh-fs-sandbox'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import PermissionPresetService from '@deepseek-ai/dsh-permission-presets'
import SandboxPolicyService, { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import SessionStore, {
  SessionId,
  type Session,
  type SessionEvent,
  type SessionHeader,
} from '@deepseek-ai/dsh-session'
import SessionPersistence, {
  SessionPersistenceRevision,
  type SessionInspection,
  type SessionPersistenceSnapshot,
} from '@deepseek-ai/dsh-session-persistence'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import {
  SettingsProvider,
  type SettingsNamespace,
} from '@deepseek-ai/dsh-settings'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import ApprovalService, { type ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type {
  PaperMcpAccessScope,
  PaperMcpAgentIdentity,
  PaperMcpDescriptorLease,
} from '@paperai/mcp'
import PaperAiAcpAgents, {
  ACP_AGENT_SETTINGS_NAMESPACE,
  type AcpProviderDefinition,
} from '../src/index.ts'
import { AcpSelectionError } from '../src/runtime.ts'

const fakeAgentPath = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url))
const lifecycleProbePath = fileURLToPath(new URL('./fixtures/lifecycle-probe.ts', import.meta.url))
const execFileAsync = promisify(execFile)

interface StoredSession {
  meta: SessionHeader
  events: SessionEvent[]
}

class TestPersistence extends SessionPersistence {
  static inject = ['sessions']
  override readonly supportsRawArtifacts = false

  constructor(ctx: Context, private readonly records: Map<string, StoredSession>) {
    super(ctx)
  }

  capture(session: Session): void {
    this.records.set(session.id, {
      meta: structuredClone(session.header),
      events: structuredClone([...session.events]),
    })
  }

  override locate(): undefined {
    return undefined
  }

  override create(meta: SessionHeader): Promise<void> {
    this.records.set(meta.id, { meta: structuredClone(meta), events: [] })
    return Promise.resolve()
  }

  override append(id: SessionId, events: readonly SessionEvent[]): Promise<void> {
    const record = this.requireRecord(id)
    record.events.push(...structuredClone(events))
    return Promise.resolve()
  }

  override load(id: SessionId): Promise<SessionInspection> {
    return Promise.resolve(structuredClone(this.requireRecord(id)))
  }

  override inspect(id: SessionId, signal?: AbortSignal): Promise<SessionInspection> {
    signal?.throwIfAborted()
    return this.load(id)
  }

  override readFrom(
    id: SessionId,
    fromSeq: number,
    signal?: AbortSignal,
  ): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
    signal?.throwIfAborted()
    const record = this.requireRecord(id)
    return Promise.resolve(structuredClone({
      meta: record.meta,
      events: record.events.filter(event => event.seq >= fromSeq),
    }))
  }

  override list(signal?: AbortSignal): Promise<SessionHeader[]> {
    signal?.throwIfAborted()
    return Promise.resolve([...this.records.values()].map(record => structuredClone(record.meta)))
  }

  override listSnapshots(signal?: AbortSignal): Promise<SessionPersistenceSnapshot[]> {
    signal?.throwIfAborted()
    return Promise.resolve([...this.records.values()].map(record => ({
      header: structuredClone(record.meta),
      revision: SessionPersistenceRevision(`test:${record.meta.id}:${record.events.length}`),
    })))
  }

  private requireRecord(id: SessionId): StoredSession {
    const record = this.records.get(id)
    if (record === undefined) throw new Error(`missing test session ${id}`)
    return record
  }
}

class TestSettings extends SettingsProvider {
  private readonly storedDocument: Record<string, unknown>

  constructor(ctx: Context, options: { readonly document: Record<string, unknown> }) {
    super(ctx)
    this.storedDocument = structuredClone(options.document)
  }

  override get writable(): boolean {
    return true
  }

  protected override load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.storedDocument))
  }

  protected override persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.storedDocument[ns] = structuredClone(section)
    return Promise.resolve()
  }
}

interface LogEntry {
  event: string
  label: string
  [key: string]: unknown
}

class TestPaperMcp extends Service {
  readonly leases: Array<{
    readonly descriptor: PaperMcpDescriptorLease['descriptor']
    readonly scope: PaperMcpAccessScope
    actor: PaperMcpAgentIdentity
    disposed: boolean
  }> = []

  constructor(ctx: Context) {
    super(ctx, 'paperMcp')
  }

  issueDescriptor(actor: PaperMcpAgentIdentity, scope: PaperMcpAccessScope): PaperMcpDescriptorLease {
    const state = {
      descriptor: {
        type: 'http' as const,
        name: 'paperai',
        url: 'http://127.0.0.1:3210/api/paperai/mcp',
        headers: [{ name: 'Authorization', value: 'Bearer fake-paperai-token' }],
      },
      scope,
      actor: structuredClone(actor),
      disposed: false,
    }
    this.leases.push(state)
    return {
      descriptor: state.descriptor,
      get actor() { return structuredClone(state.actor) },
      updateActor: (next) => {
        if (state.disposed) throw new Error('test MCP lease disposed')
        state.actor = structuredClone(next)
        return structuredClone(state.actor)
      },
      dispose: () => {
        state.disposed = true
        return Promise.resolve()
      },
    }
  }
}

interface Harness {
  readonly ctx: Context
  readonly root: string
  readonly fallbackRoot: string
  readonly logPath: string
  readonly promptReleasePath: string
  readonly acpFiber: Awaited<ReturnType<Context['plugin']>>
  readonly persistence: TestPersistence
  readonly mcp: TestPaperMcp
  readonly approvalRequests: () => number
}

const cleanup: Array<{ ctx: Context; root: string }> = []

afterEach(async () => {
  for (const resource of cleanup.splice(0).reverse()) {
    await resource.ctx.fiber.dispose()
    await rm(resource.root, { recursive: true, force: true })
  }
})

async function mountHarness(options: {
  readonly env?: Readonly<Record<string, string>>
  readonly neverSetMode?: { readonly mode: string; readonly once: boolean }
  readonly cancelFinalToolOnce?: boolean
  readonly promptBarrier?: boolean
  readonly mountApproval?: boolean
  readonly mountPermissionPresets?: boolean
  readonly approvalOutcome?: ApprovalOutcome
  readonly records?: Map<string, StoredSession>
  readonly settingsDocument?: Record<string, unknown>
  readonly writePath?: (workspaceRoot: string, fallbackRoot: string) => string
} = {}): Promise<Harness> {
  const scratchRoot = await mkdtemp(join(homedir(), 'paperai-agent-acp-'))
  const root = join(scratchRoot, 'workspace')
  const fallbackRoot = join(scratchRoot, 'fallback')
  await Promise.all([mkdir(root), mkdir(fallbackRoot)])
  const logPath = join(scratchRoot, 'fake-acp.jsonl')
  const promptReleasePath = join(scratchRoot, 'prompt-release')
  const ctx = new Context()
  cleanup.push({ ctx, root: scratchRoot })
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: fallbackRoot })
  await ctx.plugin(SandboxedFileSystem, { cwd: fallbackRoot })
  if (options.mountPermissionPresets === true) {
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(SessionProjectionRegistry)
    ctx.provide('shell', {
      sandboxMode: 'workspace-write',
      resolve() { throw new Error('ACP permission tests do not execute shell commands') },
      run() { throw new Error('ACP permission tests do not execute shell commands') },
      start() { throw new Error('ACP permission tests do not execute shell commands') },
    })
  }
  await ctx.plugin(TestPaperMcp)
  const records = options.records ?? new Map<string, StoredSession>()
  await ctx.plugin(TestPersistence, records)
  const persistence = ctx.sessionPersistence as TestPersistence
  let approvalRequests = 0
  if (options.mountApproval !== false) {
    await ctx.plugin(ApprovalService, { policy: 'ask' })
    ctx.on('approval/request', () => {
      approvalRequests += 1
      return Promise.resolve(options.approvalOutcome ?? 'allowed-once')
    })
  }
  if (options.mountPermissionPresets === true) {
    await ctx.plugin(PermissionPresetService, {
      presets: {
        'read-only': { sandbox: 'read-only', approval: 'ask' },
        'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
        'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
      },
      defaultPreset: 'workspace-write',
    })
  }
  if (options.settingsDocument !== undefined) {
    await ctx.plugin(TestSettings, { document: options.settingsDocument })
  }
  const commonEnv = {
    FAKE_ACP_LOG: logPath,
    FAKE_ACP_SESSION_ID: 'external-paper-session',
    ...options.neverSetMode === undefined
      ? {}
      : {
        FAKE_ACP_NEVER_SET_MODE: options.neverSetMode.mode,
        ...options.neverSetMode.once
          ? { FAKE_ACP_NEVER_SET_MODE_ONCE_FILE: join(scratchRoot, 'stalled-set-mode-once') }
          : {},
      },
    ...options.cancelFinalToolOnce === true
      ? { FAKE_ACP_CANCEL_FINAL_TOOL_ONCE_FILE: join(scratchRoot, 'cancel-final-tool-once') }
      : {},
    ...options.promptBarrier === true
      ? { FAKE_ACP_PROMPT_RELEASE_FILE: promptReleasePath }
      : {},
    ...options.writePath === undefined
      ? {}
      : { FAKE_ACP_WRITE_PATH: options.writePath(root, fallbackRoot) },
    ...options.env,
  }
  const acpFiber = await ctx.plugin(PaperAiAcpAgents, {
    codex: {
      command: process.execPath,
      args: [fakeAgentPath],
      env: { ...commonEnv, FAKE_ACP_LABEL: 'codex' },
    },
    claude: {
      command: process.execPath,
      args: [fakeAgentPath],
      env: { ...commonEnv, FAKE_ACP_LABEL: 'claude' },
    },
  })
  return {
    ctx,
    root,
    fallbackRoot,
    logPath,
    promptReleasePath,
    acpFiber,
    persistence,
    mcp: ctx.paperMcp as unknown as TestPaperMcp,
    approvalRequests: () => approvalRequests,
  }
}

async function createAgent(
  harness: Harness,
  id: string,
  route: 'codex' | 'claude' = 'codex',
  model?: string,
): Promise<AgentHandle> {
  return await harness.ctx.agents.create({
    sessionId: SessionId(id),
    factoryRoute: route,
    meta: { cwd: harness.root },
    ...model === undefined ? {} : { agentOptions: { model } },
  })
}

async function createAgentWithSandboxMode(
  harness: Harness,
  id: string,
  route: 'codex' | 'claude',
  mode: 'read-only' | 'workspace-write' | 'danger-full-access',
): Promise<AgentHandle> {
  return await harness.ctx.agents.create({
    sessionId: SessionId(id),
    factoryRoute: route,
    meta: { cwd: harness.root },
    setup: (agentCtx) => {
      const agent = agentCtx.agent
      if (agent === undefined) throw new Error('ACP Agent setup is missing its Agent scope')
      setSandboxMode(agent.session, mode)
    },
  })
}

async function runTurn(handle: AgentHandle, text: string): Promise<void> {
  handle.agent.followup(createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }))
  await handle.agent.whenIdle()
}

async function readLog(path: string): Promise<LogEntry[]> {
  try {
    const content = await readFile(path, 'utf8')
    return content.trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as LogEntry)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function expectResolvesWithin(promise: Promise<unknown>, timeoutMs = 1_000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      promise.then(() => 'resolved' as const),
      new Promise<'timed-out'>((resolve) => {
        timer = setTimeout(() => { resolve('timed-out') }, timeoutMs)
      }),
    ])
    expect(result).toBe('resolved')
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function runLifecycleProbe(action: 'dispose' | 'startup-rollback'): Promise<void> {
  await execFileAsync(process.execPath, [
    '--import',
    'tsx/esm',
    lifecycleProbePath,
    action,
  ], {
    cwd: process.cwd(),
    timeout: 5_000,
    windowsHide: true,
  })
}

describe('PaperAI ACP routed Agent lifecycle', { concurrent: false }, () => {
  it('creates through an exact route and selects only an advertised provider model', async () => {
    const harness = await mountHarness()
    expect(harness.ctx.agents.hasFactoryRoute('codex')).toBe(true)
    expect(harness.ctx.agents.hasFactoryRoute('claude')).toBe(true)

    const handle = await createAgent(harness, 'routed-create', 'codex', 'fake-beta')
    const controller = handle.agent.modelController
    expect(controller?.provider).toEqual({ id: 'codex', name: 'Codex' })
    expect(controller?.currentModel).toBe('fake-beta')
    await expect(controller?.listModels()).resolves.toMatchObject([
      {
        id: 'fake-alpha',
        name: 'Fake Alpha',
        description: 'Stable fake model',
        group: 'Fake models',
      },
      {
        id: 'fake-beta',
        name: 'Fake Beta',
        description: 'Alternate fake model',
        group: 'Fake models',
      },
    ])
    expect(harness.ctx.agents.get(SessionId('routed-create'))).toBe(handle.agent)
    expect(harness.ctx.sessions.get(SessionId('routed-create'))).toBe(handle.agent.session)
    expect(handle.agent.session.events.find(event => event.type === 'paperai/acp/session')?.data)
      .toEqual({ provider: 'codex', externalSessionId: 'external-paper-session', resumed: false })
    expect((await readLog(harness.logPath)).find(entry => entry.event === 'set-config-option'))
      .toMatchObject({ configId: 'model', value: 'fake-beta', label: 'codex' })
    const createdLog = (await readLog(harness.logPath)).find(entry => entry.event === 'new-session')
    expect(createdLog?.mcpServers).toEqual([expect.objectContaining({
      type: 'http',
      name: 'paperai',
      url: 'http://127.0.0.1:3210/api/paperai/mcp',
    })])
    expect(harness.mcp.leases).toHaveLength(1)
    expect(harness.mcp.leases[0]?.actor).toMatchObject({
      client: 'codex',
      provider: 'codex',
      model: 'fake-beta',
      sessionId: 'routed-create',
    })
    await controller?.selectModel('fake-alpha')
    expect(harness.mcp.leases[0]?.actor.model).toBe('fake-alpha')

  }, 20_000)

  it('applies reasoning effort and fast mode through the provider config options', async () => {
    const harness = await mountHarness()
    const handle = await createAgent(harness, 'routed-effort', 'codex', 'fake-beta')
    const controller = handle.agent.modelController
    if (controller === undefined) throw new Error('expected an ACP model controller')
    expect(controller.currentReasoningEffort).toBe('medium')
    expect(controller.switches).toEqual([{
      id: 'fast', name: 'Fast mode', description: '1.5x speed, increased usage', enabled: false,
    }])
    const reasoning = {
      efforts: [
        { id: 'low', name: 'Low' },
        { id: 'medium', name: 'Medium' },
        { id: 'high', name: 'High', description: 'Deeper reasoning' },
      ],
      defaultEffort: 'medium',
    }
    expect((await controller.listModels()).map(model => model.reasoning)).toEqual([reasoning, reasoning])

    const before = (await readLog(harness.logPath)).filter(entry => entry.event === 'set-config-option').length
    await expect(controller.selectModel('fake-beta', { reasoningEffort: 'high', switches: { fast: true } }))
      .resolves.toBe('fake-beta')
    expect(controller.currentReasoningEffort).toBe('high')
    expect(controller.switches?.[0]?.enabled).toBe(true)
    // The unchanged model is not re-sent; effort and switch each travel once.
    const applied = (await readLog(harness.logPath))
      .filter(entry => entry.event === 'set-config-option')
      .slice(before)
    expect(applied.map(entry => [entry['configId'], entry['value']])).toEqual([['effort', 'high'], ['fast', true]])

    await expect(controller.selectModel('fake-beta', { reasoningEffort: 'extreme' }))
      .rejects.toThrow('did not advertise reasoning effort "extreme"')
    await expect(controller.selectModel('fake-beta', { switches: { turbo: true } }))
      .rejects.toThrow('did not advertise switch "turbo"')
    // Re-applying the current values sends nothing to the provider.
    await controller.selectModel('fake-beta', { reasoningEffort: 'high', switches: { fast: true } })
    expect((await readLog(harness.logPath)).filter(entry => entry.event === 'set-config-option'))
      .toHaveLength(before + 2)

    // Model-visible ⟺ logged: the applied selection is a durable session fact,
    // recorded once per change, and the next request header carries the effort.
    const configEvents = handle.agent.session.events
      .filter(event => event.type === 'paperai/acp/config')
      .map(event => event.data)
    expect(configEvents).toEqual([
      { provider: 'codex', model: 'fake-beta', reasoningEffort: 'medium', switches: { fast: false } },
      { provider: 'codex', model: 'fake-beta', reasoningEffort: 'high', switches: { fast: true } },
    ])
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: '记录推理强度' }],
      source: { kind: 'user' },
    }))
    await handle.agent.whenIdle()
    expect(handle.agent.session.requestHeader()?.config).toMatchObject({
      provider: 'codex', model: 'fake-beta', reasoningEffort: 'high',
    })
    await handle.dispose()
  }, 20_000)

  it('restores earlier selection steps when a later provider step is rejected', async () => {
    const harness = await mountHarness({
      env: { FAKE_ACP_REJECT_SET_CONFIG_VALUE: 'true', FAKE_ACP_NOTIFY_CONFIG_UPDATES: '1' },
    })
    const handle = await createAgent(harness, 'routed-atomic', 'codex', 'fake-beta')
    const controller = handle.agent.modelController
    if (controller === undefined) throw new Error('expected an ACP model controller')
    const before = (await readLog(harness.logPath)).filter(entry => entry.event === 'set-config-option').length

    // The effort applies first; the fast switch (boolean true) is rejected, so
    // the effort is put back and the caller sees one restored failure.
    const failure = await controller.selectModel('fake-beta', { reasoningEffort: 'high', switches: { fast: true } })
      .then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(AcpSelectionError)
    expect(failure).toMatchObject({ restored: true, restoreErrors: [] })
    expect(controller.currentReasoningEffort).toBe('medium')
    expect(controller.switches?.[0]?.enabled).toBe(false)
    const applied = (await readLog(harness.logPath))
      .filter(entry => entry.event === 'set-config-option')
      .slice(before)
      .map(entry => [entry['configId'], entry['value']])
    expect(applied).toEqual([['effort', 'high'], ['fast', true], ['effort', 'medium']])
    // The provider announced every step; none of the intermediate states
    // reached the session log, and the runtime stays in service.
    const configEvents = handle.agent.session.events
      .filter(event => event.type === 'paperai/acp/config')
      .map(event => event.data)
    expect(configEvents).toEqual([
      { provider: 'codex', model: 'fake-beta', reasoningEffort: 'medium', switches: { fast: false } },
    ])
    await controller.listModels()
    expect((await readLog(harness.logPath)).filter(entry => entry.event === 'initialize')).toHaveLength(1)
    await handle.dispose()
  }, 20_000)

  it('restores the effort the previous model carried, not the one the switched model re-advertised', async () => {
    const harness = await mountHarness({
      env: {
        FAKE_ACP_REJECT_SET_CONFIG_VALUE: 'true',
        FAKE_ACP_MODEL_RESETS_EFFORT: '1',
        FAKE_ACP_NOTIFY_CONFIG_UPDATES: '1',
      },
    })
    const handle = await createAgent(harness, 'routed-effort-restore', 'codex', 'fake-beta')
    const controller = handle.agent.modelController
    if (controller === undefined) throw new Error('expected an ACP model controller')
    await controller.selectModel('fake-beta', { reasoningEffort: 'high' })
    const before = (await readLog(harness.logPath)).filter(entry => entry.event === 'set-config-option').length

    // Switching to fake-alpha re-advertises the effort at "medium"; the fast
    // switch is rejected; the restore must bring back beta AND its "high".
    const failure = await controller.selectModel('fake-alpha', { switches: { fast: true } })
      .then(() => undefined, (error: unknown) => error)
    expect(failure).toMatchObject({ name: 'AcpSelectionError', restored: true, restoreErrors: [] })
    expect(controller.currentModel).toBe('fake-beta')
    expect(controller.currentReasoningEffort).toBe('high')
    const applied = (await readLog(harness.logPath))
      .filter(entry => entry.event === 'set-config-option')
      .slice(before)
      .map(entry => [entry['configId'], entry['value']])
    expect(applied).toEqual([['model', 'fake-alpha'], ['fast', true], ['model', 'fake-beta'], ['effort', 'high']])
    const configEvents = handle.agent.session.events
      .filter(event => event.type === 'paperai/acp/config')
      .map(event => event.data)
    expect(configEvents).toEqual([
      { provider: 'codex', model: 'fake-beta', reasoningEffort: 'medium', switches: { fast: false } },
      { provider: 'codex', model: 'fake-beta', reasoningEffort: 'high', switches: { fast: false } },
    ])
    await handle.dispose()
  }, 20_000)

  it('restores in dependency order and rebuilds the runtime when a restore step is rejected too', async () => {
    const harness = await mountHarness({
      env: { FAKE_ACP_REJECT_SET_CONFIG_VALUE: 'true,medium', FAKE_ACP_NOTIFY_CONFIG_UPDATES: '1' },
    })
    const handle = await createAgent(harness, 'routed-unrestored', 'codex', 'fake-beta')
    const controller = handle.agent.modelController
    if (controller === undefined) throw new Error('expected an ACP model controller')
    const before = (await readLog(harness.logPath)).filter(entry => entry.event === 'set-config-option').length

    // Model and effort apply, the switch is rejected; the model goes back
    // before the effort (the provider validates efforts per model), and the
    // effort restore is rejected as well, so the session is left mid-way.
    const failure = await controller
      .selectModel('fake-alpha', { reasoningEffort: 'high', switches: { fast: true } })
      .then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(AcpSelectionError)
    expect(failure).toMatchObject({ restored: false })
    expect((failure as AcpSelectionError).restoreErrors).toHaveLength(1)
    const applied = (await readLog(harness.logPath))
      .filter(entry => entry.event === 'set-config-option')
      .slice(before)
      .map(entry => [entry['configId'], entry['value']])
    expect(applied).toEqual([
      ['model', 'fake-alpha'], ['effort', 'high'], ['fast', true], ['model', 'fake-beta'], ['effort', 'medium'],
    ])
    const loggedBefore = handle.agent.session.events.filter(event => event.type === 'paperai/acp/config')
    expect(loggedBefore).toHaveLength(1)

    // The next operation rebuilds the provider runtime and records the
    // selection the provider actually applies, so the log matches reality again.
    await controller.listModels()
    expect((await readLog(harness.logPath)).filter(entry => entry.event === 'initialize')).toHaveLength(2)
    const logged = handle.agent.session.events
      .filter(event => event.type === 'paperai/acp/config')
      .map(event => event.data)
    expect(logged.at(-1)).toEqual({
      provider: 'codex',
      model: controller.currentModel,
      reasoningEffort: controller.currentReasoningEffort,
      switches: Object.fromEntries((controller.switches ?? []).map(entry => [entry.id, entry.enabled])),
    })
    await handle.dispose()
  }, 20_000)

  it('revokes the PaperAI MCP descriptor with the Agent lifecycle', async () => {
    const harness = await mountHarness()
    const handle = await createAgent(harness, 'mcp-lease-disposal')
    expect(harness.mcp.leases[0]?.disposed).toBe(false)
    await handle.dispose()
    expect(harness.mcp.leases[0]?.disposed).toBe(true)
  }, 20_000)

  it('cancels pending setup without publishing the Agent or retaining its MCP lease', async () => {
    const harness = await mountHarness()
    const setupStarted = Promise.withResolvers<undefined>()
    const setupRelease = Promise.withResolvers<undefined>()
    const abort = new AbortController()
    const reason = new Error('caller cancelled ACP creation')
    const id = SessionId('cancelled-setup')
    const creation = harness.ctx.agents.create({
      sessionId: id,
      factoryRoute: 'codex',
      meta: { cwd: harness.root },
      signal: abort.signal,
      setup: () => {
        setupStarted.resolve(undefined)
        return setupRelease.promise
      },
    })
    const rejected = expect(creation).rejects.toBe(reason)
    try {
      await setupStarted.promise
      abort.abort(reason)
      await rejected
      expect(harness.ctx.agents.get(id)).toBeUndefined()
      expect(harness.ctx.sessions.get(id)).toBeUndefined()
      expect(harness.mcp.leases[0]?.disposed).toBe(true)
    } finally {
      setupRelease.resolve(undefined)
    }
    const retried = await createAgent(harness, id)
    expect(harness.ctx.agents.get(id)).toBe(retried.agent)
    await retried.dispose()
  }, 20_000)

  it('keeps each MCP lease bound to its own session and current sandbox mode', async () => {
    const harness = await mountHarness()
    const first = await createAgent(harness, 'mcp-scope-first')
    const second = await createAgentWithSandboxMode(harness, 'mcp-scope-second', 'claude', 'read-only')
    const firstScope = harness.mcp.leases[0]!.scope
    const secondScope = harness.mcp.leases[1]!.scope

    expect(firstScope.workspaceRoot).toBe(harness.root)
    expect(secondScope.workspaceRoot).toBe(harness.root)
    expect(firstScope.sandboxMode()).toBe('workspace-write')
    expect(secondScope.sandboxMode()).toBe('read-only')

    setSandboxMode(first.agent.session, 'read-only')
    expect(firstScope.sandboxMode()).toBe('read-only')
    setSandboxMode(first.agent.session, 'danger-full-access')
    expect(firstScope.sandboxMode()).toBe('danger-full-access')
    expect(secondScope.sandboxMode()).toBe('read-only')

    await first.dispose()
    expect(harness.mcp.leases[0]?.disposed).toBe(true)
    expect(harness.mcp.leases[1]?.disposed).toBe(false)
    await second.dispose()
  }, 20_000)

  it('resumes the provider session and suppresses replay notifications from the live transcript', async () => {
    const records = new Map<string, StoredSession>()
    const sourceHarness = await mountHarness({ records })
    const created = await createAgent(sourceHarness, 'resume-session')
    sourceHarness.persistence.capture(created.agent.session)
    const persistedEvents = structuredClone(created.agent.session.events)
    const resumeHarness = await mountHarness({ records })

    const resumed = await resumeHarness.ctx.agents.resume({
      resumeSessionId: SessionId('resume-session'),
      factoryRoute: 'codex',
    })
    expect(resumed.agent.session.events.slice(0, persistedEvents.length)).toEqual(persistedEvents)
    expect(resumed.agent.session.events.slice(persistedEvents.length).map(event => event.type))
      .toEqual(['session/end-seed'])
    expect(resumed.agent.session.events.filter(event => event.type === 'paperai/acp/session')).toHaveLength(1)
    expect(resumed.agent.session.events.some(event => (
      event.type === 'assistant/message'
      && event.data.message.content.some(block => block.type === 'text' && block.text.includes('replayed'))
    ))).toBe(false)
    expect((await readLog(resumeHarness.logPath)).find(entry => entry.event === 'load-session'))
      .toMatchObject({ sessionId: 'external-paper-session', label: 'codex' })
  }, 20_000)

  it('replaces a failed provider load only when the persisted DSH session is blank', async () => {
    const records = new Map<string, StoredSession>()
    const sourceHarness = await mountHarness({
      records,
      env: { FAKE_ACP_SESSION_ID: 'external-paper-session-old' },
    })
    const created = await createAgent(sourceHarness, 'blank-load-recovery')
    sourceHarness.persistence.capture(created.agent.session)
    await created.dispose()
    const resumeHarness = await mountHarness({
      records,
      env: {
        FAKE_ACP_FAIL_LOAD: '1',
        FAKE_ACP_SESSION_ID: 'external-paper-session-new',
      },
    })

    const resumed = await resumeHarness.ctx.agents.resume({
      resumeSessionId: SessionId('blank-load-recovery'),
      factoryRoute: 'codex',
    })

    const links = resumed.agent.session.events.flatMap(event => (
      event.type === 'paperai/acp/session' ? [event.data] : []
    ))
    expect(links).toEqual([
      { provider: 'codex', externalSessionId: 'external-paper-session-old', resumed: false },
      { provider: 'codex', externalSessionId: 'external-paper-session-new', resumed: false },
    ])
    await expect(resumed.agent.modelController?.listModels()).resolves.toMatchObject([
      {
        id: 'fake-alpha',
        name: 'Fake Alpha',
        description: 'Stable fake model',
        group: 'Fake models',
      },
      {
        id: 'fake-beta',
        name: 'Fake Beta',
        description: 'Alternate fake model',
        group: 'Fake models',
      },
    ])
    setSandboxMode(resumed.agent.session, 'read-only')
    await vi.waitFor(async () => {
      expect((await readLog(resumeHarness.logPath)).findLast(entry => entry.event === 'set-mode'))
        .toMatchObject({ sessionId: 'external-paper-session-new', modeId: 'read-only' })
    })
    expect((await readLog(resumeHarness.logPath)).map(entry => entry.event))
      .toEqual(expect.arrayContaining(['load-session', 'new-session']))
  }, 20_000)

  it('fails closed when provider load fails for a DSH session with turn history', async () => {
    const records = new Map<string, StoredSession>()
    const sourceHarness = await mountHarness({ records })
    const created = await createAgent(sourceHarness, 'nonblank-load-failure')
    created.agent.session.append('turn/start', { turn: 1 })
    created.agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    sourceHarness.persistence.capture(created.agent.session)
    await created.dispose()
    const resumeHarness = await mountHarness({ records, env: { FAKE_ACP_FAIL_LOAD: '1' } })

    await expect(resumeHarness.ctx.agents.resume({
      resumeSessionId: SessionId('nonblank-load-failure'),
      factoryRoute: 'codex',
    })).rejects.toThrow('Codex ACP failed to start: Internal error')
    expect((await readLog(resumeHarness.logPath)).map(entry => entry.event))
      .not.toContain('new-session')
  }, 20_000)

  it('tears down the Agent and Session through the public handle without hanging', async () => {
    await runLifecycleProbe('dispose')
  }, 10_000)

  it('does not dispatch a provider prompt when cancellation wins immediately before dispatch', async () => {
    const harness = await mountHarness()
    const handle = await createAgent(harness, 'cancel-before-prompt')
    let cancelled = false
    harness.ctx.on('session/event', (subject, event) => {
      if (cancelled || subject !== handle.agent.session || event.type !== 'request/context') return
      cancelled = true
      queueMicrotask(() => { handle.agent.cancel({ kind: 'user' }) })
    })
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Do not dispatch after synchronous cancellation' }],
      source: { kind: 'user' },
    }))
    await handle.agent.whenIdle()

    expect((await readLog(harness.logPath)).filter(entry => entry.event === 'prompt')).toHaveLength(0)
    expect(handle.agent.session.events.findLast(event => event.type === 'turn/end')?.data.reason)
      .toMatchObject({ kind: 'aborted' })

    await runTurn(handle, 'Dispatch on the replacement runtime')
    expect((await readLog(harness.logPath)).filter(entry => entry.event === 'prompt')).toHaveLength(1)
  }, 20_000)

  it('rolls back a failed ACP startup so the same route and session id can be retried', async () => {
    await runLifecycleProbe('startup-rollback')
  }, 10_000)
})

describe('ACP permission policy projection', { concurrent: false }, () => {
  it('does not commit a rejected native mode and settles cancellation after the replacement starts', async () => {
    const harness = await mountHarness({
      mountPermissionPresets: true,
      env: {
        FAKE_ACP_REJECT_SET_MODE: 'read-only',
        FAKE_ACP_CANCEL_FINAL_TOOL: '1',
      },
    })
    const handle = await createAgent(harness, 'native-mode-command-rejection', 'codex')
    const before = handle.agent.session.events.filter(event => (
      event.type === 'permission/preset'
      || event.type === 'sandbox/mode'
      || event.type === 'approval/policy'
    ))

    await expect(harness.ctx.commands.execute(
      handle.agent,
      '/permission read-only',
      [],
      new AbortController().signal,
    )).rejects.toThrow('Internal error')

    const after = handle.agent.session.events.filter(event => (
      event.type === 'permission/preset'
      || event.type === 'sandbox/mode'
      || event.type === 'approval/policy'
    ))
    expect(after).toEqual(before)
    expect(harness.ctx.sessionProjections.snapshot(handle.agent.session).values.permissions)
      .toMatchObject({ currentValue: 'workspace-write' })
    const log = await readLog(harness.logPath)
    expect(log.filter(entry => (
      entry.event === 'set-mode-start' && entry['modeId'] === 'read-only'
    ))).toHaveLength(1)
    expect(log.filter(entry => (
      entry.event === 'set-mode' && entry['modeId'] === 'read-only'
    ))).toHaveLength(0)

    expect((await handle.agent.modelController?.listModels())?.map(model => model.id))
      .toEqual(['fake-alpha', 'fake-beta'])
    await expect(handle.agent.modelController?.selectModel('fake-beta')).resolves.toBe('fake-beta')
    expect(handle.agent.modelController?.currentModel).toBe('fake-beta')
    expect((await readLog(harness.logPath)).filter(entry => entry.event === 'initialize')).toHaveLength(2)

    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Cancel after replacing the rejected runtime' }],
      source: { kind: 'user' },
    }))
    await vi.waitFor(async () => {
      expect((await readLog(harness.logPath)).some(entry => entry.event === 'cancel-tool-start'))
        .toBe(true)
    })
    handle.agent.cancel({ kind: 'user' })
    await handle.agent.whenIdle()

    const settledLog = await readLog(harness.logPath)
    expect(settledLog.some(entry => entry.event === 'cancel-tool-finished')).toBe(true)
    expect(settledLog.filter(entry => entry.event === 'initialize')).toHaveLength(2)
    expect(handle.agent.session.events.findLast(event => event.type === 'request/header')?.data.header)
      .toMatchObject({ config: { provider: 'codex', model: 'fake-beta' } })
    expect(handle.agent.session.events.some(event => (
      event.type === 'tool/result' && event.data.message.source.callId === 'cancel-edit'
    ))).toBe(true)
  }, 20_000)

  it('serializes concurrent model operations while replacing a cancelled runtime', async () => {
    const harness = await mountHarness({ env: { FAKE_ACP_CANCEL_FINAL_TOOL: '1' } })
    const handle = await createAgent(harness, 'concurrent-model-runtime-recovery')
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Cancel before concurrent model requests' }],
      source: { kind: 'user' },
    }))
    await vi.waitFor(async () => {
      expect((await readLog(harness.logPath)).some(entry => entry.event === 'cancel-tool-start')).toBe(true)
    })
    handle.agent.cancel({ kind: 'user' })
    await handle.agent.whenIdle()

    const controller = handle.agent.modelController
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const blocker = handle.agent.runMaintenance(async () => {
      entered.resolve(undefined)
      await release.promise
    })
    await entered.promise
    const operations = Promise.allSettled([
      controller?.listModels(),
      controller?.selectModel('fake-beta'),
    ])
    release.resolve(undefined)
    await blocker
    const outcomes = await operations

    expect(outcomes.map(outcome => outcome.status)).toEqual(['fulfilled', 'fulfilled'])
    expect(outcomes[0]).toMatchObject({
      value: [
        { id: 'fake-alpha' },
        { id: 'fake-beta' },
      ],
    })
    expect(outcomes[1]).toMatchObject({ value: 'fake-beta' })
    expect((await readLog(harness.logPath)).filter(entry => entry.event === 'initialize')).toHaveLength(2)
  }, 20_000)

  it('continues the model operation queue after an earlier operation rejects', async () => {
    const harness = await mountHarness()
    const handle = await createAgent(harness, 'rejected-model-operation-queue')
    const controller = handle.agent.modelController
    if (controller === undefined) throw new Error('ACP Agent did not publish its model controller')

    const outcomes = await Promise.allSettled([
      controller.selectModel('not-advertised'),
      controller.listModels(),
    ])

    expect(outcomes[0]).toMatchObject({ status: 'rejected' })
    expect(outcomes[1]).toMatchObject({
      status: 'fulfilled',
      value: [
        { id: 'fake-alpha' },
        { id: 'fake-beta' },
      ],
    })
  }, 20_000)

  it('drains queued model operations before disposing the Agent lifecycle', async () => {
    const harness = await mountHarness({
      cancelFinalToolOnce: true,
      env: { FAKE_ACP_CANCEL_FINAL_TOOL: '1' },
    })
    const handle = await createAgent(harness, 'dispose-queued-model-runtime-recovery')
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Cancel before disposal drains model requests' }],
      source: { kind: 'user' },
    }))
    await vi.waitFor(async () => {
      expect((await readLog(harness.logPath)).some(entry => entry.event === 'cancel-tool-start')).toBe(true)
    })
    handle.agent.cancel({ kind: 'user' })
    await handle.agent.whenIdle()

    const controller = handle.agent.modelController
    if (controller === undefined) throw new Error('ACP Agent did not publish its model controller')
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const blocker = handle.agent.runMaintenance(async () => {
      entered.resolve(undefined)
      await release.promise
    })
    await entered.promise
    const settlementOrder: string[] = []
    const operations = Promise.allSettled([
      controller.listModels(),
      controller.selectModel('fake-beta'),
    ]).then((outcomes) => {
      settlementOrder.push('model operations')
      return outcomes
    })
    const disposing = handle.dispose().then(() => { settlementOrder.push('dispose') })
    release.resolve(undefined)
    await blocker
    const outcomes = await operations
    await disposing

    expect(outcomes.map(outcome => outcome.status)).toEqual(['rejected', 'rejected'])
    expect(settlementOrder).toEqual(['model operations', 'dispose'])
    await expect(controller.listModels()).rejects.toThrow('ACP Agent lifecycle is closed')
  }, 20_000)

  it('interrupts a stalled provider model operation during disposal', async () => {
    const harness = await mountHarness({ env: { FAKE_ACP_NEVER_SET_CONFIG: 'fake-beta' } })
    const handle = await createAgent(harness, 'dispose-stalled-model-operation')
    const controller = handle.agent.modelController
    if (controller === undefined) throw new Error('ACP Agent did not publish its model controller')
    const selection = Promise.allSettled([controller.selectModel('fake-beta')])
    await vi.waitFor(async () => {
      expect((await readLog(harness.logPath)).some(entry => (
        entry.event === 'set-config-option' && entry['value'] === 'fake-beta'
      ))).toBe(true)
    })

    await expectResolvesWithin(handle.dispose())

    await expect(selection).resolves.toMatchObject([{ status: 'rejected' }])
    await expect(controller.listModels()).rejects.toThrow('ACP Agent lifecycle is closed')
  }, 20_000)

  it('does not enter a pending turn while an active model selection is unsettled', async () => {
    const harness = await mountHarness({
      promptBarrier: true,
      env: {
        FAKE_ACP_NEVER_SET_CONFIG: 'fake-beta',
      },
    })
    const handle = await createAgent(harness, 'active-model-operation-wake')
    const controller = handle.agent.modelController
    if (controller === undefined) throw new Error('ACP Agent did not publish its model controller')
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Run while model selection begins' }],
      source: { kind: 'user' },
    }))
    await vi.waitFor(async () => {
      expect((await readLog(harness.logPath)).some(entry => entry.event === 'prompt')).toBe(true)
    })
    const selection = Promise.allSettled([controller.selectModel('fake-beta')])
    await vi.waitFor(async () => {
      expect((await readLog(harness.logPath)).some(entry => (
        entry.event === 'set-config-option' && entry['value'] === 'fake-beta'
      ))).toBe(true)
    })
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Wait for the model selection' }],
      source: { kind: 'user' },
    }))
    await writeFile(harness.promptReleasePath, 'release', 'utf8')

    await handle.agent.whenIdle()

    expect((await readLog(harness.logPath)).filter(entry => entry.event === 'prompt')).toHaveLength(1)
    expect(handle.agent.inbox.hasPending).toBe(true)
    await expectResolvesWithin(handle.dispose())
    await expect(selection).resolves.toMatchObject([{ status: 'rejected' }])
  }, 20_000)

  it('applies every queued model operation before waking a pending turn', async () => {
    const harness = await mountHarness({
      cancelFinalToolOnce: true,
      env: { FAKE_ACP_CANCEL_FINAL_TOOL: '1' },
    })
    const handle = await createAgent(harness, 'queued-model-runtime-wake')
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Cancel before replacing the model runtime' }],
      source: { kind: 'user' },
    }))
    await vi.waitFor(async () => {
      expect((await readLog(harness.logPath)).some(entry => entry.event === 'cancel-tool-start')).toBe(true)
    })
    handle.agent.cancel({ kind: 'user' })
    await handle.agent.whenIdle()

    const controller = handle.agent.modelController
    if (controller === undefined) throw new Error('ACP Agent did not publish its model controller')
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const blocker = handle.agent.runMaintenance(async () => {
      entered.resolve(undefined)
      await release.promise
    })
    await entered.promise
    const operations = Promise.allSettled([
      controller.listModels(),
      controller.selectModel('fake-beta'),
    ])
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Run only after every queued model operation' }],
      source: { kind: 'user' },
    }))
    release.resolve(undefined)
    await blocker
    const outcomes = await operations
    await handle.agent.whenIdle()

    expect(outcomes.map(outcome => outcome.status)).toEqual(['fulfilled', 'fulfilled'])
    const log = await readLog(harness.logPath)
    const modelSelection = log.findIndex(entry => (
      entry.event === 'set-config-option' && entry['value'] === 'fake-beta'
    ))
    const pendingPrompt = log.findIndex(entry => (
      entry.event === 'prompt'
      && (entry['prompt'] as Array<{ text?: string }>).some(block => (
        block.text === 'Run only after every queued model operation'
      ))
    ))
    expect(modelSelection).toBeGreaterThanOrEqual(0)
    expect(pendingPrompt).toBeGreaterThan(modelSelection)
    expect(handle.agent.session.events.findLast(event => event.type === 'request/header')?.data.header)
      .toMatchObject({ config: { provider: 'codex', model: 'fake-beta' } })
  }, 20_000)

  it('settles an active turn and starts the target native mode before committing the preset', async () => {
    const harness = await mountHarness({
      mountPermissionPresets: true,
      env: { FAKE_ACP_CANCEL_FINAL_TOOL: '1' },
    })
    const handle = await createAgent(harness, 'native-mode-active-command', 'codex')
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Active while permissions change' }],
      source: { kind: 'user' },
    }))
    await vi.waitFor(async () => {
      expect((await readLog(harness.logPath)).some(entry => entry.event === 'cancel-tool-start'))
        .toBe(true)
    })

    await expect(harness.ctx.commands.execute(
      handle.agent,
      '/permission read-only',
      [],
      new AbortController().signal,
    )).resolves.toMatchObject({ result: { kind: 'success', text: 'preset read-only' } })

    const events = handle.agent.session.events
    expect(events.findIndex(event => event.type === 'turn/end')).toBeLessThan(
      events.findLastIndex(event => event.type === 'sandbox/mode'),
    )
    expect(events.some(event => (
      event.type === 'tool/result' && event.data.message.source.callId === 'cancel-edit'
    ))).toBe(true)
    expect(harness.ctx.sessionProjections.snapshot(handle.agent.session).values.permissions)
      .toMatchObject({ currentValue: 'read-only' })
    const initialized = (await readLog(harness.logPath)).filter(entry => entry.event === 'initialize')
    expect(initialized).toHaveLength(2)
    expect(initialized[1]?.['environment']).toMatchObject({ initialAgentMode: 'read-only' })
  }, 20_000)

  it('holds a queued follow-up until an active-turn permission transition commits', async () => {
    const harness = await mountHarness({
      mountPermissionPresets: true,
      env: { FAKE_ACP_CANCEL_FINAL_TOOL: '1' },
    })
    const handle = await createAgent(harness, 'native-mode-queued-command', 'codex')
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Active before permissions change' }],
      source: { kind: 'user' },
    }))
    await vi.waitFor(async () => {
      expect((await readLog(harness.logPath)).filter(entry => entry.event === 'cancel-tool-start'))
        .toHaveLength(1)
    })
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Queued under the new permissions' }],
      source: { kind: 'user' },
    }))

    await expect(harness.ctx.commands.execute(
      handle.agent,
      '/permission read-only',
      [],
      new AbortController().signal,
    )).resolves.toMatchObject({ result: { kind: 'success', text: 'preset read-only' } })
    await vi.waitFor(async () => {
      expect((await readLog(harness.logPath)).filter(entry => entry.event === 'prompt'))
        .toHaveLength(2)
    })

    const events = handle.agent.session.events
    const committedMode = events.findLastIndex(event => event.type === 'sandbox/mode')
    const queuedTurn = events.findIndex(event => event.type === 'turn/start' && event.data.turn === 2)
    expect(committedMode).toBeLessThan(queuedTurn)
    const log = await readLog(harness.logPath)
    const secondInitialize = log.findLastIndex(entry => entry.event === 'initialize')
    const secondPrompt = log.findLastIndex(entry => entry.event === 'prompt')
    expect(secondInitialize).toBeLessThan(secondPrompt)
    expect(log[secondInitialize]?.['environment']).toMatchObject({ initialAgentMode: 'read-only' })
    expect(log[secondPrompt]?.['prompt']).toEqual([{
      type: 'text',
      text: 'Queued under the new permissions',
    }])

    handle.agent.cancel({ kind: 'user' })
    await handle.agent.whenIdle()
  }, 20_000)

  it.each([
    { provider: 'codex' as const, mode: 'read-only' as const, nativeMode: 'read-only' },
    { provider: 'codex' as const, mode: 'workspace-write' as const, nativeMode: 'agent' },
    { provider: 'codex' as const, mode: 'danger-full-access' as const, nativeMode: 'agent-full-access' },
    { provider: 'claude' as const, mode: 'read-only' as const, nativeMode: 'plan' },
    { provider: 'claude' as const, mode: 'workspace-write' as const, nativeMode: 'acceptEdits' },
    { provider: 'claude' as const, mode: 'danger-full-access' as const, nativeMode: 'bypassPermissions' },
  ])('synchronizes a new $provider session in $mode to $nativeMode', async ({
    provider,
    mode,
    nativeMode,
  }) => {
    const harness = await mountHarness()

    await createAgentWithSandboxMode(harness, `native-new-${provider}-${mode}`, provider, mode)

    const log = await readLog(harness.logPath)
    const selected = log.findLast(entry => entry.event === 'set-mode')?.['modeId']
      ?? (log.find(entry => entry.event === 'initialize')?.['environment'] as LogEntry | undefined)
        ?.['initialAgentMode']
    expect(selected).toBe(nativeMode)
  }, 20_000)

  it.each([
    {
      provider: 'codex' as const,
      expected: ['agent-full-access', 'read-only'],
      modes: ['danger-full-access', 'read-only'] as const,
    },
    {
      provider: 'claude' as const,
      expected: ['bypassPermissions', 'plan'],
      modes: ['danger-full-access', 'read-only'] as const,
    },
  ])('serializes idle $provider permission switches before the next prompt', async ({
    provider,
    expected,
    modes,
  }) => {
    const harness = await mountHarness()
    const handle = await createAgent(harness, `native-switch-${provider}`, provider)

    for (const mode of modes) setSandboxMode(handle.agent.session, mode)
    await runTurn(handle, 'Run after idle permission switches')

    const log = await readLog(harness.logPath)
    const selected = log.filter(entry => entry.event === 'set-mode').map(entry => entry['modeId'])
    expect(selected.slice(-expected.length)).toEqual(expected)
    expect(log.findLastIndex(entry => entry.event === 'set-mode'))
      .toBeLessThan(log.findIndex(entry => entry.event === 'prompt'))
  }, 20_000)

  it('does not prompt until an already-requested native mode switch completes', async () => {
    const harness = await mountHarness({ env: { FAKE_ACP_SET_MODE_DELAY_MS: '250' } })
    const handle = await createAgent(harness, 'native-mode-prompt-order', 'codex')

    setSandboxMode(handle.agent.session, 'read-only')
    await runTurn(handle, 'Read under the new native mode')

    const events = (await readLog(harness.logPath)).map(entry => entry.event)
    expect(events.indexOf('set-mode-start')).toBeLessThan(events.indexOf('set-mode'))
    expect(events.indexOf('set-mode')).toBeLessThan(events.indexOf('prompt'))
  }, 20_000)

  it('cancels an active turn when a queued permission expansion is superseded by read-only', async () => {
    const harness = await mountHarness({
      neverSetMode: { mode: 'agent-full-access', once: true },
      env: {
        FAKE_ACP_PROMPT_DELAY_MS: '1000',
      },
    })
    const handle = await createAgent(harness, 'native-mode-active-tightening', 'codex')
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Active before permissions tighten' }],
      source: { kind: 'user' },
    }))
    await vi.waitFor(async () => {
      expect((await readLog(harness.logPath)).some(entry => entry.event === 'prompt')).toBe(true)
    })

    setSandboxMode(handle.agent.session, 'danger-full-access')
    await vi.waitFor(async () => {
      expect((await readLog(harness.logPath)).some(entry => (
        entry.event === 'set-mode-start' && entry['modeId'] === 'agent-full-access'
      ))).toBe(true)
    })
    setSandboxMode(handle.agent.session, 'read-only')
    await expectResolvesWithin(handle.agent.whenIdle())
    await runTurn(handle, 'Run after permission tightening')

    const log = await readLog(harness.logPath)
    const initialized = log.filter(entry => entry.event === 'initialize')
    expect(initialized).toHaveLength(2)
    expect(initialized[1]?.['environment']).toMatchObject({ initialAgentMode: 'read-only' })
    expect(log.some(entry => entry.event === 'set-mode' && entry['modeId'] === 'agent-full-access'))
      .toBe(false)
  }, 20_000)

  it('reasserts the latest DSH mode after a stale provider mode notification', async () => {
    const harness = await mountHarness({
      env: {
        FAKE_ACP_DELAY_MODE_UPDATE: 'read-only',
        FAKE_ACP_MODE_UPDATE_DELAY_MS: '250',
      },
    })
    const handle = await createAgent(harness, 'native-mode-stale-update', 'codex')
    setSandboxMode(handle.agent.session, 'read-only')
    await vi.waitFor(async () => {
      expect((await readLog(harness.logPath)).filter(entry => entry.event === 'set-mode'))
        .toHaveLength(1)
    })
    setSandboxMode(handle.agent.session, 'danger-full-access')

    await vi.waitFor(async () => {
      const selected = (await readLog(harness.logPath))
        .filter(entry => entry.event === 'set-mode')
        .map(entry => entry['modeId'])
      expect(selected).toEqual(['read-only', 'agent-full-access', 'agent-full-access'])
    }, { timeout: 2_000 })
  }, 20_000)

  it.each([
    { provider: 'codex' as const, nativeMode: 'read-only' },
    { provider: 'claude' as const, nativeMode: 'plan' },
  ])('restores the persisted $provider permission mode before publication', async ({
    provider,
    nativeMode,
  }) => {
    const records = new Map<string, StoredSession>()
    const sourceHarness = await mountHarness({ records })
    const created = await createAgentWithSandboxMode(
      sourceHarness,
      `native-resume-${provider}`,
      provider,
      'read-only',
    )
    sourceHarness.persistence.capture(created.agent.session)
    const resumeHarness = await mountHarness({ records })

    await resumeHarness.ctx.agents.resume({
      resumeSessionId: SessionId(`native-resume-${provider}`),
      factoryRoute: provider,
    })

    const log = await readLog(resumeHarness.logPath)
    const initialized = log.find(entry => entry.event === 'initialize')
    if (provider === 'codex') {
      expect(initialized?.['environment']).toMatchObject({ initialAgentMode: nativeMode })
    } else {
      expect(log.find(entry => entry.event === 'set-mode'))
        .toMatchObject({ label: provider, modeId: nativeMode })
    }
  }, 20_000)

  it.each([
    { provider: 'codex' as const, nativeMode: 'read-only' },
    { provider: 'claude' as const, nativeMode: 'plan' },
  ])('starts a replacement $provider runtime in the current permission mode', async ({
    provider,
    nativeMode,
  }) => {
    const harness = await mountHarness({ env: { FAKE_ACP_PROMPT_DELAY_MS: '300' } })
    const handle = await createAgent(harness, `native-mode-restart-${provider}`, provider)
    setSandboxMode(handle.agent.session, 'read-only')
    await vi.waitFor(async () => {
      expect((await readLog(harness.logPath)).findLast(entry => entry.event === 'set-mode'))
        .toMatchObject({ modeId: nativeMode })
    })
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Cancel this turn' }],
      source: { kind: 'user' },
    }))
    await vi.waitFor(async () => {
      expect((await readLog(harness.logPath)).some(entry => entry.event === 'prompt')).toBe(true)
    })
    handle.agent.cancel({ kind: 'user' })
    await handle.agent.whenIdle()

    await runTurn(handle, 'Run after restart')

    const log = await readLog(harness.logPath)
    const initialized = log.filter(entry => entry.event === 'initialize')
    expect(initialized).toHaveLength(2)
    if (provider === 'codex') {
      expect(initialized[1]?.['environment']).toMatchObject({ initialAgentMode: nativeMode })
    } else {
      const secondInitializeIndex = log.findLastIndex(entry => entry.event === 'initialize')
      expect(log.slice(secondInitializeIndex + 1).find(entry => entry.event === 'set-mode'))
        .toMatchObject({ label: provider, modeId: nativeMode })
    }
  }, 20_000)

  it('cancels a stalled native mode switch and replays the latest mode before the next turn', async () => {
    const harness = await mountHarness({ neverSetMode: { mode: 'read-only', once: true } })
    const warn = vi.spyOn(harness.ctx.logger, 'warn').mockImplementation(() => undefined)
    const handle = await createAgent(harness, 'native-mode-stalled-cancel', 'codex')

    setSandboxMode(handle.agent.session, 'read-only')
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Wait behind the stalled mode switch' }],
      source: { kind: 'user' },
    }))
    await vi.waitFor(async () => {
      expect((await readLog(harness.logPath)).some(entry => (
        entry.event === 'set-mode-start' && entry['modeId'] === 'read-only'
      ))).toBe(true)
    })

    handle.agent.cancel({ kind: 'user' })
    await expectResolvesWithin(handle.agent.whenIdle())
    await runTurn(handle, 'Run in the replacement runtime')

    const log = await readLog(harness.logPath)
    const initialized = log.filter(entry => entry.event === 'initialize')
    expect(initialized).toHaveLength(2)
    expect(initialized[1]?.['environment']).toMatchObject({ initialAgentMode: 'read-only' })
    expect(log.findLast(entry => entry.event === 'prompt'))
      .toMatchObject({ prompt: [{ type: 'text', text: 'Run in the replacement runtime' }] })
    expect(warn).not.toHaveBeenCalled()
  }, 20_000)

  it('disposes while a native mode switch is stalled without waiting for the provider', async () => {
    const harness = await mountHarness({ neverSetMode: { mode: 'read-only', once: false } })
    const warn = vi.spyOn(harness.ctx.logger, 'warn').mockImplementation(() => undefined)
    const handle = await createAgent(harness, 'native-mode-stalled-dispose', 'codex')

    setSandboxMode(handle.agent.session, 'read-only')
    await vi.waitFor(async () => {
      expect((await readLog(harness.logPath)).some(entry => (
        entry.event === 'set-mode-start' && entry['modeId'] === 'read-only'
      ))).toBe(true)
    })

    await expectResolvesWithin(handle.dispose())

    expect(warn).not.toHaveBeenCalled()
    expect(harness.ctx.agents.get(handle.agent.id)).toBeUndefined()
  }, 20_000)

  it('rejects publication when Claude does not advertise the required native mode', async () => {
    const harness = await mountHarness({ env: { FAKE_ACP_OMIT_MODE: 'plan' } })

    await expect(createAgentWithSandboxMode(
      harness,
      'native-mode-unavailable',
      'claude',
      'read-only',
    )).rejects.toThrow(
      'Claude ACP did not advertise required mode "plan" for sandbox mode "read-only"',
    )
    expect(harness.ctx.agents.get(SessionId('native-mode-unavailable'))).toBeUndefined()
    expect(harness.ctx.sessions.get(SessionId('native-mode-unavailable'))).toBeUndefined()
  }, 20_000)

  it.each([
    {
      name: 'full access chooses allow-always without consulting approval',
      mode: 'danger-full-access' as const,
      approvalOutcome: 'rejected' as const,
      expectedOption: 'allow-always',
      expectedRequests: 0,
      expectedAudit: 0,
    },
    {
      name: 'read-only chooses reject-always without consulting approval',
      mode: 'read-only' as const,
      approvalOutcome: 'allowed-once' as const,
      expectedOption: 'reject-always',
      expectedRequests: 0,
      expectedAudit: 0,
    },
    {
      name: 'workspace-write maps an approved host decision to allow-once',
      mode: 'workspace-write' as const,
      approvalOutcome: 'allowed-once' as const,
      expectedOption: 'allow-once',
      expectedRequests: 1,
      expectedAudit: 1,
    },
  ])('$name', async ({ mode, approvalOutcome, expectedOption, expectedRequests, expectedAudit }) => {
    const harness = await mountHarness({
      env: { FAKE_ACP_REQUEST_PERMISSION: '1' },
      approvalOutcome,
    })
    const handle = await createAgent(harness, `permission-${mode}`)
    setSandboxMode(handle.agent.session, mode)

    await runTurn(handle, 'Apply the requested document edit')

    const permission = (await readLog(harness.logPath)).find(entry => entry.event === 'permission-response')
    expect(permission?.['outcome']).toEqual({ outcome: 'selected', optionId: expectedOption })
    expect(harness.approvalRequests()).toBe(expectedRequests)
    expect(handle.agent.session.events.filter(event => event.type === 'approval/asked')).toHaveLength(expectedAudit)
    expect(handle.agent.session.events.filter(event => event.type === 'approval/decided')).toHaveLength(expectedAudit)
  }, 20_000)

  it('fails closed to reject-once when an approval service is unavailable', async () => {
    const harness = await mountHarness({
      env: { FAKE_ACP_REQUEST_PERMISSION: '1' },
      mountApproval: false,
    })
    const handle = await createAgent(harness, 'permission-no-service')
    setSandboxMode(handle.agent.session, 'workspace-write')

    await runTurn(handle, 'Try an edit without an approval provider')

    const permission = (await readLog(harness.logPath)).find(entry => entry.event === 'permission-response')
    expect(permission?.['outcome']).toEqual({ outcome: 'selected', optionId: 'reject-once' })
    expect(handle.agent.session.events.some(event => event.type === 'approval/asked')).toBe(false)
  }, 20_000)
})

describe('ACP client filesystem enforcement', { concurrent: false }, () => {
  it('reads a relative ACP path from the Session workspace through the DSH filesystem', async () => {
    const harness = await mountHarness({ env: { FAKE_ACP_READ_PATH: 'source.txt' } })
    await writeFile(join(harness.root, 'source.txt'), 'workspace source', 'utf8')
    const handle = await createAgent(harness, 'workspace-file-read')

    await runTurn(handle, 'Read the workspace source')

    expect((await readLog(harness.logPath)).find(entry => entry.event === 'read-text-file'))
      .toMatchObject({ path: 'source.txt', content: 'workspace source' })
  }, 20_000)

  it('writes through the DSH filesystem inside the session workspace', async () => {
    const harness = await mountHarness({
      writePath: root => join(root, 'agent-written.txt'),
      env: { FAKE_ACP_WRITE_CONTENT: 'workspace revision' },
    })
    const handle = await createAgent(harness, 'workspace-file-write')
    setSandboxMode(handle.agent.session, 'workspace-write')

    await runTurn(handle, 'Write the workspace revision')

    await expect(readFile(join(harness.root, 'agent-written.txt'), 'utf8')).resolves.toBe('workspace revision')
    expect((await readLog(harness.logPath)).some(entry => entry.event === 'write-text-file')).toBe(true)
  }, 20_000)

  it('denies an ACP write outside the session workspace at the final filesystem operation', async () => {
    const harness = await mountHarness({
      writePath: (_root, fallbackRoot) => join(fallbackRoot, 'fallback-denied.txt'),
    })
    const handle = await createAgent(harness, 'workspace-file-denied')
    setSandboxMode(handle.agent.session, 'workspace-write')

    await runTurn(handle, 'Try to write outside the workspace')

    const outsidePath = join(harness.fallbackRoot, 'fallback-denied.txt')
    await expect(readFile(outsidePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await readLog(harness.logPath)).find(entry => entry.event === 'write-text-file-error'))
      .toMatchObject({ path: outsidePath })
  }, 20_000)

  it('denies an ACP write inside the workspace when the session is read-only', async () => {
    const harness = await mountHarness({ writePath: root => join(root, 'read-only.txt') })
    const handle = await createAgent(harness, 'read-only-file-denied')
    setSandboxMode(handle.agent.session, 'read-only')

    await runTurn(handle, 'Try to write in read-only mode')

    await expect(readFile(join(harness.root, 'read-only.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await readLog(harness.logPath)).some(entry => entry.event === 'write-text-file-error')).toBe(true)
  }, 20_000)

  it('revokes an already-dispatched write before starting the next runtime generation', async () => {
    const harness = await mountHarness({
      writePath: root => join(root, 'cancelled-write.txt'),
      env: {
        FAKE_ACP_WRITE_CONTENT_FROM_PROMPT: '1',
      },
    })
    const handle = await createAgent(harness, 'cancelled-file-write')
    setSandboxMode(handle.agent.session, 'workspace-write')
    const originalWriteText = harness.ctx.fs.writeText.bind(harness.ctx.fs)
    const firstWriteEntered = Promise.withResolvers<AbortSignal | undefined>()
    const releaseFirstWrite = Promise.withResolvers<undefined>()
    let writeCalls = 0
    harness.ctx.fs.writeText = async (target, content, expected, signal, sandboxPolicy) => {
      writeCalls += 1
      if (writeCalls === 1) {
        firstWriteEntered.resolve(signal)
        await releaseFirstWrite.promise
      }
      return await originalWriteText(target, content, expected, signal, sandboxPolicy)
    }
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Start an in-flight write' }],
      source: { kind: 'user' },
    }))
    const cancelledWriteSignal = await firstWriteEntered.promise

    handle.agent.cancel({ kind: 'user' })
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Replacement turn' }],
      source: { kind: 'user' },
    }))
    expect(cancelledWriteSignal?.aborted).toBe(true)
    releaseFirstWrite.resolve(undefined)
    await handle.agent.whenIdle()

    const log = await readLog(harness.logPath)
    expect(log.filter(entry => entry.event === 'prompt')).toHaveLength(2)
    await expect(readFile(join(harness.root, 'cancelled-write.txt'), 'utf8'))
      .resolves.toBe('Replacement turn')
    const successfulWrites = log.filter(entry => entry.event === 'write-text-file')
    expect(successfulWrites).toHaveLength(1)
    expect(successfulWrites[0]).toMatchObject({ promptText: 'Replacement turn' })
  }, 20_000)
})

describe('ACP update transcript projection', { concurrent: false }, () => {
  it('forwards running-turn steering through the provider extension without opening a second prompt', async () => {
    const harness = await mountHarness({
      env: {
        FAKE_ACP_STEERING: '1',
        FAKE_ACP_PROMPT_DELAY_MS: '600',
      },
    })
    const handle = await createAgent(harness, 'native-steering')
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Start the long revision' }],
      source: { kind: 'user' },
    }))
    await vi.waitFor(async () => {
      expect((await readLog(harness.logPath)).some(entry => entry.event === 'prompt')).toBe(true)
    }, { timeout: 5_000 })

    handle.agent.steer(createUserMessage({
      content: [{ type: 'text', text: 'Keep the original terminology' }],
      source: { kind: 'user' },
    }))
    await handle.agent.whenIdle()

    const log = await readLog(harness.logPath)
    expect(log.filter(entry => entry.event === 'prompt')).toHaveLength(1)
    expect(log.find(entry => entry.event === 'steer')).toMatchObject({
      sessionId: 'external-paper-session',
      prompt: [{ type: 'text', text: 'Keep the original terminology' }],
    })
    const userMessages = handle.agent.session.events.filter(event => event.type === 'user/message')
    expect(userMessages).toHaveLength(2)
    expect(userMessages.flatMap(event => event.data.content).filter(block => block.type === 'text'))
      .toEqual([
        { type: 'text', text: 'Start the long revision' },
        { type: 'text', text: 'Keep the original terminology' },
      ])
    expect(handle.agent.session.events.filter(event => (
      event.type === 'agent/inbox/spliced' && event.data.target === 'next-step'
    )).at(-1)?.data).toMatchObject({ removedCount: 1, inserted: [] })
  }, 20_000)

  it('projects text, thought, tool, plan, context, and usage updates into canonical DSH events', async () => {
    const harness = await mountHarness({ env: { FAKE_ACP_FULL_UPDATES: '1' } })
    const handle = await createAgent(harness, 'transcript-projection')

    await runTurn(handle, 'Revise the introduction')

    const events = handle.agent.session.events
    expect(events.flatMap(event => (
      event.type === 'assistant/chunk' && event.data.chunk.type === 'text-delta'
        ? [event.data.chunk.text]
        : []
    ))).toEqual(['Revised ', 'introduction.'])
    const assistant = events.find(event => event.type === 'assistant/message')
    expect(assistant?.data.message).toMatchObject({
      role: 'assistant',
      source: { kind: 'model', provider: 'codex', model: 'fake-alpha' },
      content: [
        { type: 'text', text: 'Revised introduction.' },
        { type: 'reasoning', text: 'Checking evidence.' },
      ],
    })
    expect(assistant?.data.usage).toEqual({
      inputTokens: 13,
      outputTokens: 8,
      reasoningTokens: 3,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
    })
    expect(events.find(event => event.type === 'tool/call')?.data).toMatchObject({
      callId: 'edit-1',
      name: 'paperai.edit',
      arguments: '{"section":"introduction"}',
    })
    const toolResult = events.find(event => event.type === 'tool/result')
    expect(toolResult?.data).toMatchObject({
      message: {
        role: 'user',
        source: { kind: 'tool', callId: 'edit-1' },
        content: [{
          type: 'tool-result',
          toolCallId: 'edit-1',
          content: [{ type: 'text', text: '{"changedParagraphs":1}' }],
          isError: false,
        }],
      },
      meta: { source: 'acp', title: 'Edit introduction', provider: 'codex' },
    })
    expect(events.findLast(event => event.type === 'todo/write')?.data.todos).toEqual([
      { content: 'Inspect requirements', status: 'completed' },
      { content: 'Revise introduction', status: 'in_progress' },
    ])
    expect(events.find(event => (
      event.type === 'request/context' && event.data.contextWindow === 131072
    ))?.data).toMatchObject({ provider: 'codex', model: 'fake-alpha', contextWindow: 131072 })
    expect(events.filter(event => event.type === 'assistant/chunk').map(event => event.data.chunk.type))
      .toEqual(expect.arrayContaining([
        'block-start',
        'text-delta',
        'reasoning-delta',
        'block-end',
        'usage',
        'finish',
      ]))
    expect(events.findLast(event => event.type === 'turn/end')?.data.reason).toEqual({ kind: 'completed' })
    expect(handle.agent.status).toBe('idle')
    expect((await readLog(harness.logPath)).find(entry => entry.event === 'prompt')?.['prompt'])
      .toEqual([{ type: 'text', text: 'Revise the introduction' }])
  }, 20_000)

  it('keeps the turn projection open for final tool updates after cancellation', async () => {
    const harness = await mountHarness({ env: { FAKE_ACP_CANCEL_FINAL_TOOL: '1' } })
    const handle = await createAgent(harness, 'cancel-final-tool-update')
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Start an edit that will be cancelled' }],
      source: { kind: 'user' },
    }))
    await vi.waitFor(async () => {
      expect((await readLog(harness.logPath)).some(entry => entry.event === 'cancel-tool-start'))
        .toBe(true)
    })

    handle.agent.cancel({ kind: 'user' })
    await handle.agent.whenIdle()
    await vi.waitFor(async () => {
      expect((await readLog(harness.logPath)).some(entry => entry.event === 'cancel-tool-finished'))
        .toBe(true)
    })

    const events = handle.agent.session.events
    const callIndex = events.findIndex(event => (
      event.type === 'tool/call' && event.data.callId === 'cancel-edit'
    ))
    const resultIndex = events.findIndex(event => (
      event.type === 'tool/result' && event.data.message.source.callId === 'cancel-edit'
    ))
    const stepEndIndex = events.findIndex(event => event.type === 'step/end')
    const turnEndIndex = events.findIndex(event => event.type === 'turn/end')
    expect(callIndex).toBeGreaterThanOrEqual(0)
    expect(resultIndex).toBeGreaterThan(callIndex)
    expect(stepEndIndex).toBeGreaterThan(resultIndex)
    expect(turnEndIndex).toBeGreaterThan(stepEndIndex)
    expect(events.find(event => event.type === 'assistant/message')?.data)
      .toMatchObject({ interrupted: true })
    expect(events.findLast(event => event.type === 'turn/end')?.data.reason)
      .toEqual({ kind: 'aborted', reason: { kind: 'user' } })
  }, 20_000)
})

describe('ACP Agent settings and secret handling', { concurrent: false }, () => {
  it('discovers and probes both configured adapters without creating an Agent or granting project access', async () => {
    const harness = await mountHarness({
      settingsDocument: { [ACP_AGENT_SETTINGS_NAMESPACE]: { probeTimeoutMs: 5000, failureCooldownMs: 60_000 } },
    })
    expect(harness.ctx.paperAiAcpAgents.diagnosticStatus()).toMatchObject([
      { provider: 'codex', status: 'discovered', models: [] },
      { provider: 'claude', status: 'discovered', models: [] },
    ])
    expect(await readLog(harness.logPath)).toEqual([])
    for (const provider of ['codex', 'claude'] as const) {
      expect(await harness.ctx.paperAiAcpAgents.probe(provider, false)).toMatchObject({ provider, status: 'ready' })
    }
    expect(harness.ctx.paperAiAcpAgents.diagnosticStatus().every(provider => provider.status === 'ready')).toBe(true)
    expect(harness.mcp.leases).toEqual([])
    expect(harness.approvalRequests()).toBe(0)
    const events = await readLog(harness.logPath)
    expect(events.filter(event => event.event === 'new-session')).toEqual([
      expect.objectContaining({ label: 'codex', mcpServers: [] }),
      expect.objectContaining({ label: 'claude', mcpServers: [] }),
    ])
    expect(events.some(event => event.event === 'prompt')).toBe(false)
  })

  const codexDefinition: AcpProviderDefinition = {
    id: 'codex',
    name: 'Codex',
    packageName: '@agentclientprotocol/codex-acp',
    binName: 'codex-acp',
  }

  it('publishes a redacted settings descriptor for provider keys and environment overrides', async () => {
    const harness = await mountHarness({
      settingsDocument: {
        [ACP_AGENT_SETTINGS_NAMESPACE]: {
          codex: { apiKey: 'openai-secret-value', baseURL: 'https://openai.example' },
          claude: { apiKey: 'anthropic-secret-value', baseURL: 'https://anthropic.example' },
        },
      },
    })

    const descriptor = harness.ctx.settings.describe({ redactSecrets: true })
      .find(entry => entry.ns === ACP_AGENT_SETTINGS_NAMESPACE)
    expect(descriptor?.secrets).toEqual(expect.arrayContaining([
      { path: ['codex', 'env'], set: true },
      { path: ['codex', 'apiKey'], set: true },
      { path: ['claude', 'env'], set: true },
      { path: ['claude', 'apiKey'], set: true },
    ]))
    const serialized = JSON.stringify(descriptor)
    expect(serialized).not.toContain('openai-secret-value')
    expect(serialized).not.toContain('anthropic-secret-value')
    expect(serialized).not.toContain(harness.logPath)
    expect(descriptor?.value).toMatchObject({
      codex: { baseURL: 'https://openai.example' },
      claude: { baseURL: 'https://anthropic.example' },
    })
  })

  it('resolves updated settings for each new Agent and maps keys to provider-native variables', async () => {
    const harness = await mountHarness({
      settingsDocument: {
        [ACP_AGENT_SETTINGS_NAMESPACE]: {
          codex: { apiKey: 'codex-key-v1', baseURL: 'https://openai.v1' },
          claude: { apiKey: 'claude-key-v1', baseURL: 'https://anthropic.v1' },
        },
      },
    })
    await createAgent(harness, 'settings-codex-v1', 'codex')

    await harness.ctx.settings.update(ACP_AGENT_SETTINGS_NAMESPACE, {
      codex: { apiKey: 'codex-key-v2', baseURL: 'https://openai.v2' },
    })
    await vi.waitFor(() => {
      expect(harness.ctx.paperAiAcpAgents.resolveProvider(codexDefinition).env).toMatchObject({
        OPENAI_API_KEY: 'codex-key-v2',
        OPENAI_BASE_URL: 'https://openai.v2',
      })
    })
    await createAgent(harness, 'settings-codex-v2', 'codex')
    await createAgent(harness, 'settings-claude-v1', 'claude')

    const initialized = (await readLog(harness.logPath)).filter(entry => entry.event === 'initialize')
    const codex = initialized.filter(entry => entry.label === 'codex')
    const claude = initialized.filter(entry => entry.label === 'claude')
    expect(codex.map(entry => entry['environment'])).toEqual([
      {
        openAiApiKey: 'codex-key-v1',
        anthropicApiKey: null,
        openAiBaseUrl: 'https://openai.v1',
        anthropicBaseUrl: null,
        initialAgentMode: 'agent',
      },
      {
        openAiApiKey: 'codex-key-v2',
        anthropicApiKey: null,
        openAiBaseUrl: 'https://openai.v2',
        anthropicBaseUrl: null,
        initialAgentMode: 'agent',
      },
    ])
    expect(claude.map(entry => entry['environment'])).toEqual([{
      openAiApiKey: null,
      anthropicApiKey: 'claude-key-v1',
      openAiBaseUrl: null,
      anthropicBaseUrl: 'https://anthropic.v1',
      initialAgentMode: null,
    }])
  }, 30_000)
})
