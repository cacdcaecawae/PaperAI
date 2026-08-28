import { createHash } from 'node:crypto'
import { access, chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import type { EngineMutation, EngineTextNode, EngineValidation } from '@paperai/document-engine'
import {
  DocumentCommitId,
  DocumentId,
  ProjectId,
  type CapabilityHealth,
  type DocumentId as DocumentIdType,
  type DocumentNode,
  type DocumentNodeId,
  type DocumentRecord,
  type ProjectId as ProjectIdType,
  type ProjectRecord,
} from '@paperai/domain'
import { afterEach, describe, expect, it, vi } from 'vitest'
import PaperDocumentService, {
  PaperDocumentError,
  type ImportDocumentResult,
  type LegacyDocumentNormalizer,
} from '../src/index.ts'

class FakeRepository {
  readonly projects = new Map<ProjectIdType, ProjectRecord>()
  readonly documents = new Map<DocumentIdType, DocumentRecord>()
  readonly nodes = new Map<DocumentNodeId, DocumentNode>()
  failDocumentPut = false
  failDocumentDelete = false
  failNodeDelete = false
  failNextUpdate = false

  getProject(id: ProjectIdType): ProjectRecord | undefined {
    return this.projects.get(id)
  }

  getDocument(id: DocumentIdType): DocumentRecord | undefined {
    return this.documents.get(id)
  }

  listDocuments(projectId?: ProjectIdType): DocumentRecord[] {
    return [...this.documents.values()].filter(record => projectId === undefined || record.projectId === projectId)
  }

  putDocument(record: DocumentRecord): Promise<void> {
    if (this.failDocumentPut) return Promise.reject(new Error('repository unavailable'))
    this.documents.set(record.id, record)
    return Promise.resolve()
  }

  updateDocument(id: DocumentIdType, update: (record: DocumentRecord) => DocumentRecord): Promise<DocumentRecord> {
    if (this.failNextUpdate) {
      this.failNextUpdate = false
      return Promise.reject(new Error('document update unavailable'))
    }
    const current = this.documents.get(id)
    if (current === undefined) return Promise.reject(new Error('missing document'))
    const next = update(current)
    this.documents.set(id, next)
    return Promise.resolve(next)
  }

  deleteDocument(id: DocumentIdType): Promise<boolean> {
    if (this.failDocumentDelete) return Promise.reject(new Error('document delete unavailable'))
    return Promise.resolve(this.documents.delete(id))
  }

  listNodes(documentId: DocumentIdType): DocumentNode[] {
    return [...this.nodes.values()]
      .filter(node => node.documentId === documentId)
      .sort((left, right) => left.ordinal - right.ordinal)
  }

  putNode(node: DocumentNode): Promise<void> {
    this.nodes.set(node.id, node)
    return Promise.resolve()
  }

  deleteNode(id: DocumentNodeId): Promise<boolean> {
    if (this.failNodeDelete) return Promise.reject(new Error('node delete unavailable'))
    return Promise.resolve(this.nodes.delete(id))
  }
}

class FakeDocumentEngine {
  healthResult: CapabilityHealth = { status: 'ready', version: 'test' }
  nodes: EngineTextNode[] = []
  previews: string[] = []
  readPaths: string[] = []
  readFailure: Error | undefined

  health(): Promise<CapabilityHealth> {
    return Promise.resolve(this.healthResult)
  }

  readTextNodes(filePath: string): Promise<EngineTextNode[]> {
    this.readPaths.push(filePath)
    if (this.readFailure !== undefined) return Promise.reject(this.readFailure)
    return Promise.resolve(this.nodes.map(node => ({ ...node })))
  }

  previewHtml(filePath: string): Promise<string> {
    this.previews.push(filePath)
    return Promise.resolve(`<article>${filePath}</article>`)
  }

  inspect(): Promise<Record<string, unknown>> {
    return Promise.resolve({})
  }

  applyMutations(_filePath: string, _mutations: readonly EngineMutation[]): Promise<void> {
    return Promise.resolve()
  }

  validate(): Promise<EngineValidation> {
    return Promise.resolve({ success: true, details: {} })
  }
}

interface Fixture {
  ctx: Context
  root: string
  projectRoot: string
  uploadRoot: string
  projectId: ProjectIdType
  repo: FakeRepository
  engine: FakeDocumentEngine
}

const contexts: Context[] = []
const roots: string[] = []

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'paperai-文档服务-'))
  roots.push(root)
  const projectRoot = join(root, '硕士论文项目')
  const uploadRoot = join(root, '用户上传')
  await mkdir(projectRoot)
  await mkdir(uploadRoot)
  const projectId = ProjectId('project-1')
  const repo = new FakeRepository()
  repo.projects.set(projectId, {
    id: projectId,
    workspaceId: 'workspace-1',
    name: '硕士论文',
    rootPath: projectRoot,
    createdAt: '2026-08-28T00:00:00.000Z',
    updatedAt: '2026-08-28T00:00:00.000Z',
  })
  const engine = new FakeDocumentEngine()
  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide('paperRepository', repo as never)
  ctx.provide('documentEngine', engine as never)
  await ctx.plugin(PaperDocumentService)
  return { ctx, root, projectRoot, uploadRoot, projectId, repo, engine }
}

