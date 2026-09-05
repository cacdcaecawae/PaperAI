/** Transport-safe values shared by the PaperAI Host workbench and DSH client. */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type {} from '@deepseek-ai/cordis'

type SessionId = Branded<'SessionId'>
type WorkspaceId = Branded<'WorkspaceId'>

export type { ProjectIntegrityReport as PaperAIProjectIntegrityReport, WorkingRecoveryPlan as PaperAIWorkingRecoveryPlan } from '@paperai/commit-service/doctor-types'

/** Project and exact recovery plan observed by a prior read-only scan. */
export interface PaperAIRecoverWorkingRequest {
  readonly workspaceId: WorkspaceId
  readonly plan: import('@paperai/commit-service/doctor-types').WorkingRecoveryPlan
}

export type { AcpDiagnostic as PaperAIAgentDiagnostic } from '@paperai/agent-acp/diagnostic-types'

/** An explicit prompt-free diagnostic request for one configured peer Agent. */
export interface PaperAIProbeAgentRequest {
  readonly provider: 'codex' | 'claude'
  readonly force: boolean
}

/** Opaque id for one openable document row in the PaperAI project sidebar. */
export type PaperAIResourceId = Branded<'PaperAI.ResourceId'>
/** Opaque identity of an authoritative Working DOCX. */
export type PaperAIDocumentId = Branded<'PaperAI.DocumentId'>
/** Opaque identity of one stable semantic node in a Working DOCX. */
export type PaperAIDocumentNodeId = Branded<'PaperAI.DocumentNodeId'>
/** Opaque identity of one recoverable Working DOCX commit. */
export type PaperAIDocumentCommitId = Branded<'PaperAI.DocumentCommitId'>
/** Opaque Host projection revision used for optimistic concurrency. */
export type PaperAIDocumentRevision = Branded<'PaperAI.DocumentRevision'>
/** Opaque identity of one template-gate finding. */
export type PaperAIGateFindingId = Branded<'PaperAI.GateFindingId'>

/** JSON-safe notice for one durably published Working document head. */
export interface PaperAIDocumentChangedEvent {
  readonly documentId: PaperAIDocumentId
  readonly headCommitId: PaperAIDocumentCommitId
  readonly updatedAt: string
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * A Working document head was durably stored after its commit.
     * @param change - JSON-safe document id, committed head id, and update time.
     * @mode emit
     */
    'paperai/document-changed'(change: PaperAIDocumentChangedEvent): void
  }
}

/** A document's place in the thesis process; it decides which format of a template set applies. */
export type PaperAIDocumentType = 'manuscript' | 'proposal' | 'midterm' | 'final' | 'other'

/** How a Word format contributes to generated academic content. */
export type PaperAITemplateUsage = 'form-template' | 'format-reference'

/** Where a template set comes from. */
export type PaperAITemplateSetKind = 'built-in' | 'custom'

/** One Word format inside a template set, applying to one document type. */
export interface PaperAIFormatChoice {
  readonly memberId: string
  readonly documentType: PaperAIDocumentType
  readonly name: string
  readonly usage: PaperAITemplateUsage
  readonly sourceVersion: string
  readonly originalFileName: string
}

/** One template set: a school's (or the user's) formats, one per document type. */
export interface PaperAITemplateSetChoice {
  readonly packId: string
  readonly kind: PaperAITemplateSetKind
  readonly name: string
  readonly description: string
  readonly formats: readonly PaperAIFormatChoice[]
}

/** One tracked Word document listed in the project sidebar. */
export interface PaperAIDocumentRow {
  readonly id: PaperAIResourceId
  readonly documentId: PaperAIDocumentId
  readonly name: string
  readonly fileName: string
  readonly documentType: PaperAIDocumentType
  /** Display name of the bound format, or `null` while the document writes freely. */
  readonly templateName: string | null
  readonly updatedAt: string
}

/** Everything the sidebar and the project start page show for one project. */
export interface PaperAIProjectOverview {
  readonly workspaceId: WorkspaceId
  readonly projectName: string
  /** Whether the user has decided the project's template set (including "none"). */
  readonly templateDecided: boolean
  /** Chosen set id, retained if that set is deleted; `null` for none or undecided. */
  readonly templatePackId: string | null
  /** The chosen template set, or `null` while undecided, chosen as none, or no longer available. */
  readonly template: PaperAITemplateSetChoice | null
  readonly documents: readonly PaperAIDocumentRow[]
}

