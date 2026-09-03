import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import {
  DocumentCommitId,
  DocumentId,
  ProjectId,
  TemplateContractId,
  type ActorIdentity,
  type DocumentCommit,
  type DocumentMutation,
  type GateReport,
} from '@paperai/domain'
import { PAPERAI_MCP_TOOL_NAMES } from '@paperai/mcp'
import * as tool from '../src/index.ts'

const testSignal = new AbortController().signal

const TOOL_NAMES = [
  'paperai_list_projects',
  'paperai_list_documents',
  'paperai_read_document',
  'paperai_list_templates',
  'paperai_get_template',
  'paperai_list_versions',
  'paperai_check_gate',
  'paperai_prepare_export',
  'paperai_commit_document',
  'paperai_revert_document',
] as const

const WORKSPACE_ROOT = 'C:\\papers\\thesis'
const OTHER_ROOT = 'C:\\papers\\other'

const project = { id: ProjectId('project-1'), name: '硕士论文', rootPath: WORKSPACE_ROOT }
const otherProject = { id: ProjectId('project-2'), name: '别人的论文', rootPath: OTHER_ROOT }

const document = {
  id: DocumentId('document-1'),
  projectId: project.id,
  name: '开题报告',
  role: 'proposal',
  workingPath: 'C:\\papers\\thesis\\documents\\working\\proposal.docx',
  headCommitId: DocumentCommitId('commit-root'),
}

const foreignDocument = {
  ...document,
  id: DocumentId('document-2'),
  projectId: otherProject.id,
  name: '他人开题',
  workingPath: 'C:\\papers\\other\\documents\\working\\proposal.docx',
}

const nodes = [
  { id: 'node-1', text: '第一段', style: { font: '宋体' } },
  { id: 'node-2', text: '第二段', style: { font: '宋体' } },
  { id: 'node-3', text: '第三段', style: { font: '宋体' } },
]

function gate(status: GateReport['status'], mode: GateReport['mode'] = 'continuous'): GateReport {
  return {
    status,
    mode,
    documentId: document.id,
    templateId: TemplateContractId('contract-1'),
    findings: status === 'fail'
      ? [{ id: 'finding-1', severity: 'error', code: 'REQUIRED', message: 'missing section' }]
      : [],
    checkedAt: '2026-09-01T00:00:00.000Z',
  }
}

function commitOf(actor: ActorIdentity): DocumentCommit {
  return {
    id: DocumentCommitId('commit-next'),
    documentId: document.id,
    parentId: DocumentCommitId('commit-root'),
    message: 'from test',
    actor: structuredClone(actor),
    snapshotPath: 'history\\commit-next.docx',
    documentSha256: 'a'.repeat(64),
    gate: gate('pass'),
    operations: [],
    createdAt: '2026-09-01T00:01:00.000Z',
  }
}

interface FakeAgentInput {
  readonly options?: Agent['options']
  /** The route the session's latest durable request header names. */
  readonly header?: { provider: string; model: string } | undefined
  readonly cwd?: string
}

function fakeAgent({
  options = { provider: 'deepseek', model: 'deepseek-chat' },
  header,
  cwd = WORKSPACE_ROOT,
}: FakeAgentInput = {}): Agent {
  return {
    id: 'session-7',
    options,
    session: {
      id: 'session-7',
      header: { cwd },
      events: [],
      requestHeader: () => header === undefined ? undefined : { config: header },
    },
  } as unknown as Agent
}

interface Harness {
  readonly ctx: Context
  readonly submit: ReturnType<typeof vi.fn>
  readonly revert: ReturnType<typeof vi.fn>
  readonly check: ReturnType<typeof vi.fn>
  /** The sandbox mode the policy resolves for every call. */
  sandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access'
}

