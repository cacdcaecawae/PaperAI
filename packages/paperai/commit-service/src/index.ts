/**
 * Recoverable PaperAI document commits (`ctx.paperCommits`). All human and
 * Agent Working DOCX mutations pass through this service; publication creates
 * a new commit immediately and never requires a second acceptance step.
 * @module @paperai/commit-service
 */

import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { Context, Service } from '@deepseek-ai/cordis'
import type { EngineMutation } from '@paperai/document-engine'
import type DocumentEngine from '@paperai/document-engine'
import {
  DocumentCommitId,
} from '@paperai/domain'
import type {
  ActorIdentity,
  DocumentCommit,
  DocumentCommitId as DocumentCommitIdType,
  DocumentId,
  DocumentMutation,
  DocumentNode,
  DocumentOperation,
  DocumentRecord,
  DocumentRole,
  ProjectRecord,
  TemplateContractId,
} from '@paperai/domain'
import type PaperRepository from '@paperai/repository'
import type { DocumentCommitPublication } from '@paperai/repository'
import {
  createCandidateFile,
  readFileImage,
  readSnapshot,
  removeCandidateFile,
  replaceRegularFile,
  resolveCommitFilePaths,
  storeSnapshot,
} from './files.ts'
import type { CommitFilePaths, FileImage } from './files.ts'
import {
  DocumentHeadConflictError,
  DocumentValidationError,
  PaperCommitError,
} from './errors.ts'
import type {
  DocumentCommitHistory,
  PaperDocumentIndexPeer,
  PaperTemplateCommitPeer,
  RevertDocumentCommitRequest,
  SubmitDocumentCommitRequest,
} from './types.ts'

export {
  DocumentHeadConflictError,
  DocumentValidationError,
  PaperCommitError,
} from './errors.ts'
export type {
  DocumentCommitHistory,
  DocumentIndexRebuildRequest,
  PaperCommitErrorCode,
  PaperDocumentIndexPeer,
  PaperTemplateCommitPeer,
  RevertDocumentCommitRequest,
  SubmitDocumentCommitRequest,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    paperCommits: PaperCommitService
  }
}

type CommitContext = Context & {
  readonly paperRepository: PaperRepository
  readonly documentEngine: DocumentEngine
  readonly paperDocuments: PaperDocumentIndexPeer
  readonly paperTemplates: PaperTemplateCommitPeer
}

interface ResolvedSubmitRequest {
  readonly documentId: DocumentId
  readonly baseCommitId: DocumentCommitIdType | undefined
  readonly message: string
  readonly actor: ActorIdentity
  readonly mutations: readonly DocumentMutation[]
  readonly signal: AbortSignal | undefined
}

interface ResolvedRevertRequest {
  readonly documentId: DocumentId
  readonly baseCommitId: DocumentCommitIdType
  readonly targetCommitId: DocumentCommitIdType
  readonly message: string
  readonly actor: ActorIdentity
  readonly signal: AbortSignal | undefined
}

interface CompiledMutations {
  readonly engineMutations: readonly EngineMutation[]
  readonly operations: readonly DocumentOperation[]
  readonly currentNodes: readonly DocumentNode[]
  readonly templateChanged: boolean
  readonly templateId: TemplateContractId | undefined
  /** Document type the commit publishes; equals the stored role unless a mutation changed it. */
  readonly role: DocumentRole
}

interface PublishCandidateRequest {
  readonly document: DocumentRecord
  readonly paths: CommitFilePaths
  readonly original: FileImage
  readonly candidatePath: string
  readonly expectedHead: DocumentCommitIdType | undefined
  readonly message: string
  readonly actor: ActorIdentity
  readonly operations: readonly DocumentOperation[]
  readonly currentNodes: readonly DocumentNode[]
  readonly templateChanged: boolean
  readonly templateId: TemplateContractId | undefined
  readonly role: DocumentRole
  readonly signal: AbortSignal | undefined
}

type PublicationRecoveryOutcome = 'committed' | 'rolled-back'

function nonBlank(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0
}

