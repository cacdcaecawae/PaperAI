import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { DocumentEngine } from '@paperai/document-engine'
import type {
  EngineMutation,
  EngineTextNode,
  EngineValidation,
} from '@paperai/document-engine'
import {
  DocumentCommitId,
  DocumentId,
  DocumentNodeId,
  ProjectId,
  TemplateContractId,
} from '@paperai/domain'
import type {
  ActorIdentity,
  CapabilityHealth,
  DocumentCommit,
  DocumentId as DocumentIdType,
  DocumentMutation,
  DocumentNode,
  DocumentNodeId as DocumentNodeIdType,
  DocumentOperation,
  DocumentRecord,
  GateReport,
  ProjectId as ProjectIdType,
  ProjectRecord,
} from '@paperai/domain'
import type { DocumentCommitPublication } from '@paperai/repository'
import PaperCommitService, {
  DocumentHeadConflictError,
  DocumentValidationError,
  PaperCommitError,
} from '../src/index.ts'
import type {
  DocumentIndexRebuildRequest,
  PaperDocumentIndexPeer,
  PaperTemplateCommitPeer,
} from '../src/index.ts'

class Deferred {
  readonly promise: Promise<void>
  private settle: (() => void) | undefined

  constructor() {
    this.promise = new Promise((resolve) => {
      this.settle = resolve
    })
  }

  resolve(): void {
    this.settle?.()
    this.settle = undefined
  }
}

class FakePaperRepository extends Service {
  readonly projects = new Map<ProjectIdType, ProjectRecord>()
  readonly documents = new Map<DocumentIdType, DocumentRecord>()
  readonly commits = new Map<DocumentCommitId, DocumentCommit>()
  readonly publications = new Map<DocumentIdType, DocumentCommitPublication>()
  readonly nodes = new Map<DocumentNodeIdType, DocumentNode>()
  failNextDocumentUpdate = false
  failAfterNextDocumentUpdate = false
  documentUpdateCalls = 0
  putNodeCalls = 0
  deleteNodeCalls = 0
  readonly failPutNodeCalls = new Set<number>()
  readonly failDeleteNodeCalls = new Set<number>()
  onPutCommit: ((commit: DocumentCommit, repository: FakePaperRepository) => void | Promise<void>) | undefined
  onDocumentUpdate: ((call: number, repository: FakePaperRepository) => void | Promise<void>) | undefined

  constructor(ctx: Context) {
    super(ctx, 'paperRepository')
  }

  getProject(id: ProjectIdType): ProjectRecord | undefined {
    return this.projects.get(id)
  }

  getDocument(id: DocumentIdType): DocumentRecord | undefined {
    return this.documents.get(id)
  }

  getCommit(id: DocumentCommitId): DocumentCommit | undefined {
    return this.commits.get(id)
  }

  listNodes(documentId: DocumentIdType): DocumentNode[] {
    return [...this.nodes.values()]
      .filter(node => node.documentId === documentId)
      .sort((left, right) => left.ordinal - right.ordinal)
  }

  async putCommit(commit: DocumentCommit): Promise<void> {
    this.commits.set(commit.id, structuredClone(commit))
    await this.onPutCommit?.(commit, this)
  }

  getCommitPublication(documentId: DocumentIdType): DocumentCommitPublication | undefined {
    return this.publications.get(documentId)
  }

  listCommitPublications(): DocumentCommitPublication[] {
    return [...this.publications.values()]
  }

  putCommitPublication(publication: DocumentCommitPublication): Promise<void> {
    this.publications.set(publication.documentId, structuredClone(publication))
    return Promise.resolve()
  }

  deleteCommitPublication(documentId: DocumentIdType): Promise<boolean> {
    return Promise.resolve(this.publications.delete(documentId))
  }

  async updateDocument(
    id: DocumentIdType,
    update: (record: DocumentRecord) => DocumentRecord,
  ): Promise<DocumentRecord> {
    this.documentUpdateCalls += 1
    await this.onDocumentUpdate?.(this.documentUpdateCalls, this)
    if (this.failNextDocumentUpdate) {
      this.failNextDocumentUpdate = false
      throw new Error('selected document-head write failure')
    }
    const current = this.documents.get(id)
    if (current === undefined) throw new Error(`missing document ${id}`)
    const next = update(current)
    this.documents.set(id, structuredClone(next))
    if (this.failAfterNextDocumentUpdate) {
      this.failAfterNextDocumentUpdate = false
      throw new Error('selected post-persistence document-head failure')
    }
    return next
  }

  async putNode(node: DocumentNode): Promise<void> {
    this.putNodeCalls += 1
    if (this.failPutNodeCalls.has(this.putNodeCalls)) {
      throw new Error(`selected putNode failure ${this.putNodeCalls}`)
    }
    this.nodes.set(node.id, structuredClone(node))
  }

  async deleteNode(id: DocumentNodeIdType): Promise<boolean> {
    this.deleteNodeCalls += 1
    if (this.failDeleteNodeCalls.has(this.deleteNodeCalls)) {
      throw new Error(`selected deleteNode failure ${this.deleteNodeCalls}`)
    }
    return this.nodes.delete(id)
  }
}

class FakeDocumentEngine extends DocumentEngine {
  failValidation = false
  validationFailures = 0
  onValidate: ((filePath: string) => void | Promise<void>) | undefined
  nextApplyBlock: Promise<void> | undefined
  readonly applyStarted = new Deferred()
  applyCalls = 0
  activeApplies = 0
  maxActiveApplies = 0

  override health(): Promise<CapabilityHealth> {
    return Promise.resolve({ status: 'ready' })
  }

  override async readTextNodes(filePath: string): Promise<EngineTextNode[]> {
    return [{ officePath: '/body/p[1]', text: await readFile(filePath, 'utf8'), kind: 'paragraph' }]
  }

  override async previewHtml(filePath: string): Promise<string> {
    return `<p>${await readFile(filePath, 'utf8')}</p>`
  }