async function setup(config: tool.Config = {}): Promise<Harness> {
  const ctx = new Context()
  const submit = vi.fn(async (request: { actor: ActorIdentity }) => commitOf(request.actor))
  const revert = vi.fn(async (request: { actor: ActorIdentity }) => commitOf(request.actor))
  const check = vi.fn(async (request: { mode: GateReport['mode'] }) => gate('fail', request.mode))
  const harness = { ctx, submit, revert, check, sandboxMode: 'workspace-write' } as Harness
  ctx.provide('sandboxPolicy', {
    // The real policy folds the session's `sandbox/mode` log over the deployment default;
    // the fake mirrors its shape: the session cwd is the workspace root.
    resolve: (request: { session?: { header: { cwd?: string } } }) => ({
      mode: harness.sandboxMode,
      workspaceRoot: request.session?.header.cwd ?? 'C:\\fallback',
    }),
  } as never)
  ctx.provide('paperProjects', {
    get: (id: string) => [project, otherProject].find(entry => String(entry.id) === id),
    list: () => [project, otherProject],
    resolveForPath: (path: string) => Promise.resolve(
      [project, otherProject].find(entry => path === entry.rootPath || path.startsWith(`${entry.rootPath}\\`)),
    ),
  } as never)
  ctx.provide('paperDocuments', {
    listDocuments: vi.fn((projectId: string) => (
      [document, foreignDocument].filter(entry => String(entry.projectId) === projectId)
    )),
    readDocument: (id: string) => {
      const found = [document, foreignDocument].find(entry => String(entry.id) === id)
      return found === undefined ? undefined : { document: found, nodes }
    },
  } as never)
  ctx.provide('paperTemplates', {
    listPacks: () => [{ id: 'hit-master' }],
    listContracts: () => [{ id: 'contract-1' }],
    getContract: (id: string) => id === 'contract-1'
      ? { id, name: 'HIT 硕士模板', projectId: project.id }
      : id === 'contract-2'
        ? { id, name: '别人的模板', projectId: otherProject.id }
        : undefined,
    check,
  } as never)
  ctx.provide('paperCommits', {
    listHistory: () => [commitOf({ kind: 'human', name: '用户' })],
    submit,
    revert,
  } as never)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(tool, config)
  return harness
}

let callCounter = 0
function call(ctx: Context, name: string, args: unknown, agent: Agent | null = fakeAgent()) {
  return ctx.tools.execute({
    signal: testSignal,
    callId: CallId(`call-${++callCounter}`),
    name,
    arguments: args,
    ...(agent === null ? {} : { agent }),
  })
}

function errorText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
}

