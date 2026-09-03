/** Browser state layered over the Host-owned PaperAI workbench protocol. */

import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@paperai/workbench-service/remote'
import type {
  PaperAIDocumentSnapshot, PaperAIResourceId, PaperAIResourceRow,
  PaperAISelectedNodeBuffer, PaperAIDocumentChangedEvent,
} from '@paperai/workbench-service/types'

export type * from '@paperai/workbench-service/types'

/** Generated Host namespace methods used by this browser workbench. */
export type PaperAIWorkbenchRemote = Pick<
  TypertClientRemote['paperaiWorkbench'],
  | 'list'
  | 'open'
  | 'readNode'
  | 'commit'
  | 'validate'
  | 'restore'
  | 'importDocument'
  | 'createFromTemplate'
  | 'listTemplates'
  | 'installTemplatePack'
  | 'uploadTemplate'
  | 'confirmTemplate'
  | 'associateTemplate'
  | 'exportDocument'
>

/** Resource-tree read phase. */
export type PaperAIResourcePhase = 'cold' | 'loading' | 'ready' | 'error'

/** Browser state for one Workspace's additive PaperAI resource tree. */
export interface PaperAIResourceTreeState {
  phase: PaperAIResourcePhase
  resources: readonly PaperAIResourceRow[]
  selected: PaperAIResourceId | null
  error: string | null
}

/** Stable React-free source for one Workspace resource tree. */
export type PaperAIResourceTreeStore = SnapshotStore<PaperAIResourceTreeState>

/** Aggregate resource projection bound once through the slot renderer. */
export interface PaperAIResourceDirectoryState {
  workspaces: Record<string, PaperAIResourceTreeState>
}

/** Stable aggregate source; components select their owner-supplied Workspace id. */
export type PaperAIResourceDirectoryStore = SnapshotStore<PaperAIResourceDirectoryState>

/** Main workbench projection phase. */
export type PaperAIWorkbenchPhase = 'idle' | 'loading' | 'ready' | 'error'
/** Selected-node buffer phase inside a ready workbench. */
export type PaperAINodeBufferPhase = 'idle' | 'loading' | 'ready' | 'error'
/** Tabs owned by the PaperAI details view. */
export type PaperAIWorkbenchTab = 'preview' | 'edit' | 'versions' | 'template' | 'gate' | 'export'
/** Host-backed action currently excluding competing document operations. */
export type PaperAIWorkbenchAction =
  | 'importing-document'
  | 'committing'
  | 'validating'
  | 'restoring'
  | 'loading-templates'
  | 'installing-template'
  | 'uploading-template'
  | 'confirming-template'
  | 'associating-template'
  | 'exporting-draft'
  | 'exporting-delivery'
  | 'reloading-external'

/** Last completed local export surfaced to the user. */
export interface PaperAIExportReceipt {
  readonly mode: import('@paperai/workbench-service/types').PaperAIExportMode
  readonly fileName: string
  readonly outputPath: string
}

/** Browser-owned inputs retained while the selected node is rebased after an external edit. */
export interface PaperAIExternalNodeConflict {
  readonly localDraft: string
  readonly externalText: string
}

/** Complete browser state for one Session's PaperAI details view. */
export interface PaperAIWorkbenchState {
  phase: PaperAIWorkbenchPhase
  tab: PaperAIWorkbenchTab
  document: PaperAIDocumentSnapshot | null
  nodePhase: PaperAINodeBufferPhase
  selectedNode: PaperAISelectedNodeBuffer | null
  draft: string
  dirty: boolean
  action: PaperAIWorkbenchAction | null
  templates: import('@paperai/workbench-service/types').PaperAITemplateCatalog | null
  exportReceipt: PaperAIExportReceipt | null
  externalUpdate: PaperAIDocumentChangedEvent | null
  externalConflict: PaperAIExternalNodeConflict | null
  error: string | null
  nodeError: string | null
  actionError: string | null
}

/** Stable React-free source for one Session workbench. */
export type PaperAIWorkbenchStore = SnapshotStore<PaperAIWorkbenchState>

/** Settled result used by UI actions that report failure through state. */
export type PaperAIActionResult = { readonly ok: true } | { readonly ok: false; readonly error: string }

/** Built-in template packs offered when starting a document, or the Host diagnostic. */
export type PaperAITemplateChoicesResult =
  | { readonly ok: true; readonly packs: readonly import('@paperai/workbench-service/types').PaperAITemplatePackChoice[] }
  | { readonly ok: false; readonly error: string }

/** Browser-side input for starting one document from a built-in template pack member. */
export interface PaperAITemplateStartInput {
  readonly packId: string
  readonly memberId: string
  /** Manuscript upload; required by formatting-reference members. */
  readonly upload?: import('@paperai/workbench-service/types').PaperAIWordUpload
  readonly role?: import('@paperai/workbench-service/types').PaperAIDocumentRole
  readonly name?: string
}
