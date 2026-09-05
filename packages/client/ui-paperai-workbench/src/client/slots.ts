/** Component-side contracts for the PaperAI slot entries. */

import type { HostObservable, InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId, WorkspaceId } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: the SlotMap merges of the entries this plugin occupies.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {
  PaperAIActionResult, PaperAIAddFormatInput, PaperAIDocumentCommitId, PaperAIDocumentNodeId,
  PaperAIDocumentType, PaperAIExportMode, PaperAILibraryState, PaperAIProjectDirectoryState,
  PaperAIResourceId, PaperAITemplateStartInput, PaperAIWorkbenchPanel, PaperAIWorkbenchState,
} from './types.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * The brand mark leading the project start page. Declared by this
     * plugin's start-page entry so the brand plugin can supply the same mark
     * it gives the sidebar; absent, the start page shows no mark.
     */
    'paperai.start.mark': { kind: 'single'; scope: 'root'; owner: PaperAIStartMarkOwnerProps }
  }
}

/** Owner share of the start-page mark seat. */
export interface PaperAIStartMarkOwnerProps {
  /** Requested square edge in pixels. */
  size: number
  /** Host CSS class placing the mark in the headline. */
  className?: string | undefined
}

/** Template-library sources and actions shared by every surface that shows the library. */
export interface PaperAILibraryInjected {
  hooks: {
    /** The one library projection; every surface subscribes to the same source. */
    library: HostObservable<PaperAILibraryState>
  }
  /** Read the library once, or again when `force` is set. */
  loadLibrary: (force?: boolean) => Promise<void>
  /** Create an empty custom template set. */
  createTemplateSet: (input: { readonly name: string; readonly description?: string }) => Promise<PaperAIActionResult>
  /** Remove a custom template set. */
  deleteTemplateSet: (packId: string) => Promise<PaperAIActionResult>
  /** Add or replace one format in a custom set. */
  addTemplateFormat: (input: PaperAIAddFormatInput) => Promise<PaperAIActionResult>
  /** Remove one format from a custom set. */
  removeTemplateFormat: (packId: string, documentType: PaperAIDocumentType) => Promise<PaperAIActionResult>
}

/** Operations and sources injected into the sidebar document list. */
export interface PaperAIWorkspaceContentInjected {
  /** Read project integrity, or apply an explicit recovery plan and read it again. */
  inspectProject: (workspaceId: WorkspaceId, plan?: import('./types.ts').PaperAIWorkingRecoveryPlan) => Promise<void>
  hooks: {
    /** Independent diagnostics, scoped by the sidebar's project id. */
    diagnostics: HostObservable<import('./diagnostics-controller.ts').DiagnosticsState>
    /** All project projections; the component selects its owner-supplied Workspace id. */
    projects: HostObservable<PaperAIProjectDirectoryState>
  }
  /** Load an unread project or retry its failed read. */
  ensureProject: (workspaceId: WorkspaceId) => Promise<void>
  /** Force one project refresh. */
  refreshProject: (workspaceId: WorkspaceId) => Promise<void>
  /** Connect the Workspace, select its Session, and open one tracked document. */
  openDocument: (workspaceId: WorkspaceId, resourceId: PaperAIResourceId) => Promise<void>
}

/** Full props assembled for the sidebar document list entry. */
export type PaperAIWorkspaceContentProps =
  PropsRuntime<'sidebar.workspaces.content'>
  & InjectFace<PaperAIWorkspaceContentInjected>
  & PropsLocale<'paperai.workbench'>

/** Operations and sources injected into the project start page. */
export interface PaperAIStartPageInjected extends PaperAILibraryInjected {
  hooks: PaperAILibraryInjected['hooks'] & {
    /** All project projections; the page selects the owner-supplied Workspace id. */
    projects: HostObservable<PaperAIProjectDirectoryState>
  }
  /** Load an unread project or retry its failed read. */
  ensureProject: (workspaceId: WorkspaceId) => Promise<void>
  /** Record the project's template set, or the choice of none. */
  setProjectTemplate: (workspaceId: WorkspaceId, packId: string | null) => Promise<PaperAIActionResult>
  /** Connect the Workspace and start one document of a type from the project template. */
  createFromTemplate: (workspaceId: WorkspaceId, input: PaperAITemplateStartInput) => Promise<PaperAIActionResult>
  /** Connect the Workspace and import one browser-selected Word file as a free-writing document. */
  importDocument: (workspaceId: WorkspaceId, input: {
    readonly fileName: string
    readonly contentBase64: string
  }) => Promise<PaperAIActionResult>
}

/** Full props assembled for the start-page entry occupying the blank-session headline. */
export type PaperAIStartPageProps =
  PropsRuntime<'conversation.hero.content'>
  & PropsRenderSlots<'paperai.start.mark'>
  & InjectFace<PaperAIStartPageInjected>
  & PropsLocale<'paperai.workbench'>

/** Full props assembled for the Templates settings page. */
export type PaperAITemplatesSectionProps =
  PropsRuntime<'settings.section'>
  & InjectFace<PaperAILibraryInjected>
  & PropsLocale<'paperai.workbench'>

/** Operations and sources injected into the document view. */
export interface PaperAIDocumentWorkbenchInjected extends PaperAILibraryInjected {
  /** Add a frozen Word excerpt to the Session's composer. */
  quoteSelection: (document: import('./types.ts').PaperAIDocumentSnapshot, excerpt: import('./selection-context.ts').WordExcerpt) => void
  /** Remember the active document's scroll offset. */
  setScroll: (scrollTop: number) => void
  hooks: PaperAILibraryInjected['hooks'] & {
    /** Complete per-session workbench state. */
    workbench: HostObservable<PaperAIWorkbenchState>
    /** All project projections, for the project's template set. */
    projects: HostObservable<PaperAIProjectDirectoryState>
  }
  /** Retry the last Host open request for this Session. */
  retryOpen: () => Promise<void>
  /** Open one secondary panel, or close it when it is already open. */
  showPanel: (panel: PaperAIWorkbenchPanel | null) => void
  /** Start editing one block in place. */
  selectBlock: (nodeId: PaperAIDocumentNodeId) => PaperAIActionResult
  /** Replace the block draft. */
  updateDraft: (value: string) => void
  /** Discard the block draft. */
  cancelEdit: () => void
  /** Save the block draft as one version. */
  commitEdit: () => Promise<PaperAIActionResult>
  /** Run the template gate. */
  validate: () => Promise<PaperAIActionResult>
  /** Ask the Host to guess the document type before applying the project template. */
  suggestType: () => Promise<PaperAIActionResult>
  /** Bind the project template's format for a type. */
  applyTemplate: (documentType: PaperAIDocumentType) => Promise<PaperAIActionResult>
  /** Drop the bound format. */
  detachTemplate: () => Promise<PaperAIActionResult>
  /** Record the project's template set, or the choice of none. */
  setProjectTemplate: (workspaceId: WorkspaceId, packId: string | null) => Promise<PaperAIActionResult>
  /** Show or hide one version's diff. */
  showDiff: (commitId: PaperAIDocumentCommitId) => Promise<PaperAIActionResult>
  /** Restore one version through a new version. */
  restore: (commitId: PaperAIDocumentCommitId) => Promise<PaperAIActionResult>
  /** Export an immutable draft or gate-checked formal delivery. */
  exportDocument: (mode: PaperAIExportMode) => Promise<PaperAIActionResult>
  /** Replace the current projection with a pending durable head. */
  reloadExternal: () => Promise<PaperAIActionResult>
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
