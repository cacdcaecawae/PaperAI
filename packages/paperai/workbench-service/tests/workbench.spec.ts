import { Context } from '@deepseek-ai/cordis'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import {
  DocumentCommitId,
  DocumentId,
  DocumentNodeId,
  ProjectId,
  TemplateContractId,
} from '@paperai/domain'
import type {
  DocumentCommit,
  DocumentNode,
  DocumentRecord,
  GateReport,
  ProjectRecord,
  TemplateContract,
} from '@paperai/domain'
import { PaperExportError, type ExportDocumentResult } from '@paperai/export-service'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import PaperAiWorkbenchService from '../src/index.ts'
import type {
  PaperAIDocumentCommitId,
  PaperAIDocumentNodeId,
  PaperAIDocumentRevision,
  PaperAIResourceId,
} from '../src/types.ts'

const WORKSPACE_ID = WorkspaceId('workspace-1')
const SESSION_ID = SessionId('session-1')
const PROJECT_ID = ProjectId('project-1')
const DOCUMENT_ID = DocumentId('document-1')
const NODE_ID = DocumentNodeId('node-1')

interface MockCommitRequest {
  readonly baseCommitId?: ReturnType<typeof DocumentCommitId>
  readonly actor?: DocumentCommit['actor']
  readonly signal?: AbortSignal
  readonly mutations: readonly {
    readonly type?: string
    readonly nodeId?: ReturnType<typeof DocumentNodeId>
    readonly nextText?: string
    readonly templateId?: ReturnType<typeof TemplateContractId>
  }[]
}

interface MockRevertRequest {
  readonly baseCommitId: ReturnType<typeof DocumentCommitId>
  readonly targetCommitId?: ReturnType<typeof DocumentCommitId>
  readonly actor?: DocumentCommit['actor']
}

interface Harness {
  readonly ctx: Context
  readonly service: PaperAiWorkbenchService
  readonly project: ProjectRecord
  document: DocumentRecord
  nodes: DocumentNode[]
  history: DocumentCommit[]
  readonly submit: Mock<(request: MockCommitRequest) => Promise<DocumentCommit>>
  readonly rollbackImport: Mock<(documentId: ReturnType<typeof DocumentId>) => Promise<void>>
  readonly revert: Mock<(request: MockRevertRequest) => Promise<DocumentCommit>>
  readonly check: ReturnType<typeof vi.fn>
  readonly exportDocument: ReturnType<typeof vi.fn>
  readonly importDocument: Mock<(request: MockImportRequest) => Promise<unknown>>
  readonly installPack: Mock<(input: { readonly memberIds?: readonly string[] }) => Promise<TemplateContract[]>>
  readonly previewHtml: Mock<() => Promise<string>>
  contracts: TemplateContract[]
  /** Template-source record returned for `template-source`; undefined until a test stores one. */
  templateSource: DocumentRecord | undefined
}

interface MockImportRequest {
  readonly sourcePath: string
  readonly role: string
  readonly name?: string
}

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((fulfill) => { resolve = fulfill })
  return { promise, resolve }
}

function openDocument(harness: Harness) {
  return harness.service.open({
    workspaceId: WORKSPACE_ID,
    sessionId: SESSION_ID,
    resourceId: `document:${DOCUMENT_ID}` as PaperAIResourceId,
  })
}

function validateDocument(
  harness: Harness,
  document: {
    readonly revision: PaperAIDocumentRevision
    readonly headCommitId: PaperAIDocumentCommitId | null
  },
) {
  return harness.service.validate({
    sessionId: SESSION_ID,
    documentId: DOCUMENT_ID,
    revision: document.revision,
    headCommitId: document.headCommitId,
  })
}

function deferSubmitSettlement(
  operation: Harness['submit'],
): { readonly published: Promise<DocumentCommit>; readonly settle: (commit: DocumentCommit) => void } {
  const implementation = operation.getMockImplementation()
  if (implementation === undefined) throw new Error('submit operation has no mock implementation')
  const published = deferred<DocumentCommit>()
  const settlement = deferred<DocumentCommit>()
  operation.mockImplementationOnce(async (request) => {
    const commit = await implementation(request)
    published.resolve(commit)
    return await settlement.promise
  })
  return { published: published.promise, settle: settlement.resolve }
}

function deferRevertSettlement(
  operation: Harness['revert'],
): { readonly published: Promise<DocumentCommit>; readonly settle: (commit: DocumentCommit) => void } {
  const implementation = operation.getMockImplementation()
  if (implementation === undefined) throw new Error('revert operation has no mock implementation')
  const published = deferred<DocumentCommit>()
  const settlement = deferred<DocumentCommit>()
  operation.mockImplementationOnce(async (request) => {
    const commit = await implementation(request)
    published.resolve(commit)
    return await settlement.promise
  })
  return { published: published.promise, settle: settlement.resolve }
}

const contexts: Context[] = []
const roots: string[] = []

function commitRecord(id: string, parentId?: string): DocumentCommit {
  return {
    id: DocumentCommitId(id),
    documentId: DOCUMENT_ID,
    ...(parentId === undefined ? {} : { parentId: DocumentCommitId(parentId) }),
    message: `版本 ${id}`,
    actor: { kind: 'human', name: '用户', client: 'paperai', sessionId: SESSION_ID },
    snapshotPath: `F:\\paper\\snapshots\\${id}.docx`,
    documentSha256: `sha-${id}`,
    gate: {
      status: 'pass', mode: 'continuous', documentId: DOCUMENT_ID, findings: [], checkedAt: '2026-08-28T00:00:00.000Z',
    },
    operations: [],
    createdAt: '2026-08-28T00:00:00.000Z',
  }
}

