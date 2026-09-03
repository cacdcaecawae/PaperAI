/**
 * Transport-neutral PaperAI domain vocabulary. The Working DOCX remains the
 * authoritative body; these records describe identity, metadata, operations,
 * template contracts, gates, and recoverable commits around it.
 * @module @paperai/domain
 */

import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { Branded } from '@deepseek-ai/dsh-brand'

/** PaperAI project identity. */
export type ProjectId = Branded<'PaperAI.ProjectId'>
/** Working document identity. */
export type DocumentId = Branded<'PaperAI.DocumentId'>
/** Stable semantic node identity. */
export type DocumentNodeId = Branded<'PaperAI.DocumentNodeId'>
/** Recoverable document commit identity. */
export type DocumentCommitId = Branded<'PaperAI.DocumentCommitId'>
/** Template contract identity. */
export type TemplateContractId = Branded<'PaperAI.TemplateContractId'>
/** Template rule identity. */
export type TemplateRuleId = Branded<'PaperAI.TemplateRuleId'>
/** Change-conflict identity. */
export type ChangeConflictId = Branded<'PaperAI.ChangeConflictId'>

/**
 * Brand a raw project id after validation at its owning boundary.
 * @param value A validated raw project id.
 * @returns The same value typed as a project id; this function performs no validation.
 */
export const ProjectId = (value: string): ProjectId => value as ProjectId
/**
 * Brand a raw document id after validation at its owning boundary.
 * @param value A validated raw document id.
 * @returns The same value typed as a document id; this function performs no validation.
 */
export const DocumentId = (value: string): DocumentId => value as DocumentId
/**
 * Brand a raw node id after validation at its owning boundary.
 * @param value A validated raw document-node id.
 * @returns The same value typed as a document-node id; this function performs no validation.
 */
export const DocumentNodeId = (value: string): DocumentNodeId => value as DocumentNodeId
/**
 * Brand a raw commit id after validation at its owning boundary.
 * @param value A validated raw document-commit id.
 * @returns The same value typed as a document-commit id; this function performs no validation.
 */
export const DocumentCommitId = (value: string): DocumentCommitId => value as DocumentCommitId
/**
 * Brand a raw template id after validation at its owning boundary.
 * @param value A validated raw template-contract id.
 * @returns The same value typed as a template-contract id; this function performs no validation.
 */
export const TemplateContractId = (value: string): TemplateContractId => value as TemplateContractId
/**
 * Brand a raw template-rule id after validation at its owning boundary.
 * @param value A validated raw template-rule id.
 * @returns The same value typed as a template-rule id; this function performs no validation.
 */
export const TemplateRuleId = (value: string): TemplateRuleId => value as TemplateRuleId
/**
 * Brand a raw conflict id after validation at its owning boundary.
 * @param value A validated raw change-conflict id.
 * @returns The same value typed as a change-conflict id; this function performs no validation.
 */
export const ChangeConflictId = (value: string): ChangeConflictId => value as ChangeConflictId

/** Human, Agent, or maintenance actor recorded on every completed mutation. */
export interface ActorIdentity {
  kind: 'human' | 'agent' | 'system'
  name: string
  client?: string
  provider?: string
  model?: string
  modelRevision?: string
  sessionId?: string
  runId?: string
}

/** Health of an optional native or external capability. */
export interface CapabilityHealth {
  status: 'ready' | 'degraded' | 'unavailable'
  version?: string
  detail?: string
}

/** PaperAI project projected into one DSH workspace directory. */
export interface ProjectRecord {
  id: ProjectId
  workspaceId: string
  name: string
  rootPath: string
  createdAt: string
  updatedAt: string
}

/** The academic role that controls template compatibility and delivery rules. */
export type DocumentRole = 'manuscript' | 'proposal' | 'midterm' | 'final' | 'other'

/** Whether a Word source can produce content or serves only as formatting evidence. */
export type TemplateUsage = 'form-template' | 'format-reference'

