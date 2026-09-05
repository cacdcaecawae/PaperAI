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
import type { TemplateLibraryPack } from '@paperai/template-service'
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
const HIT_PACK_ID = 'hit-master-thesis'

interface MockCommitRequest {
  readonly baseCommitId?: ReturnType<typeof DocumentCommitId>
  readonly actor?: DocumentCommit['actor']
  readonly signal?: AbortSignal
  readonly mutations: readonly {
    readonly type?: string
    readonly nodeId?: ReturnType<typeof DocumentNodeId>
    readonly nextText?: string
    readonly templateId?: ReturnType<typeof TemplateContractId>
    readonly documentType?: DocumentRecord['role']
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
  project: ProjectRecord
  document: DocumentRecord
  nodes: DocumentNode[]
  history: DocumentCommit[]
  readonly submit: Mock<(request: MockCommitRequest) => Promise<DocumentCommit>>
  readonly rollbackImport: Mock<(documentId: ReturnType<typeof DocumentId>) => Promise<void>>
  readonly revert: Mock<(request: MockRevertRequest) => Promise<DocumentCommit>>
  readonly check: ReturnType<typeof vi.fn>
  readonly exportDocument: ReturnType<typeof vi.fn>
  readonly importDocument: Mock<(request: MockImportRequest) => Promise<unknown>>
  readonly installPack: Mock<(input: { readonly packId?: string; readonly memberIds?: readonly string[] }) => Promise<TemplateContract[]>>
  readonly previewHtml: Mock<() => Promise<string>>
  readonly readTextNodes: Mock<(path: string) => Promise<{ officePath: string; text: string; kind: 'paragraph' }[]>>
  contracts: TemplateContract[]
  /** Custom template sets the fake template service reports. */
  library: TemplateLibraryPack[]
  /** Paragraph texts the fake document engine reads per snapshot path. */
  snapshotTexts: Record<string, string[]>
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

async function createHarness(rootPath = 'F:\\paper'): Promise<Harness> {
  const ctx = new Context()
  contexts.push(ctx)
  const harness = {} as Harness
  harness.project = {
    id: PROJECT_ID,
    workspaceId: WORKSPACE_ID,
    name: '硕士论文',
    rootPath,
    templatePackId: HIT_PACK_ID,
    templateDecidedAt: '2026-08-28T00:00:00.000Z',
    createdAt: '2026-08-28T00:00:00.000Z',
    updatedAt: '2026-08-28T00:00:00.000Z',
  }
  harness.library = []
  harness.snapshotTexts = {}
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
      if (mutation.type === 'unbind-template') {
        const { templateId: _unbound, ...rest } = harness.document
        harness.document = rest
      }
      if (mutation.type === 'set-document-type' && mutation.documentType !== undefined) {
        harness.document = { ...harness.document, role: mutation.documentType }
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
  const installPack = vi.fn(async (_input: { readonly packId?: string; readonly memberIds?: readonly string[] }) => {
    harness.contracts = [templateContract()]
    return structuredClone(harness.contracts)
  })
  const readTextNodes = vi.fn(async (path: string) => (harness.snapshotTexts[path] ?? []).map((text, index) => ({
    officePath: `/body/p[${index + 1}]`, text, kind: 'paragraph' as const,
  })))
  harness.templateSource = undefined

  ctx.provide('workspaceRegistry', {
    get: (id: typeof WORKSPACE_ID) => id === WORKSPACE_ID
      ? { id: WORKSPACE_ID, path: harness.project.rootPath, title: harness.project.name }
      : undefined,
  } as never)
  ctx.provide('documentEngine', { readTextNodes } as never)
  ctx.provide('paperProjects', {
    create: async () => ({
      project: structuredClone(harness.project), projectCreated: false, contextFile: 'preserved', git: { status: 'ready' },
    }),
    get: (id: typeof PROJECT_ID) => id === PROJECT_ID ? structuredClone(harness.project) : undefined,
    setTemplateChoice: async (id: typeof PROJECT_ID, packId: string | null) => {
      expect(id).toBe(PROJECT_ID)
      const { templatePackId: _dropped, ...rest } = harness.project
      harness.project = {
        ...rest,
        ...(packId === null ? {} : { templatePackId: packId }),
        templateDecidedAt: '2026-08-28T00:05:00.000Z',
        updatedAt: '2026-08-28T00:05:00.000Z',
      }
      return structuredClone(harness.project)
    },
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
    inspectProject: vi.fn(async () => ({ checkedAt: '2026-09-05T00:00:00.000Z', documents: 1, issues: [], repairs: [] })),
    recoverMissingWorking: vi.fn(async () => {}),
    listHistory: () => structuredClone(harness.history),
    submit,
    revert,
  } as never)
  const libraryPack = (id: string): TemplateLibraryPack => {
    const pack = harness.library.find(candidate => candidate.id === id)
    if (pack === undefined) throw new Error(`template-service: unknown template set: ${id}`)
    return pack
  }
  ctx.provide('paperTemplates', {
    listPacks: () => [
      {
        id: HIT_PACK_ID, kind: 'built-in', name: 'HIT 硕士毕设', description: '校级模板', version: 'v1', sourceLabel: 'HIT',
        members: [
          {
            id: 'proposal', name: '开题报告', description: '开题模板', appliesToRoles: ['proposal'],
            usage: 'form-template', sourceVersion: 'v1', originalFileName: '开题.doc', sourceSha256: 'sha',
          },
          {
            id: 'thesis', name: '论文书写范例', description: '排版参考', appliesToRoles: ['manuscript'],
            usage: 'format-reference', sourceVersion: 'v1', originalFileName: '范例.doc', sourceSha256: 'sha-2',
          },
        ],
      },
      ...harness.library.filter(pack => pack.formats.length > 0).map(pack => ({
        id: pack.id, kind: 'custom', name: pack.name, description: pack.description, version: 'custom', sourceLabel: '用户添加',
        members: pack.formats.map(format => ({
          id: format.id, name: format.name, description: '自定义', appliesToRoles: [format.id],
          usage: format.usage, sourceVersion: format.addedAt, originalFileName: format.originalFileName, sourceSha256: format.source.sha256,
        })),
      })),
    ],
    listLibraryPacks: () => structuredClone(harness.library),
    createLibraryPack: async (input: { name: string; description?: string }) => {
      const pack: TemplateLibraryPack = {
        id: `custom-${String(harness.library.length + 1).padStart(8, '0')}`,
        name: input.name, description: input.description ?? '', createdAt: 'now', updatedAt: 'now', formats: [],
      }
      harness.library = [...harness.library, pack]
      return structuredClone(pack)
    },
    deleteLibraryPack: async (id: string) => {
      libraryPack(id)
      harness.library = harness.library.filter(pack => pack.id !== id)
    },
    addLibraryFormat: async (input: { packId: string; role: 'proposal'; usage: 'form-template'; name?: string; upload: { fileName: string; bytes: Uint8Array } }) => {
      const pack = libraryPack(input.packId)
      const format = {
        id: input.role, name: input.name ?? input.upload.fileName, usage: input.usage, originalFileName: input.upload.fileName,
        source: { path: 'sources/x.docx', sha256: 'a'.repeat(64), size: input.upload.bytes.byteLength },
        normalized: { path: 'normalized/x.docx', sha256: 'a'.repeat(64), size: input.upload.bytes.byteLength },
        addedAt: 'now',
      }
      const updated = { ...pack, formats: [...pack.formats.filter(item => item.id !== input.role), format] }
      harness.library = harness.library.map(item => item.id === pack.id ? updated : item)
      return structuredClone(updated)
    },
    removeLibraryFormat: async (id: string, role: string) => {
      const pack = libraryPack(id)
      const updated = { ...pack, formats: pack.formats.filter(format => format.id !== role) }
      harness.library = harness.library.map(item => item.id === pack.id ? updated : item)
      return structuredClone(updated)
    },
    listContracts: () => structuredClone(harness.contracts),
    getContract: (id: ReturnType<typeof TemplateContractId>) => harness.contracts.find(item => item.id === id),
    installPack,
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
    listProjects: () => [structuredClone(harness.project)],
    getCommit: (id: ReturnType<typeof DocumentCommitId>) => (
      harness.history.find(commit => commit.id === id)
    ),
    getDocument: (id: ReturnType<typeof DocumentId>) => (
      id === DOCUMENT_ID ? structuredClone(harness.document) : id === DocumentId('template-source') ? harness.templateSource : undefined
    ),
  } as never)
  await ctx.plugin(PaperAiWorkbenchService).await()
  const service = ctx.paperaiWorkbench
  Object.assign(harness, {
    ctx, service, submit, rollbackImport, revert, check, exportDocument, importDocument, installPack,
    previewHtml, readTextNodes,
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
      ...(origin === 'built-in' ? { packId: HIT_PACK_ID, memberId: 'proposal', sourceVersion: 'v1' } : {}),
    },
    appliesToRoles: ['proposal'],
    usage: 'form-template',
    status: 'draft',
    createdAt: '2026-08-28T00:00:00.000Z',
    updatedAt: '2026-08-28T00:00:00.000Z',
  }
}

describe('PaperAiWorkbenchService', () => {
  it('scans only existing projects and rejects repair plans owned by another project', async () => {
    const h = await createHarness()
    const create = vi.spyOn(h.ctx.paperProjects, 'create')
    const recover = vi.spyOn(h.ctx.paperCommits, 'recoverMissingWorking')
    await expect(h.service.inspectProject({ workspaceId: WORKSPACE_ID })).resolves.toMatchObject({ documents: 1, issues: [] })
    expect(create).not.toHaveBeenCalled()
    expect(recover).not.toHaveBeenCalled()
    await expect(h.service.inspectProject({ workspaceId: WorkspaceId('missing') })).rejects.toThrow(/does not exist/)
    vi.spyOn(h.ctx.paperRepository, 'listProjects').mockReturnValueOnce([])
    await expect(h.service.inspectProject({ workspaceId: WORKSPACE_ID })).rejects.toThrow(/not initialized/)
    const plan = { documentId: DOCUMENT_ID, headCommitId: DocumentCommitId('commit-1'), sha256: 'digest', workingPath: h.document.workingPath }
    h.document = { ...h.document, projectId: ProjectId('another') }
    await expect(h.service.recoverWorking({ workspaceId: WORKSPACE_ID, plan })).rejects.toThrow(/does not belong/)
    expect(recover).not.toHaveBeenCalled()
    h.document = { ...h.document, projectId: PROJECT_ID }
    await expect(h.service.recoverWorking({ workspaceId: WORKSPACE_ID, plan })).resolves.toMatchObject({ issues: [] })
    expect(recover).toHaveBeenCalledExactlyOnceWith(plan, undefined)
    expect(create).not.toHaveBeenCalled()
  })

  it('describes the project: its template decision, the chosen set, and only tracked documents', async () => {
    const root = await mkdtemp(join(tmpdir(), 'paperai-workbench-overview-'))
    roots.push(root)
    await mkdir(join(root, 'documents', 'working'), { recursive: true })
    await writeFile(join(root, 'documents', 'working', 'unregistered.docx'), 'not-a-domain-document')
    const harness = await createHarness(root)
    harness.contracts = [{ ...templateContract(), status: 'confirmed' }]
    harness.document = { ...harness.document, templateId: TemplateContractId('template-1') }

    const overview = await harness.service.overview({ workspaceId: WORKSPACE_ID })
    expect(overview).toMatchObject({
      workspaceId: WORKSPACE_ID,
      projectName: '硕士论文',
      templateDecided: true,
      template: { packId: HIT_PACK_ID, kind: 'built-in', name: 'HIT 硕士毕设' },
    })
    expect(overview.template?.formats).toEqual([
      expect.objectContaining({ memberId: 'proposal', documentType: 'proposal', usage: 'form-template', sourceVersion: 'v1' }),
      expect.objectContaining({ memberId: 'thesis', documentType: 'manuscript', usage: 'format-reference', sourceVersion: 'v1' }),
    ])
    expect(overview.documents).toEqual([{
      id: `document:${DOCUMENT_ID}`,
      documentId: DOCUMENT_ID,
      name: '开题报告',
      fileName: '开题报告.docx',
      documentType: 'proposal',
      templateName: 'HIT 开题报告',
      updatedAt: '2026-08-28T00:00:00.000Z',
    }])

    harness.project = { ...harness.project, templatePackId: 'custom-gone' }
    expect(await harness.service.overview({ workspaceId: WORKSPACE_ID })).toMatchObject({
      templateDecided: true, templatePackId: 'custom-gone', template: null,
    })
    const { templatePackId: _pack, templateDecidedAt: _decided, ...undecided } = harness.project
    harness.project = undecided
    expect(await harness.service.overview({ workspaceId: WORKSPACE_ID })).toMatchObject({
      templateDecided: false, templatePackId: null, template: null,
    })
  })

  it('records the project template choice, including the choice of none', async () => {
    const harness = await createHarness()
    const chosen = await harness.service.setProjectTemplate({ workspaceId: WORKSPACE_ID, packId: null })
    expect(chosen).toMatchObject({ templateDecided: true, templatePackId: null, template: null })
    expect(harness.project.templatePackId).toBeUndefined()
    const again = await harness.service.setProjectTemplate({ workspaceId: WORKSPACE_ID, packId: HIT_PACK_ID })
    expect(again.template?.packId).toBe(HIT_PACK_ID)
    await expect(harness.service.setProjectTemplate({ workspaceId: WORKSPACE_ID, packId: 'custom-missing' }))
      .rejects.toThrow('not in the library')

    // A custom set may be chosen before it holds any format; starting a document then names the gap.
    await harness.service.createTemplateSet({ name: '空集' })
    const empty = await harness.service.setProjectTemplate({ workspaceId: WORKSPACE_ID, packId: 'custom-00000001' })
    expect(empty.template).toEqual({ packId: 'custom-00000001', kind: 'custom', name: '空集', description: '', formats: [] })
    await expect(harness.service.createFromTemplate({ workspaceId: WORKSPACE_ID, sessionId: SESSION_ID, documentType: 'proposal' }))
      .rejects.toThrow('no format')
  })

  it('emits JSON-safe document changes only for committed Working document puts', async () => {
    const harness = await createHarness()
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

  it('contains document change listener failures without interrupting durable change observers', async () => {
    const harness = await createHarness()
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
    const harness = await createHarness()
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
    const harness = await createHarness()
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
    const harness = await createHarness()
    await expect(harness.service.overview({ workspaceId: WorkspaceId('missing') })).rejects.toThrow('does not exist')
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
    const harness = await createHarness(root)
    const result = await harness.service.importDocument({
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      fileName: '开题报告.docx',
      contentBase64: Buffer.from('word-upload').toString('base64'),
    })
    expect(result).toMatchObject({ status: 'imported', createdCommitId: 'commit-1' })
    // Free writing: no type is asked at import; the document starts as "other".
    expect(harness.importDocument).toHaveBeenCalledWith(expect.objectContaining({ role: 'other' }), undefined)
    expect(harness.submit).toHaveBeenCalledWith(expect.objectContaining({
      mutations: [{ type: 'milestone', label: '导入 开题报告.docx' }],
    }))
    await expect(readFile(join(root, '.paperai', 'uploads', 'v1', 'missing'))).rejects.toThrow()

    await expect(harness.service.importDocument({
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      fileName: '../bad.docx',
      contentBase64: 'not-base64',
    })).rejects.toThrow('safe .doc or .docx')
  })

  it('treats the root commit as the commit point: a failed or cancelled preview still returns the created document', async () => {
    const root = await mkdtemp(join(tmpdir(), 'paperai-workbench-preview-'))
    roots.push(root)
    const harness = await createHarness(root)
    harness.previewHtml.mockRejectedValueOnce(new Error('OfficeCLI preview crashed'))
    const controller = new AbortController()
    const request = {
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      fileName: '开题报告.docx',
      contentBase64: Buffer.from('word-upload').toString('base64'),
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
    const harness = await createHarness(root)
    const failure = new Error('root commit rejected')
    harness.submit.mockRejectedValueOnce(failure)

    await expect(harness.service.importDocument({
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      fileName: '开题报告.docx',
      contentBase64: Buffer.from('word-upload').toString('base64'),
    })).rejects.toBe(failure)

    expect(harness.rollbackImport).toHaveBeenCalledOnce()
    expect(harness.rollbackImport).toHaveBeenCalledWith(DOCUMENT_ID)
    expect(await readdir(join(root, '.paperai', 'uploads', 'v1'))).toEqual([])
  })

  it('finishes import rollback after root commit submission is cancelled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'paperai-workbench-submit-cancel-'))
    roots.push(root)
    const harness = await createHarness(root)
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
    }, controller.signal)).rejects.toBe(cancelled)

    expect(harness.submit).toHaveBeenCalledWith(expect.objectContaining({ signal: controller.signal }))
    expect(harness.rollbackImport).toHaveBeenCalledOnce()
    expect(harness.rollbackImport.mock.calls[0]).toHaveLength(1)
    expect(await readdir(join(root, '.paperai', 'uploads', 'v1'))).toEqual([])
  })

  it('reports root submission and import rollback failures together', async () => {
    const root = await mkdtemp(join(tmpdir(), 'paperai-workbench-rollback-failure-'))
    roots.push(root)
    const harness = await createHarness(root)
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
      })
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(AggregateError)
    if (!(failure instanceof AggregateError)) throw new Error('expected aggregate rollback failure')
    expect(failure.errors).toEqual([submissionFailure, rollbackFailure])
    expect(failure.message).toContain('root commit and import rollback failed')
  })

  it('starts a document of one type from the project template and binds its format in the root commit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'paperai-workbench-template-start-'))
    roots.push(root)
    const harness = await createHarness(root)
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
      documentType: 'proposal',
    })
    expect(result).toMatchObject({ status: 'imported', createdCommitId: 'commit-1' })
    if (result.status !== 'imported') throw new Error('expected an imported document')
    expect(result.opened.document.template).toMatchObject({
      name: 'HIT 开题报告', kind: 'built-in', packName: 'HIT 硕士毕设', usage: 'form-template',
    })
    expect(harness.installPack).toHaveBeenCalledWith(
      expect.objectContaining({ packId: HIT_PACK_ID, memberIds: ['proposal'] }),
      undefined,
    )
    expect(harness.contracts[0]?.status).toBe('confirmed')
    expect(harness.importDocument).toHaveBeenCalledWith(
      expect.objectContaining({ sourcePath: templatePath, role: 'proposal', name: '开题报告' }),
      undefined,
    )
    expect(harness.submit).toHaveBeenCalledWith(expect.objectContaining({
      message: '从模板新建：开题报告',
      mutations: [
        { type: 'milestone', label: '从模板新建 开题报告' },
        { type: 'bind-template', templateId: 'template-1' },
      ],
    }))