function createHarness(rootPath = 'F:\\paper'): Harness {
  const ctx = new Context()
  contexts.push(ctx)
  const project: ProjectRecord = {
    id: PROJECT_ID,
    workspaceId: WORKSPACE_ID,
    name: '硕士论文',
    rootPath,
    createdAt: '2026-08-28T00:00:00.000Z',
    updatedAt: '2026-08-28T00:00:00.000Z',
  }
  const harness = {} as Harness
  harness.document = {
    id: DOCUMENT_ID,
    projectId: PROJECT_ID,
    documentKind: 'working',
    name: '开题报告',
    role: 'proposal',
    immutableSourcePath: join(rootPath, 'documents', 'source', '开题报告.docx'),
    workingPath: join(rootPath, 'documents', 'working', '开题报告.docx'),
    mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    sourceSha256: 'source-sha',
    nodeCount: 1,
    createdAt: '2026-08-28T00:00:00.000Z',
    updatedAt: '2026-08-28T00:00:00.000Z',
  }
  harness.nodes = [{
    id: NODE_ID,
    documentId: DOCUMENT_ID,
    officePath: '/body/p[1]',
    ordinal: 0,
    kind: 'paragraph',
    text: '原始段落',
    style: {},
    hash: 'node-sha',
    lineage: [NODE_ID],
    updatedAt: '2026-08-28T00:00:00.000Z',
  }]
  harness.history = []
  harness.contracts = []

  const submit = vi.fn(async (request: MockCommitRequest) => {
    expect(request.baseCommitId).toBe(harness.document.headCommitId)
    const next = commitRecord(`commit-${harness.history.length + 1}`, harness.document.headCommitId)
    harness.history = [next, ...harness.history]
    harness.document = {
      ...harness.document,
      headCommitId: next.id,
      updatedAt: `2026-08-28T00:00:0${harness.history.length}.000Z`,
    }
    for (const mutation of request.mutations) {
      if (mutation.nodeId !== undefined && mutation.nextText !== undefined) {
        harness.nodes = harness.nodes.map(node => node.id === mutation.nodeId
          ? { ...node, text: mutation.nextText!, lastCommitId: next.id }
          : node)
      }
      if (mutation.type === 'bind-template' && mutation.templateId !== undefined) {
        harness.document = { ...harness.document, templateId: mutation.templateId }
      }
    }
    return next
  })
  const revert = vi.fn(async (request: MockRevertRequest) => {
    expect(request.baseCommitId).toBe(harness.document.headCommitId)
    const next = commitRecord(`commit-${harness.history.length + 1}`, harness.document.headCommitId)
    harness.history = [next, ...harness.history]
    harness.document = { ...harness.document, headCommitId: next.id, updatedAt: '2026-08-28T00:00:09.000Z' }
    return next
  })
  const check = vi.fn(async () => ({
    status: 'fail' as const,
    mode: 'continuous' as const,
    documentId: DOCUMENT_ID,
    findings: [{
      id: 'required-title', severity: 'error' as const, code: 'required-field', message: '缺少题目',
    }],
    checkedAt: '2026-08-28T00:01:00.000Z',
  }))
  const rollbackImport = vi.fn(async (_documentId: ReturnType<typeof DocumentId>) => {})
  const previewHtml = vi.fn(async () => '<html><body><p>只读预览</p></body></html>')
  const importDocument = vi.fn(async (request: MockImportRequest) => {
    expect(await readFile(request.sourcePath, 'utf8')).toBe('word-upload')
    return {
      status: 'imported' as const,
      document: structuredClone(harness.document),
      nodes: structuredClone(harness.nodes),
    }
  })
  const installPack = vi.fn(async (_input: { readonly memberIds?: readonly string[] }) => {
    harness.contracts = [templateContract()]
    return structuredClone(harness.contracts)
  })
  harness.templateSource = undefined

  ctx.provide('workspaceRegistry', {
    get: (id: typeof WORKSPACE_ID) => id === WORKSPACE_ID
      ? { id: WORKSPACE_ID, path: project.rootPath, title: project.name }
      : undefined,
  } as never)
  ctx.provide('paperProjects', {
    create: async () => ({ project, projectCreated: false, contextFile: 'preserved', git: { status: 'ready' } }),
    get: (id: typeof PROJECT_ID) => id === PROJECT_ID ? project : undefined,
  } as never)
  ctx.provide('paperDocuments', {
    listDocuments: () => [harness.document],
    readDocument: (id: typeof DOCUMENT_ID) => id === DOCUMENT_ID
      ? { document: structuredClone(harness.document), nodes: structuredClone(harness.nodes) }
      : undefined,
    previewHtml,
    importDocument,
    rollbackImport,
  } as never)
  ctx.provide('paperCommits', {
    listHistory: () => structuredClone(harness.history),
    submit,
    revert,
  } as never)
  ctx.provide('paperTemplates', {
    listPacks: () => [{
      id: 'hit-master-thesis', name: 'HIT 硕士毕设', description: '校级模板', version: 'v1', sourceLabel: 'HIT',
      members: [{
        id: 'proposal', name: '开题报告', description: '开题模板', appliesToRoles: ['proposal'],
        usage: 'form-template', sourceVersion: 'v1', originalFileName: '开题.doc', sourceSha256: 'sha',
      }],
    }],
    listContracts: () => structuredClone(harness.contracts),
    getContract: (id: ReturnType<typeof TemplateContractId>) => harness.contracts.find(item => item.id === id),
    installPack,
    upload: async () => {
      harness.contracts = [templateContract('uploaded')]
      return structuredClone(harness.contracts[0])
    },
    confirm: async (id: ReturnType<typeof TemplateContractId>) => {
      harness.contracts = harness.contracts.map(item => item.id === id ? { ...item, status: 'confirmed' } : item)
      return structuredClone(harness.contracts.find(item => item.id === id))
    },
    check,
  } as never)
  const exportDocument = vi.fn(
    async (request: { destinationPath: string; mode: 'draft-export' | 'delivery-export' }) => {
      const next = await submit({
        ...(harness.document.headCommitId === undefined
          ? {}
          : { baseCommitId: harness.document.headCommitId }),
        mutations: [{ type: 'milestone' }],
      })
      return {
        outputPath: request.destinationPath,
        report: {
          status: 'pass' as const,
          mode: request.mode,
          documentId: DOCUMENT_ID,
          findings: [],
          checkedAt: '2026-08-28T00:02:00.000Z',
        },
        gate: {
          status: 'pass' as const,
          mode: request.mode,
          documentId: DOCUMENT_ID,
          findings: [],
          checkedAt: '2026-08-28T00:02:00.000Z',
        },
        commit: next,
      }
    },
  )
  ctx.provide('paperExports', { exportDocument } as never)
  ctx.provide('paperRepository', {
    getCommit: (id: ReturnType<typeof DocumentCommitId>) => (
      harness.history.find(commit => commit.id === id)
    ),
    getDocument: (id: ReturnType<typeof DocumentId>) => (
      id === DocumentId('template-source') ? harness.templateSource : undefined
    ),
  } as never)
  const service = new PaperAiWorkbenchService(ctx)
  Object.assign(harness, {
    ctx, service, project, submit, rollbackImport, revert, check, exportDocument, importDocument, installPack,
    previewHtml,
  })
  return harness
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async (ctx) => { await ctx.fiber.dispose() }))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function templateContract(origin: 'built-in' | 'uploaded' = 'built-in'): TemplateContract {
  const id = TemplateContractId('template-1')
  return {
    id,
    projectId: PROJECT_ID,
    name: origin === 'built-in' ? 'HIT 开题报告' : '自定义开题模板',
    sourceDocumentId: DocumentId('template-source'),
    version: 1,
    rules: [],
    slots: [],
    fixedNodeIds: [],
    instructionNodeIds: [],
    pageSetup: {},
    styleMap: {},
    origin: {
      kind: origin === 'built-in' ? 'built-in' : 'upload',
      label: '模板', originalFileName: '模板.docx',
    },
    appliesToRoles: ['proposal'],
    usage: 'form-template',
    status: 'draft',
    createdAt: '2026-08-28T00:00:00.000Z',
    updatedAt: '2026-08-28T00:00:00.000Z',
  }
}

