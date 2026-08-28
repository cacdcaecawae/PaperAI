/** Type-only Host, descriptor, and optional export-adapter values for PaperAI MCP. */

import type { PaperCommitService } from '@paperai/commit-service'
import type { PaperDocumentService } from '@paperai/document-service'
import type {
  ActorIdentity,
  DocumentCommit,
  DocumentRecord,
  GateReport,
} from '@paperai/domain'
import type { PaperProjectService } from '@paperai/project-service'
import type { PaperTemplateService } from '@paperai/template-service'

/** Agent identity captured by one authenticated MCP descriptor lease. */
export interface PaperMcpAgentIdentity extends ActorIdentity {
  readonly kind: 'agent'
  readonly client: 'codex' | 'claude'
  readonly sessionId: string
}

/** ACP-compatible Streamable HTTP descriptor passed to one local Agent. */
export interface PaperMcpHttpServerDescriptor {
  readonly type: 'http'
  readonly name: string
  readonly url: string
  readonly headers: Array<{
    readonly name: string
    readonly value: string
  }>
}

/** Descriptor plus its explicit authentication-lifetime owner. */
export interface PaperMcpDescriptorLease {
  readonly descriptor: PaperMcpHttpServerDescriptor
  readonly actor: PaperMcpAgentIdentity
  /**
   * Replace mutable provenance for subsequent MCP requests on this lease.
   * @param actor - Updated Agent provenance with the original client and session id.
   * @returns a detached snapshot of the accepted identity.
   */
  updateActor(actor: PaperMcpAgentIdentity): PaperMcpAgentIdentity
  /** Revoke the descriptor token; repeated calls have no effect. */
  dispose(): Promise<void>
}

/** Bounded model-facing result sizes and mutation batches. */
export interface PaperMcpToolLimits {
  readonly defaultNodesPerRead: number
  readonly maxNodesPerRead: number
  readonly maxMutationsPerCommit: number
}

/** Narrow domain consumers required by the MCP tool implementation. */
export interface PaperMcpDependencies {
  readonly projects: Pick<PaperProjectService, 'get' | 'list'>
  readonly documents: Pick<PaperDocumentService, 'listDocuments' | 'readDocument'>
  readonly templates: Pick<PaperTemplateService, 'check' | 'getContract' | 'listContracts' | 'listPacks'>
  readonly commits: Pick<PaperCommitService, 'listHistory' | 'revert' | 'submit'>
}

/** Request delegated to a future delivery-export domain provider. */
export interface PaperMcpExportRequest {
  readonly document: DocumentRecord
  readonly destinationPath: string
  readonly mode: 'draft-export' | 'delivery-export'
  readonly gate: GateReport
  readonly actor: PaperMcpAgentIdentity
}

/** Export result that proves the provider recorded a recoverable version. */
export interface PaperMcpExportResult {
  readonly outputPath: string
  readonly gate: GateReport
  readonly commit: DocumentCommit
}

/** Optional provider for publishing a checked DOCX outside the Working copy. */
export interface PaperMcpExportAdapter {
  /**
   * Publish one checked document without mutating its Working DOCX.
   * @param request - Checked source, destination, Agent identity, and gate report.
   * @returns the output path and the version commit recorded by the provider.
   */
  exportDocument(request: PaperMcpExportRequest): Promise<PaperMcpExportResult>
}