function validateActor(actor: Readonly<ActorIdentity>): ActorIdentity {
  if (!nonBlank(actor.name)) {
    throw new PaperCommitError('INVALID_PROVENANCE', 'document commit actor name must be non-blank')
  }
  for (const [field, value] of [
    ['client', actor.client],
    ['provider', actor.provider],
    ['model', actor.model],
    ['modelRevision', actor.modelRevision],
    ['sessionId', actor.sessionId],
    ['runId', actor.runId],
  ] as const) {
    if (value !== undefined && !nonBlank(value)) {
      throw new PaperCommitError('INVALID_PROVENANCE', `document commit actor ${field} must be non-blank when present`)
    }
  }
  if (actor.kind === 'agent') {
    if (!nonBlank(actor.client) || !nonBlank(actor.model) || !nonBlank(actor.sessionId)) {
      throw new PaperCommitError(
        'INVALID_PROVENANCE',
        'Agent document commits require client, model, and sessionId provenance',
      )
    }
  }
  return structuredClone(actor)
}

function resolveSubmitRequest(request: SubmitDocumentCommitRequest): ResolvedSubmitRequest {
  const message = request.message.trim()
  if (message.length === 0) {
    throw new PaperCommitError('INVALID_REQUEST', 'document commit message must be non-blank')
  }
  if (request.mutations.length === 0) {
    throw new PaperCommitError('INVALID_REQUEST', 'document commit requires at least one mutation')
  }
  return {
    documentId: request.documentId,
    baseCommitId: request.baseCommitId,
    message,
    actor: validateActor(request.actor),
    mutations: structuredClone(request.mutations),
    signal: request.signal,
  }
}

function resolveRevertRequest(request: RevertDocumentCommitRequest): ResolvedRevertRequest {
  const message = request.message?.trim() || `Revert to ${request.targetCommitId}`
  return {
    documentId: request.documentId,
    baseCommitId: request.baseCommitId,
    targetCommitId: request.targetCommitId,
    message,
    actor: validateActor(request.actor),
    signal: request.signal,
  }
}

function cloneCommit(commit: DocumentCommit): DocumentCommit {
  return structuredClone(commit)
}

function assertNever(value: never): never {
  throw new PaperCommitError('UNSUPPORTED_MUTATION', `unsupported document mutation '${String(value)}'`)
}

/** FIFO commit controller and the only authoritative Working DOCX mutation path. */
export class PaperCommitService extends Service {
  static inject = ['paperRepository', 'documentEngine', 'paperDocuments', 'paperTemplates']

  private readonly queues = new Map<DocumentId, Promise<void>>()

  constructor(ctx: Context) {
    super(ctx, 'paperCommits')
  }

  /** Recover every durable publication before the service accepts document work. */
  protected async [Service.init](): Promise<void> {
    const publications = this.dependencies.paperRepository.listCommitPublications()
      .map(publication => structuredClone(publication))
      .sort((left, right) => left.documentId.localeCompare(right.documentId))
    for (const publication of publications) await this.recoverPublication(publication)
  }

  /**
   * Apply mutations to a temporary copy and publish one recoverable commit.
   * Cancellation remains effective through staging; once publication starts,
   * the method completes publication or rollback before it settles.
   * @param request - base head, provenance, message, and ordered mutations.
   * @returns the completed commit after its Working DOCX and head are durable.
   */
  submit(request: SubmitDocumentCommitRequest): Promise<DocumentCommit> {
    const resolved = resolveSubmitRequest(request)
    return this.enqueue(resolved.documentId, resolved.signal, () => this.submitLocked(resolved))
  }

  /**
   * Restore a reachable snapshot and record the restoration as a new commit.
   * @param request - current head, historical target, provenance, and message.
   * @returns the new revert commit; the historical target remains unchanged.
   */
  revert(request: RevertDocumentCommitRequest): Promise<DocumentCommit> {
    const resolved = resolveRevertRequest(request)
    return this.enqueue(resolved.documentId, resolved.signal, () => this.revertLocked(resolved))
  }

  /**
   * Read one stored commit object by id, including an unreachable recovery object.
   * @param commitId - exact commit identity.
   * @returns an isolated copy, or `undefined` when no object exists.
   */
  getCommit(commitId: DocumentCommitIdType): DocumentCommit | undefined {
    const commit = this.dependencies.paperRepository.getCommit(commitId)
    return commit === undefined ? undefined : cloneCommit(commit)
  }

