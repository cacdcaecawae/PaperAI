import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageSqlite from '@deepseek-ai/dsh-storage-sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DocumentCommitId,
  DocumentId,
  DocumentNodeId,
  ProjectId,
} from '@paperai/domain'
import type {
  DocumentCommit,
  DocumentNode,
  DocumentRecord,
  ProjectRecord,
} from '@paperai/domain'
import PaperRepository, { paperaiDomainSpec } from '../src/index.ts'
import type { DocumentCommitPublication } from '../src/index.ts'

const legacyPaperaiDomainSpec = StorageDomain.defineDomain({
  name: 'paperai',
  version: 1,
  tables: {
    projects: paperaiDomainSpec.tables.projects,
    documents: paperaiDomainSpec.tables.documents,
    nodes: paperaiDomainSpec.tables.nodes,
    commits: paperaiDomainSpec.tables.commits,
    templates: paperaiDomainSpec.tables.templates,
    conflicts: paperaiDomainSpec.tables.conflicts,
  },
})

let ctx: Context | undefined
const roots: string[] = []

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function openRepository(path: string): Promise<Context> {
  const opened = new Context()
  await opened.plugin(Storage)
  await opened.plugin(StorageSqlite, { path, journalMode: 'wal' })
  await opened.plugin(StorageDomain, { backend: 'sqlite', routes: {} })
  await opened.plugin(PaperRepository)
  return opened
}

