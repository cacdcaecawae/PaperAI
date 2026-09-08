/** Transport-safe project integrity observations and recovery candidates. */

import type { DocumentCommitId, DocumentId } from '@paperai/domain'

/** One observed project problem; paths identify the affected local artifact. */
export interface ProjectIntegrityIssue {
  readonly documentId: DocumentId
  readonly code: 'missing-source' | 'source-changed' | 'missing-working' | 'working-changed' | 'invalid-head' | 'invalid-snapshot' | 'duplicate-path' | 'unsafe-path' | 'unreadable-file'
  readonly path: string
  readonly detail: string
}

/** A missing Working DOCX can be materialized only from this exact verified head. */
export interface WorkingRecoveryPlan {
  readonly documentId: DocumentId
  readonly headCommitId: DocumentCommitId
  readonly sha256: string
  readonly workingPath: string
}

/** Immutable observation; repairs are separate explicit operations. */
export interface ProjectIntegrityReport {
  readonly checkedAt: string
  readonly documents: number
  readonly issues: readonly ProjectIntegrityIssue[]
  readonly repairs: readonly WorkingRecoveryPlan[]
}