  /**
   * Read the user-visible history from the current head toward the root.
   * Unreachable objects retained after failed publication are excluded.
   * @param documentId - document whose reachable history is requested.
   * @returns newest-first isolated commit records.
   */
  listHistory(documentId: DocumentId): DocumentCommitHistory {
    return this.reachableHistory(this.requireDocument(documentId)).map(cloneCommit)
  }

  private get dependencies(): CommitContext {
    return this.ctx as CommitContext
  }

  private enqueue<T>(documentId: DocumentId, signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(documentId) ?? Promise.resolve()
    const run = previous.then(async () => {
      await this.recoverDocumentPublication(documentId)
      signal?.throwIfAborted()
      return await operation()
    })
    const tail = run.then(() => undefined, () => undefined)
    this.queues.set(documentId, tail)
    return run.finally(() => {
      if (this.queues.get(documentId) === tail) this.queues.delete(documentId)
    })
  }

  private requireDocument(documentId: DocumentId): DocumentRecord {
    const document = this.dependencies.paperRepository.getDocument(documentId)
    if (document === undefined) {
      throw new PaperCommitError('DOCUMENT_NOT_FOUND', `document '${documentId}' does not exist`)
    }
    if (document.documentKind === 'template-source') {
      throw new PaperCommitError('DOCUMENT_NOT_WORKING', `document '${documentId}' is a template source, not a Working DOCX`)
    }
    return document
  }

  private assertWorkingMatchesHead(document: DocumentRecord, workingSha256: string): void {
    if (document.headCommitId === undefined) return
    const head = this.dependencies.paperRepository.getCommit(document.headCommitId)
    if (head === undefined || head.documentId !== document.id) {
      throw new PaperCommitError(
        'WORKING_COPY_CHANGED',
        `document '${document.id}' head does not resolve to an owned commit snapshot`,
      )
    }
    if (head.documentSha256 !== workingSha256) {
      throw new PaperCommitError(
        'WORKING_COPY_CHANGED',
        `document '${document.id}' Working DOCX differs from head '${head.id}'; capture the external edit as its own version before continuing`,
      )
    }
  }

  private requireProject(document: DocumentRecord): ProjectRecord {
    const project = this.dependencies.paperRepository.getProject(document.projectId)
    if (project === undefined) {
      throw new PaperCommitError(
        'PROJECT_NOT_FOUND',
        `project '${document.projectId}' for document '${document.id}' does not exist`,
      )
    }
    return project
  }

  private assertHead(document: DocumentRecord, expectedHead: DocumentCommitIdType | undefined): void {
    if (document.headCommitId !== expectedHead) {
      throw new DocumentHeadConflictError(document.id, expectedHead, document.headCommitId)
    }
  }

  private async submitLocked(request: ResolvedSubmitRequest): Promise<DocumentCommit> {
    request.signal?.throwIfAborted()
    const document = this.requireDocument(request.documentId)
    this.assertHead(document, request.baseCommitId)
    const project = this.requireProject(document)
    const paths = resolveCommitFilePaths(project.rootPath, document.workingPath)
    const original = await readFileImage(paths.workingPath, 'WORKING_COPY_CHANGED', 'Working DOCX')
    this.assertWorkingMatchesHead(document, original.sha256)
    const compiled = await this.compileMutations(document, request.mutations)
    return await this.withCandidate(paths, original.bytes, async (candidatePath) => {
      if (compiled.engineMutations.length > 0) {
        await this.dependencies.documentEngine.applyMutations(
          candidatePath,
          compiled.engineMutations,
          request.signal,
        )
      }
      return await this.prepareAndPublish({
        document,
        paths,
        original,
        candidatePath,
        expectedHead: request.baseCommitId,
        message: request.message,
        actor: request.actor,
        operations: compiled.operations,
        currentNodes: compiled.currentNodes,
        templateChanged: compiled.templateChanged,
        templateId: compiled.templateId,
        role: compiled.role,
        signal: request.signal,
      })
    })
  }