describe('PaperRepository', () => {
  it('keeps the v1 record format while declaring durable publication journals', () => {
    expect(paperaiDomainSpec.version).toBe(1)
    expect(paperaiDomainSpec.tables).toHaveProperty('commit_publications')
  })

  it('opens a pre-journal v1 SQLite unit without rewriting existing records', async () => {
    const root = await mkdtemp(join(tmpdir(), 'paperai-repository-v1-'))
    roots.push(root)
    const databasePath = join(root, 'paperai.sqlite')
    const record: ProjectRecord = {
      id: ProjectId('legacy-project'),
      workspaceId: 'legacy-workspace',
      name: '既有论文',
      rootPath: 'D:\\papers\\legacy',
      createdAt: '2026-08-27T00:00:00.000Z',
      updatedAt: '2026-08-27T00:00:00.000Z',
    }

    ctx = new Context()
    await ctx.plugin(Storage)
    await ctx.plugin(StorageSqlite, { path: databasePath, journalMode: 'wal' })
    await ctx.plugin(StorageDomain, { backend: 'sqlite', routes: {} })
    const legacyDomain = await ctx.storageDomain.open(legacyPaperaiDomainSpec)
    await legacyDomain.table('projects').put(record.id, record)
    await legacyDomain.close()
    await ctx.fiber.dispose()
    ctx = undefined

    ctx = await openRepository(databasePath)
    expect(ctx.paperRepository.getProject(record.id)).toEqual(record)
    expect(ctx.paperRepository.listCommitPublications()).toEqual([])
    await ctx.fiber.dispose()
    ctx = undefined

    const database = new DatabaseSync(databasePath)
    try {
      expect(database.prepare('SELECT version FROM units WHERE name = ?').get('paperai')).toEqual({ version: 1 })
      expect(database.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      ).get('u_paperai_commit_publications')).toEqual({ name: 'u_paperai_commit_publications' })
      expect(database.prepare('SELECT COUNT(*) AS count FROM u_paperai_projects').get()).toEqual({ count: 1 })
    } finally {
      database.close()
    }
  })

  it('loads through the real Cordis/storage-domain/SQLite composition', async () => {
    ctx = await openRepository(':memory:')

    const record: ProjectRecord = {
      id: ProjectId('project-1'),
      workspaceId: 'workspace-1',
      name: '硕士论文',
      rootPath: 'D:\\papers\\thesis',
      createdAt: '2026-08-28T00:00:00.000Z',
      updatedAt: '2026-08-28T00:00:00.000Z',
    }
    await ctx.paperRepository.putProject(record)

    expect(ctx.paperRepository.getProject(record.id)).toEqual(record)
    expect(ctx.paperRepository.listProjects()).toEqual([record])
  })

  it('deletes one document record idempotently without cascading to its nodes', async () => {
    ctx = await openRepository(':memory:')
    const documentId = DocumentId('document-delete')
    const nodeId = DocumentNodeId('node-retained')
    const document: DocumentRecord = {
      id: documentId,
      projectId: ProjectId('project-delete'),
      documentKind: 'working',
      name: 'Delete me',
      role: 'manuscript',
      immutableSourcePath: 'D:\\papers\\source.docx',
      workingPath: 'D:\\papers\\working.docx',
      mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      sourceSha256: 'a'.repeat(64),
      nodeCount: 1,
      createdAt: '2026-08-28T00:00:00.000Z',
      updatedAt: '2026-08-28T00:00:00.000Z',
    }
    const node: DocumentNode = {
      id: nodeId,
      documentId,
      officePath: '/body/p[1]',
      ordinal: 0,
      kind: 'paragraph',
      text: 'retained for the owning service',
      style: {},
      hash: 'node-hash',
      lineage: [nodeId],
      updatedAt: '2026-08-28T00:00:00.000Z',
    }
    await ctx.paperRepository.putDocument(document)
    await ctx.paperRepository.putNode(node)

    await expect(ctx.paperRepository.deleteDocument(documentId)).resolves.toBe(true)
    await expect(ctx.paperRepository.deleteDocument(documentId)).resolves.toBe(false)
    expect(ctx.paperRepository.getDocument(documentId)).toBeUndefined()
    expect(ctx.paperRepository.listNodes(documentId)).toEqual([node])
  })

  it('retains and clears a commit publication journal across a SQLite reopen', async () => {
    const root = await mkdtemp(join(tmpdir(), 'paperai-repository-journal-'))
    roots.push(root)
    const databasePath = join(root, 'paperai.sqlite')
    const projectId = ProjectId('project-1')
    const documentId = DocumentId('document-1')
    const commitId = DocumentCommitId('commit-1')
    const nodeId = DocumentNodeId('node-1')
    const beforeDocument: DocumentRecord = {
      id: documentId,
      projectId,
      documentKind: 'working',
      name: 'Thesis.docx',
      role: 'manuscript',
      immutableSourcePath: join(root, 'source.docx'),
      workingPath: join(root, 'working.docx'),
      mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      sourceSha256: 'a'.repeat(64),
      nodeCount: 1,
      createdAt: '2026-08-28T00:00:00.000Z',
      updatedAt: '2026-08-28T00:00:00.000Z',
    }
    const beforeNode: DocumentNode = {
      id: nodeId,
      documentId,
      officePath: '/body/p[1]',
      ordinal: 0,
      kind: 'paragraph',
      text: 'alpha',
      style: {},
      hash: 'before',
      lineage: [],
      updatedAt: '2026-08-28T00:00:00.000Z',
    }
    const afterNode: DocumentNode = {
      ...beforeNode,
      text: 'beta',
      hash: 'after',
      lastCommitId: commitId,
    }
    const commit: DocumentCommit = {
      id: commitId,
      documentId,
      message: 'Revision',
      actor: { kind: 'human', name: 'ly' },
      snapshotPath: join(root, 'beta.docx'),
      documentSha256: 'b'.repeat(64),
      gate: {
        status: 'pass',
        mode: 'continuous',
        documentId,
        findings: [],
        checkedAt: '2026-08-28T00:00:00.000Z',
      },
      operations: [],
      createdAt: '2026-08-28T00:00:01.000Z',
    }
    const publication: DocumentCommitPublication = {
      version: 1,
      documentId,
      commit,
      before: {
        document: beforeDocument,
        nodes: [beforeNode],
        working: {
          snapshotPath: join(root, 'alpha.docx'),
          sha256: 'a'.repeat(64),
          mode: 0o600,
        },
      },
      after: {
        document: {
          ...beforeDocument,
          headCommitId: commitId,
          updatedAt: commit.createdAt,
        },
        nodes: [afterNode],
      },
      createdAt: commit.createdAt,
    }

    ctx = await openRepository(databasePath)
    await ctx.paperRepository.putCommitPublication(publication)
    await ctx.fiber.dispose()
    ctx = undefined

    ctx = await openRepository(databasePath)
    expect(ctx.paperRepository.getCommitPublication(documentId)).toEqual(publication)
    expect(ctx.paperRepository.listCommitPublications()).toEqual([publication])
    await expect(ctx.paperRepository.deleteCommitPublication(documentId)).resolves.toBe(true)
    await expect(ctx.paperRepository.deleteCommitPublication(documentId)).resolves.toBe(false)
  })
})
