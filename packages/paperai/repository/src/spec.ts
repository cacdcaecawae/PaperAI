/** Durable PaperAI domain specification over DSH storage-domain. */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import {
  ChangeConflictId,
  DocumentCommitId,
  DocumentId,
  DocumentNodeId,
  ProjectId,
  TemplateContractId,
  TemplateRuleId,
} from '@paperai/domain'
import type {
  ChangeConflict,
  DocumentCommit,
  DocumentNode,
  DocumentRecord,
  ProjectRecord,
  TemplateContract,
} from '@paperai/domain'

/** Content-addressed Working DOCX image retained for publication rollback. */
export interface CommitPublicationWorkingImage {
  /** Verified immutable snapshot path. */
  readonly snapshotPath: string
  /** SHA-256 of both the snapshot and the Working DOCX it represents. */
  readonly sha256: string
  /** Permission mode restored with the file bytes. */
  readonly mode: number
}

/** Durable write-ahead record for one document commit publication. */
export interface DocumentCommitPublication {
  /** Journal record format. */
  readonly version: 1
  /** Document whose publication owns this per-document journal slot. */
  readonly documentId: DocumentId
  /** Complete immutable commit that publication stores before touching Working DOCX. */
  readonly commit: DocumentCommit
  /** Authoritative state restored when the document head has not advanced. */
  readonly before: {
    readonly document: DocumentRecord
    readonly nodes: readonly DocumentNode[]
    readonly working: CommitPublicationWorkingImage
  }
  /** Authoritative state retained when the document head reached the commit. */
  readonly after: {
    readonly document: DocumentRecord
    readonly nodes: readonly DocumentNode[]
  }
  /** Time at which publication intent became durable. */
  readonly createdAt: string
}

const actor = z.object({
  kind: z.enum(['human', 'agent', 'system']),
  name: z.string(),
  client: z.string().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  modelRevision: z.string().optional(),
  sessionId: z.string().optional(),
  runId: z.string().optional(),
})

const documentId = z.string().transform(DocumentId)
const projectId = z.string().transform(ProjectId)
const nodeId = z.string().transform(DocumentNodeId)
const commitId = z.string().transform(DocumentCommitId)
const templateId = z.string().transform(TemplateContractId)
const ruleId = z.string().transform(TemplateRuleId)

const finding = z.object({
  id: z.string(),
  ruleId: ruleId.optional(),
  severity: z.enum(['error', 'warning', 'info']),
  code: z.string(),
  message: z.string(),
  nodeId: nodeId.optional(),
  officePath: z.string().optional(),
  expected: z.unknown().optional(),
  actual: z.unknown().optional(),
  repairHint: z.string().optional(),
  overridden: z.boolean().optional(),
})

const gate = z.object({
  status: z.enum(['pass', 'pass-with-exceptions', 'fail']),
  mode: z.enum(['continuous', 'draft-export', 'delivery-export']),
  documentId,
  templateId: templateId.optional(),
  findings: z.array(finding),
  checkedAt: z.string(),
})

/** Runtime validator for project records. */
export const projectRecordSchema: z.ZodType<ProjectRecord> = z.object({
  id: projectId,
  workspaceId: z.string(),
  name: z.string(),
  rootPath: z.string(),
  templatePackId: z.string().optional(),
  templateDecidedAt: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
}) as z.ZodType<ProjectRecord>