/** Immutable source plus its derived authoritative Working DOCX. */
export interface DocumentRecord {
  id: DocumentId
  projectId: ProjectId
  /** Working manuscripts are user-visible and mutable only through commits; template sources are evidence-only assets. */
  documentKind?: 'working' | 'template-source'
  name: string
  role: DocumentRole
  immutableSourcePath: string
  workingPath: string
  mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  sourceSha256: string
  templateId?: TemplateContractId
  headCommitId?: DocumentCommitId
  nodeCount: number
  createdAt: string
  updatedAt: string
}

/** Semantic kind projected from an OfficeCLI path. */
export type DocumentNodeKind = 'paragraph' | 'heading' | 'table' | 'table-cell' | 'field' | 'unknown'

/** Stable node index rebuilt after each Working DOCX mutation. */
export interface DocumentNode {
  id: DocumentNodeId
  documentId: DocumentId
  officePath: string
  ordinal: number
  kind: DocumentNodeKind
  text: string
  style: Record<string, unknown>
  hash: string
  parentId?: DocumentNodeId
  lineage: DocumentNodeId[]
  lastCommitId?: DocumentCommitId
  updatedAt: string
}

/** Operations accepted by the single document-commit path. */
export type DocumentMutation =
  | { type: 'replace-text'; nodeId: DocumentNodeId; baseText: string; nextText: string }
  | { type: 'insert-node'; text: string; afterNodeId?: DocumentNodeId; beforeNodeId?: DocumentNodeId; style?: string }
  | { type: 'delete-node'; nodeId: DocumentNodeId; baseText?: string }
  | { type: 'set-style'; nodeId: DocumentNodeId; patch: Record<string, unknown> }
  | { type: 'set-fact'; key: string; value: string }
  | { type: 'bind-template'; templateId: TemplateContractId }
  | { type: 'revert'; targetCommitId: DocumentCommitId }
  | { type: 'milestone'; label: string }

/** Materialized operation diff stored with a commit. */
export interface DocumentOperation {
  type: DocumentMutation['type']
  nodeId?: DocumentNodeId
  officePath?: string
  before: unknown
  after: unknown
}

/** Template requirement severity. */
export type RuleSeverity = 'error' | 'warning' | 'info'

/** Template requirement families understood by the delivery gate. */
export type TemplateRuleKind =
  | 'file-integrity'
  | 'template-identity'
  | 'fixed-text'
  | 'required-section'
  | 'required-field'
  | 'minimum-characters'
  | 'reference-count'
  | 'font'
  | 'font-size'
  | 'paragraph-spacing'
  | 'page-setup'
  | 'table-structure'
  | 'placeholder'
  | 'cross-document-fact'
  | 'visual-layout'
  | 'custom'

/** Evidence retained when a template rule is compiled. */
export interface TemplateEvidence {
  documentId: DocumentId
  nodeId?: DocumentNodeId
  officePath?: string
  excerpt: string
  source: 'document' | 'style' | 'page-setup' | 'user'
}

/** One confirmed or draft delivery requirement. */
export interface TemplateRule {
  id: TemplateRuleId
  kind: TemplateRuleKind
  label: string
  description: string
  severity: RuleSeverity
  scope?: string
  expected?: unknown
  evidence: TemplateEvidence[]
  confidence: number
  enabled: boolean
}

/** User-fillable seat found in a form template. */
export interface TemplateSlot {
  id: string
  key: string
  label: string
  officePath: string
  type: 'text' | 'long-text' | 'date' | 'number' | 'image' | 'table-row'
  required: boolean
  repeatable: boolean
}

/** Immutable provenance for a built-in or uploaded template source. */
export interface TemplateOrigin {
  kind: 'upload' | 'built-in'
  label: string
  originalFileName: string
  packId?: string
  memberId?: string
  sourceVersion?: string
  normalizedSha256?: string
}

/** Compiled, reviewable contract used by creation and delivery gates. */
export interface TemplateContract {
  id: TemplateContractId
  projectId: ProjectId
  name: string
  sourceDocumentId: DocumentId
  version: number
  rules: TemplateRule[]
  slots: TemplateSlot[]
  fixedNodeIds: DocumentNodeId[]
  instructionNodeIds: DocumentNodeId[]
  pageSetup: Record<string, unknown>
  styleMap: Record<string, unknown>
  origin: TemplateOrigin
  appliesToRoles: DocumentRole[]
  usage: TemplateUsage
  status: 'draft' | 'confirmed'
  createdAt: string
  updatedAt: string
}

