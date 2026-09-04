/** Public values exchanged with the PaperAI template service. */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type {
  DocumentRecord,
  DocumentRole,
  GateMode,
  ProjectId,
  TemplateContractId,
  TemplateUsage,
} from '@paperai/domain'

/** Installed template-pack identity. */
export type TemplatePackId = Branded<'PaperAI.TemplatePackId'>

/** Member identity scoped to one template pack. */
export type TemplatePackMemberId = Branded<'PaperAI.TemplatePackMemberId'>

/** One immutable file retained for source provenance. */
export interface TemplatePackSourceAsset {
  /** Absolute package asset path borrowed only during registration and installation. */
  readonly path: string
  /** Original user-facing filename. */
  readonly originalFileName: string
  /** Lowercase SHA-256 of the exact source bytes. */
  readonly sha256: string
  /** Exact source size in bytes. */
  readonly size: number
}

/** OfficeCLI-readable DOCX derived without changing the source asset. */
export interface TemplatePackNormalizedAsset {
  /** Absolute package asset path borrowed only during registration and installation. */
  readonly path: string
  /** Lowercase SHA-256 of the normalized DOCX bytes. */
  readonly sha256: string
  /** Exact normalized size in bytes. */
  readonly size: number
}

/** One installable institutional template inside a pack. */
export interface TemplatePackMember {
  readonly id: TemplatePackMemberId
  readonly name: string
  readonly description: string
  readonly appliesToRoles: readonly DocumentRole[]
  readonly usage: TemplateUsage
  readonly sourceVersion: string
  readonly source: TemplatePackSourceAsset
  readonly normalized: TemplatePackNormalizedAsset
}

/** Immutable manifest contributed by a built-in template-pack plugin. */
export interface TemplatePackManifest {
  readonly id: TemplatePackId
  readonly name: string
  readonly description: string
  readonly version: string
  readonly sourceLabel: string
  readonly members: readonly TemplatePackMember[]
}

/** Where a template set comes from: shipped with the product or added by the user. */
export type TemplatePackKind = 'built-in' | 'custom'

/** Asset-free pack summary safe to expose to UI and command consumers. */
export interface TemplatePackSummary {
  readonly id: TemplatePackId
  readonly kind: TemplatePackKind
  readonly name: string
  readonly description: string
  readonly version: string
  readonly sourceLabel: string
  readonly members: readonly TemplatePackMemberSummary[]
}

/** Asset-free member summary safe to expose outside the Host. */
export interface TemplatePackMemberSummary {
  readonly id: TemplatePackMemberId
  readonly name: string
  readonly description: string
  readonly appliesToRoles: readonly DocumentRole[]
  readonly usage: TemplateUsage
  readonly sourceVersion: string
  readonly originalFileName: string
  readonly sourceSha256: string
}

/** Selects all or part of a registered template pack for one project. */
export interface InstallTemplatePackInput {
  readonly projectId: ProjectId
  readonly packId: TemplatePackId
  /** Omission installs every member; an empty array is invalid. */
  readonly memberIds?: readonly TemplatePackMemberId[]
}

/** Imports a user-selected Word file as a reviewable draft contract. */
export interface UploadTemplateInput {
  readonly projectId: ProjectId
  readonly name: string
  readonly sourcePath: string
  readonly appliesToRoles: readonly DocumentRole[]
  readonly usage: TemplateUsage
}

/** Runs the template checks attached to one document. */
export interface CheckTemplateInput {
  readonly documentId: import('@paperai/domain').DocumentId
  readonly mode: import('@paperai/domain').GateMode
}

/** A confirmed template can be associated only with compatible document roles. */
export interface AssociateTemplateInput {
  readonly documentId: import('@paperai/domain').DocumentId
  readonly templateId: TemplateContractId
  /** Document type the binding commit switches to; defaults to the stored role. */
  readonly role?: DocumentRole
}

/** Runs a gate against staged DOCX bytes without publishing them as Working state. */
export interface CheckTemplateCandidateInput {
  readonly document: DocumentRecord
  readonly candidatePath: string
  readonly templateId?: TemplateContractId
  readonly mode: GateMode
}
