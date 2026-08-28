import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { DocumentEngine } from '@paperai/document-engine'
import type { EngineMutation, EngineTextNode, EngineValidation } from '@paperai/document-engine'
import { DocumentId, DocumentNodeId, ProjectId } from '@paperai/domain'
import type {
  CapabilityHealth,
  DocumentCommit,
  DocumentCommitId,
  DocumentId as DocumentIdType,
  DocumentNode,
  DocumentNodeId as DocumentNodeIdType,
  DocumentRecord,
  GateReport,
  ProjectId as ProjectIdType,
  ProjectRecord,
} from '@paperai/domain'
import type { DocumentCommitPublication } from '@paperai/repository'
import PaperCommitService from '../src/index.ts'
import type {
  DocumentIndexRebuildRequest,
  PaperDocumentIndexPeer,
  PaperTemplateCommitPeer,
} from '../src/index.ts'
import { readFileImage, resolveCommitFilePaths, storeSnapshot } from '../src/files.ts'

const PROJECT_ID = ProjectId('project-1')
const DOCUMENT_ID = DocumentId('document-1')
const NODE_ID = DocumentNodeId('node-1')

interface RecoveryRepositoryState {
  readonly projects: Map<ProjectIdType, ProjectRecord>
  readonly documents: Map<DocumentIdType, DocumentRecord>
  readonly nodes: Map<DocumentNodeIdType, DocumentNode>
  readonly commits: Map<DocumentCommitId, DocumentCommit>
  readonly publications: Map<DocumentIdType, DocumentCommitPublication>
}

function createRepositoryState(): RecoveryRepositoryState {
  return {
    projects: new Map(),
    documents: new Map(),
    nodes: new Map(),
    commits: new Map(),
    publications: new Map(),
  }
}

class RecoveryRepository extends Service {
  constructor(ctx: Context, private readonly state: RecoveryRepositoryState) {
    super(ctx, 'paperRepository')
  }

  getProject(id: ProjectIdType): ProjectRecord | undefined {
    return this.state.projects.get(id)
  }

  putProject(record: ProjectRecord): Promise<void> {
    this.state.projects.set(record.id, structuredClone(record))
    return Promise.resolve()
  }

  getDocument(id: DocumentIdType): DocumentRecord | undefined {
    return this.state.documents.get(id)
  }

  putDocument(record: DocumentRecord): Promise<void> {
    this.state.documents.set(record.id, structuredClone(record))
    return Promise.resolve()
  }

  updateDocument(
    id: DocumentIdType,
    update: (record: DocumentRecord) => DocumentRecord,
  ): Promise<DocumentRecord> {
    const current = this.state.documents.get(id)
    if (current === undefined) return Promise.reject(new Error(`missing document '${id}'`))
    const next = update(current)
    this.state.documents.set(id, structuredClone(next))
    return Promise.resolve(next)
  }

  listNodes(documentId: DocumentIdType): DocumentNode[] {
    return [...this.state.nodes.values()]
      .filter(node => node.documentId === documentId)
      .sort((left, right) => left.ordinal - right.ordinal)
  }

  putNode(node: DocumentNode): Promise<void> {
    this.state.nodes.set(node.id, structuredClone(node))
    return Promise.resolve()
  }

  deleteNode(id: DocumentNodeIdType): Promise<boolean> {
    return Promise.resolve(this.state.nodes.delete(id))
  }

  getCommit(id: DocumentCommitId): DocumentCommit | undefined {
    return this.state.commits.get(id)
  }

  putCommit(commit: DocumentCommit): Promise<void> {
    this.state.commits.set(commit.id, structuredClone(commit))
    return Promise.resolve()
  }

  getCommitPublication(documentId: DocumentIdType): DocumentCommitPublication | undefined {
    return this.state.publications.get(documentId)
  }

  listCommitPublications(): DocumentCommitPublication[] {
    return [...this.state.publications.values()]
  }

  putCommitPublication(publication: DocumentCommitPublication): Promise<void> {
    this.state.publications.set(publication.documentId, structuredClone(publication))
    return Promise.resolve()
  }

  deleteCommitPublication(documentId: DocumentIdType): Promise<boolean> {
    return Promise.resolve(this.state.publications.delete(documentId))
  }
}

class RecoveryDocumentEngine extends DocumentEngine {
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
    let text = await readFile(filePath, 'utf8')
    for (const mutation of mutations) {
      if (mutation.type !== 'replace-text') throw new Error(`unsupported recovery mutation '${mutation.type}'`)
      text = mutation.text
    }
    await writeFile(filePath, text, 'utf8')
  }

  override validate(): Promise<EngineValidation> {
    return Promise.resolve({ success: true, details: { package: 'word/document.xml' } })
  }
}

class RecoveryPaperDocuments extends Service implements PaperDocumentIndexPeer {
  static inject = ['paperRepository']

  constructor(ctx: Context) {
    super(ctx, 'paperDocuments')
  }

