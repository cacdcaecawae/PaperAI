/** Component-side contracts for the two PaperAI slot entries. */

import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId, WorkspaceId } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  PaperAIActionResult, PaperAIDocumentCommitId, PaperAIDocumentNodeId,
  PaperAIDocumentRole, PaperAIExportMode, PaperAIResourceId,
  PaperAIResourceDirectoryState, PaperAITemplateChoicesResult, PaperAITemplateStartInput,
  PaperAITemplateUsage, PaperAIWorkbenchState, PaperAIWorkbenchTab,
} from './types.ts'

/** Operations and sources injected into each Workspace resource-tree contribution. */
export interface PaperAIWorkspaceContentInjected {
  hooks: {
    /** All Workspace resource projections; the component selects its owner id. */
    resources: HostObservable<PaperAIResourceDirectoryState>
  }
  /** Seed one cold Workspace tree. */
  ensureResources: (workspaceId: WorkspaceId) => Promise<void>
  /** Force one backed Workspace tree refresh. */
  refreshResources: (workspaceId: WorkspaceId) => Promise<void>
  /** Connect the Workspace, select its Session, and open one backed document. */
  openResource: (workspaceId: WorkspaceId, resourceId: PaperAIResourceId) => Promise<void>
  /** Connect the Workspace and import one browser-selected Word source. */
  importDocument: (workspaceId: WorkspaceId, input: {
    readonly fileName: string
    readonly contentBase64: string
    readonly role: PaperAIDocumentRole
  }) => Promise<PaperAIActionResult>
  /** Connect the Workspace and start one document from a built-in template pack member. */
  createFromTemplate: (workspaceId: WorkspaceId, input: PaperAITemplateStartInput) => Promise<PaperAIActionResult>
  /** Read the built-in template packs offered by the start flow. */
  loadTemplateChoices: (workspaceId: WorkspaceId) => Promise<PaperAITemplateChoicesResult>
}

/** Full props assembled for the Workspace content list entry. */
export type PaperAIWorkspaceContentProps =
  PropsRuntime<'sidebar.workspaces.content'>
  & InjectFace<PaperAIWorkspaceContentInjected>
  & PropsLocale<'paperai.workbench'>

/** Operations and per-session source injected into the document details entry. */
export interface PaperAIDocumentWorkbenchInjected {
  hooks: {
    /** Complete per-session workbench state. */
    workbench: HostObservable<PaperAIWorkbenchState>
  }
  /** Select one local tab. */
  selectTab: (tab: PaperAIWorkbenchTab) => void
  /** Retry the last Host open request for this Session. */
  retryOpen: () => Promise<void>
  /** Read one semantic node into a temporary edit buffer. */
  selectNode: (nodeId: PaperAIDocumentNodeId) => Promise<PaperAIActionResult>
  /** Replace the browser-local value of the selected node buffer. */
  updateDraft: (value: string) => void
  /** Reset the selected node buffer without contacting the Host. */
  discardDraft: () => void
  /** Submit one node mutation and create a durable version. */
  commitSelected: () => Promise<PaperAIActionResult>
  /** Run the current template gate. */
  validate: () => Promise<PaperAIActionResult>
  /** Refresh the built-in packs and installed template contracts. */
  loadTemplates: () => Promise<PaperAIActionResult>
  /** Install one member of a built-in template pack for review. */
  installTemplate: (packId: string, memberId: string) => Promise<PaperAIActionResult>
  /** Upload one custom Word template for the open document role. */
  uploadTemplate: (input: {
    readonly fileName: string
    readonly contentBase64: string
    readonly name: string
    readonly usage: PaperAITemplateUsage
  }) => Promise<PaperAIActionResult>
  /** Confirm the parsed requirements after review. */
  confirmTemplate: (templateId: string) => Promise<PaperAIActionResult>
  /** Bind one confirmed template through a document commit. */
  associateTemplate: (templateId: string) => Promise<PaperAIActionResult>
  /** Export an immutable draft or gate-checked formal delivery. */
  exportDocument: (mode: PaperAIExportMode) => Promise<PaperAIActionResult>
  /** Replace the current projection with a pending durable head. */
  reloadExternal: () => Promise<PaperAIActionResult>
  /** Resolve a selected-node conflict against the latest external head. */
  resolveExternalConflict: (resolution: 'local' | 'external' | 'merged') => void
  /** Restore one backed commit through a newly created version. */
  restore: (commitId: PaperAIDocumentCommitId) => Promise<PaperAIActionResult>
  /** Demand or release the layout's whole-content-area details focus. */
  setDetailsFocus: (active: boolean) => void
}

/** Full props assembled for the PaperAI details view entry. */
export type PaperAIDocumentWorkbenchProps =
  PropsRuntime<'conversation.details.view'>
  & InjectFace<PaperAIDocumentWorkbenchInjected>
  & PropsLocale<'paperai.workbench'>

/** Session-addressed injected factory result used by lifecycle tests. */
export type PaperAIDocumentWorkbenchInjection = (
  sessionId: SessionId,
) => PaperAIDocumentWorkbenchInjected