/** Every template set the user can choose from: built-in packs and custom sets, empty ones included. */
export interface PaperAITemplateLibrary {
  readonly sets: readonly PaperAITemplateSetChoice[]
}

/** Request for one Workspace's project overview. */
export interface PaperAIOverviewRequest {
  readonly workspaceId: WorkspaceId
}

/** Record the project's template set; `null` chooses to write without a template. */
export interface PaperAISetProjectTemplateRequest {
  readonly workspaceId: WorkspaceId
  readonly packId: string | null
}

/** Create an empty custom template set. */
export interface PaperAICreateTemplateSetRequest {
  readonly name: string
  readonly description?: string
}

/** Remove a custom template set from the library. */
export interface PaperAIDeleteTemplateSetRequest {
  readonly packId: string
}

/** Add or replace the format for one document type in a custom set. */
export interface PaperAIAddTemplateFormatRequest {
  readonly packId: string
  readonly documentType: PaperAIDocumentType
  readonly usage: PaperAITemplateUsage
  readonly name?: string
  readonly fileName: string
  readonly contentBase64: string
}

/** Remove the format for one document type from a custom set. */
export interface PaperAIRemoveTemplateFormatRequest {
  readonly packId: string
  readonly documentType: PaperAIDocumentType
}

/** Semantic kind projected from the authoritative Working DOCX node index. */
export type PaperAIDocumentNodeKind =
  | 'paragraph'
  | 'heading'
  | 'table'
  | 'table-cell'
  | 'field'
  | 'unknown'

/** One block of the document; only Host-marked editable nodes can request an edit buffer. */
export interface PaperAIDocumentNodeSummary {
  readonly nodeId: PaperAIDocumentNodeId
  readonly kind: PaperAIDocumentNodeKind
  readonly label: string
  readonly depth: number
  readonly editable: boolean
  /** Current plain text, the block editor's starting value. */
  readonly text: string
}

/** Temporary plain-text content for exactly one selected semantic node. */
export interface PaperAISelectedNodeBuffer {
  readonly documentId: PaperAIDocumentId
  readonly nodeId: PaperAIDocumentNodeId
  readonly label: string
  readonly kind: PaperAIDocumentNodeKind
  readonly baseRevision: PaperAIDocumentRevision
  readonly baseCommitId: PaperAIDocumentCommitId | null
  readonly format: 'text'
  readonly text: string
}

/** Replace the text of exactly one semantic node. */
export interface PaperAIReplaceTextMutation {
  readonly type: 'replace-text'
  readonly nodeId: PaperAIDocumentNodeId
  readonly baseText: string
  readonly nextText: string
}

/** Only node-addressed text mutations are admitted by the browser workbench. */
export type PaperAIDocumentMutation = PaperAIReplaceTextMutation

/** Human, Agent, or system provenance attached to one durable version. */
export interface PaperAIVersionActor {
  readonly kind: 'human' | 'agent' | 'system'
  readonly name: string
  readonly client?: string
  readonly provider?: string
  readonly model?: string
}

/** One durable Working DOCX commit projected into the version list. */
export interface PaperAIDocumentVersion {
  readonly commitId: PaperAIDocumentCommitId
  readonly parentCommitId: PaperAIDocumentCommitId | null
  readonly revision: PaperAIDocumentRevision
  readonly createdAt: string
  readonly summary: string
  readonly actor: PaperAIVersionActor
  readonly restorable: boolean
}

/** Gate severity displayed beside one template requirement. */
export type PaperAIGateSeverity = 'error' | 'warning' | 'info'

/** One requirement the bound format imposes on the document. */
export interface PaperAITemplateRequirement {
  readonly ruleId: string
  readonly kind: string
  readonly label: string
  readonly description: string
  readonly severity: PaperAIGateSeverity
  readonly enabled: boolean
}

/** The format bound to one document, with the template set it came from. */
export interface PaperAITemplateSummary {
  readonly templateId: string
  readonly name: string
  readonly kind: PaperAITemplateSetKind
  readonly packId?: string
  readonly packName?: string
  readonly memberId?: string
  readonly sourceVersion?: string
  readonly usage: PaperAITemplateUsage
  readonly requirements: readonly PaperAITemplateRequirement[]
}