  private async revertLocked(request: ResolvedRevertRequest): Promise<DocumentCommit> {
    request.signal?.throwIfAborted()
    const document = this.requireDocument(request.documentId)
    this.assertHead(document, request.baseCommitId)
    if (request.targetCommitId === request.baseCommitId) {
      throw new PaperCommitError('INVALID_REQUEST', 'revert target must differ from the current head')
    }
    const target = this.reachableHistory(document)
      .find(commit => commit.id === request.targetCommitId)
    if (target === undefined) {
      throw new PaperCommitError(
        'COMMIT_NOT_FOUND',
        `commit '${request.targetCommitId}' is not reachable from document '${document.id}'`,
      )
    }
    const project = this.requireProject(document)
    const paths = resolveCommitFilePaths(project.rootPath, document.workingPath)
    const original = await readFileImage(paths.workingPath, 'WORKING_COPY_CHANGED', 'Working DOCX')
    this.assertWorkingMatchesHead(document, original.sha256)
    const snapshot = await readSnapshot(paths, target.snapshotPath, target.documentSha256)
    const currentNodes = structuredClone(
      await this.dependencies.paperDocuments.readNodes(document.id),
    ) as DocumentNode[]
    const operation: DocumentOperation = {
      type: 'revert',
      before: {
        commitId: document.headCommitId,
        documentSha256: original.sha256,
      },
      after: {
        commitId: target.id,
        documentSha256: target.documentSha256,
      },
    }
    return await this.withCandidate(paths, snapshot.bytes, async candidatePath => (
      await this.prepareAndPublish({
        document,
        paths,
        original,
        candidatePath,
        expectedHead: request.baseCommitId,
        message: request.message,
        actor: request.actor,
        operations: [operation],
        currentNodes,
        templateChanged: document.templateId !== target.gate.templateId,
        templateId: target.gate.templateId,
        role: document.role,
        signal: request.signal,
      })
    ))
  }

  private async withCandidate<T>(
    paths: CommitFilePaths,
    source: Uint8Array,
    operation: (candidatePath: string) => Promise<T>,
  ): Promise<T> {
    const candidatePath = await createCandidateFile(paths, source)
    let failed = false
    let failure: unknown
    try {
      return await operation(candidatePath)
    } catch (error) {
      failed = true
      failure = error
      throw error
    } finally {
      try {
        await removeCandidateFile(paths, candidatePath)
      } catch (cleanupError) {
        if (failed) {
          throw new AggregateError(
            [failure, cleanupError],
            `document candidate '${candidatePath}' failed and cleanup also failed`,
          )
        }
        this.ctx.logger.warn(`completed document commit left temporary candidate '${candidatePath}': ${String(cleanupError)}`)
      }
    }
  }