  readNodes(documentId: DocumentIdType): readonly DocumentNode[] {
    return this.ctx.paperRepository.listNodes(documentId)
  }

  async buildCandidateIndex(request: DocumentIndexRebuildRequest): Promise<readonly DocumentNode[]> {
    const text = await readFile(request.candidatePath, 'utf8')
    return [{
      id: request.currentNodes[0]?.id ?? NODE_ID,
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

class RecoveryPaperTemplates extends Service implements PaperTemplateCommitPeer {
  constructor(ctx: Context) {
    super(ctx, 'paperTemplates')
  }

  validateAssociation(): DocumentRecord {
    throw new Error('recovery fixture does not bind templates')
  }

  checkCandidate(input: { readonly document: DocumentRecord; readonly mode: GateReport['mode'] }): Promise<GateReport> {
    return Promise.resolve({
      status: 'pass',
      mode: input.mode,
      documentId: input.document.id,
      findings: [],
      checkedAt: '2026-08-28T00:00:00.000Z',
    })
  }
}

interface RecoveryHarness {
  readonly ctx: Context
  readonly root: string
  readonly workingPath: string
}

interface PublicationFixture {
  readonly publication: DocumentCommitPublication
  readonly commit: DocumentCommit
}

const contexts: Context[] = []
const roots: string[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function createProjectRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'paperai-commit-recovery-'))
  roots.push(root)
  await mkdir(join(root, 'documents'), { recursive: true })
  await mkdir(join(root, 'sources'), { recursive: true })
  await writeFile(join(root, 'documents', 'working.docx'), 'alpha', 'utf8')
  await writeFile(join(root, 'sources', 'source.docx'), 'alpha', 'utf8')
  return root
}

async function openBase(root: string, state: RecoveryRepositoryState): Promise<RecoveryHarness> {
  const ctx = new Context()
  contexts.push(ctx)
  const RepositoryPlugin = class extends RecoveryRepository {
    constructor(pluginContext: Context) {
      super(pluginContext, state)
    }
  }
  await ctx.plugin(RepositoryPlugin)
  await ctx.plugin(RecoveryDocumentEngine)
  await ctx.plugin(RecoveryPaperDocuments)
  await ctx.plugin(RecoveryPaperTemplates)
  return { ctx, root, workingPath: join(root, 'documents', 'working.docx') }
}

async function seedProject(harness: RecoveryHarness): Promise<void> {
  const repository = harness.ctx.paperRepository
  await repository.putProject({
    id: PROJECT_ID,
    workspaceId: 'workspace-1',
    name: 'Thesis',
    rootPath: harness.root,
    createdAt: '2026-08-28T00:00:00.000Z',
    updatedAt: '2026-08-28T00:00:00.000Z',
  })
  await repository.putDocument({
    id: DOCUMENT_ID,
    projectId: PROJECT_ID,
    documentKind: 'working',
    name: 'Thesis.docx',
    role: 'manuscript',
    immutableSourcePath: join(harness.root, 'sources', 'source.docx'),
    workingPath: harness.workingPath,
    mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    sourceSha256: createHash('sha256').update('alpha').digest('hex'),
    nodeCount: 1,
    createdAt: '2026-08-28T00:00:00.000Z',
    updatedAt: '2026-08-28T00:00:00.000Z',
  })
  await repository.putNode({
    id: NODE_ID,
    documentId: DOCUMENT_ID,
    officePath: '/body/p[1]',
    ordinal: 0,
    kind: 'paragraph',
    text: 'alpha',
    style: {},
    hash: createHash('sha256').update('alpha').digest('hex'),
    lineage: [],
    updatedAt: '2026-08-28T00:00:00.000Z',
  })
}

async function mountCommits(harness: RecoveryHarness): Promise<void> {
  await harness.ctx.plugin(PaperCommitService)
}

async function seedPublication(
  harness: RecoveryHarness,
  head: 'before' | 'after',
): Promise<PublicationFixture> {
  const repository = harness.ctx.paperRepository
  const beforeDocument = structuredClone(repository.getDocument(DOCUMENT_ID))
  if (beforeDocument === undefined) throw new Error('recovery fixture document missing')
  const beforeNodes = structuredClone(repository.listNodes(DOCUMENT_ID))
  const beforeWorking = await readFileImage(harness.workingPath, 'RECOVERY_FAILED', 'fixture Working DOCX')
  const paths = resolveCommitFilePaths(harness.root, harness.workingPath)
  const originalSnapshotPath = await storeSnapshot(paths, beforeWorking.bytes, beforeWorking.sha256)
  const commit = await harness.ctx.paperCommits.submit({
    documentId: DOCUMENT_ID,
    message: 'Interrupted revision',
    actor: { kind: 'human', name: 'ly' },
    mutations: [{ type: 'replace-text', nodeId: NODE_ID, baseText: 'alpha', nextText: 'beta' }],
  })
  const afterDocument = structuredClone(repository.getDocument(DOCUMENT_ID))
  if (afterDocument === undefined) throw new Error('published recovery fixture document missing')
  const publication: DocumentCommitPublication = {
    version: 1,
    documentId: DOCUMENT_ID,
    commit,
    before: {
      document: beforeDocument,
      nodes: beforeNodes,
      working: {
        snapshotPath: originalSnapshotPath,
        sha256: beforeWorking.sha256,
        mode: beforeWorking.mode,
      },
    },
    after: {
      document: afterDocument,
      nodes: structuredClone(repository.listNodes(DOCUMENT_ID)),
    },
    createdAt: commit.createdAt,
  }
  if (head === 'before') await repository.putDocument(beforeDocument)
  await repository.putCommitPublication(publication)
  return { publication, commit }
}

async function disposeHarness(harness: RecoveryHarness): Promise<void> {
  await harness.ctx.fiber.dispose()
  const index = contexts.indexOf(harness.ctx)
  if (index >= 0) contexts.splice(index, 1)
}

describe('PaperCommitService durable crash recovery', () => {
  it('rolls back commit-stored and Working-replaced state on the next Host boot', async () => {
    const root = await createProjectRoot()
    const state = createRepositoryState()
    const first = await openBase(root, state)
    await seedProject(first)
    await mountCommits(first)
    const { commit } = await seedPublication(first, 'before')
    expect(await readFile(first.workingPath, 'utf8')).toBe('beta')
    expect(first.ctx.paperRepository.getDocument(DOCUMENT_ID)?.headCommitId).toBeUndefined()
    await disposeHarness(first)

    const reopened = await openBase(root, state)
    await mountCommits(reopened)
    expect(await readFile(reopened.workingPath, 'utf8')).toBe('alpha')
    expect(reopened.ctx.paperRepository.getDocument(DOCUMENT_ID)?.headCommitId).toBeUndefined()
    expect(reopened.ctx.paperRepository.listNodes(DOCUMENT_ID)[0]?.text).toBe('alpha')
    expect(reopened.ctx.paperRepository.getCommitPublication(DOCUMENT_ID)).toBeUndefined()
    expect(reopened.ctx.paperRepository.getCommit(commit.id)).toEqual(commit)
  })

  it('finalizes a committed journal before the next operation enters its FIFO', async () => {
    const root = await createProjectRoot()
    const harness = await openBase(root, createRepositoryState())
    await seedProject(harness)
    await mountCommits(harness)
    const { commit } = await seedPublication(harness, 'after')

    const next = await harness.ctx.paperCommits.submit({
      documentId: DOCUMENT_ID,
      baseCommitId: commit.id,
      message: 'Revision after recovery',
      actor: { kind: 'human', name: 'ly' },
      mutations: [{ type: 'replace-text', nodeId: NODE_ID, baseText: 'beta', nextText: 'gamma' }],
    })

    expect(next.parentId).toBe(commit.id)
    expect(await readFile(harness.workingPath, 'utf8')).toBe('gamma')
    expect(harness.ctx.paperRepository.getCommitPublication(DOCUMENT_ID)).toBeUndefined()
  })

  it('reconstructs the commit when only its journal became durable before the crash', async () => {
    const root = await createProjectRoot()
    const state = createRepositoryState()
    const first = await openBase(root, state)
    await seedProject(first)
    await mountCommits(first)
    const { publication, commit } = await seedPublication(first, 'before')
    state.commits.delete(commit.id)
    state.nodes.clear()
    for (const node of publication.before.nodes) state.nodes.set(node.id, structuredClone(node))
    await writeFile(first.workingPath, 'alpha', 'utf8')
    await disposeHarness(first)

    const reopened = await openBase(root, state)
    await mountCommits(reopened)
    expect(reopened.ctx.paperRepository.getCommit(commit.id)).toEqual(commit)
    expect(reopened.ctx.paperRepository.getCommitPublication(DOCUMENT_ID)).toBeUndefined()
    expect(await readFile(reopened.workingPath, 'utf8')).toBe('alpha')
  })

  it('retains the journal and unknown Working bytes when recovery cannot prove ownership', async () => {
    const root = await createProjectRoot()
    const state = createRepositoryState()
    const first = await openBase(root, state)
    await seedProject(first)
    await mountCommits(first)
    const { publication } = await seedPublication(first, 'before')
    await writeFile(first.workingPath, 'external Word edit', 'utf8')
    await disposeHarness(first)

    const reopened = await openBase(root, state)
    await expect(mountCommits(reopened)).rejects.toMatchObject({ code: 'RECOVERY_FAILED' })
    expect(await readFile(reopened.workingPath, 'utf8')).toBe('external Word edit')
    expect(reopened.ctx.paperRepository.getCommitPublication(DOCUMENT_ID)).toEqual(publication)
    expect(reopened.ctx.paperRepository.getDocument(DOCUMENT_ID)?.headCommitId).toBeUndefined()
  })
})
