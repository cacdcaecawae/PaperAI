/** Stable semantic-index construction over document-engine text nodes. */

import { createHash, randomUUID } from 'node:crypto'
import type { EngineTextNode } from '@paperai/document-engine'
import {
  DocumentNodeId,
  type DocumentId,
  type DocumentNode,
  type DocumentNodeKind,
} from '@paperai/domain'

/** Invalid engine output that cannot form an unambiguous semantic index. */
export class DocumentIndexError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DocumentIndexError'
  }
}

interface PreparedNode {
  officePath: string
  ordinal: number
  kind: DocumentNodeKind
  text: string
  hash: string
}

interface RelatedCandidate {
  node: PreparedNode
  index: number
  candidate: DocumentNode
  affinity: number
  distance: number
}

/* v8 ignore next -- EngineTextNode.kind is a closed same-process union. */
function assertNever(value: never): never {
  throw new DocumentIndexError(`Unsupported engine node kind: ${String(value)}`)
}

function domainKind(kind: EngineTextNode['kind']): DocumentNodeKind {
  switch (kind) {
    case 'paragraph': return 'paragraph'
    case 'table': return 'table-cell'
    case 'unknown': return 'unknown'
    /* v8 ignore next -- EngineTextNode.kind is a closed same-process union. */
    default: return assertNever(kind)
  }
}

function semanticHash(kind: DocumentNodeKind, text: string): string {
  return createHash('sha256').update(kind).update('\0').update(text).digest('hex')
}

function pathFamily(path: string): string {
  return path.replace(/\[\d+\]/gu, '[]')
}

function nearest(
  candidates: readonly DocumentNode[],
  ordinal: number,
  officePath: string,
  used: ReadonlySet<DocumentNodeId>,
): DocumentNode | undefined {
  let selected: DocumentNode | undefined
  let selectedDistance = Number.POSITIVE_INFINITY
  for (const candidate of candidates) {
    if (used.has(candidate.id)) continue
    const distance = Math.abs(candidate.ordinal - ordinal)
    if (selected === undefined
      || distance < selectedDistance
      || (distance === selectedDistance
        && candidate.officePath === officePath
        && selected.officePath !== officePath)) {
      selected = candidate
      selectedDistance = distance
    }
  }
  return selected
}

function textAffinity(left: string, right: string): number {
  const leftPoints = Array.from(left)
  const rightPoints = Array.from(right)
  const limit = Math.min(leftPoints.length, rightPoints.length)
  let prefix = 0
  while (prefix < limit && leftPoints[prefix] === rightPoints[prefix]) prefix += 1
  let suffix = 0
  while (suffix < limit - prefix
    && leftPoints[leftPoints.length - 1 - suffix] === rightPoints[rightPoints.length - 1 - suffix]) suffix += 1
  return prefix + suffix
}

function normalizedLineage(previous: DocumentNode): DocumentNodeId[] {
  return previous.lineage.includes(previous.id)
    ? [...previous.lineage]
    : [...previous.lineage, previous.id]
}

/**
 * Build the ordered node index while preserving prior identity where content,
 * Office path, or structural position identifies the same semantic node.
 * @param documentId - owning document identity.
 * @param engineNodes - complete engine projection in document order.
 * @param previousNodes - previous ordered index for lineage matching.
 * @param updatedAt - timestamp shared by this rebuild.
 * @returns the complete replacement index.
 * @throws DocumentIndexError when engine paths are blank or duplicated.
 */