describe('PaperAiWorkbenchService', () => {
  it('initializes one selected DSH Workspace and projects real resources', async () => {
    const root = await mkdtemp(join(tmpdir(), 'paperai-workbench-resources-'))
    roots.push(root)
    await Promise.all([
      mkdir(join(root, 'figures', 'chapter-1'), { recursive: true }),
      mkdir(join(root, 'experiments', 'data'), { recursive: true }),
      mkdir(join(root, 'experiments', 'empty'), { recursive: true }),
      mkdir(join(root, 'code', 'src'), { recursive: true }),
      mkdir(join(root, 'code', 'empty'), { recursive: true }),
      mkdir(join(root, 'documents', 'working'), { recursive: true }),
      mkdir(join(root, 'templates'), { recursive: true }),
    ])
    await Promise.all([
      writeFile(join(root, 'figures', 'chapter-1', 'diagram.png'), 'figure'),
      writeFile(join(root, 'experiments', 'data', 'samples.csv'), 'experiment'),
      writeFile(join(root, 'code', 'src', 'analyze.ts'), 'code'),
      writeFile(join(root, 'documents', 'working', 'unregistered.docx'), 'not-a-domain-document'),
      writeFile(join(root, 'templates', 'raw.docx'), 'not-a-contract'),
    ])
    const harness = createHarness(root)
    harness.contracts = [templateContract()]
    const listed = await harness.service.list({ workspaceId: WORKSPACE_ID })
    expect(listed.workspaceId).toBe(WORKSPACE_ID)
    expect(listed.resources.filter(resource => resource.category === 'document')).toEqual([
      expect.objectContaining({ id: `document:${DOCUMENT_ID}`, openable: true }),
    ])
    expect(listed.resources.filter(resource => resource.category === 'template')).toEqual([
      expect.objectContaining({ id: 'template:template-1', openable: false }),
    ])
    expect(listed.resources.filter(resource => (
      resource.category !== 'document' && resource.category !== 'template'
    ))).toEqual([
      expect.objectContaining({ category: 'image', kind: 'folder', path: 'figures', depth: 0 }),
      expect.objectContaining({ category: 'image', kind: 'folder', path: 'figures/chapter-1', depth: 1 }),
      expect.objectContaining({ category: 'image', kind: 'file', path: 'figures/chapter-1/diagram.png', depth: 2 }),
      expect.objectContaining({ category: 'experiment', kind: 'folder', path: 'experiments', depth: 0 }),
      expect.objectContaining({ category: 'experiment', kind: 'folder', path: 'experiments/data', depth: 1 }),
      expect.objectContaining({ category: 'experiment', kind: 'file', path: 'experiments/data/samples.csv', depth: 2 }),
      expect.objectContaining({ category: 'code', kind: 'folder', path: 'code', depth: 0 }),
      expect.objectContaining({ category: 'code', kind: 'folder', path: 'code/src', depth: 1 }),
      expect.objectContaining({ category: 'code', kind: 'file', path: 'code/src/analyze.ts', depth: 2 }),
    ])
    expect(listed.resources.some(resource => resource.path.includes('/empty'))).toBe(false)
    expect(listed.resources.some(resource => resource.name === 'unregistered.docx')).toBe(false)
    expect(listed.resources.some(resource => resource.name === 'raw.docx')).toBe(false)
  })

  it('emits JSON-safe document changes only for committed Working document puts', () => {
    const harness = createHarness()
    const seen: unknown[] = []
    harness.ctx.on('paperai/document-changed', (change) => { seen.push(structuredClone(change)) })
    const commit = commitRecord('commit-event')
    harness.history = [commit]
    const current = {
      ...harness.document,
      headCommitId: commit.id,
      updatedAt: '2026-08-28T00:03:00.000Z',
    }
    harness.ctx.emit('domain/changed', {
      domain: 'paperai', table: 'commits', key: commit.id, operation: 'put', value: commit,
    })
    harness.ctx.emit('domain/changed', {
      domain: 'paperai', table: 'documents', key: harness.document.id, operation: 'put', value: harness.document,
    })
    harness.ctx.emit('domain/changed', {
      domain: 'paperai', table: 'documents', key: current.id, operation: 'put',
      value: { ...current, documentKind: 'template-source' },
    })
    harness.ctx.emit('domain/changed', {
      domain: 'paperai', table: 'documents', key: current.id, operation: 'put', value: current,
    })
    expect(seen).toEqual([{
      documentId: DOCUMENT_ID,
      headCommitId: commit.id,
      updatedAt: '2026-08-28T00:03:00.000Z',
    }])
    expect(JSON.parse(JSON.stringify(seen[0]))).toEqual(seen[0])
  })

  it('contains document change listener failures without interrupting durable change observers', () => {
    const harness = createHarness()
    const commit = commitRecord('commit-event-listener-failure')
    harness.history = [commit]
    const current = {
      ...harness.document,
      headCommitId: commit.id,
      updatedAt: '2026-08-28T00:04:00.000Z',
    }
    let durableObserverRan = false
    harness.ctx.on('paperai/document-changed', () => { throw new Error('projection failed') })
    harness.ctx.on('domain/changed', () => { durableObserverRan = true })

    expect(() => {
      harness.ctx.emit('domain/changed', {
        domain: 'paperai', table: 'documents', key: current.id, operation: 'put', value: current,
      })
    }).not.toThrow()
    expect(durableObserverRan).toBe(true)
  })

  it('opens read-only preview and edits only one semantic node through a commit', async () => {
    const harness = createHarness()
    const opened = await harness.service.open({
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      resourceId: `document:${DOCUMENT_ID}` as PaperAIResourceId,
    })
    expect(opened.document.previewHtml).toContain('只读预览')
    expect(opened.selectedNode).toMatchObject({ format: 'text', nodeId: NODE_ID, text: '原始段落' })

    const committed = await harness.service.commit({
      sessionId: SESSION_ID,
      documentId: DOCUMENT_ID,
      baseRevision: opened.document.revision,
      baseCommitId: null,
      mutations: [{
        type: 'replace-text',
        nodeId: NODE_ID,
        baseText: '原始段落',
        nextText: '人工修改后的段落',
      }],
    })
    expect(harness.submit.mock.calls[0]?.[0].actor).toMatchObject({
      kind: 'human', client: 'paperai', sessionId: SESSION_ID,
    })
    expect(committed.selectedNode?.text).toBe('人工修改后的段落')
    expect(committed.document.versions[0]?.actor.name).toBe('用户')
    expect(committed.createdCommitId).toBe('commit-1')

    await expect(harness.service.readNode({
      sessionId: SESSION_ID,
      documentId: DOCUMENT_ID,
      nodeId: NODE_ID,
      revision: opened.document.revision,
      headCommitId: null,
    })).rejects.toThrow('changed; reload')
    await expect(harness.service.readNode({
      sessionId: SESSION_ID,
      documentId: DOCUMENT_ID,
      nodeId: NODE_ID,
      revision: committed.document.revision,
      headCommitId: committed.document.headCommitId,
    }, AbortSignal.abort())).rejects.toThrow('aborted')
  })

  it('runs a live gate and restores through a new recoverable commit', async () => {
    const harness = createHarness()
    const opened = await harness.service.open({
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      resourceId: `document:${DOCUMENT_ID}` as PaperAIResourceId,
    })
    const committed = await harness.service.commit({
      sessionId: SESSION_ID,
      documentId: DOCUMENT_ID,
      baseRevision: opened.document.revision,
      baseCommitId: null,
      mutations: [{
        type: 'replace-text', nodeId: NODE_ID,
        baseText: '原始段落', nextText: '版本一',
      }],
    })
    const gate = await harness.service.validate({
      sessionId: SESSION_ID,
      documentId: DOCUMENT_ID,
      revision: committed.document.revision,
      headCommitId: committed.document.headCommitId,
    })
    expect(gate.gate).toMatchObject({ status: 'failed', findings: [{ passed: false, message: '缺少题目' }] })
    expect(harness.check).toHaveBeenCalledOnce()

    const restored = await harness.service.restore({
      sessionId: SESSION_ID,
      documentId: DOCUMENT_ID,
      baseRevision: committed.document.revision,
      baseCommitId: committed.createdCommitId,
      targetCommitId: 'historical' as PaperAIDocumentCommitId,
    })
    expect(harness.revert.mock.calls[0]?.[0]).toMatchObject({
      actor: { kind: 'human', client: 'paperai' },
      targetCommitId: 'historical',
    })
    expect(restored.createdCommitId).toBe('commit-2')
  })

  it('rejects unknown Workspaces, resources, nodes, and unborn restores', async () => {
    const harness = createHarness()
    await expect(harness.service.list({ workspaceId: WorkspaceId('missing') })).rejects.toThrow('does not exist')
    await expect(harness.service.open({
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      resourceId: 'template:x' as PaperAIResourceId,
    })).rejects.toThrow('not an openable')
    await expect(harness.service.readNode({
      sessionId: SESSION_ID,
      documentId: DOCUMENT_ID,
      nodeId: 'missing' as PaperAIDocumentNodeId,
      revision: 'unborn:source-sha:2026-08-28T00:00:00.000Z' as PaperAIDocumentRevision,
      headCommitId: null,
    })).rejects.toThrow('does not belong')
    await expect(harness.service.restore({
      sessionId: SESSION_ID,
      documentId: DOCUMENT_ID,
      baseRevision: 'x' as PaperAIDocumentRevision,
      baseCommitId: null,
      targetCommitId: 'x' as PaperAIDocumentCommitId,
    })).rejects.toThrow('unborn document')
  })

  it('stages a browser Word upload, creates its root commit, and cleans staging', async () => {
    const root = await mkdtemp(join(tmpdir(), 'paperai-workbench-upload-'))
    roots.push(root)
    const harness = createHarness(root)
    const result = await harness.service.importDocument({
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      fileName: '开题报告.docx',
      contentBase64: Buffer.from('word-upload').toString('base64'),
      role: 'proposal',
    })
    expect(result).toMatchObject({ status: 'imported', createdCommitId: 'commit-1' })
    expect(harness.submit).toHaveBeenCalledWith(expect.objectContaining({
      mutations: [{ type: 'milestone', label: '导入 开题报告.docx' }],
    }))
    await expect(readFile(join(root, '.paperai', 'uploads', 'v1', 'missing'))).rejects.toThrow()

    await expect(harness.service.importDocument({
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      fileName: '../bad.docx',
      contentBase64: 'not-base64',
      role: 'proposal',
    })).rejects.toThrow('safe .doc or .docx')
  })

  it('treats the root commit as the commit point: a failed or cancelled preview still returns the created document', async () => {
    const root = await mkdtemp(join(tmpdir(), 'paperai-workbench-preview-'))
    roots.push(root)
    const harness = createHarness(root)
    harness.previewHtml.mockRejectedValueOnce(new Error('OfficeCLI preview crashed'))
    const controller = new AbortController()
    const request = {
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      fileName: '开题报告.docx',
      contentBase64: Buffer.from('word-upload').toString('base64'),
      role: 'proposal' as const,
    }
    harness.submit.mockImplementationOnce(async (submission) => {
      const implementation = harness.submit.getMockImplementation()
      if (implementation === undefined) throw new Error('submit has no implementation')
      // The caller gives up while the commit is being published: the commit
      // still lands, and the response must say so.
      controller.abort(new Error('caller cancelled'))
      return await implementation(submission)
    })

    const result = await harness.service.importDocument(request, controller.signal)
    expect(result).toMatchObject({ status: 'imported', createdCommitId: 'commit-1' })
    if (result.status !== 'imported') throw new Error('expected an imported document')
    expect(result.opened.document.previewHtml).toBe('')
    expect(result.opened.document.headCommitId).toBe('commit-1')
    expect(harness.rollbackImport).not.toHaveBeenCalled()
    expect(harness.previewHtml).toHaveBeenCalledWith(DOCUMENT_ID, undefined)
  })

  it('rolls back the imported document when root commit submission rejects', async () => {
    const root = await mkdtemp(join(tmpdir(), 'paperai-workbench-submit-reject-'))
    roots.push(root)
    const harness = createHarness(root)
    const failure = new Error('root commit rejected')
    harness.submit.mockRejectedValueOnce(failure)

    await expect(harness.service.importDocument({
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      fileName: '开题报告.docx',
      contentBase64: Buffer.from('word-upload').toString('base64'),
      role: 'proposal',
    })).rejects.toBe(failure)

    expect(harness.rollbackImport).toHaveBeenCalledOnce()
    expect(harness.rollbackImport).toHaveBeenCalledWith(DOCUMENT_ID)
    expect(await readdir(join(root, '.paperai', 'uploads', 'v1'))).toEqual([])
  })

  it('finishes import rollback after root commit submission is cancelled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'paperai-workbench-submit-cancel-'))
    roots.push(root)
    const harness = createHarness(root)
    const controller = new AbortController()
    const cancelled = new Error('root commit cancelled')
    harness.submit.mockImplementationOnce(async (request) => {
      controller.abort(cancelled)
      request.signal?.throwIfAborted()
      throw new Error('aborted submission continued')
    })

    await expect(harness.service.importDocument({
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      fileName: '开题报告.docx',
      contentBase64: Buffer.from('word-upload').toString('base64'),
      role: 'proposal',
    }, controller.signal)).rejects.toBe(cancelled)

    expect(harness.submit).toHaveBeenCalledWith(expect.objectContaining({ signal: controller.signal }))
    expect(harness.rollbackImport).toHaveBeenCalledOnce()
    expect(harness.rollbackImport.mock.calls[0]).toHaveLength(1)
    expect(await readdir(join(root, '.paperai', 'uploads', 'v1'))).toEqual([])
  })

  it('reports root submission and import rollback failures together', async () => {
    const root = await mkdtemp(join(tmpdir(), 'paperai-workbench-rollback-failure-'))
    roots.push(root)
    const harness = createHarness(root)
    const submissionFailure = new Error('root commit rejected')
    const rollbackFailure = new Error('import rollback failed')
    harness.submit.mockRejectedValueOnce(submissionFailure)
    harness.rollbackImport.mockRejectedValueOnce(rollbackFailure)

    let failure: unknown
    try {
      await harness.service.importDocument({
        workspaceId: WORKSPACE_ID,
        sessionId: SESSION_ID,
        fileName: '开题报告.docx',
        contentBase64: Buffer.from('word-upload').toString('base64'),
        role: 'proposal',
      })
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(AggregateError)
    if (!(failure instanceof AggregateError)) throw new Error('expected aggregate rollback failure')
    expect(failure.errors).toEqual([submissionFailure, rollbackFailure])
    expect(failure.message).toContain('root commit and import rollback failed')
  })

  it('starts a document from a built-in form template and binds it in the root commit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'paperai-workbench-template-start-'))
    roots.push(root)
    const harness = createHarness(root)
    const templatePath = join(root, 'templates', 'hit-proposal.docx')
    await mkdir(join(root, 'templates'), { recursive: true })
    await writeFile(templatePath, 'word-upload')
    harness.templateSource = {
      ...harness.document,
      id: DocumentId('template-source'),
      documentKind: 'template-source',
      name: 'hit-proposal',
      immutableSourcePath: templatePath,
      workingPath: templatePath,
    }

    const result = await harness.service.createFromTemplate({
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      packId: 'hit-master-thesis',
      memberId: 'proposal',
    })
    expect(result).toMatchObject({ status: 'imported', createdCommitId: 'commit-1' })
    if (result.status !== 'imported') throw new Error('expected an imported document')
    expect(result.opened.document.template?.name).toBe('HIT 开题报告')
    expect(harness.installPack).toHaveBeenCalledWith(
      expect.objectContaining({ packId: 'hit-master-thesis', memberIds: ['proposal'] }),
      undefined,
    )
    expect(harness.contracts[0]?.status).toBe('confirmed')
    expect(harness.importDocument).toHaveBeenCalledWith(
      expect.objectContaining({ sourcePath: templatePath, role: 'proposal', name: 'HIT 开题报告' }),
      undefined,
    )
    expect(harness.submit).toHaveBeenCalledWith(expect.objectContaining({
      message: '从模板新建：开题报告',
      mutations: [
        { type: 'milestone', label: '从模板新建 HIT 开题报告' },
        { type: 'bind-template', templateId: 'template-1' },
      ],
    }))

    // A form template is the document itself: an upload cannot replace it.
    await expect(harness.service.createFromTemplate({
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      packId: 'hit-master-thesis',
      memberId: 'proposal',
      upload: { fileName: '论文.docx', contentBase64: Buffer.from('word-upload').toString('base64') },
    })).rejects.toThrow('accepts no upload')

    // Starting again reuses the confirmed contract and the caller's own name.
    const again = createHarness(root)
    again.templateSource = harness.templateSource
    again.installPack.mockImplementationOnce(async () => {
      again.contracts = structuredClone(harness.contracts)
      return structuredClone(again.contracts)
    })
    await again.service.createFromTemplate({
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      packId: 'hit-master-thesis',
      memberId: 'proposal',
      name: '开题报告二稿',
    })
    expect(again.importDocument).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: '开题报告二稿' }),
      undefined,
    )
    expect(again.contracts[0]?.status).toBe('confirmed')

    harness.templateSource = undefined
    await expect(harness.service.createFromTemplate({
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      packId: 'hit-master-thesis',
      memberId: 'proposal',
    })).rejects.toThrow('no stored source document')
  })

  it('formats an uploaded manuscript with a reference template and rejects foreign roles', async () => {
    const root = await mkdtemp(join(tmpdir(), 'paperai-workbench-template-reference-'))
    roots.push(root)
    const harness = createHarness(root)
    const reference = (): TemplateContract[] => {
      harness.contracts = [{ ...templateContract(), usage: 'format-reference', appliesToRoles: ['manuscript'] }]
      return structuredClone(harness.contracts)
    }
    harness.installPack.mockImplementation(async () => reference())
    const start = { workspaceId: WORKSPACE_ID, sessionId: SESSION_ID, packId: 'hit-master-thesis', memberId: 'thesis' }

    await expect(harness.service.createFromTemplate(start)).rejects.toThrow('upload the manuscript')
    expect(harness.importDocument).not.toHaveBeenCalled()
    await expect(harness.service.createFromTemplate({ ...start, role: 'proposal' }))
      .rejects.toThrow("does not apply to 'proposal' documents")

    const result = await harness.service.createFromTemplate({
      ...start,
      upload: { fileName: '论文.docx', contentBase64: Buffer.from('word-upload').toString('base64') },
    })
    expect(result).toMatchObject({ status: 'imported', createdCommitId: 'commit-1' })
    expect(harness.importDocument).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'manuscript', name: 'HIT 开题报告' }),
      undefined,
    )
    expect(harness.submit).toHaveBeenCalledWith(expect.objectContaining({
      mutations: [
        { type: 'milestone', label: '从模板新建 HIT 开题报告' },
        { type: 'bind-template', templateId: 'template-1' },
      ],
    }))
    expect(await readdir(join(root, '.paperai', 'uploads', 'v1'))).toEqual([])

    harness.installPack.mockImplementationOnce(async () => {
      harness.contracts = [{ ...templateContract(), appliesToRoles: [] }]
      return structuredClone(harness.contracts)
    })
    await expect(harness.service.createFromTemplate(start)).rejects.toThrow('applies to no document role')
  })

  it('installs, confirms, and associates a compatible template through a commit', async () => {
    const harness = createHarness()
    const initial = await harness.service.listTemplates({ workspaceId: WORKSPACE_ID })
    expect(initial.packs[0]?.packId).toBe('hit-master-thesis')
    expect(initial.contracts).toEqual([])
    const installed = await harness.service.installTemplatePack({
      workspaceId: WORKSPACE_ID,
      packId: 'hit-master-thesis',
      memberIds: ['proposal'],
    })
    expect(installed.contracts[0]).toMatchObject({ status: 'draft', source: 'built-in' })
    const confirmed = await harness.service.confirmTemplate({
      workspaceId: WORKSPACE_ID,
      templateId: 'template-1',
    })
    expect(confirmed.contracts[0]?.status).toBe('confirmed')
    const opened = await harness.service.open({
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      resourceId: `document:${DOCUMENT_ID}` as PaperAIResourceId,
    })
    const associated = await harness.service.associateTemplate({
      sessionId: SESSION_ID,
      documentId: DOCUMENT_ID,
      baseRevision: opened.document.revision,
      baseCommitId: null,
      templateId: 'template-1',
    })
    expect(harness.submit).toHaveBeenLastCalledWith(expect.objectContaining({
      mutations: [{ type: 'bind-template', templateId: 'template-1' }],
    }))
    expect(associated.document.template?.name).toBe('HIT 开题报告')
  })

  it('keeps a validation claim started after template association publication but before settlement', async () => {
    const harness = createHarness()
    harness.contracts = [{ ...templateContract(), status: 'confirmed' }]
    const opened = await openDocument(harness)
    const associationSettlement = deferSubmitSettlement(harness.submit)
    const associating = harness.service.associateTemplate({
      sessionId: SESSION_ID,
      documentId: DOCUMENT_ID,
      baseRevision: opened.document.revision,
      baseCommitId: opened.document.headCommitId,
      templateId: 'template-1',
    })
    const associationCommit = await associationSettlement.published
    const published = await openDocument(harness)
    const delayedValidation = deferred<GateReport>()
    harness.check.mockReturnValueOnce(delayedValidation.promise)
    const validating = validateDocument(harness, published.document)
    expect(harness.check).toHaveBeenCalledOnce()

    associationSettlement.settle(associationCommit)
    const associated = await associating
    delayedValidation.resolve({
      status: 'pass',
      mode: 'continuous',
      documentId: DOCUMENT_ID,
      findings: [],
      checkedAt: '2026-08-28T00:03:00.000Z',
    })
    const currentValidation = await validating
    expect(associated.document.revision).toBe(published.document.revision)
    expect((await openDocument(harness)).document.gate).toEqual(currentValidation.gate)
  })

  it('exports into the project tree and refreshes the milestone-backed version', async () => {
    const root = await mkdtemp(join(tmpdir(), 'paperai-workbench-export-'))
    roots.push(root)
    const harness = createHarness(root)
    const opened = await harness.service.open({
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      resourceId: `document:${DOCUMENT_ID}` as PaperAIResourceId,
    })
    const exported = await harness.service.exportDocument({
      sessionId: SESSION_ID,
      documentId: DOCUMENT_ID,
      baseRevision: opened.document.revision,
      baseCommitId: null,
      mode: 'draft-export',
    })
    expect(exported.status).toBe('success')
    if (exported.status !== 'success') throw new Error('draft export unexpectedly blocked')
    expect(exported.outputPath).toBe(join(root, 'exports', 'drafts', '开题报告-草稿.docx'))
    expect(exported).toMatchObject({
      status: 'success',
      fileName: '开题报告-草稿.docx',
      gate: { status: 'passed' },
      createdCommitId: 'commit-1',
    })
    expect(exported.document.versions[0]?.summary).toBe('版本 commit-1')

    const reexported = await harness.service.exportDocument({
      sessionId: SESSION_ID,
      documentId: DOCUMENT_ID,
      baseRevision: exported.document.revision,
      baseCommitId: exported.document.headCommitId,
      mode: 'draft-export',
    })
    expect(reexported.status).toBe('success')
    const gateCache: unknown = Reflect.get(harness.service, 'gateCache')
    expect(gateCache).toBeInstanceOf(Map)
    if (!(gateCache instanceof Map)) throw new Error('workbench gate cache is not a Map')
    expect(gateCache.size).toBe(1)
  })

  it('does not let a delayed validation replace the gate for a newer exported revision', async () => {
    const root = await mkdtemp(join(tmpdir(), 'paperai-workbench-export-race-'))
    roots.push(root)
    const harness = createHarness(root)
    const opened = await openDocument(harness)
    const delayed = deferred<GateReport>()
    harness.check.mockReturnValueOnce(delayed.promise)
    const validating = validateDocument(harness, opened.document)
    expect(harness.check).toHaveBeenCalledOnce()

    const exported = await harness.service.exportDocument({
      sessionId: SESSION_ID,
      documentId: DOCUMENT_ID,
      baseRevision: opened.document.revision,
      baseCommitId: opened.document.headCommitId,
      mode: 'draft-export',
    })
    expect(exported.status).toBe('success')
    if (exported.status !== 'success') throw new Error('draft export unexpectedly blocked')
    delayed.resolve({
      status: 'fail',
      mode: 'continuous',
      documentId: DOCUMENT_ID,
      findings: [{
        id: 'stale-validation', severity: 'error', code: 'required-field', message: '旧版本报告',
      }],
      checkedAt: '2026-08-28T00:01:00.000Z',
    })
    await validating

    const current = await openDocument(harness)
    expect(current.document.revision).toBe(exported.document.revision)
    expect(current.document.gate).toEqual(exported.gate)
    const gateCache: unknown = Reflect.get(harness.service, 'gateCache')
    expect(gateCache).toBeInstanceOf(Map)
    if (!(gateCache instanceof Map)) throw new Error('workbench gate cache is not a Map')
    expect(gateCache.size).toBe(1)
  })

  it('lets an export advancing the revision supersede a later validation from its source revision', async () => {
    const root = await mkdtemp(join(tmpdir(), 'paperai-workbench-export-source-race-'))
    roots.push(root)
    const harness = createHarness(root)
    const opened = await openDocument(harness)
    const delayedExport = deferred<ExportDocumentResult>()
    const delayedValidation = deferred<GateReport>()
    harness.exportDocument.mockReturnValueOnce(delayedExport.promise)
    harness.check.mockReturnValueOnce(delayedValidation.promise)
    const exporting = harness.service.exportDocument({
      sessionId: SESSION_ID,
      documentId: DOCUMENT_ID,
      baseRevision: opened.document.revision,
      baseCommitId: opened.document.headCommitId,
      mode: 'draft-export',
    })
    await vi.waitFor(() => { expect(harness.exportDocument).toHaveBeenCalledOnce() })
    const validating = validateDocument(harness, opened.document)
    expect(harness.check).toHaveBeenCalledOnce()
    const exportCommit = await harness.submit({ mutations: [{ type: 'milestone' }] })
    const report: GateReport = {
      status: 'pass',
      mode: 'draft-export',
      documentId: DOCUMENT_ID,
      findings: [],
      checkedAt: '2026-08-28T00:02:00.000Z',
    }
    delayedExport.resolve({
      outputPath: join(root, 'exports', 'drafts', '开题报告-草稿.docx'),
      report,
      gate: report,
      commit: exportCommit,
    })
    const exported = await exporting
    expect(exported.status).toBe('success')
    if (exported.status !== 'success') throw new Error('draft export unexpectedly blocked')
    expect(exported.document.gate).toEqual(exported.gate)

    delayedValidation.resolve({
      status: 'fail',
      mode: 'continuous',
      documentId: DOCUMENT_ID,
      findings: [{ id: 'source-validation', severity: 'error', code: 'old-check', message: '源版本报告' }],
      checkedAt: '2026-08-28T00:01:00.000Z',
    })
    await validating
    expect((await openDocument(harness)).document.gate).toEqual(exported.gate)
  })

  it('lets validation from the exported revision fence the completing export', async () => {
    const root = await mkdtemp(join(tmpdir(), 'paperai-workbench-export-target-race-'))
    roots.push(root)
    const harness = createHarness(root)
    const opened = await openDocument(harness)
    const delayedExport = deferred<ExportDocumentResult>()
    const delayedValidation = deferred<GateReport>()
    harness.exportDocument.mockReturnValueOnce(delayedExport.promise)
    const exporting = harness.service.exportDocument({
      sessionId: SESSION_ID,
      documentId: DOCUMENT_ID,
      baseRevision: opened.document.revision,
      baseCommitId: opened.document.headCommitId,
      mode: 'draft-export',
    })
    await vi.waitFor(() => { expect(harness.exportDocument).toHaveBeenCalledOnce() })
    const exportCommit = await harness.submit({ mutations: [{ type: 'milestone' }] })
    const exportedRevision = await openDocument(harness)
    harness.check.mockReturnValueOnce(delayedValidation.promise)
    const validating = validateDocument(harness, exportedRevision.document)
    expect(harness.check).toHaveBeenCalledOnce()
    const exportReport: GateReport = {
      status: 'pass',
      mode: 'draft-export',
      documentId: DOCUMENT_ID,
      findings: [],
      checkedAt: '2026-08-28T00:02:00.000Z',
    }
    delayedExport.resolve({
      outputPath: join(root, 'exports', 'drafts', '开题报告-草稿.docx'),
      report: exportReport,
      gate: exportReport,
      commit: exportCommit,
    })
    const exported = await exporting
    expect(exported.status).toBe('success')
    if (exported.status !== 'success') throw new Error('draft export unexpectedly blocked')
    expect(exported.document.gate).toEqual({ status: 'not-run', findings: [] })

    delayedValidation.resolve({
      status: 'fail',
      mode: 'continuous',
      documentId: DOCUMENT_ID,
      findings: [{ id: 'target-validation', severity: 'warning', code: 'new-check', message: '导出版本报告' }],
      checkedAt: '2026-08-28T00:03:00.000Z',
    })
    const currentValidation = await validating
    expect((await openDocument(harness)).document.gate).toEqual(currentValidation.gate)
  })

  it('does not attach a completed export report to a later external revision', async () => {
    const root = await mkdtemp(join(tmpdir(), 'paperai-workbench-external-export-race-'))
    roots.push(root)
    const harness = createHarness(root)
    const opened = await openDocument(harness)
    const delayed = deferred<ExportDocumentResult>()
    harness.exportDocument.mockReturnValueOnce(delayed.promise)
    const exporting = harness.service.exportDocument({
      sessionId: SESSION_ID,
      documentId: DOCUMENT_ID,
      baseRevision: opened.document.revision,
      baseCommitId: opened.document.headCommitId,
      mode: 'draft-export',
    })
    await vi.waitFor(() => { expect(harness.exportDocument).toHaveBeenCalledOnce() })
    const exportCommit = await harness.submit({ mutations: [{ type: 'milestone' }] })
    const newerCommit = await harness.submit({
      baseCommitId: exportCommit.id,
      mutations: [{ type: 'replace-text', nodeId: NODE_ID, nextText: '外部新版本' }],
    })
    const report: GateReport = {
      status: 'pass',
      mode: 'draft-export',
      documentId: DOCUMENT_ID,
      findings: [],
      checkedAt: '2026-08-28T00:02:00.000Z',
    }
    delayed.resolve({
      outputPath: join(root, 'exports', 'drafts', '开题报告-草稿.docx'),
      report,
      gate: report,
      commit: exportCommit,
    })

    const exported = await exporting
    expect(exported.status).toBe('success')
    if (exported.status !== 'success') throw new Error('draft export unexpectedly blocked')
    expect(exported.document.headCommitId).toBe(newerCommit.id)
    expect(exported.gate).toMatchObject({ status: 'passed', checkedAt: report.checkedAt })
    expect(exported.document.gate).toEqual({ status: 'not-run', findings: [] })
  })

  it('does not let an earlier validation replace a later blocked-export gate for the same revision', async () => {
    const root = await mkdtemp(join(tmpdir(), 'paperai-workbench-blocked-race-'))
    roots.push(root)
    const harness = createHarness(root)
    const opened = await openDocument(harness)
    const delayed = deferred<GateReport>()
    harness.check.mockReturnValueOnce(delayed.promise)
    const validating = validateDocument(harness, opened.document)
    expect(harness.check).toHaveBeenCalledOnce()
    const blockedReport: GateReport = {
      status: 'fail',
      mode: 'delivery-export',
      documentId: DOCUMENT_ID,
      findings: [{
        id: 'delivery-block', severity: 'error', code: 'required-field', message: '交付门禁失败',
      }],
      checkedAt: '2026-08-28T00:04:00.000Z',
    }
    harness.exportDocument.mockRejectedValueOnce(new PaperExportError(
      'DELIVERY_BLOCKED',
      'delivery blocked',
      blockedReport,
    ))

    const blocked = await harness.service.exportDocument({
      sessionId: SESSION_ID,
      documentId: DOCUMENT_ID,
      baseRevision: opened.document.revision,
      baseCommitId: opened.document.headCommitId,
      mode: 'delivery-export',
    })
    expect(blocked.status).toBe('blocked')
    delayed.resolve({
      status: 'fail',
      mode: 'continuous',
      documentId: DOCUMENT_ID,
      findings: [{
        id: 'stale-validation', severity: 'warning', code: 'old-check', message: '较早的连续检查',
      }],
      checkedAt: '2026-08-28T00:01:00.000Z',
    })
    await validating

    const current = await openDocument(harness)
    expect(current.document.revision).toBe(opened.document.revision)
    expect(current.document.gate).toEqual(blocked.gate)
  })

  it('keeps the current gate when a pre-commit validation settles last', async () => {
    const harness = createHarness()
    const opened = await openDocument(harness)
    const delayed = deferred<GateReport>()
    harness.check.mockReturnValueOnce(delayed.promise)
    const staleValidation = validateDocument(harness, opened.document)
    expect(harness.check).toHaveBeenCalledOnce()
    const committed = await harness.service.commit({
      sessionId: SESSION_ID,
      documentId: DOCUMENT_ID,
      baseRevision: opened.document.revision,
      baseCommitId: opened.document.headCommitId,
      mutations: [{
        type: 'replace-text', nodeId: NODE_ID, baseText: '原始段落', nextText: '新版本',
      }],
    })
    const currentValidation = await validateDocument(harness, committed.document)
    delayed.resolve({
      status: 'fail',
      mode: 'continuous',
      documentId: DOCUMENT_ID,
      findings: [{ id: 'stale-validation', severity: 'error', code: 'old-check', message: '旧版本报告' }],
      checkedAt: '2026-08-28T00:00:30.000Z',
    })
    await staleValidation

    const current = await openDocument(harness)
    expect(current.document.revision).toBe(committed.document.revision)
    expect(current.document.gate).toEqual(currentValidation.gate)
  })

  it('keeps a validation claim started after commit publication but before commit settlement', async () => {
    const harness = createHarness()
    const opened = await openDocument(harness)
    const commitSettlement = deferSubmitSettlement(harness.submit)
    const committing = harness.service.commit({
      sessionId: SESSION_ID,
      documentId: DOCUMENT_ID,
      baseRevision: opened.document.revision,
      baseCommitId: opened.document.headCommitId,
      mutations: [{
        type: 'replace-text', nodeId: NODE_ID, baseText: '原始段落', nextText: '已发布版本',
      }],
    })
    const commit = await commitSettlement.published
    const published = await openDocument(harness)
    const delayedValidation = deferred<GateReport>()
    harness.check.mockReturnValueOnce(delayedValidation.promise)
    const validating = validateDocument(harness, published.document)
    expect(harness.check).toHaveBeenCalledOnce()

    commitSettlement.settle(commit)
    const committed = await committing
    delayedValidation.resolve({
      status: 'pass',
      mode: 'continuous',
      documentId: DOCUMENT_ID,
      findings: [],
      checkedAt: '2026-08-28T00:03:00.000Z',
    })
    const currentValidation = await validating
    expect(committed.document.revision).toBe(published.document.revision)
    expect((await openDocument(harness)).document.gate).toEqual(currentValidation.gate)
  })

  it('keeps the current gate when a pre-restore validation settles last', async () => {
    const harness = createHarness()
    const opened = await openDocument(harness)
    const committed = await harness.service.commit({
      sessionId: SESSION_ID,
      documentId: DOCUMENT_ID,
      baseRevision: opened.document.revision,
      baseCommitId: opened.document.headCommitId,
      mutations: [{
        type: 'replace-text', nodeId: NODE_ID, baseText: '原始段落', nextText: '待恢复版本',
      }],
    })
    const delayed = deferred<GateReport>()
    harness.check.mockReturnValueOnce(delayed.promise)
    const staleValidation = validateDocument(harness, committed.document)
    expect(harness.check).toHaveBeenCalledOnce()
    const restored = await harness.service.restore({
      sessionId: SESSION_ID,
      documentId: DOCUMENT_ID,
      baseRevision: committed.document.revision,
      baseCommitId: committed.document.headCommitId,
      targetCommitId: 'historical' as PaperAIDocumentCommitId,
    })
    const currentValidation = await validateDocument(harness, restored.document)
    delayed.resolve({
      status: 'fail',
      mode: 'continuous',
      documentId: DOCUMENT_ID,
      findings: [{ id: 'stale-validation', severity: 'error', code: 'old-check', message: '恢复前报告' }],
      checkedAt: '2026-08-28T00:00:30.000Z',
    })
    await staleValidation

    const current = await openDocument(harness)
    expect(current.document.revision).toBe(restored.document.revision)
    expect(current.document.gate).toEqual(currentValidation.gate)
  })

  it('keeps a validation claim started after restore publication but before restore settlement', async () => {
    const harness = createHarness()
    const opened = await openDocument(harness)
    const committed = await harness.service.commit({
      sessionId: SESSION_ID,
      documentId: DOCUMENT_ID,
      baseRevision: opened.document.revision,
      baseCommitId: opened.document.headCommitId,
      mutations: [{
        type: 'replace-text', nodeId: NODE_ID, baseText: '原始段落', nextText: '待恢复版本',
      }],
    })
    const restoreSettlement = deferRevertSettlement(harness.revert)
    const restoring = harness.service.restore({
      sessionId: SESSION_ID,
      documentId: DOCUMENT_ID,
      baseRevision: committed.document.revision,
      baseCommitId: committed.document.headCommitId,
      targetCommitId: 'historical' as PaperAIDocumentCommitId,
    })
    const restoreCommit = await restoreSettlement.published
    const published = await openDocument(harness)
    const delayedValidation = deferred<GateReport>()
    harness.check.mockReturnValueOnce(delayedValidation.promise)
    const validating = validateDocument(harness, published.document)
    expect(harness.check).toHaveBeenCalledOnce()

    restoreSettlement.settle(restoreCommit)
    const restored = await restoring
    delayedValidation.resolve({
      status: 'pass',
      mode: 'continuous',
      documentId: DOCUMENT_ID,
      findings: [],
      checkedAt: '2026-08-28T00:03:00.000Z',
    })
    const currentValidation = await validating
    expect(restored.document.revision).toBe(published.document.revision)
    expect((await openDocument(harness)).document.gate).toEqual(currentValidation.gate)
  })

  it('returns a projectable blocked delivery without creating an export commit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'paperai-workbench-blocked-export-'))
    roots.push(root)
    const harness = createHarness(root)
    const opened = await harness.service.open({
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      resourceId: `document:${DOCUMENT_ID}` as PaperAIResourceId,
    })
    const report: GateReport = {
      status: 'fail',
      mode: 'delivery-export',
      documentId: DOCUMENT_ID,
      findings: [{
        id: 'required-title',
        severity: 'error',
        code: 'required-field',
        message: '缺少题目',
        officePath: '/body/p[1]',
      }],
      checkedAt: '2026-08-28T00:04:00.000Z',
    }
    harness.exportDocument.mockRejectedValueOnce(new PaperExportError(
      'DELIVERY_BLOCKED',
      'delivery blocked',
      report,
    ))
    const blocked = await harness.service.exportDocument({
      sessionId: SESSION_ID,
      documentId: DOCUMENT_ID,
      baseRevision: opened.document.revision,
      baseCommitId: null,
      mode: 'delivery-export',
    })
    expect(blocked).toEqual({
      status: 'blocked',
      documentId: DOCUMENT_ID,
      revision: opened.document.revision,
      headCommitId: null,
      fileName: '开题报告.docx',
      gate: {
        status: 'failed',
        checkedAt: '2026-08-28T00:04:00.000Z',
        findings: [{
          id: 'required-title',
          severity: 'error',
          title: 'required-field',
          message: '缺少题目',
          location: '/body/p[1]',
          passed: false,
        }],
      },
    })
    expect(harness.submit).not.toHaveBeenCalled()
    await expect(readFile(join(root, 'exports', 'delivery', '开题报告.docx')))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not disguise non-gate export failures as blocked results', async () => {
    const root = await mkdtemp(join(tmpdir(), 'paperai-workbench-export-error-'))
    roots.push(root)
    const harness = createHarness(root)
    const opened = await harness.service.open({
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      resourceId: `document:${DOCUMENT_ID}` as PaperAIResourceId,
    })
    harness.exportDocument.mockRejectedValueOnce(new PaperExportError(
      'DESTINATION_INVALID',
      'invalid destination',
    ))
    await expect(harness.service.exportDocument({
      sessionId: SESSION_ID,
      documentId: DOCUMENT_ID,
      baseRevision: opened.document.revision,
      baseCommitId: null,
      mode: 'draft-export',
    })).rejects.toMatchObject({ code: 'DESTINATION_INVALID' })
  })
})
