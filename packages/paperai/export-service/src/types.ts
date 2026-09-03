/** Type-only requests and results for checked PaperAI DOCX exports. */

import type {
  ActorIdentity,
  DocumentCommit,
  DocumentRecord,
  GateMode,
  GateReport,
} from '@paperai/domain'

/** Export modes that produce a DOCX outside the authoritative Working copy. */
export type PaperExportMode = Extract<GateMode, 'draft-export' | 'delivery-export'>

/** Host or MCP request to publish one checked immutable commit snapshot. */
export interface ExportDocumentRequest {
  /** Document state observed before the export milestone is submitted. */
  readonly document: DocumentRecord
  /** Absolute `.docx` path selected by the caller. */
  readonly destinationPath: string
  /**
   * Directory the published file must resolve inside, checked on real paths
   * at publish time so a link under it cannot carry the file elsewhere;
   * absent leaves the destination unconfined.
   */
  readonly writableRoot?: string
  /** Draft exports retain findings; delivery exports reject blocking errors. */
  readonly mode: PaperExportMode
  /** Human or Agent provenance retained by the export milestone commit. */
  readonly actor: Readonly<ActorIdentity>
  /** A caller-side report may accompany MCP requests; the service checks again. */
  readonly gate?: GateReport
  /** Cancellation is admitted until the milestone publication begins. */
  readonly signal?: AbortSignal
}

/** Completed export and the exact report and version that produced its bytes. */
export interface ExportDocumentResult {
  /** Canonical absolute path of the published DOCX. */
  readonly outputPath: string
  /** Fresh report evaluated immediately before the milestone commit. */
  readonly report: GateReport
  /** Alias required by the current PaperAI MCP export-adapter response. */
  readonly gate: GateReport
  /** Recoverable milestone whose immutable snapshot supplied the output bytes. */
  readonly commit: DocumentCommit
}

/** Stable failures raised by `ctx.paperExports`. */
export type PaperExportErrorCode =
  | 'DELIVERY_BLOCKED'
  | 'DESTINATION_EXISTS'
  | 'DESTINATION_INVALID'
  | 'DESTINATION_OUTSIDE_WORKSPACE'
  | 'DESTINATION_PROTECTED'
  | 'EXPORT_TOO_LARGE'
  | 'SNAPSHOT_CORRUPT'
