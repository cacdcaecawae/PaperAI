/** Typed failures raised by the PaperAI document commit service. */

import type { DocumentCommitId, DocumentId } from '@paperai/domain'
import type { PaperCommitErrorCode } from './types.ts'

/** Caller-visible PaperAI commit failure with a stable machine code. */
export class PaperCommitError extends Error {
  /**
   * Create a typed commit failure.
   * @param code - stable failure category.
   * @param message - actionable failure description.
   * @param options - optional native error cause.
   */
  constructor(
    readonly code: PaperCommitErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'PaperCommitError'
  }
}

/** Optimistic-concurrency failure retaining both compared heads. */
export class DocumentHeadConflictError extends PaperCommitError {
  /**
   * Create a head conflict.
   * @param documentId - document whose head changed.
   * @param expectedHead - head observed by the caller.
   * @param actualHead - head current at publication time.
   */
  constructor(
    readonly documentId: DocumentId,
    readonly expectedHead: DocumentCommitId | undefined,
    readonly actualHead: DocumentCommitId | undefined,
  ) {
    super(
      'HEAD_CONFLICT',
      `document '${documentId}' head changed: expected ${expectedHead ?? '<none>'}, actual ${actualHead ?? '<none>'}`,
    )
    this.name = 'DocumentHeadConflictError'
  }
}

/** Structural Office validation failure retaining provider evidence. */
export class DocumentValidationError extends PaperCommitError {
  /**
   * Create a validation failure.
   * @param documentId - candidate document identity.
   * @param details - structured validation evidence returned by the engine.
   */
  constructor(
    readonly documentId: DocumentId,
    readonly details: Readonly<Record<string, unknown>>,
  ) {
    super('VALIDATION_FAILED', `document '${documentId}' failed Office validation`)
    this.name = 'DocumentValidationError'
  }
}