/** One requirement result from the latest template-gate run. */
export interface PaperAIGateFinding {
  readonly id: PaperAIGateFindingId
  readonly severity: PaperAIGateSeverity
  readonly title: string
  readonly message: string
  readonly location?: string
  readonly passed: boolean
}

/** Latest delivery-gate report projected for one document revision. */
export interface PaperAITemplateGateReport {
  readonly status: 'not-run' | 'passed' | 'failed'
  readonly checkedAt?: string
  readonly findings: readonly PaperAIGateFinding[]
}

/** Read-only projection of one authoritative Working DOCX. */
export interface PaperAIDocumentSnapshot {
  readonly documentId: PaperAIDocumentId
  readonly resourceId: PaperAIResourceId
  readonly workspaceId: WorkspaceId
  readonly sessionId: SessionId
  readonly title: string
  readonly documentType: PaperAIDocumentType
  readonly path: string
  readonly revision: PaperAIDocumentRevision
  readonly headCommitId: PaperAIDocumentCommitId | null
  /** Derived document preview; never accepted as an edit source. */
  readonly previewHtml: string
  readonly nodes: readonly PaperAIDocumentNodeSummary[]
  readonly versions: readonly PaperAIDocumentVersion[]
  readonly template: PaperAITemplateSummary | null
  /** The project's template set has a format for this document type. */
  readonly projectFormatAvailable: boolean
  readonly gate: PaperAITemplateGateReport
}

/** Result of opening a Working DOCX and its optional initial node buffer. */
export interface PaperAIDocumentOpenResult {
  readonly document: PaperAIDocumentSnapshot
  readonly selectedNode: PaperAISelectedNodeBuffer | null
}

/** Result of applying node mutations and creating one recoverable commit. */
export interface PaperAIDocumentCommitResult extends PaperAIDocumentOpenResult {
  readonly createdCommitId: PaperAIDocumentCommitId
}

/** Result of validating one unchanged Working DOCX revision. */
export interface PaperAIValidateResult {
  readonly documentId: PaperAIDocumentId
  readonly revision: PaperAIDocumentRevision
  readonly headCommitId: PaperAIDocumentCommitId | null
  readonly gate: PaperAITemplateGateReport
}

/** Request to open one project document in a DSH Session. */
export interface PaperAIOpenDocumentRequest {
  readonly workspaceId: WorkspaceId
  readonly sessionId: SessionId
  readonly resourceId: PaperAIResourceId
}

/** Request for a fresh temporary buffer of one semantic node. */
export interface PaperAIReadNodeRequest {
  readonly sessionId: SessionId
  readonly documentId: PaperAIDocumentId
  readonly nodeId: PaperAIDocumentNodeId
  readonly revision: PaperAIDocumentRevision
  readonly headCommitId: PaperAIDocumentCommitId | null
}

/** Optimistic node-mutation request that must create one durable version. */
export interface PaperAICommitDocumentRequest {
  readonly sessionId: SessionId
  readonly documentId: PaperAIDocumentId
  readonly baseRevision: PaperAIDocumentRevision
  readonly baseCommitId: PaperAIDocumentCommitId | null
  readonly mutations: readonly PaperAIDocumentMutation[]
}

/** Request to run the template gate without changing document content. */
export interface PaperAIValidateDocumentRequest {
  readonly sessionId: SessionId
  readonly documentId: PaperAIDocumentId
  readonly revision: PaperAIDocumentRevision
  readonly headCommitId: PaperAIDocumentCommitId | null
}

/** Request to create a new version by restoring an earlier commit. */
export interface PaperAIRestoreDocumentRequest {
  readonly sessionId: SessionId
  readonly documentId: PaperAIDocumentId
  readonly baseRevision: PaperAIDocumentRevision
  readonly baseCommitId: PaperAIDocumentCommitId | null
  readonly targetCommitId: PaperAIDocumentCommitId
}

/** Browser Word upload that Host stages before immutable document import. */
export interface PaperAIWordUpload {
  readonly fileName: string
  readonly contentBase64: string
}

/** Import a Word file as a free-writing document: no template, type decided later. */
export interface PaperAIImportDocumentRequest {
  readonly workspaceId: WorkspaceId
  readonly sessionId: SessionId
  readonly fileName: string
  readonly contentBase64: string
  readonly name?: string
}