export function buildDocumentIndex(
  documentId: DocumentId,
  engineNodes: readonly EngineTextNode[],
  previousNodes: readonly DocumentNode[],
  updatedAt: string,
): DocumentNode[] {
  const seenPaths = new Set<string>()
  const prepared: PreparedNode[] = engineNodes.map((node, ordinal) => {
    if (node.officePath.length === 0) throw new DocumentIndexError('Document engine returned a blank Office path')
    if (seenPaths.has(node.officePath)) {
      throw new DocumentIndexError(`Document engine returned duplicate Office path '${node.officePath}'`)
    }
    seenPaths.add(node.officePath)
    const kind = domainKind(node.kind)
    return {
      officePath: node.officePath,
      ordinal,
      kind,
      text: node.text,
      hash: semanticHash(kind, node.text),
    }
  })

  const byHash = new Map<string, DocumentNode[]>()
  const byPath = new Map<string, DocumentNode[]>()
  const byFamily = new Map<string, DocumentNode[]>()
  for (const previous of previousNodes) {
    const hashEntries = byHash.get(previous.hash) ?? []
    hashEntries.push(previous)
    byHash.set(previous.hash, hashEntries)
    const pathEntries = byPath.get(previous.officePath) ?? []
    pathEntries.push(previous)
    byPath.set(previous.officePath, pathEntries)
    const familyKey = `${previous.kind}\0${pathFamily(previous.officePath)}`
    const familyEntries = byFamily.get(familyKey) ?? []
    familyEntries.push(previous)
    byFamily.set(familyKey, familyEntries)
  }

  const matches = new Map<number, DocumentNode>()
  const used = new Set<DocumentNodeId>()
  const assign = (node: PreparedNode, index: number, candidates: readonly DocumentNode[] | undefined): void => {
    if (candidates === undefined) return
    const match = nearest(candidates, node.ordinal, node.officePath, used)
    if (match === undefined) return
    matches.set(index, match)
    used.add(match.id)
  }

  for (const [index, node] of prepared.entries()) assign(node, index, byHash.get(node.hash))

  const related: RelatedCandidate[] = []
  for (const [index, node] of prepared.entries()) {
    if (matches.has(index)) continue
    const candidates = byFamily.get(`${node.kind}\0${pathFamily(node.officePath)}`) ?? []
    for (const candidate of candidates) {
      if (used.has(candidate.id)) continue
      const affinity = textAffinity(node.text, candidate.text)
      if (affinity === 0) continue
      related.push({
        node,
        index,
        candidate,
        affinity,
        distance: Math.abs(node.ordinal - candidate.ordinal),
      })
    }
  }
  related.sort((left, right) => right.affinity - left.affinity || left.distance - right.distance)
  for (const pair of related) {
    if (matches.has(pair.index) || used.has(pair.candidate.id)) continue
    matches.set(pair.index, pair.candidate)
    used.add(pair.candidate.id)
  }

  for (const [index, node] of prepared.entries()) {
    if (!matches.has(index)) assign(node, index, byPath.get(node.officePath))
  }

  const unmatchedByFamily = new Map<string, number[]>()
  for (const [index, node] of prepared.entries()) {
    if (matches.has(index)) continue
    const key = `${node.kind}\0${pathFamily(node.officePath)}`
    const entries = unmatchedByFamily.get(key) ?? []
    entries.push(index)
    unmatchedByFamily.set(key, entries)
  }
  for (const [key, indexes] of unmatchedByFamily) {
    const candidates = (byFamily.get(key) ?? []).filter(candidate => !used.has(candidate.id))
    if (indexes.length !== 1 || candidates.length !== 1) continue
    const index = indexes[0] as number
    const candidate = candidates[0] as DocumentNode
    matches.set(index, candidate)
    used.add(candidate.id)
  }

  return prepared.map((node, index): DocumentNode => {
    const previous = matches.get(index)
    const id = previous?.id ?? DocumentNodeId(randomUUID())
    return {
      id,
      documentId,
      officePath: node.officePath,
      ordinal: node.ordinal,
      kind: node.kind,
      text: node.text,
      style: previous === undefined ? {} : { ...previous.style },
      hash: node.hash,
      lineage: previous === undefined ? [id] : normalizedLineage(previous),
      ...(previous?.lastCommitId === undefined ? {} : { lastCommitId: previous.lastCommitId }),
      updatedAt,
    }
  })
}
