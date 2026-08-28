/**
 * PaperAI repository (`ctx.paperRepository`) over the DSH domain data form.
 * The product profile routes the `paperai` domain to the SQLite backend.
 * @module @paperai/repository
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import type {
  ChangeConflict,
  ChangeConflictId,
  DocumentCommit,
  DocumentCommitId,
  DocumentId,
  DocumentNode,
  DocumentNodeId,
  DocumentRecord,
  ProjectId,
  ProjectRecord,
  TemplateContract,
  TemplateContractId,
} from '@paperai/domain'
import { paperaiDomainSpec } from './spec.ts'
import type { DocumentCommitPublication } from './spec.ts'

export { paperaiDomainSpec } from './spec.ts'
export type { CommitPublicationWorkingImage, DocumentCommitPublication } from './spec.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    paperRepository: PaperRepository
  }
}

/**
 * Typed repository with synchronous reads and durable queued writes. Returned
 * records are retained storage values and must be replaced rather than mutated;
 * calls outside the initialized service lifetime fail and writes propagate storage errors.
 */
export class PaperRepository extends Service {
  static inject = ['storageDomain']

  private domain: Domain<typeof paperaiDomainSpec> | undefined

  constructor(ctx: Context) {
    super(ctx, 'paperRepository')
  }

  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(paperaiDomainSpec)
    this.domain = domain
    this.ctx.effect(() => async () => {
      await domain.close()
      this.domain = undefined
    }, 'paperRepository.closeDomain')
  }

  /**
   * Read one project from the in-memory domain snapshot.
   * @param id - project identity to read.
   * @returns the stored project, or `undefined` when absent.
   */
  getProject(id: ProjectId): ProjectRecord | undefined {
    return this.projects().get(id)
  }

  /**
   * List all projects from a stable domain snapshot.
   * @returns projects in repository insertion order.
   */
  listProjects(): ProjectRecord[] {
    return [...this.projects().entries()].map(([, value]) => value)
  }

  /**
   * Durably insert or replace one complete project record.
   * @param record - complete project record keyed by its identity.
   */
  putProject(record: ProjectRecord): Promise<void> {
    return this.projects().put(record.id, record)
  }

  /**
   * Read one document from the in-memory domain snapshot.
   * @param id - document identity to read.
   * @returns the stored document, or `undefined` when absent.
   */
  getDocument(id: DocumentId): DocumentRecord | undefined {
    return this.documents().get(id)
  }

  /**
   * List all documents or those owned by one project.
   * @param projectId - optional project identity used to filter the snapshot.
   * @returns matching documents in repository insertion order.
   */
  listDocuments(projectId?: ProjectId): DocumentRecord[] {
    return [...this.documents().entries()]
      .map(([, value]) => value)
      .filter(value => projectId === undefined || value.projectId === projectId)
  }

  /**
   * Durably insert or replace one complete document record.
   * @param record - complete document record keyed by its identity.
   */
  putDocument(record: DocumentRecord): Promise<void> {
    return this.documents().put(record.id, record)
  }

  /**
   * Atomically replace one document from the value current at its write-queue slot.
   * @param id - existing document identity to update.
   * @param update - synchronous transform from the current record to its replacement.
   * @returns the durably stored replacement record.
   * @throws when the document is absent at the update's queue slot.
   */
  updateDocument(id: DocumentId, update: (record: DocumentRecord) => DocumentRecord): Promise<DocumentRecord> {
    return this.documents().update(id, update)
  }

  /**
   * Durably delete one document record without cascading to related tables.
   * @param id - document identity to delete.
   * @returns `true` when a record was deleted, or `false` when it was absent.
   */
  deleteDocument(id: DocumentId): Promise<boolean> {
    return this.documents().delete(id)
  }

  /**
   * List one document's semantic nodes in document order.
   * @param documentId - owning document identity.
   * @returns matching nodes sorted by ascending ordinal.
   */
  listNodes(documentId: DocumentId): DocumentNode[] {
    return [...this.nodes().entries()]
      .map(([, value]) => value)
      .filter(value => value.documentId === documentId)
      .sort((left, right) => left.ordinal - right.ordinal)
  }

  /**
   * Durably insert or replace one complete semantic node.
   * @param record - complete node record keyed by its identity.
   */
  putNode(record: DocumentNode): Promise<void> {
    return this.nodes().put(record.id, record)
  }

  /**
   * Durably delete one semantic node when present.
   * @param id - node identity to delete.
   * @returns `true` when a record was deleted, or `false` when it was absent.
   */
  deleteNode(id: DocumentNodeId): Promise<boolean> {
    return this.nodes().delete(id)
  }

  /**
   * Read one document commit from the in-memory domain snapshot.
   * @param id - commit identity to read.
   * @returns the stored commit, or `undefined` when absent.
   */
  getCommit(id: DocumentCommitId): DocumentCommit | undefined {
    return this.commits().get(id)
  }

  /**
   * List one document's commits in chronological order.
   * @param documentId - owning document identity.
   * @returns matching commits sorted by ascending creation timestamp.
   */
  listCommits(documentId: DocumentId): DocumentCommit[] {
    return [...this.commits().entries()]
      .map(([, value]) => value)
      .filter(value => value.documentId === documentId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  }

  /**
   * Durably insert or replace one complete document commit.
   * @param record - complete commit record keyed by its identity.
   */
  putCommit(record: DocumentCommit): Promise<void> {
    return this.commits().put(record.id, record)
  }

  /**
   * Read one document's interrupted commit publication.
   * @param documentId - document identity that owns the journal slot.
   * @returns the retained publication record, or `undefined` when no recovery is pending.
   */
  getCommitPublication(documentId: DocumentId): DocumentCommitPublication | undefined {
    return this.commitPublications().get(documentId)
  }

  /**
   * List interrupted commit publications from a stable domain snapshot.
   * @returns publication records in repository insertion order.
   */
  listCommitPublications(): DocumentCommitPublication[] {
    return [...this.commitPublications().entries()].map(([, value]) => value)
  }

  /**
   * Durably insert or replace one document's commit publication intent.
   * @param record - complete write-ahead record keyed by its document identity.
   */
  putCommitPublication(record: DocumentCommitPublication): Promise<void> {
    return this.commitPublications().put(record.documentId, record)
  }

  /**
   * Durably clear one resolved commit publication.
   * @param documentId - document identity whose journal slot is resolved.
   * @returns `true` when a record was deleted, or `false` when it was already absent.
   */
  deleteCommitPublication(documentId: DocumentId): Promise<boolean> {
    return this.commitPublications().delete(documentId)
  }

  /**
   * Read one template contract from the in-memory domain snapshot.
   * @param id - template contract identity to read.
   * @returns the stored contract, or `undefined` when absent.
   */
  getTemplate(id: TemplateContractId): TemplateContract | undefined {
    return this.templates().get(id)
  }

  /**
   * List all template contracts or those owned by one project.
   * @param projectId - optional project identity used to filter the snapshot.
   * @returns matching contracts in repository insertion order.
   */
  listTemplates(projectId?: ProjectId): TemplateContract[] {
    return [...this.templates().entries()]
      .map(([, value]) => value)
      .filter(value => projectId === undefined || value.projectId === projectId)
  }

  /**
   * Durably insert or replace one complete template contract.
   * @param record - complete template contract keyed by its identity.
   */
  putTemplate(record: TemplateContract): Promise<void> {
    return this.templates().put(record.id, record)
  }

  /**
   * List unresolved or resolved conflicts recorded for one document.
   * @param documentId - owning document identity.
   * @returns matching conflicts in repository insertion order.
   */
  listConflicts(documentId: DocumentId): ChangeConflict[] {
    return [...this.conflicts().entries()]
      .map(([, value]) => value)
      .filter(value => value.documentId === documentId)
  }

  /**
   * Durably insert or replace one complete change-conflict record.
   * @param record - complete conflict record keyed by its identity.
   */
  putConflict(record: ChangeConflict): Promise<void> {
    return this.conflicts().put(record.id, record)
  }

  private requireDomain(): Domain<typeof paperaiDomainSpec> {
    if (this.domain === undefined) throw new Error('paperRepository is not initialized')
    return this.domain
  }

  private projects(): KvTable<ProjectId, ProjectRecord> {
    return this.requireDomain().table('projects')
  }

  private documents(): KvTable<DocumentId, DocumentRecord> {
    return this.requireDomain().table('documents')
  }

  private nodes(): KvTable<DocumentNodeId, DocumentNode> {
    return this.requireDomain().table('nodes')
  }

  private commits(): KvTable<DocumentCommitId, DocumentCommit> {
    return this.requireDomain().table('commits')
  }

  private commitPublications(): KvTable<DocumentId, DocumentCommitPublication> {
    return this.requireDomain().table('commit_publications')
  }

  private templates(): KvTable<TemplateContractId, TemplateContract> {
    return this.requireDomain().table('templates')
  }

  private conflicts(): KvTable<ChangeConflictId, ChangeConflict> {
    return this.requireDomain().table('conflicts')
  }
}

export default PaperRepository
