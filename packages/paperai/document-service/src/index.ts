/**
 * PaperAI document service (`ctx.paperDocuments`). It snapshots submitted Word
 * files, publishes an independent Working DOCX, and owns its semantic index.
 * @module @paperai/document-service
 */

import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { basename, extname, isAbsolute } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type { DocumentEngine, EngineTextNode } from '@paperai/document-engine'
import {
  DocumentId,
  type CapabilityHealth,
  type DocumentNode,
  type DocumentRecord,
  type DocumentRole,
  type ProjectId,
  type ProjectRecord,
} from '@paperai/domain'
import type { PaperRepository } from '@paperai/repository'
import {
  cleanupStagedDocument,
  copyDocxWorkingFile,
  finalizeWorkingFile,
  ImmutableSourceIntegrityError,
  publishStagedDocument,
  removePublishedDocument,
  sha256File,
  stageSourceFile,
  verifyImmutableSourceFile,
  type PublishedDocumentFiles,
  type StagedDocumentFiles,
  type WordSourceExtension,
} from './files.ts'
import { buildDocumentIndex, DocumentIndexError } from './indexer.ts'
import type {
  BuildCandidateDocumentIndexRequest,
  DegradedDocumentImport,
  ImportDocumentRequest,
  ImportDocumentResult,
  LegacyDocumentNormalizer,
  PaperDocumentErrorCode,
  PaperDocumentSnapshot,
} from './types.ts'

export type {
  BuildCandidateDocumentIndexRequest,
  DegradedDocumentImport,
  ImportDocumentRequest,
  ImportDocumentResult,
  ImportedDocumentResult,
  LegacyDocumentNormalizer,
  LegacyNormalizationResult,
  PaperDocumentErrorCode,
  PaperDocumentSnapshot,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    paperRepository: PaperRepository
    paperDocuments: PaperDocumentService
  }
}

/** Input, lookup, or index failure with a stable caller-facing code. */
export class PaperDocumentError extends Error {
  /** Stable error category for Host and MCP adapters. */
  readonly code: PaperDocumentErrorCode

  /**
   * @param message - actionable failure description.
   * @param code - stable machine-readable category.
   * @param options - optional underlying filesystem or engine failure.
   */
  constructor(message: string, code: PaperDocumentErrorCode, options?: ErrorOptions) {
    super(message, options)
    this.name = 'PaperDocumentError'
    this.code = code
  }
}