describe('paperai-tool-document', () => {
  it('registers the complete PaperAI vocabulary with the MCP tool names', async () => {
    const { ctx } = await setup()
    const names = ctx.tools.schemas().map(schema => schema.name)
    for (const name of TOOL_NAMES) expect(names).toContain(name)
    expect(names.filter(name => name.startsWith('paperai_')).sort()).toEqual([...PAPERAI_MCP_TOOL_NAMES].sort())
    const commitSchema = ctx.tools.schemas().find(schema => schema.name === 'paperai_commit_document')
    const mutations = (commitSchema?.parameters as { properties: Record<string, { items?: { oneOf?: unknown[] } }> })
      .properties.mutations
    expect(mutations?.items?.oneOf).toHaveLength(5)
  })

  it('reads bounded pages, strips styles unless requested, and reports the next offset', async () => {
    const { ctx } = await setup()
    const first = await call(ctx, 'paperai_read_document', { documentId: 'document-1', limit: 2 })
    expect(first.isError).toBe(false)
    expect(first.value).toMatchObject({
      document: { id: 'document-1' },
      nodes: [{ id: 'node-1', text: '第一段' }, { id: 'node-2', text: '第二段' }],
      page: { offset: 0, count: 2, total: 3, nextOffset: 2 },
    })
    expect((first.value as { nodes: Record<string, unknown>[] }).nodes[0]).not.toHaveProperty('style')

    const rest = await call(ctx, 'paperai_read_document', { documentId: 'document-1', offset: 2, includeStyle: true })
    expect(rest.value).toMatchObject({
      nodes: [{ id: 'node-3', style: { font: '宋体' } }],
      page: { offset: 2, count: 1, total: 3, nextOffset: null },
    })

    const missing = await call(ctx, 'paperai_read_document', { documentId: 'document-x' })
    expect(missing.isError).toBe(true)
  })

  it('lists only the session project, its documents, templates, and versions', async () => {
    const { ctx } = await setup()
    expect((await call(ctx, 'paperai_list_projects', {})).value).toEqual({ projects: [project] })
    expect((await call(ctx, 'paperai_list_documents', { projectId: 'project-1', role: 'proposal' })).value)
      .toMatchObject({ documents: [{ id: 'document-1' }] })
    expect((await call(ctx, 'paperai_list_templates', { projectId: 'project-1' })).value)
      .toEqual({ packs: [{ id: 'hit-master' }], contracts: [{ id: 'contract-1' }] })
    expect((await call(ctx, 'paperai_get_template', { templateId: 'contract-1' })).value)
      .toEqual({ template: { id: 'contract-1', name: 'HIT 硕士模板', projectId: 'project-1' } })
    expect((await call(ctx, 'paperai_get_template', { templateId: 'contract-x' })).isError).toBe(true)
    expect((await call(ctx, 'paperai_list_versions', { documentId: 'document-1' })).value)
      .toMatchObject({ commits: [{ id: 'commit-next' }] })
  })

  it('refuses every record outside the project that owns the session workspace', async () => {
    const { ctx, submit, revert, check } = await setup()
    const foreign = [
      call(ctx, 'paperai_list_documents', { projectId: 'project-2' }),
      call(ctx, 'paperai_list_templates', { projectId: 'project-2' }),
      call(ctx, 'paperai_get_template', { templateId: 'contract-2' }),
      call(ctx, 'paperai_read_document', { documentId: 'document-2' }),
      call(ctx, 'paperai_list_versions', { documentId: 'document-2' }),
      call(ctx, 'paperai_check_gate', { documentId: 'document-2', mode: 'continuous' }),
      call(ctx, 'paperai_prepare_export', { documentId: 'document-2', mode: 'draft-export' }),
      call(ctx, 'paperai_commit_document', {
        documentId: 'document-2',
        message: 'x',
        mutations: [{ type: 'milestone', label: 'x' }],
      }),
      call(ctx, 'paperai_revert_document', { documentId: 'document-2', baseCommitId: 'a', targetCommitId: 'b' }),
    ]
    for (const result of await Promise.all(foreign)) {
      expect(result.isError).toBe(true)
      expect(errorText(result)).toContain('PROJECT_OUT_OF_SCOPE')
    }
    expect(submit).not.toHaveBeenCalled()
    expect(revert).not.toHaveBeenCalled()
    expect(check).not.toHaveBeenCalled()

    // A session opened outside every project has no document scope at all.
    const homeless = await call(ctx, 'paperai_list_projects', {}, fakeAgent({ cwd: 'C:\\elsewhere' }))
    expect(homeless.isError).toBe(true)
    expect(errorText(homeless)).toContain('NO_PROJECT_FOR_SESSION')
    // A session inside a subdirectory of the project still resolves to it.
    const nested = await call(ctx, 'paperai_list_projects', {}, fakeAgent({ cwd: `${WORKSPACE_ROOT}\\chapters` }))
    expect(nested.value).toEqual({ projects: [project] })
  })

  it('keeps reads open but refuses mutations under the read-only sandbox mode', async () => {
    const harness = await setup()
    harness.sandboxMode = 'read-only'
    const { ctx, submit, revert } = harness
    expect((await call(ctx, 'paperai_read_document', { documentId: 'document-1' })).isError).toBe(false)
    expect((await call(ctx, 'paperai_check_gate', { documentId: 'document-1', mode: 'continuous' })).isError).toBe(false)

    const committed = await call(ctx, 'paperai_commit_document', {
      documentId: 'document-1',
      message: 'x',
      mutations: [{ type: 'milestone', label: 'x' }],
    })
    expect(committed.isError).toBe(true)
    expect(errorText(committed)).toContain('READ_ONLY_SESSION')
    const reverted = await call(ctx, 'paperai_revert_document', {
      documentId: 'document-1', baseCommitId: 'commit-root', targetCommitId: 'commit-old',
    })
    expect(reverted.isError).toBe(true)
    expect(errorText(reverted)).toContain('READ_ONLY_SESSION')
    expect(submit).not.toHaveBeenCalled()
    expect(revert).not.toHaveBeenCalled()

    harness.sandboxMode = 'danger-full-access'
    expect((await call(ctx, 'paperai_commit_document', {
      documentId: 'document-1', message: 'x', mutations: [{ type: 'milestone', label: 'x' }],
    })).isError).toBe(false)
    // Full access widens the filesystem, not the document scope.
    expect(errorText(await call(ctx, 'paperai_read_document', { documentId: 'document-2' })))
      .toContain('PROJECT_OUT_OF_SCOPE')
  })

  it('checks gates and gates the delivery export decision on active errors', async () => {
    const { ctx, check } = await setup()
    const report = await call(ctx, 'paperai_check_gate', { documentId: 'document-1', mode: 'continuous' })
    expect(report.value).toMatchObject({ report: { mode: 'continuous', status: 'fail' } })

    const delivery = await call(ctx, 'paperai_prepare_export', { documentId: 'document-1', mode: 'delivery-export' })
    expect(delivery.value).toMatchObject({
      allowed: false,
      sourcePath: document.workingPath,
      suggestedFileName: '开题报告.docx',
      headCommitId: 'commit-root',
    })
    const draft = await call(ctx, 'paperai_prepare_export', { documentId: 'document-1', mode: 'draft-export' })
    expect(draft.value).toMatchObject({ allowed: true })
    expect(check).toHaveBeenCalledTimes(3)
  })

  it('maps every mutation variant and stamps DSH session provenance on commits', async () => {
    const { ctx, submit } = await setup()
    const result = await call(ctx, 'paperai_commit_document', {
      documentId: 'document-1',
      baseCommitId: 'commit-root',
      message: '完善第三章',
      mutations: [
        { type: 'replace-text', nodeId: 'node-1', baseText: '第一段', nextText: '新的第一段' },
        { type: 'insert-node', text: '新增段落', afterNodeId: 'node-2', style: 'Body Text' },
        { type: 'delete-node', nodeId: 'node-3', baseText: '第三段' },
        { type: 'bind-template', templateId: 'contract-1' },
        { type: 'milestone', label: '第三章初稿' },
      ],
    })
    expect(result.isError).toBe(false)
    const request = (submit.mock.calls[0] as unknown[])[0] as {
      actor: ActorIdentity
      mutations: DocumentMutation[]
      baseCommitId: string
      message: string
    }
    expect(request.message).toBe('完善第三章')
    expect(request.baseCommitId).toBe('commit-root')
    expect(request.mutations.map(mutation => mutation.type)).toEqual([
      'replace-text', 'insert-node', 'delete-node', 'bind-template', 'milestone',
    ])
    expect(request.actor).toEqual({
      kind: 'agent',
      name: 'DSH',
      client: 'dsh',
      sessionId: 'session-7',
      provider: 'deepseek',
      model: 'deepseek-chat',
    })
    expect(result.value).toMatchObject({
      commit: { id: 'commit-next' },
      provenance: { client: 'dsh' },
      gateSummary: { status: 'pass', nextActions: '门禁通过，可继续写作。' },
    })
    const rendered = result.content.filter(block => block.type === 'text').map(block => block.text).join('')
    expect(rendered).toContain('已提交版本 commit-next')
    expect(rendered).toContain('门禁通过')
  })

  it('records the route of the current durable request header, not the creation route', async () => {
    const { ctx, submit } = await setup()
    // The picker switched the session to another model: the request header
    // logged before this turn's model call names it, `agent.options` does not.
    const switched = fakeAgent({
      options: { provider: 'deepseek', model: 'deepseek-chat' },
      header: { provider: 'deepseek', model: 'deepseek-reasoner' },
    })
    const result = await call(ctx, 'paperai_commit_document', {
      documentId: 'document-1',
      message: '换模型后的修改',
      mutations: [{ type: 'milestone', label: 'x' }],
    }, switched)
    expect(result.isError).toBe(false)
    const request = (submit.mock.calls[0] as unknown[])[0] as { actor: ActorIdentity }
    expect(request.actor).toMatchObject({ provider: 'deepseek', model: 'deepseek-reasoner' })
  })

  it('reverts through the commit service with the same provenance and digest', async () => {
    const { ctx, revert } = await setup()
    const result = await call(ctx, 'paperai_revert_document', {
      documentId: 'document-1',
      baseCommitId: 'commit-root',
      targetCommitId: 'commit-old',
      message: '回退到审阅版',
    }, fakeAgent({ options: {} }))
    expect(result.isError).toBe(false)
    const request = (revert.mock.calls[0] as unknown[])[0] as { actor: ActorIdentity; targetCommitId: string }
    expect(request.targetCommitId).toBe('commit-old')
    expect(request.actor).toEqual({ kind: 'agent', name: 'DSH', client: 'dsh', sessionId: 'session-7' })
    expect(result.value).toMatchObject({ gateSummary: { status: 'pass' } })
  })

  it('rejects agentless calls, ambiguous insertion, and out-of-bounds batches', async () => {
    const { ctx, submit } = await setup({ maxMutationsPerCommit: 2 })
    const base = { documentId: 'document-1', message: 'x' }
    const replace = { type: 'replace-text', nodeId: 'node-1', baseText: 'a', nextText: 'b' }

    const agentless = await call(ctx, 'paperai_commit_document', { ...base, mutations: [replace] }, null)
    expect(agentless.isError).toBe(true)
    expect((await call(ctx, 'paperai_read_document', { documentId: 'document-1' }, null)).isError).toBe(true)

    const ambiguous = await call(ctx, 'paperai_commit_document', {
      ...base,
      mutations: [{ type: 'insert-node', text: 'x', afterNodeId: 'a', beforeNodeId: 'b' }],
    })
    expect(ambiguous.isError).toBe(true)

    const empty = await call(ctx, 'paperai_commit_document', { ...base, mutations: [] })
    expect(empty.isError).toBe(true)
    const oversized = await call(ctx, 'paperai_commit_document', {
      ...base,
      mutations: [replace, replace, replace],
    })
    expect(oversized.isError).toBe(true)
    expect(submit).not.toHaveBeenCalled()
  })

  it('fails loud on invalid deployment limits', async () => {
    await expect(setup({ defaultNodesPerRead: 300, maxNodesPerRead: 100 })).rejects.toThrow(/must not exceed/)
    await expect(setup({ maxMutationsPerCommit: 0 })).rejects.toThrow(/positive safe integer/)
  })
})