  private async compileMutations(
    document: DocumentRecord,
    mutations: readonly DocumentMutation[],
  ): Promise<CompiledMutations> {
    const currentNodes = structuredClone(
      await this.dependencies.paperDocuments.readNodes(document.id),
    ) as DocumentNode[]
    const nodes = new Map(currentNodes.map(node => [node.id, structuredClone(node)]))
    const engineMutations: EngineMutation[] = []
    const operations: DocumentOperation[] = []
    let templateChanged = false
    let templateId = document.templateId
    let role = document.role

    const requireNode = (nodeId: DocumentNode['id']): DocumentNode => {
      const node = nodes.get(nodeId)
      if (node === undefined || node.documentId !== document.id) {
        throw new PaperCommitError(
          'NODE_NOT_FOUND',
          `node '${nodeId}' does not belong to document '${document.id}'`,
        )
      }
      return node
    }

    for (const mutation of mutations) {
      switch (mutation.type) {
        case 'replace-text': {
          const node = requireNode(mutation.nodeId)
          if (node.text !== mutation.baseText) {
            throw new PaperCommitError(
              'NODE_TEXT_CONFLICT',
              `node '${node.id}' text changed since the mutation was prepared`,
            )
          }
          if (mutation.nextText === mutation.baseText) {
            throw new PaperCommitError('INVALID_REQUEST', `replace-text for node '${node.id}' is a no-op`)
          }
          engineMutations.push({ type: 'replace-text', officePath: node.officePath, text: mutation.nextText })
          operations.push({
            type: mutation.type,
            nodeId: node.id,
            officePath: node.officePath,
            before: mutation.baseText,
            after: mutation.nextText,
          })
          nodes.set(node.id, { ...node, text: mutation.nextText })
          break
        }
        case 'insert-node': {
          if (mutation.afterNodeId !== undefined && mutation.beforeNodeId !== undefined) {
            throw new PaperCommitError('INVALID_REQUEST', 'insert-node accepts either afterNodeId or beforeNodeId, not both')
          }
          const after = mutation.afterNodeId === undefined ? undefined : requireNode(mutation.afterNodeId)
          const before = mutation.beforeNodeId === undefined ? undefined : requireNode(mutation.beforeNodeId)
          engineMutations.push({
            type: 'insert-paragraph',
            text: mutation.text,
            ...(mutation.style === undefined ? {} : { style: mutation.style }),
            ...(after === undefined ? {} : { after: after.officePath }),
            ...(before === undefined ? {} : { before: before.officePath }),
          })
          operations.push({
            type: mutation.type,
            before: null,
            after: structuredClone(mutation),
          })
          break
        }
        case 'delete-node': {
          const node = requireNode(mutation.nodeId)
          if (mutation.baseText !== undefined && node.text !== mutation.baseText) {
            throw new PaperCommitError(
              'NODE_TEXT_CONFLICT',
              `node '${node.id}' text changed since the deletion was prepared`,
            )
          }
          engineMutations.push({ type: 'remove', officePath: node.officePath })
          operations.push({
            type: mutation.type,
            nodeId: node.id,
            officePath: node.officePath,
            before: { text: node.text, style: structuredClone(node.style) },
            after: null,
          })
          nodes.delete(node.id)
          break
        }
        case 'bind-template':
          this.dependencies.paperTemplates.validateAssociation({
            documentId: document.id,
            templateId: mutation.templateId,
            role,
          })
          operations.push({
            type: mutation.type,
            before: templateId ?? null,
            after: mutation.templateId,
          })
          templateChanged = true
          templateId = mutation.templateId
          break
        case 'unbind-template':
          if (templateId === undefined) {
            throw new PaperCommitError('INVALID_REQUEST', `document '${document.id}' has no template to unbind`)
          }
          operations.push({ type: mutation.type, before: templateId, after: null })
          templateChanged = true
          templateId = undefined
          break
        case 'set-document-type': {
          if (mutation.documentType === role) {
            throw new PaperCommitError(
              'INVALID_REQUEST',
              `document '${document.id}' already has type '${role}'`,
            )
          }
          // A bound format applies to one type; changing the type without
          // rebinding in the same commit would leave a mismatched binding.
          const rebinds = mutations.some(candidate => candidate.type === 'bind-template')
          if (templateId !== undefined && !rebinds) {
            operations.push({ type: 'unbind-template', before: templateId, after: null })
            templateChanged = true
            templateId = undefined
          }
          operations.push({ type: mutation.type, before: role, after: mutation.documentType })
          role = mutation.documentType
          break
        }
        case 'milestone': {
          const label = mutation.label.trim()
          if (label.length === 0) {
            throw new PaperCommitError('INVALID_REQUEST', 'milestone label must be non-blank')
          }
          operations.push({ type: mutation.type, before: null, after: label })
          break
        }
        case 'set-style':
        case 'set-fact':
          throw new PaperCommitError(
            'UNSUPPORTED_MUTATION',
            `document engine cannot apply '${mutation.type}' mutations through its current interface`,
          )
        case 'revert':
          throw new PaperCommitError('UNSUPPORTED_MUTATION', 'use paperCommits.revert() for snapshot restoration')
        default:
          assertNever(mutation)
      }
    }

    return {
      engineMutations,
      operations,
      currentNodes,
      templateChanged,
      templateId,
      role,
    }
  }

