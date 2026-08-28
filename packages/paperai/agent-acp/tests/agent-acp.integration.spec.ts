import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { Context, Service } from '@deepseek-ai/cordis'
import AgentRegistry, { type AgentHandle } from '@deepseek-ai/dsh-agent'
import SandboxedFileSystem from '@deepseek-ai/dsh-fs-sandbox'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
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
import {
  SettingsProvider,
  type SettingsNamespace,
} from '@deepseek-ai/dsh-settings'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import ApprovalService, { type ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type {
  PaperMcpAgentIdentity,
  PaperMcpDescriptorLease,
} from '@paperai/mcp'
import PaperAiAcpAgents, {
  ACP_AGENT_SETTINGS_NAMESPACE,
  type AcpProviderDefinition,
} from '../src/index.ts'

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
    actor: PaperMcpAgentIdentity
    disposed: boolean
  }> = []

  constructor(ctx: Context) {
    super(ctx, 'paperMcp')
  }

  issueDescriptor(actor: PaperMcpAgentIdentity): PaperMcpDescriptorLease {
    const state = {
      descriptor: {
        type: 'http' as const,
        name: 'paperai',
        url: 'http://127.0.0.1:3210/api/paperai/mcp',
        headers: [{ name: 'Authorization', value: 'Bearer fake-paperai-token' }],
      },
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
  readonly mountApproval?: boolean
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
  const ctx = new Context()
  cleanup.push({ ctx, root: scratchRoot })
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: fallbackRoot })
  await ctx.plugin(SandboxedFileSystem, { cwd: fallbackRoot })
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
  if (options.settingsDocument !== undefined) {
    await ctx.plugin(TestSettings, { document: options.settingsDocument })
  }
  const commonEnv = {
    FAKE_ACP_LOG: logPath,
    FAKE_ACP_SESSION_ID: 'external-paper-session',
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
    await expect(controller?.listModels()).resolves.toEqual([
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

  it('revokes the PaperAI MCP descriptor with the Agent lifecycle', async () => {
    const harness = await mountHarness()
    const handle = await createAgent(harness, 'mcp-lease-disposal')
    expect(harness.mcp.leases[0]?.disposed).toBe(false)
    await handle.dispose()
    expect(harness.mcp.leases[0]?.disposed).toBe(true)
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

  it('tears down the Agent and Session through the public handle without hanging', async () => {
    await runLifecycleProbe('dispose')
  }, 10_000)

  it('rolls back a failed ACP startup so the same route and session id can be retried', async () => {
    await runLifecycleProbe('startup-rollback')
  }, 10_000)
})

describe('ACP permission policy projection', { concurrent: false }, () => {
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
})

describe('ACP Agent settings and secret handling', { concurrent: false }, () => {
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
      },
      {
        openAiApiKey: 'codex-key-v2',
        anthropicApiKey: null,
        openAiBaseUrl: 'https://openai.v2',
        anthropicBaseUrl: null,
      },
    ])
    expect(claude.map(entry => entry['environment'])).toEqual([{
      openAiApiKey: null,
      anthropicApiKey: 'claude-key-v1',
      openAiBaseUrl: null,
      anthropicBaseUrl: 'https://anthropic.v1',
    }])
  }, 30_000)
})
