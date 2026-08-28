import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import type { DomainChanged } from '@deepseek-ai/dsh-storage-domain'
import {
  DocumentId,
  ProjectId,
  type DocumentNode,
  type DocumentRecord,
} from '@paperai/domain'
import { afterEach, describe, expect, it } from 'vitest'
import * as DocumentInvariant from '../src/invariant.ts'

let ctx: Context | undefined

const document: DocumentRecord = {
  id: DocumentId('document-1'),
  projectId: ProjectId('project-1'),
  name: '论文',
  role: 'manuscript',
  immutableSourcePath: 'D:\\论文\\sources\\论文.docx',
  workingPath: 'D:\\论文\\working\\论文.docx',
  mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  sourceSha256: 'abc',
  nodeCount: 1,
  createdAt: '2026-08-28T00:00:00.000Z',
  updatedAt: '2026-08-28T00:00:00.000Z',
}

const node = { documentId: document.id } as DocumentNode

const put = (overrides?: Partial<Pick<DomainChanged, 'domain' | 'table' | 'key'>>): DomainChanged => ({
  domain: 'paperai',
  table: 'documents',
  key: document.id,
  operation: 'put',
  value: document,
  ...overrides,
})

async function setup(current: DocumentRecord | undefined, nodes: readonly DocumentNode[]): Promise<Context> {
  ctx = new Context()
  await ctx.plugin(InvariantRegistry)
  ctx.provide('paperRepository', {
    getDocument: () => current,
    listNodes: () => [...nodes],
  } as never)
  await ctx.plugin(DocumentInvariant)
  return ctx
}

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
})

describe('PaperAI document publication invariant', () => {
  it('accepts a complete document and ignores foreign or deleted records', async () => {
    const current = await setup(document, [node])
    expect(() => { current.emit('domain/changed', put()) }).not.toThrow()
    expect(() => { current.emit('domain/changed', put({ domain: 'other' })) }).not.toThrow()
    expect(() => { current.emit('domain/changed', put({ table: 'nodes' })) }).not.toThrow()
    expect(() => {
      current.emit('domain/changed', {
        domain: 'paperai', table: 'documents', key: document.id, operation: 'deleted',
      })
    }).not.toThrow()
  })

  it('rejects unreadable records, node-count divergence, and aliased files', async () => {
    const absent = await setup(undefined, [])
    expect(() => { absent.emit('domain/changed', put()) }).toThrow(/cannot read/)
    await absent.fiber.dispose()

    const mismatch = await setup(document, [])
    expect(() => { mismatch.emit('domain/changed', put()) }).toThrow(/declares 1 nodes/)
    await mismatch.fiber.dispose()

    const aliased = { ...document, workingPath: document.immutableSourcePath }
    const sameFile = await setup(aliased, [node])
    expect(() => { sameFile.emit('domain/changed', put()) }).toThrow(/same file/)
  })

  it('removes the listener when the companion fiber is disposed', async () => {
    ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    ctx.provide('paperRepository', { getDocument: () => undefined, listNodes: () => [] } as never)
    const fiber = ctx.plugin(DocumentInvariant)
    await fiber
    await fiber.dispose()
    expect(() => { ctx!.emit('domain/changed', put()) }).not.toThrow()
  })
})