  private async prepareAndPublish(request: PublishCandidateRequest): Promise<DocumentCommit> {
    request.signal?.throwIfAborted()
    const validation = await this.dependencies.documentEngine.validate(request.candidatePath, request.signal)
    if (!validation.success) {
      throw new DocumentValidationError(request.document.id, validation.details)
    }
    const candidate = await readFileImage(
      request.candidatePath,
      'WORKING_COPY_CHANGED',
      'temporary Working DOCX candidate',
    )
    const createdAt = new Date().toISOString()
    const commitId = DocumentCommitId(randomUUID())
    const rebuilt = await this.dependencies.paperDocuments.buildCandidateIndex({
      document: structuredClone(request.document),
      candidatePath: request.candidatePath,
      commitId,
      currentNodes: structuredClone(request.currentNodes),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    })
    const nextNodes = this.validateRebuiltIndex(request.document.id, commitId, rebuilt)
    const gate = await this.dependencies.paperTemplates.checkCandidate({
      document: request.document,
      candidatePath: request.candidatePath,
      ...(request.templateId === undefined ? {} : { templateId: request.templateId }),
      mode: 'continuous',
    }, request.signal)
    request.signal?.throwIfAborted()
    const snapshotPath = await storeSnapshot(
      request.paths,
      candidate.bytes,
      candidate.sha256,
    )
    request.signal?.throwIfAborted()

    const latest = this.requireDocument(request.document.id)
    this.assertHead(latest, request.expectedHead)
    if (latest.workingPath !== request.document.workingPath) {
      throw new PaperCommitError(
        'WORKING_COPY_CHANGED',
        `document '${latest.id}' Working DOCX path changed while the commit was staged`,
      )
    }
    const current = await readFileImage(request.paths.workingPath, 'WORKING_COPY_CHANGED', 'Working DOCX')
    if (current.sha256 !== request.original.sha256) {
      throw new PaperCommitError(
        'WORKING_COPY_CHANGED',
        `document '${latest.id}' Working DOCX changed without a new document head`,
      )
    }

    const commit: DocumentCommit = {
      id: commitId,
      documentId: request.document.id,
      ...(request.expectedHead === undefined ? {} : { parentId: request.expectedHead }),
      message: request.message,
      actor: structuredClone(request.actor),
      snapshotPath,
      documentSha256: candidate.sha256,
      gate: structuredClone(gate),
      operations: request.operations.map(operation => structuredClone(operation)),
      createdAt,
    }
    request.signal?.throwIfAborted()
    await this.publishCommit(
      { ...request, original: current },
      commit,
      candidate,
      nextNodes,
    )
    return cloneCommit(commit)
  }

  private validateRebuiltIndex(
    documentId: DocumentId,
    commitId: DocumentCommitIdType,
    nodes: readonly DocumentNode[],
  ): DocumentNode[] {
    const ids = new Set<string>()
    const ordinals = new Set<number>()
    const result = structuredClone(nodes) as DocumentNode[]
    for (const node of result) {
      if (node.documentId !== documentId || node.lastCommitId !== commitId) {
        throw new PaperCommitError(
          'INDEX_INVALID',
          `rebuilt node '${node.id}' does not carry document '${documentId}' and commit '${commitId}'`,
        )
      }
      if (ids.has(node.id) || ordinals.has(node.ordinal)) {
        throw new PaperCommitError('INDEX_INVALID', 'rebuilt document index contains duplicate node ids or ordinals')
      }
      ids.add(node.id)
      ordinals.add(node.ordinal)
    }
    return result.sort((left, right) => left.ordinal - right.ordinal)
  }