const UNSAFE_NAME = /[<>:"/\\|?*\u0000-\u001f\u007f]/u
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu

/* v8 ignore next -- Closed same-process unions are enforced by TypeScript. */
function assertNever(value: never): never {
  throw new Error(`Unexpected legacy normalization result: ${String(value)}`)
}

function sourceExtension(sourcePath: string): WordSourceExtension {
  const extension = extname(sourcePath).toLocaleLowerCase('en-US')
  if (extension === '.doc' || extension === '.docx') return extension
  throw new PaperDocumentError(
    `Unsupported Word source '${sourcePath}'; expected a .docx or .doc file`,
    'SOURCE_FORMAT_UNSUPPORTED',
  )
}

function documentStem(sourcePath: string, requestedName?: string): string {
  const extension = extname(sourcePath)
  const raw = requestedName ?? basename(sourcePath, extension)
  const withoutWordExtension = raw.replace(/\.(?:docx|doc)$/iu, '')
  const value = withoutWordExtension.trim().normalize('NFC')
  if (value.length === 0
    || value === '.'
    || value === '..'
    || value.endsWith('.')
    || UNSAFE_NAME.test(value)
    || WINDOWS_DEVICE_NAME.test(value)) {
    throw new PaperDocumentError(
      `Document name '${raw}' is not a safe cross-platform file name`,
      'DOCUMENT_NAME_INVALID',
    )
  }
  return value
}

function degraded(
  capability: DegradedDocumentImport['capability'],
  health: CapabilityHealth,
  detail: string,
): DegradedDocumentImport {
  return { status: 'degraded', capability, health, detail }
}

function legacyNormalizer(engine: DocumentEngine): LegacyDocumentNormalizer | undefined {
  const candidate = engine as DocumentEngine & Partial<LegacyDocumentNormalizer>
  return typeof candidate.normalizeLegacyDocument === 'function'
    ? candidate as DocumentEngine & LegacyDocumentNormalizer
    : undefined
}

async function rollbackTasks(primary: unknown, tasks: readonly (() => Promise<unknown>)[]): Promise<never> {
  const failures: unknown[] = []
  for (const task of tasks) {
    try {
      await task()
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length > 0) {
    throw new AggregateError([primary, ...failures], 'PaperAI document rollback failed')
  }
  throw primary
}

/** Immutable-source and Working-DOCX service backed by repository and engine Providers. */
export class PaperDocumentService extends Service {
  static inject = ['paperRepository', 'documentEngine']

  private readonly leases = new Map<DocumentId, Promise<void>>()

  constructor(ctx: Context) {
    super(ctx, 'paperDocuments')
  }

  /**
   * Snapshot and index a Word source. No files or records are published when
   * the configured engine reports a degraded capability.
   * @param request - project, source path, role, and optional display stem.
   * @param signal - optional cancellation propagated to engine operations.
   * @returns a complete imported snapshot or an explicit capability downgrade.
   * @throws PaperDocumentError for invalid input, missing records, or invalid engine nodes.
   */
  async importDocument(request: ImportDocumentRequest, signal?: AbortSignal): Promise<ImportDocumentResult> {
    signal?.throwIfAborted()
    const project = await this.requireProject(request.projectId)
    await this.requireSourceFile(request.sourcePath)
    const extension = sourceExtension(request.sourcePath)
    const stem = documentStem(request.sourcePath, request.name)
    const health = await this.ctx.documentEngine.health(signal)
    if (health.status !== 'ready') {
      const detail = health.detail ?? 'The configured document engine is not ready for import'
      return degraded('document-engine', health, detail)
    }

    const normalizer = extension === '.doc' ? legacyNormalizer(this.ctx.documentEngine) : undefined
    if (extension === '.doc' && normalizer === undefined) {
      const detail = 'The configured document engine cannot normalize legacy .doc files to DOCX; no files or records were created'
      return degraded('legacy-doc-normalization', { status: 'degraded', detail }, detail)
    }

    let staged: StagedDocumentFiles | undefined
    let published: PublishedDocumentFiles | undefined
    try {
      staged = await stageSourceFile(project.rootPath, request.sourcePath, extension, signal)
      if (extension === '.docx') {
        await copyDocxWorkingFile(staged, signal)
      } else {
        /* v8 ignore next -- The preflight return above excludes this typed narrowing gap. */
        if (normalizer === undefined) {
          /* v8 ignore next -- Preserves an explicit failure if the preflight invariant is edited incorrectly. */
          throw new Error('Legacy document normalizer resolution diverged during import')
        }
        const result = await normalizer.normalizeLegacyDocument(staged.sourcePath, staged.workingPath, signal)
        switch (result.status) {
          case 'degraded': {
            const detail = result.detail
            return degraded('legacy-doc-normalization', { status: 'degraded', detail }, detail)
          }
          case 'normalized': break
          /* v8 ignore next -- LegacyNormalizationResult is a closed same-process union. */
          default: return assertNever(result)
        }
        try {
          await finalizeWorkingFile(staged.workingPath)
        } catch (error) {
          throw new PaperDocumentError(
            'Legacy Word normalization did not produce a usable Working DOCX',
            'WORKING_COPY_INVALID',
            { cause: error },
          )
        }
      }

      const id = DocumentId(randomUUID())
      const updatedAt = new Date().toISOString()
      const engineNodes = await this.ctx.documentEngine.readTextNodes(staged.workingPath, signal)
      const nodes = this.buildIndex(id, engineNodes, [], updatedAt)
      const sourceSha256 = await sha256File(staged.sourcePath, signal)
      published = await publishStagedDocument(project.rootPath, staged, stem, sourceSha256, signal)
      await cleanupStagedDocument(staged)
      staged = undefined
      const document: DocumentRecord = {
        id,
        projectId: project.id,
        documentKind: 'working',
        name: published.name,
        role: request.role,
        immutableSourcePath: published.immutableSourcePath,
        workingPath: published.workingPath,
        mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        sourceSha256: published.sourceSha256,
        nodeCount: nodes.length,
        createdAt: updatedAt,
        updatedAt,
      }
      await this.persistImport(document, nodes)
      return { status: 'imported', document, nodes }
    } catch (error) {
      if (published !== undefined) {
        const files = published
        return await rollbackTasks(error, [() => removePublishedDocument(files)])
      }
      throw error
    } finally {
      if (staged !== undefined) await cleanupStagedDocument(staged)
    }
  }

  /**
   * Remove a Working import after its root-commit attempt has settled without a commit.
   * Cleanup is non-cancellable, deletes only service-published copies, and removes the
   * document record last so a failed attempt can be retried with the same identity.
   * @param documentId - identity returned by a successful {@link importDocument} call.
   * @returns after the record, semantic nodes, immutable copy, and Working copy are absent.
   * @throws PaperDocumentError when the record is not a Working import or has acquired a head commit.
   */
  async rollbackImport(documentId: DocumentId): Promise<void> {
    await this.withDocumentLease(documentId, async () => {
      const current = this.ctx.paperRepository.getDocument(documentId)
      if (current === undefined) return
      if (current.documentKind !== 'working' || current.headCommitId !== undefined) {
        throw new PaperDocumentError(
          `PaperAI import '${String(documentId)}' is not an uncommitted Working document`,
          'IMPORT_ROLLBACK_FORBIDDEN',
        )
      }

      const nodes = this.ctx.paperRepository.listNodes(current.id)
      const files: PublishedDocumentFiles = {
        name: current.name,
        immutableSourcePath: current.immutableSourcePath,
        workingPath: current.workingPath,
        sourceSha256: current.sourceSha256,
      }
      await removePublishedDocument(files)
      for (const node of nodes) await this.ctx.paperRepository.deleteNode(node.id)
      await this.ctx.paperRepository.deleteDocument(current.id)
    })
  }

  /**
   * List project documents, optionally restricted to one academic role.
   * @param projectId - owning project identity.
   * @param role - optional exact role filter.
   * @returns deterministic creation/name/id order.
   */
  listDocuments(projectId: ProjectId, role?: DocumentRole): DocumentRecord[] {
    return this.ctx.paperRepository.listDocuments(projectId)
      .filter(document => document.documentKind !== 'template-source')
      .filter(document => role === undefined || document.role === role)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt)
        || left.name.localeCompare(right.name)
        || String(left.id).localeCompare(String(right.id)))
  }

  /**
   * Read one repository snapshot.
   * @param documentId - document identity.
   * @returns document metadata and ordered nodes, or undefined when absent.
   */
  readDocument(documentId: DocumentId): PaperDocumentSnapshot | undefined {
    const document = this.ctx.paperRepository.getDocument(documentId)
    if (document === undefined) return undefined
    return { document, nodes: this.ctx.paperRepository.listNodes(documentId) }
  }

  /**
   * Verify the immutable source before a Consumer reads or copies its bytes.
   * @param documentId - document identity whose source should be verified.
   * @param signal - optional hash cancellation.
   * @returns the verified lowercase SHA-256 digest.
   * @throws PaperDocumentError when the document is absent, writable, replaced, or corrupted.
   */
  async verifyImmutableSource(documentId: DocumentId, signal?: AbortSignal): Promise<string> {
    const document = this.requireDocument(documentId)
    try {
      return await verifyImmutableSourceFile(
        document.immutableSourcePath,
        document.sourceSha256,
        signal,
      )
    } catch (error) {
      if (error instanceof ImmutableSourceIntegrityError) {
        throw new PaperDocumentError(error.message, 'SOURCE_INTEGRITY_INVALID', { cause: error })
      }
      throw error
    }
  }

  /**
   * Read the current ordered semantic index without exposing repository aliases.
   * @param documentId - document identity.
   * @returns an isolated node snapshot.
   * @throws PaperDocumentError when the document does not exist.
   */
  readNodes(documentId: DocumentId): readonly DocumentNode[] {
    this.requireDocument(documentId)
    return structuredClone(this.ctx.paperRepository.listNodes(documentId))
  }

  /**
   * Build, but do not publish, the semantic index for a staged commit DOCX.
   * The commit service remains the sole owner of Working DOCX and repository
   * publication; this method only projects candidate bytes through OfficeCLI.
   * @param request - candidate file, observed metadata, and stable prior nodes.
   * @returns isolated nodes carrying the prospective commit identity.
   */
  buildCandidateIndex(request: BuildCandidateDocumentIndexRequest): Promise<readonly DocumentNode[]> {
    return this.withDocumentLease(request.document.id, async () => {
      const current = this.requireDocument(request.document.id)
      if (current.workingPath !== request.document.workingPath) {
        throw new PaperDocumentError(
          `PaperAI document '${String(current.id)}' Working DOCX changed before candidate indexing`,
          'WORKING_COPY_INVALID',
        )
      }
      if (request.currentNodes.some(node => node.documentId !== current.id)) {
        throw new PaperDocumentError(
          `Candidate index for '${String(current.id)}' contains a node owned by another document`,
          'DOCUMENT_INDEX_INVALID',
        )
      }
      const updatedAt = new Date().toISOString()
      const engineNodes = await this.ctx.documentEngine.readTextNodes(request.candidatePath, request.signal)
      return this.buildIndex(current.id, engineNodes, request.currentNodes, updatedAt)
        .map(node => ({ ...node, lastCommitId: request.commitId }))
    })
  }

  /**
   * Render the current Working DOCX as generated preview HTML.
   * @param documentId - document identity.
   * @param signal - optional engine cancellation.
   * @returns generated preview HTML; it is never an editable authority.
   * @throws PaperDocumentError when the document does not exist.
   */
  async previewHtml(documentId: DocumentId, signal?: AbortSignal): Promise<string> {
    const document = this.requireDocument(documentId)
    return await this.ctx.documentEngine.previewHtml(document.workingPath, signal)
  }

  /**
   * Re-read the Working DOCX and replace its semantic index while preserving
   * prior node identity where content or structure still identifies lineage.
   * @param documentId - document identity.
   * @param signal - optional engine cancellation.
   * @returns updated repository snapshot.
   * @throws PaperDocumentError when the document is missing or engine nodes are invalid.
   */
  rebuildIndex(documentId: DocumentId, signal?: AbortSignal): Promise<PaperDocumentSnapshot> {
    return this.withDocumentLease(documentId, async () => {
      const document = this.requireDocument(documentId)
      const previous = this.ctx.paperRepository.listNodes(documentId)
      const updatedAt = new Date().toISOString()
      const engineNodes = await this.ctx.documentEngine.readTextNodes(document.workingPath, signal)
      const nodes = this.buildIndex(documentId, engineNodes, previous, updatedAt)
      const updatedDocument = await this.persistRebuiltIndex(document, previous, nodes, updatedAt)
      return { document: updatedDocument, nodes }
    })
  }

  private async requireProject(projectId: ProjectId): Promise<ProjectRecord> {
    const project = this.ctx.paperRepository.getProject(projectId)
    if (project === undefined) {
      throw new PaperDocumentError(`PaperAI project '${String(projectId)}' does not exist`, 'PROJECT_NOT_FOUND')
    }
    if (!isAbsolute(project.rootPath)) {
      throw new PaperDocumentError(`PaperAI project root '${project.rootPath}' is not absolute`, 'PROJECT_ROOT_INVALID')
    }
    try {
      const metadata = await stat(project.rootPath)
      if (!metadata.isDirectory()) throw new Error('not a directory')
    } catch (error) {
      throw new PaperDocumentError(
        `PaperAI project root '${project.rootPath}' is not an accessible directory`,
        'PROJECT_ROOT_INVALID',
        { cause: error },
      )
    }
    return project
  }

  private async requireSourceFile(sourcePath: string): Promise<void> {
    try {
      const metadata = await stat(sourcePath)
      if (!metadata.isFile()) {
        throw new PaperDocumentError(`Word source '${sourcePath}' is not a regular file`, 'SOURCE_NOT_FILE')
      }
    } catch (error) {
      if (error instanceof PaperDocumentError) throw error
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        throw new PaperDocumentError(`Word source '${sourcePath}' does not exist`, 'SOURCE_NOT_FOUND', { cause: error })
      }
      throw error
    }
  }

  private requireDocument(documentId: DocumentId): DocumentRecord {
    const document = this.ctx.paperRepository.getDocument(documentId)
    if (document === undefined) {
      throw new PaperDocumentError(`PaperAI document '${String(documentId)}' does not exist`, 'DOCUMENT_NOT_FOUND')
    }
    return document
  }

  private buildIndex(
    documentId: DocumentId,
    engineNodes: readonly EngineTextNode[],
    previous: readonly DocumentNode[],
    updatedAt: string,
  ): DocumentNode[] {
    try {
      return buildDocumentIndex(documentId, engineNodes, previous, updatedAt)
    } catch (error) {
      const failure = error as DocumentIndexError
      throw new PaperDocumentError(failure.message, 'DOCUMENT_INDEX_INVALID', { cause: failure })
    }
  }

  private async persistImport(document: DocumentRecord, nodes: readonly DocumentNode[]): Promise<void> {
    const written: DocumentNode[] = []
    try {
      for (const node of nodes) {
        await this.ctx.paperRepository.putNode(node)
        written.push(node)
      }
      await this.ctx.paperRepository.putDocument(document)
    } catch (error) {
      return await rollbackTasks(error, written.toReversed().map(node => (
        () => this.ctx.paperRepository.deleteNode(node.id)
      )))
    }
  }

  private async persistRebuiltIndex(
    document: DocumentRecord,
    previous: readonly DocumentNode[],
    nodes: readonly DocumentNode[],
    updatedAt: string,
  ): Promise<DocumentRecord> {
    const nextIds = new Set(nodes.map(node => node.id))
    const previousIds = new Set(previous.map(node => node.id))
    try {
      for (const node of nodes) await this.ctx.paperRepository.putNode(node)
      for (const node of previous) {
        if (!nextIds.has(node.id)) await this.ctx.paperRepository.deleteNode(node.id)
      }
      return await this.ctx.paperRepository.updateDocument(document.id, current => ({
        ...current,
        nodeCount: nodes.length,
        updatedAt,
      }))
    } catch (error) {
      const tasks: (() => Promise<unknown>)[] = [
        ...previous.map(node => () => this.ctx.paperRepository.putNode(node)),
        ...nodes.filter(node => !previousIds.has(node.id))
          .map(node => () => this.ctx.paperRepository.deleteNode(node.id)),
        () => this.ctx.paperRepository.putDocument(document),
      ]
      return await rollbackTasks(error, tasks)
    }
  }

  private withDocumentLease<T>(documentId: DocumentId, operation: () => Promise<T>): Promise<T> {
    const previous = this.leases.get(documentId) ?? Promise.resolve()
    const run = previous.then(operation, operation)
    const tail = run.then(() => undefined, () => undefined)
    this.leases.set(documentId, tail)
    return run.finally(() => {
      if (this.leases.get(documentId) === tail) this.leases.delete(documentId)
    })
  }
}

export default PaperDocumentService
