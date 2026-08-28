import { createHash } from 'node:crypto'
import {
  DocumentCommitId,
  DocumentId,
  DocumentNodeId,
  type DocumentNode,
  type DocumentNodeKind,
} from '@paperai/domain'
import { describe, expect, it } from 'vitest'
import { buildDocumentIndex, DocumentIndexError } from '../src/indexer.ts'

const documentId = DocumentId('document-1')
const at = '2026-08-28T00:00:00.000Z'

function hash(kind: DocumentNodeKind, text: string): string {
  return createHash('sha256').update(kind).update('\0').update(text).digest('hex')
}

function previous(
  id: string,
  officePath: string,
  ordinal: number,
  text: string,
  overrides: Partial<DocumentNode> = {},
): DocumentNode {
  return {
    id: DocumentNodeId(id),
    documentId,
    officePath,
    ordinal,
    kind: 'paragraph',
    text,
    style: {},
    hash: hash('paragraph', text),
    lineage: [DocumentNodeId(id)],
    updatedAt: at,
    ...overrides,
  }
}

describe('buildDocumentIndex', () => {
  it('rejects blank and duplicate Office paths', () => {
    expect(() => buildDocumentIndex(documentId, [
      { officePath: '', text: 'blank', kind: 'paragraph' },
    ], [], at)).toThrow(new DocumentIndexError('Document engine returned a blank Office path'))
    expect(() => buildDocumentIndex(documentId, [
      { officePath: '/body/p[1]', text: 'a', kind: 'paragraph' },
      { officePath: '/body/p[1]', text: 'b', kind: 'paragraph' },
    ], [], at)).toThrow(/duplicate Office path/)
  })

  it('maps every supported engine kind and initializes new lineage', () => {
    const nodes = buildDocumentIndex(documentId, [
      { officePath: '/body/p[1]', text: 'paragraph', kind: 'paragraph' },
      { officePath: '/body/tbl[1]/tr[1]/tc[1]/p[1]', text: 'cell', kind: 'table' },
      { officePath: '/body/custom[1]', text: 'other', kind: 'unknown' },
    ], [], at)
    expect(nodes.map(node => node.kind)).toEqual(['paragraph', 'table-cell', 'unknown'])
    expect(nodes.every(node => node.lineage[0] === node.id)).toBe(true)
  })

  it('keeps the nearest duplicate-content identity and retained metadata', () => {
    const first = previous('first', '/body/p[1]', 0, 'same')
    const second = previous('second', '/body/p[3]', 2, 'same', {
      style: { font: '宋体' },
      lineage: [],
      lastCommitId: DocumentCommitId('commit-1'),
    })
    const nodes = buildDocumentIndex(documentId, [
      { officePath: '/body/p[2]', text: 'new', kind: 'paragraph' },
      { officePath: '/body/p[3]', text: 'same', kind: 'paragraph' },
      { officePath: '/body/p[4]', text: 'same', kind: 'paragraph' },
    ], [first, second], at)
    expect(nodes[1]).toMatchObject({
      id: second.id,
      style: { font: '宋体' },
      lineage: [second.id],
      lastCommitId: DocumentCommitId('commit-1'),
    })
    expect(nodes[2]?.id).toBe(first.id)
  })

  it('uses related text before an inserted node can steal a shifted identity', () => {
    const old = previous('old', '/body/p[1]', 0, '研究背景与意义')
    const [inserted, edited] = buildDocumentIndex(documentId, [
      { officePath: '/body/p[1]', text: '新增说明', kind: 'paragraph' },
      { officePath: '/body/p[2]', text: '研究背景与意义（修订）', kind: 'paragraph' },
    ], [old], at)
    expect(inserted?.id).not.toBe(old.id)
    expect(edited?.id).toBe(old.id)
  })

  it('retains a sole structurally corresponding node after a complete rewrite', () => {
    const old = previous('old', '/body/p[2]', 1, 'before')
    const [rewritten] = buildDocumentIndex(documentId, [
      { officePath: '/body/p[3]', text: '完全不同', kind: 'paragraph' },
    ], [old], at)
    expect(rewritten?.id).toBe(old.id)

    const ambiguous = buildDocumentIndex(documentId, [
      { officePath: '/body/p[3]', text: 'x', kind: 'paragraph' },
      { officePath: '/body/p[4]', text: 'y', kind: 'paragraph' },
    ], [old], at)
    expect(ambiguous.every(node => node.id !== old.id)).toBe(true)
  })

  it('keeps a nearer duplicate and resolves equal-affinity edits by distance', () => {
    const near = previous('near', '/body/p[1]', 0, 'same')
    const far = previous('far', '/body/p[10]', 9, 'same')
    const [same] = buildDocumentIndex(documentId, [
      { officePath: '/body/p[1]', text: 'same', kind: 'paragraph' },
    ], [near, far], at)
    expect(same?.id).toBe(near.id)

    const first = previous('first', '/body/p[1]', 0, '甲乙')
    const second = previous('second', '/body/p[4]', 3, '丙丁')
    const edited = buildDocumentIndex(documentId, [
      { officePath: '/body/p[2]', text: '甲新', kind: 'paragraph' },
      { officePath: '/body/p[3]', text: '丙新', kind: 'paragraph' },
    ], [first, second], at)
    expect(edited.map(node => node.id)).toEqual([first.id, second.id])
  })
})