  private async publishCommit(
    request: PublishCandidateRequest,
    commit: DocumentCommit,
    candidate: FileImage,
    nextNodes: readonly DocumentNode[],
  ): Promise<void> {
    const repository = this.dependencies.paperRepository
    const documentBefore = structuredClone(this.requireDocument(request.document.id))
    this.assertHead(documentBefore, request.expectedHead)
    const currentNodes = repository.listNodes(request.document.id)
    if (!isDeepStrictEqual(currentNodes, request.currentNodes)) {
      throw new PaperCommitError(
        'WORKING_COPY_CHANGED',
        `document '${request.document.id}' node index changed while the commit was staged`,
      )
    }
    const originalSnapshotPath = await storeSnapshot(
      request.paths,
      request.original.bytes,
      request.original.sha256,
    )
    const documentAfter: DocumentRecord = {
      ...documentBefore,
      role: request.role,
      headCommitId: commit.id,
      nodeCount: nextNodes.length,
      updatedAt: commit.createdAt,
    }
    if (request.templateChanged) {
      if (request.templateId === undefined) delete documentAfter.templateId
      else documentAfter.templateId = request.templateId
    }
    const publication: DocumentCommitPublication = {
      version: 1,
      documentId: request.document.id,
      commit: cloneCommit(commit),
      before: {
        document: structuredClone(documentBefore),
        nodes: structuredClone(currentNodes),
        working: {
          snapshotPath: originalSnapshotPath,
          sha256: request.original.sha256,
          mode: request.original.mode,
        },
      },
      after: {
        document: structuredClone(documentAfter),
        nodes: structuredClone(nextNodes),
      },
      createdAt: commit.createdAt,
    }
    this.assertPublicationRecord(publication)
    if (repository.getCommitPublication(publication.documentId) !== undefined) {
      throw new PaperCommitError(
        'RECOVERY_FAILED',
        `document '${publication.documentId}' already has an unresolved commit publication`,
      )
    }
    await repository.putCommitPublication(structuredClone(publication))
    try {
      await this.ensurePublicationCommit(publication)
      await replaceRegularFile(request.paths.workingPath, candidate.bytes, request.original.mode)
      await this.replaceIndex(currentNodes, nextNodes)
      await repository.updateDocument(request.document.id, (current) => {
        if (!isDeepStrictEqual(current, documentBefore)) {
          throw new PaperCommitError(
            'WORKING_COPY_CHANGED',
            `document '${current.id}' metadata changed after commit publication became durable`,
          )
        }
        return structuredClone(documentAfter)
      })
      await repository.deleteCommitPublication(publication.documentId)
    } catch (error) {
      let outcome: PublicationRecoveryOutcome
      try {
        outcome = await this.recoverPublication(publication)
      } catch (recoveryError) {
        throw new AggregateError(
          [error, recoveryError],
          `document '${request.document.id}' publication failed and durable recovery could not converge`,
        )
      }
      if (outcome === 'committed') return
      throw error
    }
  }

  private async recoverDocumentPublication(documentId: DocumentId): Promise<void> {
    const publication = this.dependencies.paperRepository.getCommitPublication(documentId)
    if (publication !== undefined) await this.recoverPublication(structuredClone(publication))
  }