/** Runtime validator for document records. */
// Zod's optional-property output permits an explicitly present `undefined`,
// while PaperAI's exact domain types only permit omission. The storage medium
// is JSON (which omits `undefined`), so this cast documents the durable-boundary
// equivalence without weakening the public domain model.
export const documentRecordSchema = z.object({
  id: documentId,
  projectId,
  documentKind: z.enum(['working', 'template-source']).optional(),
  name: z.string(),
  role: z.enum(['manuscript', 'proposal', 'midterm', 'final', 'other']),
  immutableSourcePath: z.string(),
  workingPath: z.string(),
  mediaType: z.literal('application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
  sourceSha256: z.string(),
  templateId: templateId.optional(),
  headCommitId: commitId.optional(),
  nodeCount: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
}) as unknown as z.ZodType<DocumentRecord>

/** Runtime validator for semantic nodes. */
export const documentNodeSchema = z.object({
  id: nodeId,
  documentId,
  officePath: z.string(),
  ordinal: z.number().int().nonnegative(),
  kind: z.enum(['paragraph', 'heading', 'table', 'table-cell', 'field', 'unknown']),
  text: z.string(),
  style: z.record(z.string(), z.unknown()),
  hash: z.string(),
  parentId: nodeId.optional(),
  lineage: z.array(nodeId),
  lastCommitId: commitId.optional(),
  updatedAt: z.string(),
}) as unknown as z.ZodType<DocumentNode>

/** Runtime validator for complete recoverable commits. */
export const documentCommitSchema = z.object({
  id: commitId,
  documentId,
  parentId: commitId.optional(),
  message: z.string(),
  actor,
  snapshotPath: z.string(),
  documentSha256: z.string(),
  gate,
  operations: z.array(z.object({
    type: z.enum([
      'replace-text', 'insert-node', 'delete-node', 'set-style', 'set-fact',
      'bind-template', 'unbind-template', 'set-document-type', 'revert', 'milestone',
    ]),
    nodeId: nodeId.optional(),
    officePath: z.string().optional(),
    before: z.unknown(),
    after: z.unknown(),
  })),
  createdAt: z.string(),
}) as unknown as z.ZodType<DocumentCommit>

const commitPublicationWorkingImageSchema: z.ZodType<CommitPublicationWorkingImage> = z.object({
  snapshotPath: z.string(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  mode: z.number().int().nonnegative(),
})

/** Runtime validator for an interrupted document commit publication. */
export const documentCommitPublicationSchema = z.object({
  version: z.literal(1),
  documentId,
  commit: documentCommitSchema,
  before: z.object({
    document: documentRecordSchema,
    nodes: z.array(documentNodeSchema),
    working: commitPublicationWorkingImageSchema,
  }),
  after: z.object({
    document: documentRecordSchema,
    nodes: z.array(documentNodeSchema),
  }),
  createdAt: z.string(),
}) as unknown as z.ZodType<DocumentCommitPublication>

const templateRule = z.object({
  id: ruleId,
  kind: z.enum([
    'file-integrity', 'template-identity', 'fixed-text', 'required-section',
    'required-field', 'minimum-characters', 'reference-count', 'font',
    'font-size', 'paragraph-spacing', 'page-setup', 'table-structure',
    'placeholder', 'cross-document-fact', 'visual-layout', 'custom',
  ]),
  label: z.string(),
  description: z.string(),
  severity: z.enum(['error', 'warning', 'info']),
  scope: z.string().optional(),
  expected: z.unknown().optional(),
  evidence: z.array(z.object({
    documentId,
    nodeId: nodeId.optional(),
    officePath: z.string().optional(),
    excerpt: z.string(),
    source: z.enum(['document', 'style', 'page-setup', 'user']),
  })),
  confidence: z.number().min(0).max(1),
  enabled: z.boolean(),
})

/** Runtime validator for draft and confirmed template contracts. */
export const templateContractSchema = z.object({
  id: templateId,
  projectId,
  name: z.string(),
  sourceDocumentId: documentId,
  version: z.number().int().positive(),
  rules: z.array(templateRule),
  slots: z.array(z.object({
    id: z.string(),
    key: z.string(),
    label: z.string(),
    officePath: z.string(),
    type: z.enum(['text', 'long-text', 'date', 'number', 'image', 'table-row']),
    required: z.boolean(),
    repeatable: z.boolean(),
  })),
  fixedNodeIds: z.array(nodeId),
  instructionNodeIds: z.array(nodeId),
  pageSetup: z.record(z.string(), z.unknown()),
  styleMap: z.record(z.string(), z.unknown()),
  origin: z.object({
    kind: z.enum(['upload', 'built-in']),
    label: z.string(),
    originalFileName: z.string(),
    packId: z.string().optional(),
    memberId: z.string().optional(),
    sourceVersion: z.string().optional(),
    normalizedSha256: z.string().optional(),
  }),
  appliesToRoles: z.array(z.enum(['manuscript', 'proposal', 'midterm', 'final', 'other'])),
  usage: z.enum(['form-template', 'format-reference']),
  status: z.enum(['draft', 'confirmed']),
  createdAt: z.string(),
  updatedAt: z.string(),
}) as unknown as z.ZodType<TemplateContract>

/** Runtime validator for optimistic-conflict records. */
export const changeConflictSchema: z.ZodType<ChangeConflict> = z.object({
  id: z.string().transform(ChangeConflictId),
  documentId,
  nodeId,
  baseCommitId: commitId,
  headCommitId: commitId,
  baseText: z.string(),
  currentText: z.string(),
  incomingText: z.string(),
  reason: z.string(),
})

/** One versioned durable PaperAI unit, routed to SQLite by the product profile. */
export const paperaiDomainSpec = defineDomain({
  name: 'paperai',
  // The journal is an additive table: storage backends materialize missing
  // declared tables without changing or rewriting existing v1 records.
  version: 1,
  tables: {
    projects: domainTable<ProjectId, ProjectRecord>(projectRecordSchema),
    documents: domainTable<DocumentId, DocumentRecord>(documentRecordSchema),
    nodes: domainTable<DocumentNodeId, DocumentNode>(documentNodeSchema),
    commits: domainTable<DocumentCommitId, DocumentCommit>(documentCommitSchema),
    commit_publications: domainTable<DocumentId, DocumentCommitPublication>(documentCommitPublicationSchema),
    templates: domainTable<TemplateContractId, TemplateContract>(templateContractSchema),
    conflicts: domainTable<ChangeConflictId, ChangeConflict>(changeConflictSchema),
  },
})
