/** Type-only requests and peer interfaces for PaperAI document commits. */

import type {
  ActorIdentity,
  DocumentCommit,
  DocumentCommitId,
  DocumentId,
  DocumentMutation,
  DocumentNode,
  DocumentRecord,
  GateMode,
  GateReport,
  TemplateContractId,
} from '@paperai/domain'

/** Input supplied to the document service when a candidate index is rebuilt. */
export interface DocumentIndexRebuildRequest {
  /** Durable document identity. */
  readonly document: DocumentRecord
  /** Temporary candidate DOCX; the authoritative Working DOCX is unchanged. */
  readonly candidatePath: string
  /** Commit identity stamped on every rebuilt node. */
  readonly commitId: DocumentCommitId
  /** Current stable nodes used to preserve semantic identities where possible. */
  readonly currentNodes: readonly DocumentNode[]
  /** Caller cancellation remains effective until publication starts. */
  readonly signal?: AbortSignal
}

/** Minimal document-service dependency consumed by the commit service. */
export interface PaperDocumentIndexPeer {
  /** Read the current stable node index for one document. */
  readNodes(documentId: DocumentId): readonly DocumentNode[] | Promise<readonly DocumentNode[]>
  /** Build, but do not publish, the node index for one candidate DOCX. */
  buildCandidateIndex(request: DocumentIndexRebuildRequest): Promise<readonly DocumentNode[]>
}

/** Template checks consumed by the commit service without owning template state. */
export interface PaperTemplateCommitPeer {
  /** Reject missing, draft, cross-project, role-incompatible, or evidence-only bindings. */
  validateAssociation(input: {
    readonly documentId: DocumentId
    readonly templateId: TemplateContractId
  }): DocumentRecord
  /** Run a real gate over an unpublished DOCX candidate. */
  checkCandidate(input: {
    readonly document: DocumentRecord
    readonly candidatePath: string
    readonly templateId?: TemplateContractId
    readonly mode: GateMode
  }, signal?: AbortSignal): Promise<GateReport>
}

/** Human or Agent request to mutate one Working DOCX and create a commit. */
export interface SubmitDocumentCommitRequest {
  /** Document whose Working DOCX will be changed. */
  readonly documentId: DocumentId
  /** Head observed by the editor; omission represents an unborn history. */
  readonly baseCommitId?: DocumentCommitId
  /** User-visible version message. */
  readonly message: string
  /** Human or Agent identity retained without inference. */
  readonly actor: Readonly<ActorIdentity>
  /** Ordered domain mutations compiled against the current node index. */
  readonly mutations: readonly DocumentMutation[]
  /** Cancellation is admitted until durable publication starts. */
  readonly signal?: AbortSignal
}

/** Request to restore one reachable snapshot as a new child commit. */
export interface RevertDocumentCommitRequest {
  /** Document whose Working DOCX will receive the historical snapshot. */
  readonly documentId: DocumentId
  /** Current head observed by the caller. */
  readonly baseCommitId: DocumentCommitId
  /** Reachable historical commit whose bytes will be restored. */
  readonly targetCommitId: DocumentCommitId
  /** User-visible version message; a deterministic target message is used when omitted. */
  readonly message?: string
  /** Human or Agent identity retained on the new revert commit. */
  readonly actor: Readonly<ActorIdentity>
  /** Cancellation is admitted until durable publication starts. */
  readonly signal?: AbortSignal
}

/** Stable error codes returned by `ctx.paperCommits`. */
export type PaperCommitErrorCode =
  | 'COMMIT_NOT_FOUND'
  | 'DOCUMENT_NOT_FOUND'
  | 'DOCUMENT_NOT_WORKING'
  | 'HEAD_CONFLICT'
  | 'INDEX_INVALID'
  | 'INVALID_PROVENANCE'
  | 'INVALID_REQUEST'
  | 'NODE_NOT_FOUND'
  | 'NODE_TEXT_CONFLICT'
  | 'PROJECT_NOT_FOUND'
  | 'RECOVERY_FAILED'
  | 'SNAPSHOT_CORRUPT'
  | 'UNSUPPORTED_MUTATION'
  | 'VALIDATION_FAILED'
  | 'WORKING_COPY_CHANGED'

/** Reachable commit history ordered from current head toward the root. */
export type DocumentCommitHistory = readonly DocumentCommit[]
