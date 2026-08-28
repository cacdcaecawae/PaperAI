/** Transport-safe values shared by the PaperAI Host workbench and DSH client. */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type {} from '@deepseek-ai/cordis'

type SessionId = Branded<'SessionId'>
type WorkspaceId = Branded<'WorkspaceId'>

/** Opaque id for one row in the PaperAI project tree. */
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

/** Domain and real filesystem groups rendered below an expanded DSH Workspace. */
export type PaperAIResourceCategory = 'document' | 'template' | 'image' | 'experiment' | 'code'
/** Filesystem-like presentation kind for one projected resource. */
export type PaperAIResourceKind = 'file' | 'folder'
/** Optional Working state projected beside one resource row. */
export type PaperAIResourceStatus = 'clean' | 'modified' | 'pending' | 'blocked'

/** One flat Host-projected project resource. */
export interface PaperAIResourceRow {
  readonly id: PaperAIResourceId
  readonly category: PaperAIResourceCategory
  readonly kind: PaperAIResourceKind
  readonly name: string
  readonly path: string
  readonly depth: number
  readonly openable: boolean
  readonly status?: PaperAIResourceStatus
}

/** Host result for one Workspace resource listing. */
export interface PaperAIResourceList {
  readonly workspaceId: WorkspaceId
  readonly resources: readonly PaperAIResourceRow[]
}

/** Semantic kind projected from the authoritative Working DOCX node index. */
export type PaperAIDocumentNodeKind =
  | 'paragraph'
  | 'heading'
  | 'table'
  | 'table-cell'
  | 'field'
  | 'unknown'

/** One outline row; only Host-marked editable nodes can request an edit buffer. */
export interface PaperAIDocumentNodeSummary {
  readonly nodeId: PaperAIDocumentNodeId
  readonly kind: PaperAIDocumentNodeKind
  readonly label: string
  readonly depth: number
  readonly editable: boolean
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

/** Only node-addressed text mutations are admitted by the v1 workbench. */
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

/** Source and display metadata for the template linked to one document. */
export interface PaperAITemplateSummary {
  readonly templateId: string
  readonly name: string
  readonly source: 'built-in' | 'uploaded'
  readonly version?: string
}

/** Gate severity displayed beside one template requirement. */
export type PaperAIGateSeverity = 'error' | 'warning' | 'info'

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
  readonly role: PaperAIDocumentRole
  readonly path: string
  readonly revision: PaperAIDocumentRevision
  readonly headCommitId: PaperAIDocumentCommitId | null
  /** Derived document preview; never accepted as an edit source. */
  readonly previewHtml: string
  readonly nodes: readonly PaperAIDocumentNodeSummary[]
  readonly versions: readonly PaperAIDocumentVersion[]
  readonly template: PaperAITemplateSummary | null
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

/** Request for one Workspace's project resources. */
export interface PaperAIListResourcesRequest {
  readonly workspaceId: WorkspaceId
}

/** Request to open one project resource in a DSH Session. */
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

/** Academic document role selected during Word import. */
export type PaperAIDocumentRole = 'manuscript' | 'proposal' | 'midterm' | 'final' | 'other'

/** Browser upload that Host stages before immutable document import. */
export interface PaperAIImportDocumentRequest {
  readonly workspaceId: WorkspaceId
  readonly sessionId: SessionId
  readonly fileName: string
  readonly contentBase64: string
  readonly role: PaperAIDocumentRole
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

/** How a Word template contributes to generated academic content. */
export type PaperAITemplateUsage = 'form-template' | 'format-reference'

/** One selectable member of a built-in institutional template pack. */
export interface PaperAITemplatePackMemberChoice {
  readonly memberId: string
  readonly name: string
  readonly description: string
  readonly appliesToRoles: readonly PaperAIDocumentRole[]
  readonly usage: PaperAITemplateUsage
  readonly originalFileName: string
}

/** One registered institutional template pack. */
export interface PaperAITemplatePackChoice {
  readonly packId: string
  readonly name: string
  readonly description: string
  readonly version: string
  readonly members: readonly PaperAITemplatePackMemberChoice[]
}

/** One installed, reviewable template contract. */
export interface PaperAITemplateContractChoice {
  readonly templateId: string
  readonly name: string
  readonly status: 'draft' | 'confirmed'
  readonly source: 'built-in' | 'uploaded'
  readonly appliesToRoles: readonly PaperAIDocumentRole[]
  readonly usage: PaperAITemplateUsage
  readonly ruleCount: number
  readonly slotCount: number
  readonly originPackId?: string
  readonly originMemberId?: string
  readonly requirements: readonly PaperAITemplateRequirementChoice[]
}

/** Reviewable requirement extracted from one Word template contract. */
export interface PaperAITemplateRequirementChoice {
  readonly ruleId: string
  readonly kind: string
  readonly label: string
  readonly description: string
  readonly severity: PaperAIGateSeverity
  readonly confidence: number
  readonly enabled: boolean
}

/** Complete template choices for one PaperAI project. */
export interface PaperAITemplateCatalog {
  readonly workspaceId: WorkspaceId
  readonly packs: readonly PaperAITemplatePackChoice[]
  readonly contracts: readonly PaperAITemplateContractChoice[]
}

/** Request the built-in and installed template choices for a Workspace. */
export interface PaperAIListTemplatesRequest {
  readonly workspaceId: WorkspaceId
}

/** Install one or more members from a built-in pack as reviewable drafts. */
export interface PaperAIInstallTemplatePackRequest {
  readonly workspaceId: WorkspaceId
  readonly packId: string
  readonly memberIds?: readonly string[]
}

/** Upload a custom Word template as a reviewable draft contract. */
export interface PaperAIUploadTemplateRequest {
  readonly workspaceId: WorkspaceId
  readonly fileName: string
  readonly contentBase64: string
  readonly name: string
  readonly appliesToRoles: readonly PaperAIDocumentRole[]
  readonly usage: PaperAITemplateUsage
}

/** Confirm the parsed rules of one installed or uploaded contract. */
export interface PaperAIConfirmTemplateRequest {
  readonly workspaceId: WorkspaceId
  readonly templateId: string
}

/** Attach one confirmed, role-compatible contract through a document commit. */
export interface PaperAIAssociateTemplateRequest {
  readonly sessionId: SessionId
  readonly documentId: PaperAIDocumentId
  readonly baseRevision: PaperAIDocumentRevision
  readonly baseCommitId: PaperAIDocumentCommitId | null
  readonly templateId: string
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