  override inspect(): Promise<Record<string, unknown>> {
    return Promise.resolve({})
  }

  override async applyMutations(filePath: string, mutations: readonly EngineMutation[]): Promise<void> {
    this.applyCalls += 1
    this.activeApplies += 1
    this.maxActiveApplies = Math.max(this.maxActiveApplies, this.activeApplies)
    this.applyStarted.resolve()
    const block = this.nextApplyBlock
    this.nextApplyBlock = undefined
    try {
      if (block !== undefined) await block
      let content = await readFile(filePath, 'utf8')
      for (const mutation of mutations) {
        if (mutation.type !== 'replace-text' || mutation.officePath !== '/body/p[1]') {
          throw new Error(`unsupported fake mutation ${mutation.type}`)
        }
        content = mutation.text
      }
      await writeFile(filePath, content, 'utf8')
    } finally {
      this.activeApplies -= 1
    }
  }

  override async validate(filePath: string): Promise<EngineValidation> {
    await this.onValidate?.(filePath)
    const selectedFailure = this.failValidation || this.validationFailures > 0
    if (this.validationFailures > 0) this.validationFailures -= 1
    return selectedFailure
      ? { success: false, details: { code: 'selected-invalid-docx' } }
      : { success: true, details: { package: 'word/document.xml' } }
  }
}

class FakePaperDocuments extends Service implements PaperDocumentIndexPeer {
  static inject = ['paperRepository']

  nextRebuildBlock: Promise<void> | undefined
  readonly rebuildStarted = new Deferred()
  nextRebuildOverride: ((
    request: DocumentIndexRebuildRequest,
  ) => readonly DocumentNode[] | Promise<readonly DocumentNode[]>) | undefined

  constructor(ctx: Context) {
    super(ctx, 'paperDocuments')
  }

  readNodes(documentId: DocumentIdType): readonly DocumentNode[] {
    const repository = this.ctx.paperRepository as unknown as FakePaperRepository
    return [...repository.nodes.values()]
      .filter(node => node.documentId === documentId)
      .sort((left, right) => left.ordinal - right.ordinal)
  }

  async buildCandidateIndex(request: DocumentIndexRebuildRequest): Promise<readonly DocumentNode[]> {
    this.rebuildStarted.resolve()
    const block = this.nextRebuildBlock
    this.nextRebuildBlock = undefined
    if (block !== undefined) await block
    const override = this.nextRebuildOverride
    this.nextRebuildOverride = undefined
    if (override !== undefined) return await override(request)
    const text = await readFile(request.candidatePath, 'utf8')
    const current = request.currentNodes[0]
    const nodeId = current?.id ?? DocumentNodeId('node-1')
    return [{
      id: nodeId,
      documentId: request.document.id,
      officePath: '/body/p[1]',
      ordinal: 0,
      kind: 'paragraph',
      text,
      style: {},
      hash: createHash('sha256').update(text).digest('hex'),
      lineage: [],
      lastCommitId: request.commitId,
      updatedAt: '2026-08-28T00:00:00.000Z',
    }]
  }
}

class FakePaperTemplates extends Service implements PaperTemplateCommitPeer {
  static inject = ['paperRepository']

  readonly contracts = new Map<string, {
    projectId: ProjectIdType
    roles: DocumentRecord['role'][]
    status: 'draft' | 'confirmed'
  }>()
  nextGate: GateReport | undefined

  constructor(ctx: Context) {
    super(ctx, 'paperTemplates')
  }

  validateAssociation(input: {
    readonly documentId: DocumentIdType
    readonly templateId: ReturnType<typeof TemplateContractId>
  }): DocumentRecord {
    const repository = this.ctx.paperRepository as unknown as FakePaperRepository
    const document = repository.getDocument(input.documentId)
    if (document === undefined) throw new Error('document not found')
    const contract = this.contracts.get(input.templateId)
    if (contract === undefined) throw new Error('template not found')
    if (contract.status !== 'confirmed') throw new Error('template must be confirmed')
    if (contract.projectId !== document.projectId) throw new Error('template belongs to another project')
    if (!contract.roles.includes(document.role)) throw new Error('template does not apply to document role')
    return structuredClone(document)
  }

  checkCandidate(input: {
    readonly document: DocumentRecord
    readonly candidatePath: string
    readonly templateId?: ReturnType<typeof TemplateContractId>
    readonly mode: GateReport['mode']
  }): Promise<GateReport> {
    if (this.nextGate !== undefined) {
      const report = this.nextGate
      this.nextGate = undefined
      return Promise.resolve(structuredClone(report))
    }
    return Promise.resolve({
      status: 'pass',
      mode: input.mode,
      documentId: input.document.id,
      ...(input.templateId === undefined ? {} : { templateId: input.templateId }),
      findings: [],
      checkedAt: '2026-08-28T00:00:00.000Z',
    })
  }
}

interface Harness {
  readonly ctx: Context
  readonly root: string
  readonly workingPath: string
  readonly documentId: DocumentIdType
  readonly nodeId: DocumentNodeIdType
  readonly repository: FakePaperRepository
  readonly engine: FakeDocumentEngine
  readonly documents: FakePaperDocuments
  readonly templates: FakePaperTemplates
}

