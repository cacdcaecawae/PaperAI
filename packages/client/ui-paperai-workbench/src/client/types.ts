/** Browser state layered over the Host-owned PaperAI workbench protocol. */

import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@paperai/workbench-service/remote'
import type {
  PaperAIDocumentNodeId, PaperAIDocumentSnapshot, PaperAIDocumentType,
  PaperAIDocumentTypeSuggestion, PaperAIExportMode, PaperAIProjectOverview, PaperAIResourceId,
  PaperAITemplateLibrary, PaperAIVersionDiff,
} from '@paperai/workbench-service/types'

export type * from '@paperai/workbench-service/types'

/** Generated Host namespace methods used by this browser workbench. */
export type PaperAIWorkbenchRemote = Pick<
  TypertClientRemote['paperaiWorkbench'],
  | 'overview'
  | 'agentDiagnostics'
  | 'probeAgent'
  | 'inspectProject'
  | 'recoverWorking'
  | 'setProjectTemplate'
  | 'listTemplateLibrary'
  | 'createTemplateSet'
  | 'deleteTemplateSet'
  | 'addTemplateFormat'
  | 'removeTemplateFormat'
  | 'importDocument'
  | 'createFromTemplate'
  | 'open'
  | 'commit'
  | 'validate'
  | 'restore'
  | 'applyTemplate'
  | 'detachTemplate'
  | 'suggestDocumentType'
  | 'diffVersion'
  | 'exportDocument'
>

/** Read phase shared by every Host-backed projection. */
export type PaperAIReadPhase = 'cold' | 'loading' | 'ready' | 'error'

/** Host-backed action currently running against one project. */
export type PaperAIProjectAction = 'starting' | 'choosing-template'

/** Browser state for one project: its overview plus the start-page gestures in flight. */
export interface PaperAIProjectState {
  phase: PaperAIReadPhase
  overview: PaperAIProjectOverview | null
  /** Document row selected in the sidebar. */
  selected: PaperAIResourceId | null
  error: string | null
  action: PaperAIProjectAction | null
  actionError: string | null
}

/** Stable React-free source for one project. */
export type PaperAIProjectStore = SnapshotStore<PaperAIProjectState>

/** Aggregate project projection bound once through the slot renderer. */
export interface PaperAIProjectDirectoryState {
  workspaces: Record<string, PaperAIProjectState>
}

/** Stable aggregate source; components select their owner-supplied Workspace id. */
export type PaperAIProjectDirectoryStore = SnapshotStore<PaperAIProjectDirectoryState>

/** Host-backed action currently changing the template library. */
export type PaperAILibraryAction = 'creating' | 'deleting' | 'adding' | 'removing'

/** Browser state for the template library shared by the settings page and the template dialog. */
export interface PaperAILibraryState {
  phase: PaperAIReadPhase
  library: PaperAITemplateLibrary | null
  error: string | null
  action: PaperAILibraryAction | null
  actionError: string | null
}

/** Stable React-free source for the template library. */
export type PaperAILibraryStore = SnapshotStore<PaperAILibraryState>

/** Main workbench projection phase. */
export type PaperAIWorkbenchPhase = 'idle' | 'loading' | 'ready' | 'error'

/** Secondary surfaces that open beside the document, one at a time. */
export type PaperAIWorkbenchPanel = 'template' | 'gate' | 'versions'

/** Host-backed action currently excluding competing document operations. */
export type PaperAIWorkbenchAction =
  | 'committing'
  | 'validating'
  | 'restoring'
  | 'applying-template'
  | 'detaching-template'
  | 'suggesting-type'
  | 'diffing'
  | 'exporting-draft'
  | 'exporting-delivery'
  | 'reloading-external'

/** The block being edited in place: its node, the text it started from, and the draft. */
export interface PaperAIBlockEdit {
  readonly nodeId: PaperAIDocumentNodeId
  readonly baseText: string
  readonly draft: string
  /** The current document changed this block; retain the draft for copying or discarding. */
  readonly conflicted?: boolean
}

/** One version's diff loaded into the versions panel. */
export interface PaperAIVersionDiffState {
  readonly commitId: PaperAIVersionDiff['commitId']
  readonly result: PaperAIVersionDiff | null
  readonly error: string | null
}

/** Last completed local export surfaced to the user. */
export interface PaperAIExportReceipt {
  readonly mode: PaperAIExportMode
  readonly fileName: string
  readonly outputPath: string
}

/** A document head observed through a notification or a reconnect read. */
export type PaperAIExternalDocumentHead = Pick<PaperAIDocumentSnapshot, 'documentId' | 'headCommitId'>

/** Complete browser state for one Session's PaperAI document view. */
export interface PaperAIWorkbenchState {
  /** Inactive document views retained in recency order; drafts survive their eviction separately. */
  retained: readonly PaperAIRetainedView[]
  /** Last scroll offset of this document preview. */
  scrollTop: number
  phase: PaperAIWorkbenchPhase
  document: PaperAIDocumentSnapshot | null
  edit: PaperAIBlockEdit | null
  action: PaperAIWorkbenchAction | null
  panel: PaperAIWorkbenchPanel | null
  diff: PaperAIVersionDiffState | null
  /** The Host's guess for the document type, shown when the user applies the project template. */
  typeSuggestion: PaperAIDocumentTypeSuggestion | null
  exportReceipt: PaperAIExportReceipt | null
  externalUpdate: PaperAIExternalDocumentHead | null
  error: string | null
  actionError: string | null
}

/** One inactive document view, without a recursively retained cache. */
export type PaperAIRetainedView = Omit<PaperAIWorkbenchState, 'retained'>

/** Stable React-free source for one Session workbench. */
export type PaperAIWorkbenchStore = SnapshotStore<PaperAIWorkbenchState>

/** Settled result used by UI actions that report failure through state. */
export type PaperAIActionResult = { readonly ok: true } | { readonly ok: false; readonly error: string }

/** Browser-side input for starting one document of a type from the project template. */
export interface PaperAITemplateStartInput {
  readonly documentType: PaperAIDocumentType
  /** Manuscript upload; required by formatting-reference formats. */
  readonly upload?: import('@paperai/workbench-service/types').PaperAIWordUpload
  readonly name?: string
}

/** Browser-side input for adding one format to a custom template set. */
export interface PaperAIAddFormatInput {
  readonly packId: string
  readonly documentType: PaperAIDocumentType
  readonly usage: import('@paperai/workbench-service/types').PaperAITemplateUsage
  readonly name?: string
  readonly fileName: string
  readonly contentBase64: string
}