/** Successful import or an explicit native-engine downgrade. */
export type PaperAIImportDocumentResult =
  | {
    readonly status: 'imported'
    readonly opened: PaperAIDocumentOpenResult
    readonly createdCommitId: PaperAIDocumentCommitId
  }
  | {
    readonly status: 'degraded'
    readonly capability: 'document-engine' | 'legacy-doc-normalization'
    readonly detail: string
  }

/**
 * Start one document of a given type from the project's template set. A form
 * template becomes the document itself; a formatting reference requires the
 * manuscript `upload` it should govern. The format is bound in the root commit.
 */
export interface PaperAICreateFromTemplateRequest {
  readonly workspaceId: WorkspaceId
  readonly sessionId: SessionId
  readonly documentType: PaperAIDocumentType
  readonly upload?: PaperAIWordUpload
  /** Defaults to the format's display name. */
  readonly name?: string
}

/** Bind the project template's format for a document type through a commit. */
export interface PaperAIApplyTemplateRequest {
  readonly sessionId: SessionId
  readonly documentId: PaperAIDocumentId
  readonly baseRevision: PaperAIDocumentRevision
  readonly baseCommitId: PaperAIDocumentCommitId | null
  readonly documentType: PaperAIDocumentType
}

/** Drop the bound format through a commit; the document keeps its type. */
export interface PaperAIDetachTemplateRequest {
  readonly sessionId: SessionId
  readonly documentId: PaperAIDocumentId
  readonly baseRevision: PaperAIDocumentRevision
  readonly baseCommitId: PaperAIDocumentCommitId | null
}

/** Ask the Host to guess a document's type from its title and opening text. */
export interface PaperAISuggestDocumentTypeRequest {
  readonly documentId: PaperAIDocumentId
}

/** The Host's guess and what it was based on. */
export interface PaperAIDocumentTypeSuggestion {
  readonly documentId: PaperAIDocumentId
  readonly documentType: PaperAIDocumentType
  readonly basis: 'title' | 'content' | 'current'
}

/** Request the text changes one version introduced over its parent. */
export interface PaperAIDiffVersionRequest {
  readonly documentId: PaperAIDocumentId
  readonly commitId: PaperAIDocumentCommitId
}

/** One paragraph-level change between two versions. */
export interface PaperAIVersionChange {
  readonly kind: 'added' | 'removed' | 'changed'
  readonly before?: string
  readonly after?: string
}

/** Paragraph-level diff of one version against its parent. */
export interface PaperAIVersionDiff {
  readonly documentId: PaperAIDocumentId
  readonly commitId: PaperAIDocumentCommitId
  readonly parentCommitId: PaperAIDocumentCommitId | null
  readonly changes: readonly PaperAIVersionChange[]
  /** Paragraphs that did not change; lets the reader judge the scale of an edit. */
  readonly unchangedCount: number
}

/** User-facing export mode: draft remains available, delivery runs the gate. */
export type PaperAIExportMode = 'draft-export' | 'delivery-export'

/** Export the exact observed document revision into its project output folder. */
export interface PaperAIExportDocumentRequest {
  readonly sessionId: SessionId
  readonly documentId: PaperAIDocumentId
  readonly baseRevision: PaperAIDocumentRevision
  readonly baseCommitId: PaperAIDocumentCommitId | null
  readonly mode: PaperAIExportMode
  readonly fileName?: string
}

/** Completed export together with the new milestone-backed workbench state. */
export interface PaperAIExportSuccessResult extends PaperAIDocumentCommitResult {
  readonly status: 'success'
  readonly outputPath: string
  readonly fileName: string
  readonly gate: PaperAITemplateGateReport
}

/** Delivery rejection that creates neither an output nor an export milestone. */
export interface PaperAIExportBlockedResult {
  readonly status: 'blocked'
  readonly documentId: PaperAIDocumentId
  readonly revision: PaperAIDocumentRevision
  readonly headCommitId: PaperAIDocumentCommitId | null
  readonly fileName: string
  readonly gate: PaperAITemplateGateReport
}

/** Explicit export completion or projectable delivery-gate rejection. */
export type PaperAIExportDocumentResult = PaperAIExportSuccessResult | PaperAIExportBlockedResult
