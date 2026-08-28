import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import type { DomainChanged } from '@deepseek-ai/dsh-storage-domain'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DocumentCommitId,
  DocumentId,
  ProjectId,
} from '@paperai/domain'
import type { DocumentCommit, DocumentRecord } from '@paperai/domain'
import * as CommitInvariant from '../src/invariant.ts'

const documentId = DocumentId('document-1')
const commitId = DocumentCommitId('commit-1')
const deletedDocumentChange: DomainChanged = {
  domain: 'paperai',
  table: 'documents',
  key: documentId,
  operation: 'deleted',
}

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

function document(headCommitId: DocumentCommit['id'] | null = commitId): DocumentRecord {
  return {
    id: documentId,
    projectId: ProjectId('project-1'),
    name: 'Thesis.docx',
    role: 'manuscript',
    immutableSourcePath: 'C:\\project\\source.docx',
    workingPath: 'C:\\project\\working.docx',
    mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    sourceSha256: '0'.repeat(64),
    ...(headCommitId === null ? {} : { headCommitId }),
    nodeCount: 1,
    createdAt: '2026-08-28T00:00:00.000Z',
    updatedAt: '2026-08-28T00:00:00.000Z',
  }
}

function commit(id = documentId): DocumentCommit {
  return {
    id: commitId,
    documentId: id,
    message: 'Revision',
    actor: { kind: 'human', name: 'ly' },
    snapshotPath: 'C:\\project\\snapshot.docx',
    documentSha256: '0'.repeat(64),
    gate: {
      status: 'pass',
      mode: 'continuous',
      documentId: id,
      findings: [],
      checkedAt: '2026-08-28T00:00:00.000Z',
    },
    operations: [],
    createdAt: '2026-08-28T00:00:00.000Z',
  }
}

async function setup(record: DocumentRecord | undefined, object: DocumentCommit | undefined): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(InvariantRegistry)
  ctx.provide('paperRepository', {
    getDocument: () => record,
    getCommit: () => object,
  })
  await ctx.plugin(CommitInvariant)
  return ctx
}

function change(overrides: Partial<DomainChanged> = {}): DomainChanged {
  return {
    domain: 'paperai',
    table: 'documents',
    key: documentId,
    operation: 'put',
    value: {},
    ...overrides,
  } as DomainChanged
}

describe('paperai commit head invariant', () => {
  it('accepts matching heads and ignores unrelated or unborn records', async () => {
    const ctx = await setup(document(), commit())
    expect(() => { ctx.emit('domain/changed', change()) }).not.toThrow()
    expect(() => { ctx.emit('domain/changed', change({ domain: 'other' })) }).not.toThrow()
    expect(() => { ctx.emit('domain/changed', change({ table: 'projects' })) }).not.toThrow()
    expect(() => { ctx.emit('domain/changed', deletedDocumentChange) }).not.toThrow()

    const unborn = await setup(document(null), undefined)
    expect(() => { unborn.emit('domain/changed', change()) }).not.toThrow()
  })

  it('rejects missing and cross-document commit objects', async () => {
    const missing = await setup(document(), undefined)
    expect(() => { missing.emit('domain/changed', change()) }).toThrow(/without a matching commit object/)

    const wrong = await setup(document(), commit(DocumentId('document-2')))
    expect(() => { wrong.emit('domain/changed', change()) }).toThrow(/without a matching commit object/)
  })
})