const contexts: Context[] = []
const roots: string[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function createHarness(initialText = 'alpha'): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'paperai-commit-'))
  roots.push(root)
  const workingPath = join(root, 'documents', 'working.docx')
  const sourcePath = join(root, 'sources', 'source.docx')
  await mkdir(join(root, 'documents'), { recursive: true })
  await mkdir(join(root, 'sources'), { recursive: true })
  await writeFile(workingPath, initialText, 'utf8')
  await writeFile(sourcePath, initialText, 'utf8')

  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(FakePaperRepository)
  await ctx.plugin(FakeDocumentEngine)
  await ctx.plugin(FakePaperDocuments)
  await ctx.plugin(FakePaperTemplates)
  await ctx.plugin(PaperCommitService)

  const repository = ctx.paperRepository as unknown as FakePaperRepository
  const engine = ctx.documentEngine as FakeDocumentEngine
  const documents = ctx.paperDocuments as unknown as FakePaperDocuments
  const templates = ctx.paperTemplates as unknown as FakePaperTemplates
  const projectId = ProjectId('project-1')
  const documentId = DocumentId('document-1')
  const nodeId = DocumentNodeId('node-1')
  repository.projects.set(projectId, {
    id: projectId,
    workspaceId: 'workspace-1',
    name: 'Thesis',
    rootPath: root,
    createdAt: '2026-08-28T00:00:00.000Z',
    updatedAt: '2026-08-28T00:00:00.000Z',
  })
  repository.documents.set(documentId, {
    id: documentId,
    projectId,
    name: 'Thesis.docx',
    role: 'manuscript',
    immutableSourcePath: sourcePath,
    workingPath,
    mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    sourceSha256: createHash('sha256').update(initialText).digest('hex'),
    nodeCount: 1,
    createdAt: '2026-08-28T00:00:00.000Z',
    updatedAt: '2026-08-28T00:00:00.000Z',
  })
  repository.nodes.set(nodeId, {
    id: nodeId,
    documentId,
    officePath: '/body/p[1]',
    ordinal: 0,
    kind: 'paragraph',
    text: initialText,
    style: {},
    hash: createHash('sha256').update(initialText).digest('hex'),
    lineage: [],
    updatedAt: '2026-08-28T00:00:00.000Z',
  })
  templates.contracts.set('template-1', { projectId, roles: ['manuscript'], status: 'confirmed' })
  templates.contracts.set('template-2', { projectId, roles: ['manuscript'], status: 'confirmed' })
  return { ctx, root, workingPath, documentId, nodeId, repository, engine, documents, templates }
}

const codexActor: ActorIdentity = {
  kind: 'agent',
  name: 'Codex',
  client: 'codex',
  provider: 'openai',
  model: 'gpt-5.6-luna',
  modelRevision: '2026-08-28',
  sessionId: 'session-codex-1',
  runId: 'run-1',
}

const humanActor: ActorIdentity = {
  kind: 'human',
  name: 'ly',
  client: 'paperai',
  sessionId: 'session-human-1',
}

function replaceMutation(nodeId: DocumentNodeIdType, baseText: string, nextText: string) {
  return { type: 'replace-text', nodeId, baseText, nextText } as const
}

interface MutationCompiler {
  compileMutations(document: DocumentRecord, mutations: readonly DocumentMutation[]): Promise<{
    readonly engineMutations: readonly EngineMutation[]
    readonly operations: readonly DocumentOperation[]
    readonly templateId?: ReturnType<typeof TemplateContractId>
  }>
}

function compile(harness: Harness, mutations: readonly DocumentMutation[]) {
  const document = harness.repository.documents.get(harness.documentId)
  if (document === undefined) throw new Error('test document missing')
  return (harness.ctx.paperCommits as unknown as MutationCompiler).compileMutations(document, mutations)
}

function rebuiltNode(
  request: DocumentIndexRebuildRequest,
  id: DocumentNodeIdType,
  ordinal: number,
  overrides: Partial<DocumentNode> = {},
): DocumentNode {
  return {
    id,
    documentId: request.document.id,
    officePath: `/body/p[${ordinal + 1}]`,
    ordinal,
    kind: 'paragraph',
    text: `node-${ordinal}`,
    style: {},
    hash: `${ordinal}`,
    lineage: [],
    lastCommitId: request.commitId,
    updatedAt: '2026-08-28T00:00:00.000Z',
    ...overrides,
  }
}