/** One actionable result from a gate run. */
export interface GateFinding {
  id: string
  ruleId?: TemplateRuleId
  severity: RuleSeverity
  code: string
  message: string
  nodeId?: DocumentNodeId
  officePath?: string
  expected?: unknown
  actual?: unknown
  repairHint?: string
  overridden?: boolean
}

/** Gate mode controls whether hard findings block export. */
export type GateMode = 'continuous' | 'draft-export' | 'delivery-export'

/** Complete gate result stored with every commit and export attempt. */
export interface GateReport {
  status: 'pass' | 'pass-with-exceptions' | 'fail'
  mode: GateMode
  documentId: DocumentId
  templateId?: TemplateContractId
  findings: GateFinding[]
  checkedAt: string
}

/**
 * Determine whether a gate report blocks a formal delivery export.
 * @param report The completed gate report to evaluate.
 * @returns `true` only for delivery exports containing a non-overridden error.
 */
export function deliveryBlocked(report: GateReport): boolean {
  return report.mode === 'delivery-export'
    && report.findings.some(finding => finding.severity === 'error' && finding.overridden !== true)
}

/** Compact digest of one gate report for model-facing tool results. */
export interface GateSummary {
  status: GateReport['status']
  errorCount: number
  warningCount: number
  infoCount: number
  /** Most severe active findings first, capped for prompt economy. */
  topFindings: { severity: RuleSeverity; code: string; message: string }[]
  /** One actionable Chinese next step for the writing agent. */
  nextActions: string
}

const GATE_SUMMARY_TOP_FINDINGS = 5

/**
 * Digest a gate report into severity counts, the most severe findings first,
 * and one actionable next step. Overridden findings are excluded because they
 * no longer demand work; a clean report without a template id names the
 * templateless free-writing mode instead of a repair step, while a corrupt
 * association (no resolvable template, error findings) still demands repair.
 * @param report - complete gate report from a commit or export check.
 * @returns the digest embedded in model-facing mutating results.
 */
export function summarizeGate(report: GateReport): GateSummary {
  const active = report.findings.filter(finding => finding.overridden !== true)
  const countOf = (severity: RuleSeverity): number =>
    active.filter(finding => finding.severity === severity).length
  const errorCount = countOf('error')
  const warningCount = countOf('warning')
  const rank: Record<RuleSeverity, number> = { error: 0, warning: 1, info: 2 }
  const topFindings = [...active]
    .sort((first, second) => rank[first.severity] - rank[second.severity])
    .slice(0, GATE_SUMMARY_TOP_FINDINGS)
    .map(finding => ({ severity: finding.severity, code: finding.code, message: finding.message }))
  const nextActions = report.templateId === undefined && active.length === 0
    ? '未关联模板：自由写作模式，无模板检查。'
    : errorCount > 0
      ? `修复 ${errorCount} 处 error 级发现后再继续写作，然后用 paperai_check_gate 复核。`
      : warningCount > 0
        ? `无 error 级发现；${warningCount} 处 warning 建议与用户确认后处理。`
        : '门禁通过，可继续写作。'
  return {
    status: report.status,
    errorCount,
    warningCount,
    infoCount: countOf('info'),
    topFindings,
    nextActions,
  }
}

/** Recoverable commit over one exact Working DOCX snapshot. */
export interface DocumentCommit {
  id: DocumentCommitId
  documentId: DocumentId
  parentId?: DocumentCommitId
  message: string
  actor: ActorIdentity
  snapshotPath: string
  documentSha256: string
  gate: GateReport
  operations: DocumentOperation[]
  createdAt: string
}

/** Optimistic-concurrency conflict returned instead of overwriting new work. */
export interface ChangeConflict {
  id: ChangeConflictId
  documentId: DocumentId
  nodeId: DocumentNodeId
  baseCommitId: DocumentCommitId
  headCommitId: DocumentCommitId
  baseText: string
  currentText: string
  incomingText: string
  reason: string
}