function imported(result: ImportDocumentResult): asserts result is Extract<ImportDocumentResult, { status: 'imported' }> {
  expect(result.status).toBe('imported')
  if (result.status !== 'imported') throw new Error(result.detail)
}

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(contexts.splice(0).map(async (ctx) => { await ctx.fiber.dispose() }))
  const tempRoot = `${resolve(tmpdir())}${sep}`.toLocaleLowerCase('en-US')
  for (const root of roots.splice(0)) {
    const target = resolve(root).toLocaleLowerCase('en-US')
    if (!target.startsWith(tempRoot)) throw new Error(`Refusing to remove non-temporary test root '${root}'`)
    await rm(root, { recursive: true, force: true })
  }
})

describe('PaperDocumentService', () => {
  it('imports a Chinese-path DOCX as independent immutable and Working copies', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-28T03:04:05.000Z'))
    const { ctx, uploadRoot, projectId, repo, engine } = await fixture()
    const source = join(uploadRoot, '硕士学位论文开题报告.docx')
    const bytes = Buffer.from('fake-docx-中文', 'utf8')
    await writeFile(source, bytes)
    engine.nodes = [
      { officePath: '/document/body/p[1]', text: '第一章 绪论', kind: 'paragraph' },
      { officePath: '/document/body/tbl[1]/tr[1]/tc[1]/p[1]', text: '表格内容', kind: 'table' },
    ]

    const result = await ctx.paperDocuments.importDocument({ projectId, sourcePath: source, role: 'proposal' })
    imported(result)
    expect(result.document).toMatchObject({
      name: '硕士学位论文开题报告',
      role: 'proposal',
      nodeCount: 2,
      createdAt: '2026-08-28T03:04:05.000Z',
      sourceSha256: createHash('sha256').update(bytes).digest('hex'),
    })
    expect(await readFile(result.document.immutableSourcePath)).toEqual(bytes)
    expect(await readFile(result.document.workingPath)).toEqual(bytes)
    expect((await lstat(result.document.immutableSourcePath)).mode & 0o222).toBe(0)
    await expect(ctx.paperDocuments.verifyImmutableSource(result.document.id))
      .resolves.toBe(result.document.sourceSha256)
    if (process.platform === 'win32') {
      await expect(writeFile(result.document.immutableSourcePath, 'overwritten'))
        .rejects.toMatchObject({ code: 'EPERM' })
      expect(await readFile(result.document.workingPath)).toEqual(bytes)
    }
    await writeFile(result.document.workingPath, 'edited-working-copy')
    expect(await readFile(result.document.immutableSourcePath)).toEqual(bytes)
    expect(result.nodes.map(node => node.kind)).toEqual(['paragraph', 'table-cell'])
    expect(result.nodes.every(node => node.lineage.length === 1 && node.lineage[0] === node.id)).toBe(true)

    expect(ctx.paperDocuments.readDocument(result.document.id)).toEqual({
      document: result.document,
      nodes: result.nodes,
    })
    repo.documents.set(DocumentId('template-evidence'), {
      ...result.document,
      id: DocumentId('template-evidence'),
      documentKind: 'template-source',
      name: '模板证据',
    })
    expect(ctx.paperDocuments.listDocuments(projectId, 'proposal')).toEqual([result.document])
    const preview = await ctx.paperDocuments.previewHtml(result.document.id)
    expect(preview).toContain(result.document.workingPath)
    expect(engine.previews).toEqual([result.document.workingPath])

    await chmod(result.document.immutableSourcePath, 0o600)
    await writeFile(result.document.immutableSourcePath, 'tampered source')
    await chmod(result.document.immutableSourcePath, 0o400)
    await expect(ctx.paperDocuments.verifyImmutableSource(result.document.id))
      .rejects.toMatchObject({ code: 'SOURCE_INTEGRITY_INVALID' } satisfies Partial<PaperDocumentError>)
    await expect(readFile(result.document.workingPath, 'utf8')).resolves.toBe('edited-working-copy')
  })

  it('rolls back an uncommitted import without deleting its uploaded source', async () => {
    const { ctx, uploadRoot, projectId, repo, engine } = await fixture()
    const source = join(uploadRoot, '待提交论文.docx')
    const sourceBytes = Buffer.from('source-template-bytes')
    await writeFile(source, sourceBytes)
    engine.nodes = [{ officePath: '/body/p[1]', text: '正文', kind: 'paragraph' }]
    const result = await ctx.paperDocuments.importDocument({ projectId, sourcePath: source, role: 'manuscript' })
    imported(result)
    const immutableSourcePath = result.document.immutableSourcePath
    const workingPath = result.document.workingPath

    await ctx.paperDocuments.rollbackImport(result.document.id)

    expect(repo.documents.size).toBe(0)
    expect(repo.nodes.size).toBe(0)
    await expect(access(immutableSourcePath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(workingPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(source)).toEqual(sourceBytes)
    await expect(ctx.paperDocuments.rollbackImport(result.document.id)).resolves.toBeUndefined()
    expect(await readFile(source)).toEqual(sourceBytes)
  })

  it('refuses to roll back an import whose durable record became committed or a template source', async () => {
    const { ctx, uploadRoot, projectId, repo, engine } = await fixture()
    const source = join(uploadRoot, '受保护模板.docx')
    await writeFile(source, 'template-source')
    engine.nodes = [{ officePath: '/body/p[1]', text: '模板正文', kind: 'paragraph' }]
    const result = await ctx.paperDocuments.importDocument({ projectId, sourcePath: source, role: 'proposal' })
    imported(result)

    repo.documents.set(result.document.id, {
      ...result.document,
      headCommitId: DocumentCommitId('root-commit'),
    })
    await expect(ctx.paperDocuments.rollbackImport(result.document.id))
      .rejects.toMatchObject({ code: 'IMPORT_ROLLBACK_FORBIDDEN' })
    expect(await readFile(result.document.immutableSourcePath, 'utf8')).toBe('template-source')

    repo.documents.set(result.document.id, {
      ...result.document,
      documentKind: 'template-source',
    })
    await expect(ctx.paperDocuments.rollbackImport(result.document.id))
      .rejects.toMatchObject({ code: 'IMPORT_ROLLBACK_FORBIDDEN' })
    expect(await readFile(source, 'utf8')).toBe('template-source')
    expect(await readFile(result.document.workingPath, 'utf8')).toBe('template-source')
  })

  it('retains the import record as a retry receipt when its final deletion fails', async () => {
    const { ctx, uploadRoot, projectId, repo, engine } = await fixture()
    const source = join(uploadRoot, '可重试回滚.docx')
    await writeFile(source, 'retry-source')
    engine.nodes = [{ officePath: '/body/p[1]', text: '正文', kind: 'paragraph' }]
    const result = await ctx.paperDocuments.importDocument({ projectId, sourcePath: source, role: 'manuscript' })
    imported(result)
    repo.failDocumentDelete = true

    await expect(ctx.paperDocuments.rollbackImport(result.document.id)).rejects.toThrow('document delete unavailable')
    expect(repo.getDocument(result.document.id)).toEqual(result.document)
    expect(repo.listNodes(result.document.id)).toEqual([])
    expect(await readFile(source, 'utf8')).toBe('retry-source')

    repo.failDocumentDelete = false
    await expect(ctx.paperDocuments.rollbackImport(result.document.id)).resolves.toBeUndefined()
    expect(repo.getDocument(result.document.id)).toBeUndefined()
  })

  it('resolves same-name conflicts across source formats and filters roles', async () => {
    const { ctx, uploadRoot, projectId, engine } = await fixture()
    const docx = join(uploadRoot, '论文.docx')
    const doc = join(uploadRoot, '旧论文.doc')
    await writeFile(docx, 'docx')
    await writeFile(doc, 'doc')
    engine.nodes = [{ officePath: '/document/body/p[1]', text: '正文', kind: 'paragraph' }]
    Object.assign(engine, {
      normalizeLegacyDocument: async (_source: string, target: string) => {
        await writeFile(target, 'normalized-docx')
        return { status: 'normalized' as const }
      },
    } satisfies LegacyDocumentNormalizer)

    const first = await ctx.paperDocuments.importDocument({ projectId, sourcePath: docx, role: 'manuscript' })
    const second = await ctx.paperDocuments.importDocument({ projectId, sourcePath: doc, role: 'final', name: '论文.doc' })
    imported(first)
    imported(second)
    expect(first.document.name).toBe('论文')
    expect(second.document.name).toBe('论文 (2)')
    expect(second.document.immutableSourcePath.endsWith('论文 (2).doc')).toBe(true)
    expect(second.document.workingPath.endsWith('论文 (2).docx')).toBe(true)
    expect(await readFile(second.document.immutableSourcePath, 'utf8')).toBe('doc')
    expect(await readFile(second.document.workingPath, 'utf8')).toBe('normalized-docx')
    expect(ctx.paperDocuments.listDocuments(projectId, 'final')).toEqual([second.document])
    expect(ctx.paperDocuments.listDocuments(projectId)).toHaveLength(2)
  })

  it('returns explicit degraded results without publishing when engine capabilities are absent', async () => {
    const { ctx, projectRoot, uploadRoot, projectId, repo, engine } = await fixture()
    const legacy = join(uploadRoot, '旧格式.doc')
    await writeFile(legacy, 'legacy')

    const unsupported = await ctx.paperDocuments.importDocument({ projectId, sourcePath: legacy, role: 'other' })
    expect(unsupported).toEqual({
      status: 'degraded',
      capability: 'legacy-doc-normalization',
      health: {
        status: 'degraded',
        detail: 'The configured document engine cannot normalize legacy .doc files to DOCX; no files or records were created',
      },
      detail: 'The configured document engine cannot normalize legacy .doc files to DOCX; no files or records were created',
    })
    expect(repo.documents.size).toBe(0)
    await expect(access(join(projectRoot, '.paperai'))).rejects.toMatchObject({ code: 'ENOENT' })

    engine.healthResult = { status: 'unavailable', detail: 'OfficeCLI native binary is missing' }
    const docx = join(uploadRoot, '论文.docx')
    await writeFile(docx, 'docx')
    await expect(ctx.paperDocuments.importDocument({ projectId, sourcePath: docx, role: 'manuscript' }))
      .resolves.toEqual({
        status: 'degraded',
        capability: 'document-engine',
        health: engine.healthResult,
        detail: 'OfficeCLI native binary is missing',
      })
    expect(repo.documents.size).toBe(0)

    engine.healthResult = { status: 'degraded' }
    await expect(ctx.paperDocuments.importDocument({ projectId, sourcePath: docx, role: 'manuscript' }))
      .resolves.toMatchObject({
        status: 'degraded',
        capability: 'document-engine',
        detail: 'The configured document engine is not ready for import',
      })
  })

  it('cleans a normalizer-owned degraded attempt and rejects an unusable output', async () => {
    const first = await fixture()
    const legacy = join(first.uploadRoot, '降级.doc')
    await writeFile(legacy, 'legacy')
    Object.assign(first.engine, {
      normalizeLegacyDocument: async () => ({ status: 'degraded' as const, detail: 'converter unavailable' }),
    } satisfies LegacyDocumentNormalizer)
    await expect(first.ctx.paperDocuments.importDocument({
      projectId: first.projectId,
      sourcePath: legacy,
      role: 'other',
    })).resolves.toMatchObject({ status: 'degraded', detail: 'converter unavailable' })
    expect(first.repo.documents.size).toBe(0)
    expect(await readdir(join(first.projectRoot, '.paperai', 'documents', 'v1', 'sources'))).toEqual([])
    expect(await readdir(join(first.projectRoot, '.paperai', 'documents', 'v1', 'working'))).toEqual([])

    const second = await fixture()
    const broken = join(second.uploadRoot, '损坏.doc')
    await writeFile(broken, 'legacy')
    Object.assign(second.engine, {
      normalizeLegacyDocument: async (_source: string, target: string) => {
        await writeFile(target, '')
        return { status: 'normalized' as const }
      },
    } satisfies LegacyDocumentNormalizer)
    await expect(second.ctx.paperDocuments.importDocument({
      projectId: second.projectId,
      sourcePath: broken,
      role: 'other',
    })).rejects.toMatchObject({ code: 'WORKING_COPY_INVALID' })
    expect(second.repo.documents.size).toBe(0)
  })

  it('preserves node identity and lineage across insertion, text edit, and deletion', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-28T01:00:00.000Z'))
    const { ctx, uploadRoot, projectId, engine } = await fixture()
    const source = join(uploadRoot, '索引.docx')
    await writeFile(source, 'docx')
    engine.nodes = [
      { officePath: '/document/body/p[1]', text: '甲段', kind: 'paragraph' },
      { officePath: '/document/body/p[2]', text: '乙段', kind: 'paragraph' },
    ]
    const importedResult = await ctx.paperDocuments.importDocument({ projectId, sourcePath: source, role: 'manuscript' })
    imported(importedResult)
    const [alpha, beta] = importedResult.nodes

    vi.setSystemTime(new Date('2026-08-28T02:00:00.000Z'))
    engine.nodes = [
      { officePath: '/document/body/p[1]', text: '新增段', kind: 'paragraph' },
      { officePath: '/document/body/p[2]', text: '甲段', kind: 'paragraph' },
      { officePath: '/document/body/p[3]', text: '乙段（修订）', kind: 'paragraph' },
    ]
    const rebuilt = await ctx.paperDocuments.rebuildIndex(importedResult.document.id)
    expect(rebuilt.nodes[1]?.id).toBe(alpha?.id)
    expect(rebuilt.nodes[2]?.id).toBe(beta?.id)
    expect(rebuilt.nodes[2]?.lineage).toEqual(beta?.lineage)
    expect(rebuilt.nodes[0]?.id).not.toBe(alpha?.id)
    expect(rebuilt.document).toMatchObject({ nodeCount: 3, updatedAt: '2026-08-28T02:00:00.000Z' })

    engine.nodes = [{ officePath: '/document/body/p[1]', text: '新增段', kind: 'paragraph' }]
    const reduced = await ctx.paperDocuments.rebuildIndex(importedResult.document.id)
    expect(reduced.nodes).toHaveLength(1)
    expect(reduced.nodes[0]?.id).toBe(rebuilt.nodes[0]?.id)
    expect(ctx.paperDocuments.readDocument(importedResult.document.id)?.document.nodeCount).toBe(1)
  })

  it('projects a commit candidate index without publishing it', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-28T04:00:00.000Z'))
    const { ctx, uploadRoot, projectId, repo, engine } = await fixture()
    const source = join(uploadRoot, '候选索引.docx')
    await writeFile(source, 'docx')
    engine.nodes = [{ officePath: '/body/p[1]', text: '原文', kind: 'paragraph' }]
    const result = await ctx.paperDocuments.importDocument({ projectId, sourcePath: source, role: 'manuscript' })
    imported(result)
    const beforeDocument = structuredClone(repo.getDocument(result.document.id))
    const beforeNodes = structuredClone(repo.listNodes(result.document.id))
    const detached = ctx.paperDocuments.readNodes(result.document.id) as DocumentNode[]
    detached[0]!.text = '调用方修改'
    expect(repo.listNodes(result.document.id)).toEqual(beforeNodes)

    const candidatePath = join(uploadRoot, 'candidate.docx')
    engine.nodes = [
      { officePath: '/body/p[1]', text: '原文已修改', kind: 'paragraph' },
      { officePath: '/body/p[2]', text: '新增段落', kind: 'paragraph' },
    ]
    const commitId = DocumentCommitId('commit-candidate')
    const candidate = await ctx.paperDocuments.buildCandidateIndex({
      document: result.document,
      candidatePath,
      commitId,
      currentNodes: beforeNodes,
    })

    expect(engine.readPaths.at(-1)).toBe(candidatePath)
    expect(candidate).toHaveLength(2)
    expect(candidate.every(node => node.lastCommitId === commitId)).toBe(true)
    expect(candidate[0]?.id).toBe(beforeNodes[0]?.id)
    expect(repo.getDocument(result.document.id)).toEqual(beforeDocument)
    expect(repo.listNodes(result.document.id)).toEqual(beforeNodes)
  })

  it('rejects invalid inputs and duplicate engine paths before publication', async () => {
    const { ctx, projectRoot, uploadRoot, projectId, repo, engine } = await fixture()
    await expect(ctx.paperDocuments.importDocument({
      projectId: ProjectId('missing'),
      sourcePath: join(uploadRoot, 'missing.docx'),
      role: 'other',
    })).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' })

    const unsupported = join(uploadRoot, 'notes.txt')
    await writeFile(unsupported, 'text')
    await expect(ctx.paperDocuments.importDocument({ projectId, sourcePath: unsupported, role: 'other' }))
      .rejects.toMatchObject({ code: 'SOURCE_FORMAT_UNSUPPORTED' })

    const source = join(uploadRoot, 'duplicate.docx')
    await writeFile(source, 'docx')
    for (const name of ['', '.', '..', 'trailing.', 'bad/name', 'CON', 'CON.notes']) {
      await expect(ctx.paperDocuments.importDocument({ projectId, sourcePath: source, role: 'other', name }))
        .rejects.toMatchObject({ code: 'DOCUMENT_NAME_INVALID' })
    }
    engine.nodes = [
      { officePath: '/document/body/p[1]', text: 'a', kind: 'paragraph' },
      { officePath: '/document/body/p[1]', text: 'b', kind: 'paragraph' },
    ]
    await expect(ctx.paperDocuments.importDocument({ projectId, sourcePath: source, role: 'other' }))
      .rejects.toMatchObject({ code: 'DOCUMENT_INDEX_INVALID' })
    expect(repo.documents.size).toBe(0)
    expect(await readdir(join(projectRoot, '.paperai', 'documents', 'v1', 'sources'))).toEqual([])
  })

  it('rolls back published files and indexed nodes when repository publication fails', async () => {
    const { ctx, projectRoot, uploadRoot, projectId, repo, engine } = await fixture()
    const source = join(uploadRoot, '回滚.docx')
    await writeFile(source, 'docx')
    engine.nodes = [{ officePath: '/document/body/p[1]', text: '正文', kind: 'paragraph' }]
    repo.failDocumentPut = true

    await expect(ctx.paperDocuments.importDocument({ projectId, sourcePath: source, role: 'manuscript' }))
      .rejects.toThrow('repository unavailable')
    expect(repo.documents.size).toBe(0)
    expect(repo.nodes.size).toBe(0)
    expect(await readdir(join(projectRoot, '.paperai', 'documents', 'v1', 'sources'))).toEqual([])
    expect(await readdir(join(projectRoot, '.paperai', 'documents', 'v1', 'working'))).toEqual([])

    repo.failNodeDelete = true
    await expect(ctx.paperDocuments.importDocument({ projectId, sourcePath: source, role: 'manuscript' }))
      .rejects.toBeInstanceOf(AggregateError)
  })

  it('restores the previous index when document metadata publication fails', async () => {
    const { ctx, uploadRoot, projectId, repo, engine } = await fixture()
    const source = join(uploadRoot, '恢复.docx')
    await writeFile(source, 'docx')
    engine.nodes = [{ officePath: '/body/p[1]', text: '原文', kind: 'paragraph' }]
    const result = await ctx.paperDocuments.importDocument({ projectId, sourcePath: source, role: 'manuscript' })
    imported(result)
    const before = result.nodes[0]
    engine.nodes = [
      { officePath: '/body/p[1]', text: '原文', kind: 'paragraph' },
      { officePath: '/body/p[2]', text: '新增', kind: 'paragraph' },
    ]
    repo.failNextUpdate = true
    await expect(ctx.paperDocuments.rebuildIndex(result.document.id)).rejects.toThrow('document update unavailable')
    expect(repo.listNodes(result.document.id)).toEqual([before])
    expect(repo.getDocument(result.document.id)).toEqual(result.document)
  })

  it('serializes concurrent index rebuilds for one document', async () => {
    const { ctx, uploadRoot, projectId, engine } = await fixture()
    const source = join(uploadRoot, '并发.docx')
    await writeFile(source, 'docx')
    engine.nodes = [{ officePath: '/body/p[1]', text: '原文', kind: 'paragraph' }]
    const result = await ctx.paperDocuments.importDocument({ projectId, sourcePath: source, role: 'manuscript' })
    imported(result)

    let releaseFirst: (() => void) | undefined
    let rebuildReads = 0
    const original = engine.readTextNodes.bind(engine)
    engine.readTextNodes = async (path: string) => {
      rebuildReads += 1
      if (rebuildReads === 1) await new Promise<void>((resolvePromise) => { releaseFirst = resolvePromise })
      return await original(path)
    }
    const first = ctx.paperDocuments.rebuildIndex(result.document.id)
    await vi.waitFor(() => { expect(rebuildReads).toBe(1) })
    const second = ctx.paperDocuments.rebuildIndex(result.document.id)
    await Promise.resolve()
    expect(rebuildReads).toBe(1)
    releaseFirst?.()
    await Promise.all([first, second])
    expect(rebuildReads).toBe(2)
  })

  it('validates project roots, source files, and deterministic list ordering', async () => {
    const { ctx, root, uploadRoot, projectId, repo } = await fixture()
    const project = repo.projects.get(projectId)!
    repo.projects.set(projectId, { ...project, rootPath: 'relative' })
    await expect(ctx.paperDocuments.importDocument({ projectId, sourcePath: join(uploadRoot, 'x.docx'), role: 'other' }))
      .rejects.toMatchObject({ code: 'PROJECT_ROOT_INVALID' })

    const rootFile = join(root, 'not-directory')
    await writeFile(rootFile, 'x')
    repo.projects.set(projectId, { ...project, rootPath: rootFile })
    await expect(ctx.paperDocuments.importDocument({ projectId, sourcePath: join(uploadRoot, 'x.docx'), role: 'other' }))
      .rejects.toMatchObject({ code: 'PROJECT_ROOT_INVALID' })
    repo.projects.set(projectId, project)
    await expect(ctx.paperDocuments.importDocument({ projectId, sourcePath: join(uploadRoot, 'missing.docx'), role: 'other' }))
      .rejects.toMatchObject({ code: 'SOURCE_NOT_FOUND' })
    await expect(ctx.paperDocuments.importDocument({ projectId, sourcePath: uploadRoot, role: 'other' }))
      .rejects.toMatchObject({ code: 'SOURCE_NOT_FILE' })
    await expect(ctx.paperDocuments.importDocument({ projectId, sourcePath: '\u0000.docx', role: 'other' }))
      .rejects.toBeInstanceOf(Error)

    const base: DocumentRecord = {
      id: DocumentId('b'), projectId, name: '同名', role: 'other',
      immutableSourcePath: 's1', workingPath: 'w1',
      mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      sourceSha256: 'x', nodeCount: 0, createdAt: '2026-01-01', updatedAt: '2026-01-01',
    }
    repo.documents.set(base.id, base)
    repo.documents.set(DocumentId('a'), { ...base, id: DocumentId('a') })
    repo.documents.set(DocumentId('c'), { ...base, id: DocumentId('c'), name: '较晚名称', createdAt: '2027-01-01' })
    expect(ctx.paperDocuments.listDocuments(projectId).map(record => record.id))
      .toEqual([DocumentId('a'), DocumentId('b'), DocumentId('c')])
  })

  it('returns undefined for absent reads and rejects absent preview and rebuild requests', async () => {
    const { ctx } = await fixture()
    const missing = DocumentId('missing')
    expect(ctx.paperDocuments.readDocument(missing)).toBeUndefined()
    await expect(ctx.paperDocuments.previewHtml(missing)).rejects.toMatchObject({
      code: 'DOCUMENT_NOT_FOUND',
    } satisfies Partial<PaperDocumentError>)
    await expect(ctx.paperDocuments.rebuildIndex(missing)).rejects.toMatchObject({
      code: 'DOCUMENT_NOT_FOUND',
    } satisfies Partial<PaperDocumentError>)
  })
})