describe('PaperCommitService', () => {
  it('serializes one document FIFO and rejects the queued stale base', async () => {
    const harness = await createHarness()
    const block = new Deferred()
    harness.engine.nextApplyBlock = block.promise

    const first = harness.ctx.paperCommits.submit({
      documentId: harness.documentId,
      message: 'Agent revision',
      actor: codexActor,
      mutations: [replaceMutation(harness.nodeId, 'alpha', 'beta')],
    })
    await harness.engine.applyStarted.promise
    const second = harness.ctx.paperCommits.submit({
      documentId: harness.documentId,
      message: 'Stale human revision',
      actor: humanActor,
      mutations: [replaceMutation(harness.nodeId, 'alpha', 'gamma')],
    })

    await Promise.resolve()
    expect(harness.engine.applyCalls).toBe(1)
    block.resolve()
    const firstCommit = await first
    await expect(second).rejects.toBeInstanceOf(DocumentHeadConflictError)

    expect(harness.engine.maxActiveApplies).toBe(1)
    expect(await readFile(harness.workingPath, 'utf8')).toBe('beta')
    expect(harness.repository.documents.get(harness.documentId)?.headCommitId).toBe(firstCommit.id)
  })

  it('leaves the authoritative file and history unchanged when Office validation fails', async () => {
    const harness = await createHarness()
    harness.engine.failValidation = true

    await expect(harness.ctx.paperCommits.submit({
      documentId: harness.documentId,
      message: 'Invalid revision',
      actor: humanActor,
      mutations: [replaceMutation(harness.nodeId, 'alpha', 'broken')],
    })).rejects.toBeInstanceOf(DocumentValidationError)

    expect(await readFile(harness.workingPath, 'utf8')).toBe('alpha')
    expect(harness.repository.documents.get(harness.documentId)?.headCommitId).toBeUndefined()
    expect(harness.repository.nodes.get(harness.nodeId)?.text).toBe('alpha')
    expect(harness.repository.commits.size).toBe(0)
    expect(harness.ctx.paperCommits.listHistory(harness.documentId)).toEqual([])
  })

  it('restores the Working DOCX and node index when final head publication fails', async () => {
    const harness = await createHarness()
    harness.repository.failNextDocumentUpdate = true

    await expect(harness.ctx.paperCommits.submit({
      documentId: harness.documentId,
      message: 'Publication failure',
      actor: humanActor,
      mutations: [replaceMutation(harness.nodeId, 'alpha', 'beta')],
    })).rejects.toThrow('selected document-head write failure')

    expect(await readFile(harness.workingPath, 'utf8')).toBe('alpha')
    expect(harness.repository.documents.get(harness.documentId)?.headCommitId).toBeUndefined()
    expect(harness.repository.nodes.get(harness.nodeId)?.text).toBe('alpha')
    expect(harness.repository.commits.size).toBe(1)
    expect(harness.ctx.paperCommits.listHistory(harness.documentId)).toEqual([])
  })

  it('finalizes the commit when persistence reports failure after storing its head', async () => {
    const harness = await createHarness()
    harness.repository.failAfterNextDocumentUpdate = true

    const commit = await harness.ctx.paperCommits.submit({
      documentId: harness.documentId,
      message: 'Post-persistence failure',
      actor: humanActor,
      mutations: [replaceMutation(harness.nodeId, 'alpha', 'beta')],
    })

    expect(await readFile(harness.workingPath, 'utf8')).toBe('beta')
    expect(harness.repository.documents.get(harness.documentId)?.headCommitId).toBe(commit.id)
    expect(harness.repository.nodes.get(harness.nodeId)?.text).toBe('beta')
    expect(harness.ctx.paperCommits.listHistory(harness.documentId)).toEqual([commit])
    expect(harness.repository.publications.size).toBe(0)
  })

  it('retains exact Agent model and session provenance on the automatic commit', async () => {
    const harness = await createHarness()
    const commit = await harness.ctx.paperCommits.submit({
      documentId: harness.documentId,
      message: 'Codex revision',
      actor: codexActor,
      mutations: [replaceMutation(harness.nodeId, 'alpha', 'beta')],
    })

    expect(commit.actor).toEqual(codexActor)
    expect(harness.repository.documents.get(harness.documentId)?.headCommitId).toBe(commit.id)
    expect(harness.ctx.paperCommits.listHistory(harness.documentId)).toEqual([commit])
    expect(commit.snapshotPath).toMatch(new RegExp(`${commit.documentSha256}\\.docx$`, 'u'))
  })

  it('rejects Agent writes that omit model or session provenance', async () => {
    const harness = await createHarness()
    expect(() => harness.ctx.paperCommits.submit({
      documentId: harness.documentId,
      message: 'Unknown Agent revision',
      actor: { kind: 'agent', name: 'unknown', client: 'codex' },
      mutations: [replaceMutation(harness.nodeId, 'alpha', 'beta')],
    })).toThrow(PaperCommitError)
  })

  it('reverts a reachable snapshot as a new child commit', async () => {
    const harness = await createHarness()
    const first = await harness.ctx.paperCommits.submit({
      documentId: harness.documentId,
      message: 'First revision',
      actor: codexActor,
      mutations: [replaceMutation(harness.nodeId, 'alpha', 'beta')],
    })
    const second = await harness.ctx.paperCommits.submit({
      documentId: harness.documentId,
      baseCommitId: first.id,
      message: 'Second revision',
      actor: humanActor,
      mutations: [replaceMutation(harness.nodeId, 'beta', 'gamma')],
    })
    const reverted = await harness.ctx.paperCommits.revert({
      documentId: harness.documentId,
      baseCommitId: second.id,
      targetCommitId: first.id,
      actor: codexActor,
    })

    expect(await readFile(harness.workingPath, 'utf8')).toBe('beta')
    expect(reverted.parentId).toBe(second.id)
    expect(reverted.id).not.toBe(first.id)
    expect(reverted.snapshotPath).toBe(first.snapshotPath)
    expect(reverted.operations).toEqual([{
      type: 'revert',
      before: { commitId: second.id, documentSha256: second.documentSha256 },
      after: { commitId: first.id, documentSha256: first.documentSha256 },
    }])
    expect(harness.ctx.paperCommits.listHistory(harness.documentId).map(commit => commit.id))
      .toEqual([reverted.id, second.id, first.id])
  })

  it('restores the target commit template binding during revert', async () => {
    const harness = await createHarness()
    const first = await harness.ctx.paperCommits.submit({
      documentId: harness.documentId,
      message: 'Version without template',
      actor: humanActor,
      mutations: [replaceMutation(harness.nodeId, 'alpha', 'beta')],
    })
    const bound = await harness.ctx.paperCommits.submit({
      documentId: harness.documentId,
      baseCommitId: first.id,
      message: 'Bind later template',
      actor: humanActor,
      mutations: [{ type: 'bind-template', templateId: TemplateContractId('template-1') }],
    })

    const reverted = await harness.ctx.paperCommits.revert({
      documentId: harness.documentId,
      baseCommitId: bound.id,
      targetCommitId: first.id,
      actor: humanActor,
    })

    expect(harness.repository.documents.get(harness.documentId)).not.toHaveProperty('templateId')
    expect(reverted.gate.templateId).toBeUndefined()
  })

  it('validates request fields and complete Agent provenance before queueing', async () => {
    const harness = await createHarness()
    expect(() => harness.ctx.paperCommits.submit({
      documentId: harness.documentId,
      message: ' ',
      actor: humanActor,
      mutations: [replaceMutation(harness.nodeId, 'alpha', 'beta')],
    })).toThrow('message must be non-blank')
    expect(() => harness.ctx.paperCommits.submit({
      documentId: harness.documentId,
      message: 'Empty batch',
      actor: humanActor,
      mutations: [],
    })).toThrow('at least one mutation')
    expect(() => harness.ctx.paperCommits.submit({
      documentId: harness.documentId,
      message: 'Missing actor',
      actor: { kind: 'human', name: ' ' },
      mutations: [replaceMutation(harness.nodeId, 'alpha', 'beta')],
    })).toThrow('actor name must be non-blank')
    expect(() => harness.ctx.paperCommits.submit({
      documentId: harness.documentId,
      message: 'Blank optional provenance',
      actor: { kind: 'human', name: 'ly', provider: ' ' },
      mutations: [replaceMutation(harness.nodeId, 'alpha', 'beta')],
    })).toThrow('actor provider must be non-blank')
    expect(new DocumentHeadConflictError(
      harness.documentId,
      DocumentCommitId('expected'),
      undefined,
    ).message).toContain('actual <none>')
  })

  it('runs the next FIFO item after the preceding item rejects', async () => {
    const harness = await createHarness()
    const block = new Deferred()
    harness.engine.nextApplyBlock = block.promise
    harness.engine.validationFailures = 1
    const failed = harness.ctx.paperCommits.submit({
      documentId: harness.documentId,
      message: 'Rejected first item',
      actor: humanActor,
      mutations: [replaceMutation(harness.nodeId, 'alpha', 'beta')],
    })
    await harness.engine.applyStarted.promise
    const next = harness.ctx.paperCommits.submit({
      documentId: harness.documentId,
      message: 'Accepted second item',
      actor: humanActor,
      mutations: [replaceMutation(harness.nodeId, 'alpha', 'gamma')],
    })
    block.resolve()

    await expect(failed).rejects.toBeInstanceOf(DocumentValidationError)
    await expect(next).resolves.toMatchObject({ message: 'Accepted second item' })
    expect(await readFile(harness.workingPath, 'utf8')).toBe('gamma')
  })

  it('reports missing document and project records without staging a file', async () => {
    const missingDocument = await createHarness()
    await expect(missingDocument.ctx.paperCommits.submit({
      documentId: DocumentId('missing'),
      message: 'Missing document',
      actor: humanActor,
      mutations: [{ type: 'milestone', label: 'checkpoint' }],
    })).rejects.toMatchObject({ code: 'DOCUMENT_NOT_FOUND' })

    const missingProject = await createHarness()
    missingProject.repository.projects.clear()
    await expect(missingProject.ctx.paperCommits.submit({
      documentId: missingProject.documentId,
      message: 'Missing project',
      actor: humanActor,
      mutations: [{ type: 'milestone', label: 'checkpoint' }],
    })).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' })
  })

  it('returns isolated commit objects and distinguishes an unknown id', async () => {
    const harness = await createHarness()
    const commit = await harness.ctx.paperCommits.submit({
      documentId: harness.documentId,
      message: 'Stored object',
      actor: humanActor,
      mutations: [replaceMutation(harness.nodeId, 'alpha', 'beta')],
    })
    const read = harness.ctx.paperCommits.getCommit(commit.id)
    expect(read).toEqual(commit)
    if (read === undefined) throw new Error('commit unexpectedly missing')
    read.message = 'caller mutation'
    expect(harness.ctx.paperCommits.getCommit(commit.id)?.message).toBe('Stored object')
    expect(harness.ctx.paperCommits.getCommit(DocumentCommitId('missing'))).toBeUndefined()
  })

  it('compiles every currently supported mutation form and rejects stale operands', async () => {
    const harness = await createHarness()
    const firstTemplate = TemplateContractId('template-1')
    const secondTemplate = TemplateContractId('template-2')
    const compiled = await compile(harness, [
      { type: 'insert-node', text: 'append' },
      { type: 'insert-node', text: 'after', afterNodeId: harness.nodeId, style: 'Body' },
      { type: 'insert-node', text: 'before', beforeNodeId: harness.nodeId },
      { type: 'delete-node', nodeId: harness.nodeId },
      { type: 'bind-template', templateId: firstTemplate },
      { type: 'bind-template', templateId: secondTemplate },
      { type: 'milestone', label: '  review-ready  ' },
    ])
    expect(compiled.engineMutations).toHaveLength(4)
    expect(compiled.operations.map(operation => operation.type)).toEqual([
      'insert-node', 'insert-node', 'insert-node', 'delete-node',
      'bind-template', 'bind-template', 'milestone',
    ])
    expect(compiled.templateId).toBe(secondTemplate)

    const sequential = await compile(harness, [
      replaceMutation(harness.nodeId, 'alpha', 'beta'),
      replaceMutation(harness.nodeId, 'beta', 'gamma'),
    ])
    expect(sequential.operations).toMatchObject([
      { before: 'alpha', after: 'beta' },
      { before: 'beta', after: 'gamma' },
    ])
    await expect(compile(harness, [
      { type: 'delete-node', nodeId: harness.nodeId },
      replaceMutation(harness.nodeId, 'alpha', 'beta'),
    ])).rejects.toMatchObject({ code: 'NODE_NOT_FOUND' })

    await expect(compile(harness, [{
      type: 'insert-node',
      text: 'ambiguous',
      afterNodeId: harness.nodeId,
      beforeNodeId: harness.nodeId,
    }])).rejects.toThrow('either afterNodeId or beforeNodeId')
    await expect(compile(harness, [replaceMutation(DocumentNodeId('missing'), 'alpha', 'beta')]))
      .rejects.toMatchObject({ code: 'NODE_NOT_FOUND' })
    await expect(compile(harness, [replaceMutation(harness.nodeId, 'stale', 'beta')]))
      .rejects.toMatchObject({ code: 'NODE_TEXT_CONFLICT' })
    await expect(compile(harness, [replaceMutation(harness.nodeId, 'alpha', 'alpha')]))
      .rejects.toThrow('no-op')
    await expect(compile(harness, [{ type: 'delete-node', nodeId: harness.nodeId, baseText: 'stale' }]))
      .rejects.toMatchObject({ code: 'NODE_TEXT_CONFLICT' })
    await expect(compile(harness, [{ type: 'milestone', label: ' ' }]))
      .rejects.toThrow('milestone label must be non-blank')
  })

  it('rejects mutations whose executable owner is not available', async () => {
    const harness = await createHarness()
    const unsupported: DocumentMutation[] = [
      { type: 'set-style', nodeId: harness.nodeId, patch: { bold: true } },
      { type: 'set-fact', key: 'student', value: 'ly' },
      { type: 'revert', targetCommitId: DocumentCommitId('target') },
    ]
    for (const mutation of unsupported) {
      await expect(compile(harness, [mutation])).rejects.toMatchObject({ code: 'UNSUPPORTED_MUTATION' })
    }
    await expect(compile(harness, [{ type: 'unknown' } as unknown as DocumentMutation]))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_MUTATION' })
  })

  it('publishes metadata-only commits and sorts a rebuilt multi-node index', async () => {
    const harness = await createHarness()
    const templateId = TemplateContractId('template-1')
    harness.documents.nextRebuildOverride = request => [
      rebuiltNode(request, DocumentNodeId('node-2'), 1),
      rebuiltNode(request, harness.nodeId, 0),
    ]
    const commit = await harness.ctx.paperCommits.submit({
      documentId: harness.documentId,
      message: 'Bind template',
      actor: humanActor,
      mutations: [{ type: 'bind-template', templateId }],
    })

    expect(harness.engine.applyCalls).toBe(0)
    expect(harness.repository.documents.get(harness.documentId)).toMatchObject({
      templateId,
      nodeCount: 2,
      headCommitId: commit.id,
    })
    expect(commit.gate.templateId).toBe(templateId)
    expect([...harness.repository.nodes.values()].map(node => node.ordinal)).toEqual([0, 1])
  })

  it('rejects invalid template bindings before publishing a commit', async () => {
    const harness = await createHarness()
    await expect(harness.ctx.paperCommits.submit({
      documentId: harness.documentId,
      message: 'Bind missing template',
      actor: humanActor,
      mutations: [{ type: 'bind-template', templateId: TemplateContractId('missing-template') }],
    })).rejects.toThrow('template not found')

    harness.templates.contracts.set('template-1', {
      projectId: ProjectId('another-project'),
      roles: ['manuscript'],
      status: 'confirmed',
    })
    await expect(harness.ctx.paperCommits.submit({
      documentId: harness.documentId,
      message: 'Bind foreign template',
      actor: humanActor,
      mutations: [{ type: 'bind-template', templateId: TemplateContractId('template-1') }],
    })).rejects.toThrow('another project')
    expect(harness.ctx.paperCommits.listHistory(harness.documentId)).toEqual([])
  })

  it('rejects unversioned Working DOCX bytes instead of attributing them to the next actor', async () => {
    const harness = await createHarness()
    const first = await harness.ctx.paperCommits.submit({
      documentId: harness.documentId,
      message: 'Versioned edit',
      actor: humanActor,
      mutations: [replaceMutation(harness.nodeId, 'alpha', 'beta')],
    })
    await writeFile(harness.workingPath, 'outside Word edit', 'utf8')
    await expect(harness.ctx.paperCommits.submit({
      documentId: harness.documentId,
      baseCommitId: first.id,
      message: 'Must not absorb external edit',
      actor: codexActor,
      mutations: [replaceMutation(harness.nodeId, 'beta', 'gamma')],
    })).rejects.toMatchObject({ code: 'WORKING_COPY_CHANGED' })
    expect(harness.ctx.paperCommits.listHistory(harness.documentId)).toHaveLength(1)
  })

  it('stores the real continuous gate report supplied for the exact candidate', async () => {
    const harness = await createHarness()
    harness.templates.nextGate = {
      status: 'fail',
      mode: 'continuous',
      documentId: harness.documentId,
      findings: [{
        id: 'required-field',
        severity: 'error',
        code: 'required_field_empty',
        message: 'Student id is required',
      }],
      checkedAt: '2026-08-28T01:00:00.000Z',
    }
    const commit = await harness.ctx.paperCommits.submit({
      documentId: harness.documentId,
      message: 'Gate evidence',
      actor: humanActor,
      mutations: [replaceMutation(harness.nodeId, 'alpha', 'beta')],
    })
    expect(commit.gate).toMatchObject({
      status: 'fail',
      findings: [expect.objectContaining({ code: 'required_field_empty' })],
    })
  })

  it('rejects a changed head, path, or Working DOCX discovered after staging', async () => {
    const changedHead = await createHarness()
    const headBlock = new Deferred()
    changedHead.documents.nextRebuildBlock = headBlock.promise
    const headCommit = changedHead.ctx.paperCommits.submit({
      documentId: changedHead.documentId,
      message: 'Head race',
      actor: humanActor,
      mutations: [replaceMutation(changedHead.nodeId, 'alpha', 'beta')],
    })
    await changedHead.documents.rebuildStarted.promise
    const headRecord = changedHead.repository.documents.get(changedHead.documentId)
    if (headRecord === undefined) throw new Error('test document missing')
    changedHead.repository.documents.set(changedHead.documentId, {
      ...headRecord,
      headCommitId: DocumentCommitId('external-head'),
    })
    headBlock.resolve()
    await expect(headCommit).rejects.toBeInstanceOf(DocumentHeadConflictError)

    const changedPath = await createHarness()
    const pathBlock = new Deferred()
    changedPath.documents.nextRebuildBlock = pathBlock.promise
    const pathCommit = changedPath.ctx.paperCommits.submit({
      documentId: changedPath.documentId,
      message: 'Path race',
      actor: humanActor,
      mutations: [replaceMutation(changedPath.nodeId, 'alpha', 'beta')],
    })
    await changedPath.documents.rebuildStarted.promise
    const pathRecord = changedPath.repository.documents.get(changedPath.documentId)
    if (pathRecord === undefined) throw new Error('test document missing')
    changedPath.repository.documents.set(changedPath.documentId, {
      ...pathRecord,
      workingPath: join(changedPath.root, 'documents', 'other.docx'),
    })
    pathBlock.resolve()
    await expect(pathCommit).rejects.toMatchObject({ code: 'WORKING_COPY_CHANGED' })

    const changedFile = await createHarness()
    const fileBlock = new Deferred()
    changedFile.documents.nextRebuildBlock = fileBlock.promise
    const fileCommit = changedFile.ctx.paperCommits.submit({
      documentId: changedFile.documentId,
      message: 'File race',
      actor: humanActor,
      mutations: [replaceMutation(changedFile.nodeId, 'alpha', 'beta')],
    })
    await changedFile.documents.rebuildStarted.promise
    await writeFile(changedFile.workingPath, 'external', 'utf8')
    fileBlock.resolve()
    await expect(fileCommit).rejects.toMatchObject({ code: 'WORKING_COPY_CHANGED' })
    expect(await readFile(changedFile.workingPath, 'utf8')).toBe('external')
  })

  it('honors cancellation during candidate staging before publication', async () => {
    const harness = await createHarness()
    const block = new Deferred()
    const controller = new AbortController()
    harness.documents.nextRebuildBlock = block.promise
    const pending = harness.ctx.paperCommits.submit({
      documentId: harness.documentId,
      message: 'Cancelled revision',
      actor: humanActor,
      mutations: [replaceMutation(harness.nodeId, 'alpha', 'beta')],
      signal: controller.signal,
    })
    await harness.documents.rebuildStarted.promise
    controller.abort()
    block.resolve()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(await readFile(harness.workingPath, 'utf8')).toBe('alpha')
  })

  it('rejects malformed rebuilt indexes before snapshot publication', async () => {
    const wrongDocument = await createHarness()
    wrongDocument.documents.nextRebuildOverride = request => [rebuiltNode(request, wrongDocument.nodeId, 0, {
      documentId: DocumentId('other'),
    })]
    await expect(wrongDocument.ctx.paperCommits.submit({
      documentId: wrongDocument.documentId,
      message: 'Wrong document index',
      actor: humanActor,
      mutations: [{ type: 'milestone', label: 'checkpoint' }],
    })).rejects.toMatchObject({ code: 'INDEX_INVALID' })

    const wrongCommit = await createHarness()
    wrongCommit.documents.nextRebuildOverride = request => [rebuiltNode(request, wrongCommit.nodeId, 0, {
      lastCommitId: DocumentCommitId('other'),
    })]
    await expect(wrongCommit.ctx.paperCommits.submit({
      documentId: wrongCommit.documentId,
      message: 'Wrong commit index',
      actor: humanActor,
      mutations: [{ type: 'milestone', label: 'checkpoint' }],
    })).rejects.toMatchObject({ code: 'INDEX_INVALID' })

    const duplicate = await createHarness()
    duplicate.documents.nextRebuildOverride = request => [
      rebuiltNode(request, duplicate.nodeId, 0),
      rebuiltNode(request, duplicate.nodeId, 1),
    ]
    await expect(duplicate.ctx.paperCommits.submit({
      documentId: duplicate.documentId,
      message: 'Duplicate node index',
      actor: humanActor,
      mutations: [{ type: 'milestone', label: 'checkpoint' }],
    })).rejects.toMatchObject({ code: 'INDEX_INVALID' })

    const duplicateOrdinal = await createHarness()
    duplicateOrdinal.documents.nextRebuildOverride = request => [
      rebuiltNode(request, duplicateOrdinal.nodeId, 0),
      rebuiltNode(request, DocumentNodeId('node-2'), 0),
    ]
    await expect(duplicateOrdinal.ctx.paperCommits.submit({
      documentId: duplicateOrdinal.documentId,
      message: 'Duplicate ordinal index',
      actor: humanActor,
      mutations: [{ type: 'milestone', label: 'checkpoint' }],
    })).rejects.toMatchObject({ code: 'INDEX_INVALID' })
  })

  it('restores or reports every node-index rollback outcome', async () => {
    const failedRestore = await createHarness()
    failedRestore.repository.failNextDocumentUpdate = true
    failedRestore.repository.failPutNodeCalls.add(2)
    await expect(failedRestore.ctx.paperCommits.submit({
      documentId: failedRestore.documentId,
      message: 'Index restore failure',
      actor: humanActor,
      mutations: [replaceMutation(failedRestore.nodeId, 'alpha', 'beta')],
    })).rejects.toBeInstanceOf(AggregateError)
    expect(await readFile(failedRestore.workingPath, 'utf8')).toBe('alpha')
    expect(failedRestore.repository.publications.size).toBe(1)
    await expect(failedRestore.ctx.paperCommits.submit({
      documentId: failedRestore.documentId,
      message: 'Retry after journal recovery',
      actor: humanActor,
      mutations: [replaceMutation(failedRestore.nodeId, 'alpha', 'gamma')],
    })).resolves.toMatchObject({ message: 'Retry after journal recovery' })
    expect(await readFile(failedRestore.workingPath, 'utf8')).toBe('gamma')
    expect(failedRestore.repository.publications.size).toBe(0)

    const addedNode = await createHarness()
    addedNode.repository.failNextDocumentUpdate = true
    addedNode.documents.nextRebuildOverride = request => [
      rebuiltNode(request, addedNode.nodeId, 0),
      rebuiltNode(request, DocumentNodeId('node-2'), 1),
    ]
    await expect(addedNode.ctx.paperCommits.submit({
      documentId: addedNode.documentId,
      message: 'Remove staged node',
      actor: humanActor,
      mutations: [{ type: 'milestone', label: 'checkpoint' }],
    })).rejects.toThrow('selected document-head write failure')
    expect(addedNode.repository.nodes.has(DocumentNodeId('node-2'))).toBe(false)

    const failedDelete = await createHarness()
    failedDelete.repository.failNextDocumentUpdate = true
    failedDelete.repository.failDeleteNodeCalls.add(1)
    failedDelete.documents.nextRebuildOverride = request => [
      rebuiltNode(request, failedDelete.nodeId, 0),
      rebuiltNode(request, DocumentNodeId('node-2'), 1),
    ]
    await expect(failedDelete.ctx.paperCommits.submit({
      documentId: failedDelete.documentId,
      message: 'Staged-node delete failure',
      actor: humanActor,
      mutations: [{ type: 'milestone', label: 'checkpoint' }],
    })).rejects.toBeInstanceOf(AggregateError)
  })

  it('does not run index rollback when Working DOCX publication cannot start', async () => {
    const harness = await createHarness()
    harness.repository.onPutCommit = async () => {
      await rm(harness.workingPath)
      await mkdir(harness.workingPath)
    }

    await expect(harness.ctx.paperCommits.submit({
      documentId: harness.documentId,
      message: 'Working file replacement failure',
      actor: humanActor,
      mutations: [replaceMutation(harness.nodeId, 'alpha', 'beta')],
    })).rejects.toBeInstanceOf(AggregateError)
    expect(harness.repository.putNodeCalls).toBe(0)
    expect(harness.repository.documents.get(harness.documentId)?.headCommitId).toBeUndefined()
    expect(harness.repository.publications.size).toBe(1)
  })

  it('reports a Working DOCX rollback failure together with the publication failure', async () => {
    const harness = await createHarness()
    harness.repository.failNextDocumentUpdate = true
    harness.repository.onDocumentUpdate = async () => {
      await rm(harness.workingPath)
      await mkdir(harness.workingPath)
    }

    await expect(harness.ctx.paperCommits.submit({
      documentId: harness.documentId,
      message: 'Working file rollback failure',
      actor: humanActor,
      mutations: [replaceMutation(harness.nodeId, 'alpha', 'beta')],
    })).rejects.toBeInstanceOf(AggregateError)
  })

  it('removes stale index nodes when the rebuilt document no longer contains them', async () => {
    const harness = await createHarness()
    harness.documents.nextRebuildOverride = () => []

    const commit = await harness.ctx.paperCommits.submit({
      documentId: harness.documentId,
      message: 'Remove stale index nodes',
      actor: humanActor,
      mutations: [{ type: 'milestone', label: 'empty-index' }],
    })

    expect(harness.repository.nodes.size).toBe(0)
    expect(harness.repository.documents.get(harness.documentId)).toMatchObject({
      headCommitId: commit.id,
      nodeCount: 0,
    })
  })

  it('rolls back a path change discovered at the final head update', async () => {
    const changedPath = await createHarness()
    changedPath.repository.onDocumentUpdate = (call, repository) => {
      if (call !== 1) return
      const current = repository.documents.get(changedPath.documentId)
      if (current === undefined) return
      repository.documents.set(changedPath.documentId, {
        ...current,
        workingPath: join(changedPath.root, 'documents', 'other.docx'),
      })
    }
    await expect(changedPath.ctx.paperCommits.submit({
      documentId: changedPath.documentId,
      message: 'Final path race',
      actor: humanActor,
      mutations: [replaceMutation(changedPath.nodeId, 'alpha', 'beta')],
    })).rejects.toMatchObject({ code: 'WORKING_COPY_CHANGED' })
    expect(await readFile(changedPath.workingPath, 'utf8')).toBe('alpha')
  })

  it('keeps cleanup failures attached to failed work but not to a published commit', async () => {
    const failed = await createHarness()
    failed.engine.onValidate = async (candidatePath) => {
      await rm(candidatePath, { force: true })
      await mkdir(candidatePath)
    }
    await expect(failed.ctx.paperCommits.submit({
      documentId: failed.documentId,
      message: 'Candidate cleanup failure',
      actor: humanActor,
      mutations: [replaceMutation(failed.nodeId, 'alpha', 'beta')],
    })).rejects.toBeInstanceOf(AggregateError)

    const completed = await createHarness()
    completed.documents.nextRebuildOverride = async (request) => {
      const node = rebuiltNode(request, completed.nodeId, 0)
      await rm(request.candidatePath, { force: true })
      await mkdir(request.candidatePath)
      return [node]
    }
    await expect(completed.ctx.paperCommits.submit({
      documentId: completed.documentId,
      message: 'Published despite cleanup failure',
      actor: humanActor,
      mutations: [replaceMutation(completed.nodeId, 'alpha', 'beta')],
    })).resolves.toMatchObject({ message: 'Published despite cleanup failure' })
    expect(await readFile(completed.workingPath, 'utf8')).toBe('beta')
  })

  it('rejects invalid revert targets and corrupt reachable history', async () => {
    const harness = await createHarness()
    const first = await harness.ctx.paperCommits.submit({
      documentId: harness.documentId,
      message: 'First revision',
      actor: humanActor,
      mutations: [replaceMutation(harness.nodeId, 'alpha', 'beta')],
    })
    await expect(harness.ctx.paperCommits.revert({
      documentId: harness.documentId,
      baseCommitId: first.id,
      targetCommitId: first.id,
      actor: humanActor,
    })).rejects.toThrow('target must differ')
    await expect(harness.ctx.paperCommits.revert({
      documentId: harness.documentId,
      baseCommitId: first.id,
      targetCommitId: DocumentCommitId('unreachable'),
      message: 'Explicit revert message',
      actor: humanActor,
    })).rejects.toMatchObject({ code: 'COMMIT_NOT_FOUND' })

    harness.repository.commits.set(first.id, { ...first, parentId: first.id })
    expect(() => harness.ctx.paperCommits.listHistory(harness.documentId))
      .toThrow('commit history contains a cycle')

    harness.repository.commits.clear()
    expect(() => harness.ctx.paperCommits.listHistory(harness.documentId))
      .toThrow('references missing commit')

    harness.repository.commits.set(first.id, { ...first, documentId: DocumentId('other') })
    expect(() => harness.ctx.paperCommits.listHistory(harness.documentId))
      .toThrow('references missing commit')
  })
})