/** Selected-section buffer owned by the client only for the edit duration. */
export interface SectionBuffer {
  documentId: DocumentId
  baseCommitId?: DocumentCommitId
  selectedNodeId: DocumentNodeId
  nodes: DocumentNode[]
  loadedAt: string
}

/** Why a document operation is refused for the calling Agent session. */
export type PaperAccessDeniedCode =
  | 'NO_PROJECT_FOR_SESSION'
  | 'PROJECT_OUT_OF_SCOPE'
  | 'READ_ONLY_SESSION'
  | 'WRITE_OUTSIDE_WORKSPACE'

/**
 * The DSH sandbox modes as the document routes read them: `read-only` refuses
 * mutations, `workspace-write` confines file output to the session workspace,
 * and `danger-full-access` lifts that confinement.
 */
export type PaperSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

/**
 * Refusal raised by the shared document-access checks that every Agent route
 * (native DSH tools and the MCP bridge) applies before touching a domain service.
 * The message carries the code prefix so a plain error text stays self-describing.
 */
export class PaperAccessError extends Error {
  constructor(readonly code: PaperAccessDeniedCode, message: string) {
    super(`${code}: ${message}`)
    this.name = 'PaperAccessError'
  }
}

/**
 * What one Agent session may touch: exactly the PaperAI project that owns its
 * workspace, and the sandbox mode that decides mutations and file output.
 */
export interface PaperAccessScope {
  /** The project resolved from the session workspace root. */
  readonly projectId: ProjectId
  /** Absolute session workspace root; the writable root under `workspace-write`. */
  readonly workspaceRoot: string
  /** Effective sandbox mode of the session at the time of the call. */
  readonly sandboxMode: PaperSandboxMode
}

/**
 * Refuse any project other than the session's own.
 * @param scope - the calling session's resolved scope.
 * @param projectId - project the requested record belongs to.
 * @param subject - model-facing name of the requested record, for the refusal text.
 * @throws PaperAccessError `PROJECT_OUT_OF_SCOPE` when the project differs.
 */
export function assertProjectInScope(scope: PaperAccessScope, projectId: ProjectId, subject: string): void {
  if (projectId !== scope.projectId) {
    throw new PaperAccessError(
      'PROJECT_OUT_OF_SCOPE',
      `${subject} belongs to PaperAI project '${projectId}', outside this session's workspace project '${scope.projectId}'`,
    )
  }
}

/**
 * Refuse document mutations under the `read-only` sandbox mode.
 * @param scope - the calling session's resolved scope.
 * @param operation - model-facing name of the refused operation.
 * @throws PaperAccessError `READ_ONLY_SESSION` when the session is read-only.
 */
export function assertMutationAllowed(scope: PaperAccessScope, operation: string): void {
  if (scope.sandboxMode === 'read-only') {
    throw new PaperAccessError(
      'READ_ONLY_SESSION',
      `${operation} is refused: this session runs in read-only sandbox mode; switch the session to workspace-write first`,
    )
  }
}

/**
 * Confine a file the Agent asks the Host to write — an export destination —
 * to the session workspace, the same writable root the filesystem tools
 * enforce under `workspace-write`; only `danger-full-access` may write
 * elsewhere. A relative path resolves against the workspace root. The check is
 * lexical over the resolved path, matching the commit service's containment.
 * @param scope - the calling session's resolved scope.
 * @param path - destination the Agent supplied.
 * @param subject - model-facing name of the destination, for the refusal text.
 * @returns the absolute destination path to write.
 * @throws PaperAccessError `WRITE_OUTSIDE_WORKSPACE` when the path escapes the workspace without full access.
 */
export function assertWriteWithinWorkspace(scope: PaperAccessScope, path: string, subject: string): string {
  const destination = resolve(scope.workspaceRoot, path)
  if (scope.sandboxMode === 'danger-full-access') return destination
  const inside = relative(scope.workspaceRoot, destination)
  if (inside === '' || (inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside))) return destination
  throw new PaperAccessError(
    'WRITE_OUTSIDE_WORKSPACE',
    `${subject} '${path}' is outside this session's workspace '${scope.workspaceRoot}'; only a danger-full-access session may write there`,
  )
}