    // A form template is the document itself: an upload cannot replace it.
    await expect(harness.service.createFromTemplate({
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      documentType: 'proposal',
      upload: { fileName: '论文.docx', contentBase64: Buffer.from('word-upload').toString('base64') },
    })).rejects.toThrow('accepts no upload')

    // Starting again reuses the confirmed contract and the caller's own name.
    const again = await createHarness(root)
    again.templateSource = harness.templateSource
    again.installPack.mockImplementationOnce(async () => {
      again.contracts = structuredClone(harness.contracts)
      return structuredClone(again.contracts)
    })
    await again.service.createFromTemplate({
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      documentType: 'proposal',
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
      documentType: 'proposal',
    })).rejects.toThrow('no stored source document')

    // Without a project template set, or without a format for the type, nothing can start.
    await expect(harness.service.createFromTemplate({
      workspaceId: WORKSPACE_ID, sessionId: SESSION_ID, documentType: 'midterm',
    })).rejects.toThrow("no format for 'midterm'")
    const { templatePackId: _dropped, ...free } = harness.project
    harness.project = free
    await expect(harness.service.createFromTemplate({
      workspaceId: WORKSPACE_ID, sessionId: SESSION_ID, documentType: 'proposal',
    })).rejects.toThrow('has no template set')
  })

  it('formats an uploaded manuscript with the project reference format', async () => {
    const root = await mkdtemp(join(tmpdir(), 'paperai-workbench-template-reference-'))
    roots.push(root)
    const harness = await createHarness(root)
    harness.installPack.mockImplementation(async () => {
      harness.contracts = [{
        ...templateContract(), name: 'HIT 论文范例', usage: 'format-reference', appliesToRoles: ['manuscript'],
      }]
      return structuredClone(harness.contracts)
    })
    const start = { workspaceId: WORKSPACE_ID, sessionId: SESSION_ID, documentType: 'manuscript' as const }

    await expect(harness.service.createFromTemplate(start)).rejects.toThrow('upload the manuscript')
    expect(harness.importDocument).not.toHaveBeenCalled()

    const result = await harness.service.createFromTemplate({
      ...start,
      upload: { fileName: '论文.docx', contentBase64: Buffer.from('word-upload').toString('base64') },
    })
    expect(result).toMatchObject({ status: 'imported', createdCommitId: 'commit-1' })
    expect(harness.installPack).toHaveBeenCalledWith(
      expect.objectContaining({ packId: HIT_PACK_ID, memberIds: ['thesis'] }),
      undefined,
    )
    expect(harness.importDocument).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'manuscript', name: '论文书写范例' }),
      undefined,
    )
    expect(harness.submit).toHaveBeenCalledWith(expect.objectContaining({
      mutations: [
        { type: 'milestone', label: '从模板新建 论文书写范例' },
        { type: 'bind-template', templateId: 'template-1' },
      ],
    }))
    expect(await readdir(join(root, '.paperai', 'uploads', 'v1'))).toEqual([])
  })

  it('applies the project format for a type through one commit, changing the type when it differs, and detaches it again', async () => {
    const harness = await createHarness()
    harness.document = { ...harness.document, role: 'other' }
    const opened = await openDocument(harness)
    expect(opened.document).toMatchObject({ documentType: 'other', template: null, projectFormatAvailable: false })

    const applied = await harness.service.applyTemplate({
      sessionId: SESSION_ID,
      documentId: DOCUMENT_ID,
      baseRevision: opened.document.revision,
      baseCommitId: null,
      documentType: 'proposal',
    })
    expect(harness.installPack).toHaveBeenCalledWith(
      expect.objectContaining({ packId: HIT_PACK_ID, memberIds: ['proposal'] }),
      undefined,
    )
    expect(harness.contracts[0]?.status).toBe('confirmed')
    expect(harness.submit).toHaveBeenLastCalledWith(expect.objectContaining({
      message: '套用模板：HIT 硕士毕设 · 开题报告',
      mutations: [
        { type: 'set-document-type', documentType: 'proposal' },
        { type: 'bind-template', templateId: 'template-1' },
      ],
    }))
    expect(applied.document.template?.name).toBe('HIT 开题报告')
    expect(applied.document.template).toMatchObject({ memberId: 'proposal', sourceVersion: 'v1' })
    expect(applied.document.template?.requirements).toEqual([])

    await expect(harness.service.applyTemplate({
      sessionId: SESSION_ID,
      documentId: DOCUMENT_ID,
      baseRevision: applied.document.revision,
      baseCommitId: applied.document.headCommitId,
      documentType: 'proposal',
    })).rejects.toThrow('already bound')

    const detached = await harness.service.detachTemplate({
      sessionId: SESSION_ID,
      documentId: DOCUMENT_ID,
      baseRevision: applied.document.revision,
      baseCommitId: applied.document.headCommitId,
    })
    expect(harness.submit).toHaveBeenLastCalledWith(expect.objectContaining({
      message: '解除模板绑定',
      mutations: [{ type: 'unbind-template' }],
    }))
    expect(detached.document.template).toBeNull()
    await expect(harness.service.detachTemplate({
      sessionId: SESSION_ID,
      documentId: DOCUMENT_ID,
      baseRevision: detached.document.revision,
      baseCommitId: detached.document.headCommitId,
    })).rejects.toThrow('no bound format')
  })

  it('guesses a document type from the title, then the opening text, then keeps the current type', async () => {
    const harness = await createHarness()
    harness.document = { ...harness.document, name: '硕士学位论文开题报告', role: 'other' }
    expect(await harness.service.suggestDocumentType({ documentId: DOCUMENT_ID }))
      .toEqual({ documentId: DOCUMENT_ID, documentType: 'proposal', basis: 'title' })

    harness.document = { ...harness.document, name: '初稿' }
    harness.nodes = [{ ...harness.nodes[0]!, text: '' }, { ...harness.nodes[0]!, id: DocumentNodeId('node-2'), text: '中期检查报告' }]
    expect(await harness.service.suggestDocumentType({ documentId: DOCUMENT_ID }))
      .toMatchObject({ documentType: 'midterm', basis: 'content' })

    harness.nodes = [{ ...harness.nodes[0]!, text: '一段普通文字' }]
    expect(await harness.service.suggestDocumentType({ documentId: DOCUMENT_ID }))
      .toMatchObject({ documentType: 'other', basis: 'current' })
    await expect(harness.service.suggestDocumentType({ documentId: DocumentId('missing') })).rejects.toThrow('does not exist')
  })

  it('diffs a version against its parent at paragraph level and lists a root version as all additions', async () => {
    const harness = await createHarness()
    const opened = await openDocument(harness)
    const first = await harness.service.commit({
      sessionId: SESSION_ID, documentId: DOCUMENT_ID, baseRevision: opened.document.revision, baseCommitId: null,
      mutations: [{ type: 'replace-text', nodeId: NODE_ID, baseText: '原始段落', nextText: '第一版' }],
    })
    const second = await harness.service.commit({
      sessionId: SESSION_ID, documentId: DOCUMENT_ID, baseRevision: first.document.revision, baseCommitId: first.createdCommitId,
      mutations: [{ type: 'replace-text', nodeId: NODE_ID, baseText: '第一版', nextText: '第二版' }],
    })
    const snapshotOf = (commitId: string): string => {
      const commit = harness.history.find(candidate => candidate.id === commitId)
      if (commit === undefined) throw new Error(`missing commit ${commitId}`)
      return commit.snapshotPath
    }
    harness.snapshotTexts[snapshotOf(first.createdCommitId)] = ['标题', '第一版', '删掉的段落']
    harness.snapshotTexts[snapshotOf(second.createdCommitId)] = ['标题', '第二版', '新增的段落', '再新增一段']

    const diff = await harness.service.diffVersion({ documentId: DOCUMENT_ID, commitId: second.createdCommitId })
    expect(diff).toEqual({
      documentId: DOCUMENT_ID,
      commitId: 'commit-2',
      parentCommitId: 'commit-1',
      changes: [
        { kind: 'changed', before: '第一版', after: '第二版' },
        { kind: 'changed', before: '删掉的段落', after: '新增的段落' },
        { kind: 'added', after: '再新增一段' },
      ],
      unchangedCount: 1,
    })
    const root = await harness.service.diffVersion({ documentId: DOCUMENT_ID, commitId: first.createdCommitId })
    expect(root).toMatchObject({ parentCommitId: null, unchangedCount: 0 })
    expect(root.changes).toEqual([
      { kind: 'added', after: '标题' }, { kind: 'added', after: '第一版' }, { kind: 'added', after: '删掉的段落' },
    ])
    await expect(harness.service.diffVersion({ documentId: DOCUMENT_ID, commitId: 'commit-9' as PaperAIDocumentCommitId }))
      .rejects.toThrow('does not belong')
  })

  it('lists, creates, fills, and deletes custom template sets through the library', async () => {
    const harness = await createHarness()
    expect((await harness.service.listTemplateLibrary()).sets.map(set => set.packId)).toEqual([HIT_PACK_ID])
    const created = await harness.service.createTemplateSet({ name: '我们学院 2026 版', description: '学院自定' })
    expect(created.sets).toEqual([
      expect.objectContaining({ packId: HIT_PACK_ID, kind: 'built-in' }),
      { packId: 'custom-00000001', kind: 'custom', name: '我们学院 2026 版', description: '学院自定', formats: [] },
    ])
    const filled = await harness.service.addTemplateFormat({
      packId: 'custom-00000001',
      documentType: 'proposal',
      usage: 'form-template',
      fileName: '开题模板.docx',
      contentBase64: Buffer.from('word-upload').toString('base64'),
    })
    expect(filled.sets[1]).toMatchObject({
      packId: 'custom-00000001',
      formats: [{ memberId: 'proposal', documentType: 'proposal', name: '开题模板.docx', usage: 'form-template', sourceVersion: 'now' }],
    })
    await expect(harness.service.addTemplateFormat({
      packId: 'custom-00000001', documentType: 'proposal', usage: 'form-template',
      fileName: '../bad.docx', contentBase64: 'not-base64',
    })).rejects.toThrow('safe .doc or .docx')
    const emptied = await harness.service.removeTemplateFormat({ packId: 'custom-00000001', documentType: 'proposal' })
    expect(emptied.sets[1]?.formats).toEqual([])
    const deleted = await harness.service.deleteTemplateSet({ packId: 'custom-00000001' })
    expect(deleted.sets.map(set => set.packId)).toEqual([HIT_PACK_ID])
  })

  it('keeps a validation claim started after template application publication but before settlement', async () => {
    const harness = await createHarness()
    harness.contracts = [{ ...templateContract(), status: 'confirmed' }]
    const opened = await openDocument(harness)
    const associationSettlement = deferSubmitSettlement(harness.submit)
    const associating = harness.service.applyTemplate({
      sessionId: SESSION_ID,
      documentId: DOCUMENT_ID,
      baseRevision: opened.document.revision,
      baseCommitId: opened.document.headCommitId,
      documentType: 'proposal',
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
    const harness = await createHarness(root)
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
    const harness = await createHarness(root)
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
    const harness = await createHarness(root)
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
    const harness = await createHarness(root)
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
    const harness = await createHarness(root)
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
    const harness = await createHarness(root)
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
    const harness = await createHarness()
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
    const harness = await createHarness()
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
    const harness = await createHarness()
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
    const harness = await createHarness()
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
    const harness = await createHarness(root)
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
    const harness = await createHarness(root)
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
