import type {
  CapabilityHealth,
  DocumentCommitId,
  DocumentNode,
  DocumentRecord,
  DocumentRole,
  ProjectId,
} from '@paperai/domain'

/** Stable machine-readable failures raised before or after an import operation. */
export type PaperDocumentErrorCode =
  | 'PROJECT_NOT_FOUND'
  | 'PROJECT_ROOT_INVALID'
  | 'SOURCE_NOT_FOUND'
  | 'SOURCE_NOT_FILE'
  | 'SOURCE_INTEGRITY_INVALID'
  | 'SOURCE_FORMAT_UNSUPPORTED'
  | 'DOCUMENT_NAME_INVALID'
  | 'DOCUMENT_NOT_FOUND'
  | 'DOCUMENT_INDEX_INVALID'
  | 'IMPORT_ROLLBACK_FORBIDDEN'
  | 'WORKING_COPY_INVALID'

/** User request to snapshot one Word file into a PaperAI project. */
export interface ImportDocumentRequest {
  projectId: ProjectId
  sourcePath: string
  role: DocumentRole
  /** Optional display/file stem. The service removes a trailing `.doc` or `.docx`. */
  name?: string
}

/** Successful import after both files and the semantic index are durable. */
export interface ImportedDocumentResult {
  status: 'imported'
  document: DocumentRecord
  nodes: readonly DocumentNode[]
}

/** Import refusal caused by a configured engine capability rather than input data. */
export interface DegradedDocumentImport {
  status: 'degraded'
  capability: 'document-engine' | 'legacy-doc-normalization'
  health: CapabilityHealth
  detail: string
}

/** Import either publishes a complete document or reports a capability downgrade. */
export type ImportDocumentResult = ImportedDocumentResult | DegradedDocumentImport

/** Repository-backed document metadata and its ordered semantic nodes. */
export interface PaperDocumentSnapshot {
  document: DocumentRecord
  nodes: readonly DocumentNode[]
}

/** Non-publishing candidate-index request used by the document commit path. */
export interface BuildCandidateDocumentIndexRequest {
  /** Durable document metadata observed before candidate mutation. */
  readonly document: DocumentRecord
  /** Temporary DOCX whose semantic index should be projected. */
  readonly candidatePath: string
  /** Commit identity stamped on every projected node. */
  readonly commitId: DocumentCommitId
  /** Current index used to preserve semantic node identities and lineage. */
  readonly currentNodes: readonly DocumentNode[]
  /** Optional cancellation propagated to the document engine. */
  readonly signal?: AbortSignal
}

/** Result from an optional `.doc` to `.docx` engine normalizer. */
export type LegacyNormalizationResult =
  | { status: 'normalized' }
  | { status: 'degraded'; detail: string }

/** Optional engine extension used only when importing legacy binary Word files. */
export interface LegacyDocumentNormalizer {
  /**
   * Write a new DOCX to `targetDocxPath` without modifying `sourceDocPath`.
   * A degraded result must leave no usable target behind.
   */
  normalizeLegacyDocument(
    sourceDocPath: string,
    targetDocxPath: string,
    signal?: AbortSignal,
  ): Promise<LegacyNormalizationResult>
}