  private async recoverPublication(
    publication: DocumentCommitPublication,
  ): Promise<PublicationRecoveryOutcome> {
    this.assertPublicationRecord(publication)
    const repository = this.dependencies.paperRepository
    const retained = repository.getCommitPublication(publication.documentId)
    if (retained !== undefined && !isDeepStrictEqual(retained, publication)) {
      throw this.recoveryError(publication, 'durable journal content changed during recovery')
    }
    const document = repository.getDocument(publication.documentId)
    if (document === undefined) {
      throw this.recoveryError(publication, 'document record is missing')
    }
    const project = repository.getProject(publication.before.document.projectId)
    if (project === undefined) {
      throw this.recoveryError(publication, `project '${publication.before.document.projectId}' is missing`)
    }
    const paths = resolveCommitFilePaths(project.rootPath, publication.before.document.workingPath)
    const original = await readSnapshot(
      paths,
      publication.before.working.snapshotPath,
      publication.before.working.sha256,
    )
    const candidate = await readSnapshot(
      paths,
      publication.commit.snapshotPath,
      publication.commit.documentSha256,
    )
    const working = await readFileImage(paths.workingPath, 'RECOVERY_FAILED', 'Working DOCX recovery target')
    const actualNodes = repository.listNodes(publication.documentId)
    this.assertRecoverableIndex(publication, actualNodes)
    await this.ensurePublicationCommit(publication)

    let outcome: PublicationRecoveryOutcome
    if (document.headCommitId === publication.commit.id) {
      if (document.workingPath !== publication.after.document.workingPath) {
        throw this.recoveryError(publication, 'committed document points at another Working DOCX')
      }
      if (working.sha256 !== candidate.sha256) {
        throw this.recoveryError(
          publication,
          `committed Working DOCX has unrecognized SHA-256 '${working.sha256}'`,
        )
      }
      await this.replaceIndex(actualNodes, publication.after.nodes)
      outcome = 'committed'
    } else if (document.headCommitId === publication.before.document.headCommitId) {
      if (working.sha256 !== original.sha256 && working.sha256 !== candidate.sha256) {
        throw this.recoveryError(
          publication,
          `uncommitted Working DOCX has unrecognized SHA-256 '${working.sha256}'`,
        )
      }
      const failures: unknown[] = []
      try {
        await this.replaceIndex(actualNodes, publication.before.nodes)
      } catch (error) {
        failures.push(error)
      }
      try {
        if (working.sha256 !== original.sha256
          || (working.mode & 0o777) !== (publication.before.working.mode & 0o777)) {
          await replaceRegularFile(paths.workingPath, original.bytes, publication.before.working.mode)
        }
      } catch (error) {
        failures.push(error)
      }
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          `document '${publication.documentId}' interrupted publication rollback did not converge`,
        )
      }
      outcome = 'rolled-back'
    } else {
      throw this.recoveryError(
        publication,
        `document head is '${document.headCommitId ?? '<none>'}', expected '${publication.before.document.headCommitId ?? '<none>'}' or '${publication.commit.id}'`,
      )
    }
    await repository.deleteCommitPublication(publication.documentId)
    return outcome
  }

  private async ensurePublicationCommit(publication: DocumentCommitPublication): Promise<void> {
    const repository = this.dependencies.paperRepository
    const retained = repository.getCommit(publication.commit.id)
    if (retained === undefined) {
      await repository.putCommit(cloneCommit(publication.commit))
      return
    }
    if (!isDeepStrictEqual(retained, publication.commit)) {
      throw this.recoveryError(publication, `commit '${publication.commit.id}' has conflicting durable content`)
    }
  }

  private assertPublicationRecord(publication: DocumentCommitPublication): void {
    const { before, after, commit, documentId } = publication
    if (before.document.id !== documentId
      || after.document.id !== documentId
      || commit.documentId !== documentId
      || commit.parentId !== before.document.headCommitId
      || after.document.headCommitId !== commit.id
      || before.document.workingPath !== after.document.workingPath
      || before.document.nodeCount !== before.nodes.length
      || after.document.nodeCount !== after.nodes.length) {
      throw this.recoveryError(publication, 'journal relationships are inconsistent')
    }
    if (before.nodes.some(node => node.documentId !== documentId)
      || after.nodes.some(node => node.documentId !== documentId || node.lastCommitId !== commit.id)) {
      throw this.recoveryError(publication, 'journal node ownership is inconsistent')
    }
  }

  private assertRecoverableIndex(
    publication: DocumentCommitPublication,
    actualNodes: readonly DocumentNode[],
  ): void {
    const before = new Map(publication.before.nodes.map(node => [node.id, node]))
    const after = new Map(publication.after.nodes.map(node => [node.id, node]))
    for (const node of actualNodes) {
      const oldNode = before.get(node.id)
      const newNode = after.get(node.id)
      if ((oldNode === undefined || !isDeepStrictEqual(node, oldNode))
        && (newNode === undefined || !isDeepStrictEqual(node, newNode))) {
        throw this.recoveryError(
          publication,
          `node '${node.id}' contains data outside the interrupted publication`,
        )
      }
    }
  }

  private recoveryError(publication: DocumentCommitPublication, detail: string): PaperCommitError {
    return new PaperCommitError(
      'RECOVERY_FAILED',
      `document '${publication.documentId}' commit '${publication.commit.id}' recovery failed: ${detail}; journal retained`,
    )
  }

  private async replaceIndex(
    currentNodes: readonly DocumentNode[],
    nextNodes: readonly DocumentNode[],
  ): Promise<void> {
    const repository = this.dependencies.paperRepository
    const nextIds = new Set(nextNodes.map(node => node.id))
    for (const node of nextNodes) await repository.putNode(structuredClone(node))
    for (const node of currentNodes) {
      if (!nextIds.has(node.id)) await repository.deleteNode(node.id)
    }
  }

  private reachableHistory(document: DocumentRecord): DocumentCommit[] {
    const history: DocumentCommit[] = []
    const visited = new Set<DocumentCommitIdType>()
    let commitId = document.headCommitId
    while (commitId !== undefined) {
      if (visited.has(commitId)) {
        throw new PaperCommitError('COMMIT_NOT_FOUND', `document '${document.id}' commit history contains a cycle`)
      }
      visited.add(commitId)
      const commit = this.dependencies.paperRepository.getCommit(commitId)
      if (commit === undefined || commit.documentId !== document.id) {
        throw new PaperCommitError(
          'COMMIT_NOT_FOUND',
          `document '${document.id}' head chain references missing commit '${commitId}'`,
        )
      }
      history.push(commit)
      commitId = commit.parentId
    }
    return history
  }
}

export default PaperCommitService
