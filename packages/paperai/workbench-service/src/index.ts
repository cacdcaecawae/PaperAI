/** PaperAI DSH workbench Host Remote over authoritative domain services. */

import { Buffer } from 'node:buffer'
import type { Dirent, Stats } from 'node:fs'
import { basename, extname, join, relative, sep } from 'node:path'
import { lstat, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type { Workspace } from '@deepseek-ai/dsh-workspace/types'
import type {} from '@paperai/commit-service'
import type {} from '@paperai/document-service'
import { PaperExportError, type ExportDocumentResult } from '@paperai/export-service'
import {
  DocumentCommitId,
  DocumentId,
  DocumentNodeId,
  TemplateContractId,
} from '@paperai/domain'
import type {
  DocumentCommit,
  DocumentNode,
  DocumentRecord,
  GateFinding,
  GateReport,
  ProjectRecord,
  TemplateContract,
} from '@paperai/domain'
import type {} from '@paperai/project-service'
import type {} from '@paperai/repository'
import type {} from '@paperai/template-service'
import {
  TemplatePackId,
  TemplatePackMemberId,
} from '@paperai/template-service'
import type {
  PaperAIAssociateTemplateRequest,
  PaperAICommitDocumentRequest,
  PaperAIConfirmTemplateRequest,
  PaperAIDocumentCommitId,
  PaperAIDocumentCommitResult,
  PaperAIDocumentChangedEvent,
  PaperAIDocumentId,
  PaperAIDocumentNodeSummary,
  PaperAIDocumentOpenResult,
  PaperAIDocumentRevision,
  PaperAIDocumentSnapshot,
  PaperAIDocumentVersion,
  PaperAIGateFinding,
  PaperAIExportDocumentRequest,
  PaperAIExportDocumentResult,
  PaperAIImportDocumentRequest,
  PaperAIImportDocumentResult,
  PaperAIInstallTemplatePackRequest,
  PaperAIListResourcesRequest,
  PaperAIListTemplatesRequest,
  PaperAIOpenDocumentRequest,
  PaperAIReadNodeRequest,
  PaperAIResourceId,
  PaperAIResourceList,
  PaperAIResourceRow,
  PaperAIRestoreDocumentRequest,
  PaperAISelectedNodeBuffer,
  PaperAITemplateGateReport,
  PaperAITemplateCatalog,
  PaperAITemplateContractChoice,
  PaperAITemplateSummary,
  PaperAIUploadTemplateRequest,
  PaperAIValidateDocumentRequest,
  PaperAIValidateResult,
} from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    paperaiWorkbench: PaperAiWorkbenchService
  }
}

const RESOURCE_PREFIX = 'document:'
const WORKSPACE_PATH_PREFIX = 'workspace-path:'
const DEFAULT_MAX_UPLOAD_BYTES = 128 * 1024 * 1024
const SAFE_UPLOAD_NAME = /^[^<>:"/\\|?*\u0000-\u001f\u007f]+$/u
const FILESYSTEM_RESOURCE_ROOTS = Object.freeze([
  { category: 'image', directory: 'figures' },
  { category: 'experiment', directory: 'experiments' },
  { category: 'code', directory: 'code' },
] as const)

type FilesystemResourceCategory = typeof FILESYSTEM_RESOURCE_ROOTS[number]['category']

type DurableDomainChange = {
  readonly domain: string
  readonly table: string
  readonly key: string
} & (
  | { readonly operation: 'put'; readonly value: unknown }
  | { readonly operation: 'deleted'; readonly value?: never }
)

interface CachedGateReport {
  readonly revision: PaperAIDocumentRevision
  readonly report: PaperAITemplateGateReport
}

interface GateOperation {
  readonly id: symbol
  readonly sourceRevision: PaperAIDocumentRevision
}

interface GateCacheSlot {
  readonly operation: GateOperation
  readonly cached?: CachedGateReport
}

function pathResourceId(
  category: FilesystemResourceCategory,
  path: string,
): PaperAIResourceId {
  return `${WORKSPACE_PATH_PREFIX}${category}:${path}` as PaperAIResourceId
}

function pathResourceRow(
  category: FilesystemResourceCategory,
  kind: PaperAIResourceRow['kind'],
  name: string,
  path: string,
  depth: number,
): PaperAIResourceRow {
  return {
    id: pathResourceId(category, path),
    category,
    kind,
    name,
    path,
    depth,
    openable: false,
  }
}

function deterministicNameOrder(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function isMissingPath(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

async function projectResourceDirectory(
  projectRoot: string,
  category: FilesystemResourceCategory,
  relativePath: string,
  depth: number,
): Promise<PaperAIResourceRow[]> {
  const directoryPath = join(projectRoot, relativePath)
  let metadata: Stats
  try {
    metadata = await lstat(directoryPath)
  } catch (error) {
    if (isMissingPath(error)) return []
    throw error
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) return []
  let entries: Dirent[]
  try {
    entries = await readdir(directoryPath, { withFileTypes: true })
  } catch (error) {
    if (isMissingPath(error)) return []
    throw error
  }
  entries.sort((left, right) => deterministicNameOrder(left.name, right.name))
  const descendants: PaperAIResourceRow[] = []
  for (const entry of entries) {
    const childPath = `${relativePath}/${entry.name}`
    if (entry.isDirectory()) {
      descendants.push(...await projectResourceDirectory(
        projectRoot,
        category,
        childPath,
        depth + 1,
      ))
    } else if (entry.isFile()) {
      descendants.push(pathResourceRow(category, 'file', entry.name, childPath, depth + 1))
    }
  }
  if (descendants.length === 0) return []
  return [
    pathResourceRow(category, 'folder', basename(relativePath), relativePath, depth),
    ...descendants,
  ]
}

async function projectFilesystemResources(project: ProjectRecord): Promise<PaperAIResourceRow[]> {
  const groups = await Promise.all(FILESYSTEM_RESOURCE_ROOTS.map(root => (
    projectResourceDirectory(project.rootPath, root.category, root.directory, 0)
  )))
  return groups.flat()
}

function committedDocumentChange(change: DurableDomainChange): PaperAIDocumentChangedEvent | undefined {
  if (change.domain !== 'paperai'
    || change.table !== 'documents'
    || change.operation !== 'put') {
    return undefined
  }
  if (typeof change.value !== 'object' || change.value === null) {
    throw new Error('paperai-workbench: durable document put has no record object')
  }
  const record = change.value as Record<string, unknown>
  if (record.documentKind === 'template-source' || record.headCommitId === undefined) return undefined
  if (typeof record.id !== 'string'
    || typeof record.headCommitId !== 'string'
    || typeof record.updatedAt !== 'string'
    || change.key !== record.id) {
    throw new Error(`paperai-workbench: durable document put '${change.key}' has invalid change metadata`)
  }
  return {
    documentId: record.id as PaperAIDocumentId,
    headCommitId: record.headCommitId as PaperAIDocumentCommitId,
    updatedAt: record.updatedAt,
  }
}

function resourceId(documentId: DocumentRecord['id']): PaperAIResourceId {
  return `${RESOURCE_PREFIX}${documentId}` as PaperAIResourceId
}

function documentIdFromResource(value: PaperAIResourceId): DocumentId {
  const raw = String(value)
  if (!raw.startsWith(RESOURCE_PREFIX) || raw.length === RESOURCE_PREFIX.length) {
    throw new Error(`paperai-workbench: resource '${raw}' is not an openable Working document`)
  }
  return DocumentId(raw.slice(RESOURCE_PREFIX.length))
}

function revisionOf(document: DocumentRecord): PaperAIDocumentRevision {
  return `${document.headCommitId ?? 'unborn'}:${document.sourceSha256}:${document.updatedAt}` as PaperAIDocumentRevision
}

function headOf(document: DocumentRecord): PaperAIDocumentCommitId | null {
  return document.headCommitId === undefined ? null : document.headCommitId
}

function sameHead(document: DocumentRecord, observed: PaperAIDocumentCommitId | null): boolean {
  return (document.headCommitId ?? null) === observed
}

function relativeDisplayPath(project: ProjectRecord, filePath: string): string {
  return relative(project.rootPath, filePath).split(sep).join('/')
}

function compactLabel(text: string, fallback: string): string {
  const compact = text.replace(/\s+/gu, ' ').trim()
  if (compact.length === 0) return fallback
  return compact.length <= 56 ? compact : `${compact.slice(0, 55)}…`
}

function nodeSummary(node: DocumentNode): PaperAIDocumentNodeSummary {
  return {
    nodeId: node.id,
    kind: node.kind,
    label: compactLabel(node.text, `空${node.kind === 'table-cell' ? '单元格' : '段落'}`),
    depth: node.parentId === undefined ? 0 : 1,
    editable: node.kind !== 'table',
  }
}

function versionOf(commit: DocumentCommit, head: DocumentRecord['headCommitId']): PaperAIDocumentVersion {
  return {
    commitId: commit.id,
    parentCommitId: commit.parentId === undefined ? null : commit.parentId,
    revision: `${commit.id}:${commit.documentSha256}` as PaperAIDocumentRevision,
    createdAt: commit.createdAt,
    summary: commit.message,
    actor: {
      kind: commit.actor.kind,
      name: commit.actor.name,
      ...(commit.actor.client === undefined ? {} : { client: commit.actor.client }),
      ...(commit.actor.provider === undefined ? {} : { provider: commit.actor.provider }),
      ...(commit.actor.model === undefined ? {} : { model: commit.actor.model }),
    },
    restorable: commit.id !== head,
  }
}

function templateSummary(contract: TemplateContract | undefined): PaperAITemplateSummary | null {
  if (contract === undefined) return null
  return {
    templateId: String(contract.id),
    name: contract.name,
    source: contract.origin.kind === 'built-in' ? 'built-in' : 'uploaded',
    ...(contract.origin.sourceVersion === undefined ? {} : { version: contract.origin.sourceVersion }),
  }
}

function contractChoice(contract: TemplateContract): PaperAITemplateContractChoice {
  return {
    templateId: String(contract.id),
    name: contract.name,
    status: contract.status,
    source: contract.origin.kind === 'built-in' ? 'built-in' : 'uploaded',
    appliesToRoles: [...contract.appliesToRoles],
    usage: contract.usage,
    ruleCount: contract.rules.length,
    slotCount: contract.slots.length,
    ...(contract.origin.packId === undefined ? {} : { originPackId: contract.origin.packId }),
    ...(contract.origin.memberId === undefined ? {} : { originMemberId: contract.origin.memberId }),
    requirements: contract.rules.map(rule => ({
      ruleId: String(rule.id),
      kind: rule.kind,
      label: rule.label,
      description: rule.description,
      severity: rule.severity,
      confidence: rule.confidence,
      enabled: rule.enabled,
    })),
  }
}

/** Workbench upload policy. */
export interface Config {
  /** Maximum decoded bytes accepted from one browser Word upload. */
  readonly maxUploadBytes?: number
}

function findingLocation(finding: GateFinding): string | undefined {
  return finding.officePath ?? (finding.nodeId === undefined ? undefined : String(finding.nodeId))
}

function projectedFinding(
  finding: GateFinding,
  title: string,
): PaperAIGateFinding {
  const location = findingLocation(finding)
  return {
    id: finding.id as PaperAIGateFinding['id'],
    severity: finding.severity,
    title,
    message: finding.message,
    ...(location === undefined ? {} : { location }),
    passed: false,
  }
}

function projectGate(report: GateReport, contract: TemplateContract | undefined): PaperAITemplateGateReport {
  const byRule = new Map(report.findings.flatMap(finding => (
    finding.ruleId === undefined ? [] : [[finding.ruleId, finding] as const]
  )))
  const knownRuleIds = new Set(contract?.rules.map(rule => rule.id) ?? [])
  const rules: PaperAIGateFinding[] = (contract?.rules ?? [])
    .filter(rule => rule.enabled)
    .map((rule): PaperAIGateFinding => {
      const failure = byRule.get(rule.id)
      if (failure !== undefined) return projectedFinding(failure, rule.label)
      const location = rule.scope ?? rule.evidence.find(evidence => evidence.officePath !== undefined)?.officePath
      return {
        id: rule.id as unknown as PaperAIGateFinding['id'],
        severity: rule.severity,
        title: rule.label,
        message: rule.description,
        ...(location === undefined ? {} : { location }),
        passed: true,
      }
    })
  const standalone = report.findings
    .filter(finding => finding.ruleId === undefined || !knownRuleIds.has(finding.ruleId))
    .map(finding => projectedFinding(finding, finding.code))
  return {
    status: report.status === 'fail' ? 'failed' : 'passed',
    checkedAt: report.checkedAt,
    findings: [...rules, ...standalone],
  }
}

/** Strict Remote that keeps the DSH client free of PaperAI Host dependencies. */
export class PaperAiWorkbenchService extends TypertRemoteService {
  static inject = [
    'workspaceRegistry',
    'paperProjects',
    'paperDocuments',
    'paperCommits',
    'paperTemplates',
    'paperExports',
    'paperRepository',
  ]

  static Config: z<Config> = z.object({
    maxUploadBytes: z.number().default(DEFAULT_MAX_UPLOAD_BYTES),
  })

  /**
   * One slot per document keeps the newest revision-anchored gate claim or
   * mutation fence, plus an optional current-revision report.
   */
  private readonly gateCache = new Map<DocumentId, GateCacheSlot>()
  private readonly maxUploadBytes: number

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'paperaiWorkbench')
    this.maxUploadBytes = config.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES
    if (!Number.isSafeInteger(this.maxUploadBytes) || this.maxUploadBytes <= 0) {
      throw new Error('paperai-workbench: maxUploadBytes must be a positive safe integer')
    }
    ctx.on('domain/changed', (change) => {
      const event = committedDocumentChange(change)
      if (event === undefined) return
      const commit = ctx.paperRepository.getCommit(DocumentCommitId(String(event.headCommitId)))
      if (commit === undefined || String(commit.documentId) !== String(event.documentId)) {
        throw new Error(
          `paperai-workbench: durable document '${event.documentId}' references missing head '${event.headCommitId}'`,
        )
      }
      try {
        ctx.emit('paperai/document-changed', event)
      } catch (error) {
        ctx.logger.warn(`paperai-workbench: paperai/document-changed listener failed: ${String(error)}`)
      }
    })
  }

  /**
   * Lazily initialize and list the selected Workspace's PaperAI resources.
   * @param request - Workspace whose project resources should be listed.
   * @param signal - optional cancellation signal for project and filesystem discovery.
   * @returns the flattened document, template, and non-empty filesystem resources.
   * @throws when the Workspace or its PaperAI project cannot be resolved.
   */
  @Remote('list')
  async list(request: PaperAIListResourcesRequest, signal?: AbortSignal): Promise<PaperAIResourceList> {
    signal?.throwIfAborted()
    const { project } = await this.projectForWorkspace(request.workspaceId)
    const documents: PaperAIResourceRow[] = this.ctx.paperDocuments.listDocuments(project.id)
      .map(document => ({
        id: resourceId(document.id),
        category: 'document',
        kind: 'file',
        name: `${document.name}.docx`,
        path: relativeDisplayPath(project, document.workingPath),
        depth: 0,
        openable: true,
        status: 'clean',
      }))
    const templates: PaperAIResourceRow[] = this.ctx.paperTemplates.listContracts(project.id)
      .map(contract => ({
        id: `template:${contract.id}` as PaperAIResourceId,
        category: 'template',
        kind: 'file',
        name: contract.name,
        path: `templates/${contract.name}`,
        depth: 0,
        openable: false,
        status: contract.status === 'confirmed' ? 'clean' : 'pending',
      }))
    const filesystemResources = await projectFilesystemResources(project)
    return {
      workspaceId: request.workspaceId,
      resources: [...documents, ...templates, ...filesystemResources],
    }
  }

  /**
   * Import one browser-selected `.doc` or `.docx` and establish its root version.
   * A rejected root submission is followed by non-cancellable import rollback before this method settles.
   * @param request - Workspace, Session, upload bytes, document role, and optional display name.
   * @param signal - optional cancellation signal for import, indexing, commit, and preview work.
   * @returns the opened imported document and root commit, or an explicit native-engine downgrade.
   * @throws when upload, project, import, or commit work fails; an AggregateError includes any rollback failure.
   */
  @Remote('importDocument')
  async importDocument(
    request: PaperAIImportDocumentRequest,
    signal?: AbortSignal,
  ): Promise<PaperAIImportDocumentResult> {
    const { project } = await this.projectForWorkspace(request.workspaceId)
    return await this.withUploadedWord(project, request.fileName, request.contentBase64, async (sourcePath) => {
      const imported = await this.ctx.paperDocuments.importDocument({
        projectId: project.id,
        sourcePath,
        role: request.role,
        ...(request.name === undefined ? {} : { name: request.name }),
      }, signal)
      if (imported.status === 'degraded') {
        return {
          status: 'degraded',
          capability: imported.capability,
          detail: imported.detail,
        }
      }
      let commit: DocumentCommit
      try {
        commit = await this.ctx.paperCommits.submit({
          documentId: imported.document.id,
          message: `导入：${imported.document.name}`,
          actor: {
            kind: 'human', name: '用户', client: 'paperai', sessionId: String(request.sessionId),
          },
          mutations: [{ type: 'milestone', label: `导入 ${request.fileName}` }],
          ...(signal === undefined ? {} : { signal }),
        })
      } catch (error) {
        try {
          await this.ctx.paperDocuments.rollbackImport(imported.document.id)
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            `PaperAI document '${String(imported.document.id)}' root commit and import rollback failed`,
          )
        }
        throw error
      }
      const current = this.requireDocument(imported.document.id)
      const opened = await this.projectOpen(project, current.document, current.nodes, request.sessionId, signal)
      return {
        status: 'imported',
        opened,
        createdCommitId: commit.id,
      }
    })
  }

  /**
   * List registered institutional packs and this project's compiled contracts.
   * @param request - Workspace whose template catalog should be projected.
   * @returns built-in pack choices and the project's installed contracts.
   * @throws when the Workspace or its PaperAI project cannot be resolved.
   */
  @Remote('listTemplates')
  async listTemplates(request: PaperAIListTemplatesRequest): Promise<PaperAITemplateCatalog> {
    const { project } = await this.projectForWorkspace(request.workspaceId)
    return this.templateCatalog(request.workspaceId, project)
  }

  /**
   * Install selected built-in pack members as reviewable draft contracts.
   * @param request - Workspace, pack identity, and optional member selection.
   * @param signal - optional cancellation signal for asset import and template compilation.
   * @returns the refreshed template catalog after installation.
   * @throws when the Workspace, pack, or member is unknown, or template compilation fails.
   */
  @Remote('installTemplatePack')
  async installTemplatePack(
    request: PaperAIInstallTemplatePackRequest,
    signal?: AbortSignal,
  ): Promise<PaperAITemplateCatalog> {
    const { project } = await this.projectForWorkspace(request.workspaceId)
    await this.ctx.paperTemplates.installPack({
      projectId: project.id,
      packId: TemplatePackId(request.packId),
      ...(request.memberIds === undefined
        ? {}
        : { memberIds: request.memberIds.map(TemplatePackMemberId) }),
    }, signal)
    return this.templateCatalog(request.workspaceId, project)
  }

  /**
   * Upload a custom Word template without mutating the selected source.
   * @param request - Workspace, upload bytes, display name, document roles, and template usage.
   * @param signal - optional cancellation signal for staging, normalization, and compilation.
   * @returns the refreshed template catalog containing the reviewable draft.
   * @throws when the upload or template metadata is invalid, or normalization or compilation fails.
   */
  @Remote('uploadTemplate')
  async uploadTemplate(
    request: PaperAIUploadTemplateRequest,
    signal?: AbortSignal,
  ): Promise<PaperAITemplateCatalog> {
    const { project } = await this.projectForWorkspace(request.workspaceId)
    await this.withUploadedWord(project, request.fileName, request.contentBase64, sourcePath => (
      this.ctx.paperTemplates.upload({
        projectId: project.id,
        sourcePath,
        name: request.name,
        appliesToRoles: request.appliesToRoles,
        usage: request.usage,
      }, signal)
    ))
    return this.templateCatalog(request.workspaceId, project)
  }

  /**
   * Confirm parsed template requirements before a document may use them.
   * @param request - Workspace and installed template identity selected by the user.
   * @returns the refreshed template catalog containing the confirmed contract.
   * @throws when the Workspace is missing or the template does not belong to its project.
   */
  @Remote('confirmTemplate')
  async confirmTemplate(request: PaperAIConfirmTemplateRequest): Promise<PaperAITemplateCatalog> {
    const { project } = await this.projectForWorkspace(request.workspaceId)
    const id = TemplateContractId(request.templateId)
    const contract = this.ctx.paperTemplates.getContract(id)
    if (contract === undefined || contract.projectId !== project.id) {
      throw new Error(`paperai-workbench: template '${request.templateId}' does not belong to this Workspace`)
    }
    await this.ctx.paperTemplates.confirm(id)
    return this.templateCatalog(request.workspaceId, project)
  }

  /**
   * Associate a confirmed compatible template through the document commit path.
   * @param request - document projection, Session provenance, and template identity to associate.
   * @param signal - optional cancellation signal for commit and refreshed projection work.
   * @returns the refreshed document projection and the new association commit identity.
   * @throws when the projection is stale or the template is missing, foreign, unconfirmed, incompatible, or already associated.
   */
  @Remote('associateTemplate')
  async associateTemplate(
    request: PaperAIAssociateTemplateRequest,
    signal?: AbortSignal,
  ): Promise<PaperAIDocumentCommitResult> {
    const id = DocumentId(String(request.documentId))
    const before = this.requireDocument(id)
    this.assertProjection(before.document, request.baseRevision, request.baseCommitId)
    const templateId = TemplateContractId(request.templateId)
    const contract = this.ctx.paperTemplates.getContract(templateId)
    if (contract === undefined || contract.projectId !== before.document.projectId) {
      throw new Error(`paperai-workbench: template '${templateId}' does not belong to this document's project`)
    }
    if (contract.status !== 'confirmed') {
      throw new Error(`paperai-workbench: template '${templateId}' must be confirmed before association`)
    }
    if (!contract.appliesToRoles.includes(before.document.role)) {
      throw new Error(`paperai-workbench: template '${templateId}' does not apply to '${before.document.role}' documents`)
    }
    if (before.document.templateId === templateId) {
      throw new Error(`paperai-workbench: template '${templateId}' is already associated`)
    }
    const commit = await this.ctx.paperCommits.submit({
      documentId: id,
      ...(request.baseCommitId === null ? {} : { baseCommitId: DocumentCommitId(String(request.baseCommitId)) }),
      message: `关联模板：${contract.name}`,
      actor: {
        kind: 'human', name: '用户', client: 'paperai', sessionId: String(request.sessionId),
      },
      mutations: [{ type: 'bind-template', templateId }],
      ...(signal === undefined ? {} : { signal }),
    })
    const after = this.requireDocument(id)
    this.fenceGateMutation(after.document, request.baseRevision)
    const project = this.requireProject(after.document.projectId)
    const opened = await this.projectOpen(project, after.document, after.nodes, request.sessionId, signal)
    return { ...opened, createdCommitId: commit.id }
  }

  /**
   * Export a draft or gated delivery DOCX into the project's output tree.
   * @param request - observed document projection, export mode, Session provenance, and optional file name.
   * @param signal - optional cancellation signal for validation, snapshot, publication, and refreshed projection work.
   * @returns export success with its milestone commit, or a delivery-gate rejection with no output or commit.
   * @throws when the projection or file name is invalid, or export work fails for a reason other than delivery-gate rejection.
   */
  @Remote('exportDocument')
  async exportDocument(
    request: PaperAIExportDocumentRequest,
    signal?: AbortSignal,
  ): Promise<PaperAIExportDocumentResult> {
    const id = DocumentId(String(request.documentId))
    const before = this.requireDocument(id)
    this.assertProjection(before.document, request.baseRevision, request.baseCommitId)
    const project = this.requireProject(before.document.projectId)
    const directory = join(
      project.rootPath,
      'exports',
      request.mode === 'draft-export' ? 'drafts' : 'delivery',
    )
    await mkdir(directory, { recursive: true })
    const fileName = this.exportFileName(
      request.fileName
        ?? `${before.document.name}${request.mode === 'draft-export' ? '-草稿' : ''}.docx`,
    )
    const gateOperation = this.beginGate(before.document)
    let exported: ExportDocumentResult
    try {
      exported = await this.ctx.paperExports.exportDocument({
        document: before.document,
        destinationPath: join(directory, fileName),
        mode: request.mode,
        actor: {
          kind: 'human', name: '用户', client: 'paperai', sessionId: String(request.sessionId),
        },
        ...(signal === undefined ? {} : { signal }),
      })
    } catch (error) {
      if (request.mode !== 'delivery-export'
        || !(error instanceof PaperExportError)
        || error.code !== 'DELIVERY_BLOCKED'
        || error.report === undefined) {
        throw error
      }
      const current = this.requireDocument(id)
      this.assertProjection(current.document, request.baseRevision, request.baseCommitId)
      const contract = current.document.templateId === undefined
        ? undefined
        : this.ctx.paperTemplates.getContract(current.document.templateId)
      const gate: PaperAITemplateGateReport = {
        ...projectGate(error.report, contract),
        status: 'failed',
      }
      this.rememberGate(current.document, gateOperation, gate)
      return {
        status: 'blocked',
        documentId: current.document.id,
        revision: revisionOf(current.document),
        headCommitId: headOf(current.document),
        fileName,
        gate,
      }
    }
    const after = this.requireDocument(id)
    const contract = after.document.templateId === undefined
      ? undefined
      : this.ctx.paperTemplates.getContract(after.document.templateId)
    const gate = projectGate(exported.report, contract)
    // The report covers the exported immutable commit, not a newer head published while file output completed.
    if (after.document.headCommitId === exported.commit.id) {
      this.rememberGate(after.document, gateOperation, gate)
    }
    const opened = await this.projectOpen(project, after.document, after.nodes, request.sessionId, signal)
    return {
      status: 'success',
      ...opened,
      createdCommitId: exported.commit.id,
      outputPath: exported.outputPath,
      fileName,
      gate,
    }
  }

  /**
   * Open a read-only Working DOCX projection and its first editable node.
   * @param request - Workspace, Session, and document resource to open.
   * @param signal - optional cancellation signal for preview generation.
   * @returns the current document projection and optional first editable-node buffer.
   * @throws when the Workspace or document is missing, mismatched, or cannot be projected.
   */
  @Remote('open')
  async open(request: PaperAIOpenDocumentRequest, signal?: AbortSignal): Promise<PaperAIDocumentOpenResult> {
    const { project } = await this.projectForWorkspace(request.workspaceId)
    const id = documentIdFromResource(request.resourceId)
    const snapshot = this.requireDocument(id)
    if (snapshot.document.projectId !== project.id) {
      throw new Error(`paperai-workbench: document '${id}' does not belong to Workspace '${request.workspaceId}'`)
    }
    return await this.projectOpen(project, snapshot.document, snapshot.nodes, request.sessionId, signal)
  }

  /**
   * Read one semantic node into a temporary plain-text edit buffer.
   * @param request - document projection identity and semantic node to read.
   * @param signal - optional cancellation signal for the node read.
   * @returns a fresh buffer tied to the observed revision and head commit.
   * @throws when the document or node is missing or the observed projection is stale.
   */
  @Remote('readNode')
  readNode(request: PaperAIReadNodeRequest, signal?: AbortSignal): Promise<PaperAISelectedNodeBuffer> {
    return Promise.resolve().then(() => {
      signal?.throwIfAborted()
      const snapshot = this.requireDocument(DocumentId(String(request.documentId)))
      this.assertProjection(snapshot.document, request.revision, request.headCommitId)
      return this.bufferFor(snapshot.document, snapshot.nodes, DocumentNodeId(String(request.nodeId)))
    })
  }

  /**
   * Apply selected-node mutations and create one immediate human commit.
   * @param request - observed document projection, Session provenance, and node text replacements.
   * @param signal - optional cancellation signal for mutation, commit, indexing, and preview work.
   * @returns the refreshed document projection and the new content commit identity.
   * @throws when no mutation is supplied, the projection is stale, or mutation or commit work fails.
   */
  @Remote('commit')
  async commit(
    request: PaperAICommitDocumentRequest,
    signal?: AbortSignal,
  ): Promise<PaperAIDocumentCommitResult> {
    const firstMutation = request.mutations[0]
    if (firstMutation === undefined) throw new Error('paperai-workbench: a commit requires at least one mutation')
    const id = DocumentId(String(request.documentId))
    const before = this.requireDocument(id)
    this.assertProjection(before.document, request.baseRevision, request.baseCommitId)
    const commit = await this.ctx.paperCommits.submit({
      documentId: id,
      ...(request.baseCommitId === null ? {} : { baseCommitId: DocumentCommitId(String(request.baseCommitId)) }),
      message: request.mutations.length === 1
        ? `修改：${compactLabel(firstMutation.nextText, '段落')}`
        : `修改 ${request.mutations.length} 个段落`,
      actor: {
        kind: 'human',
        name: '用户',
        client: 'paperai',
        sessionId: String(request.sessionId),
      },
      mutations: request.mutations.map(mutation => ({
        type: 'replace-text' as const,
        nodeId: DocumentNodeId(String(mutation.nodeId)),
        baseText: mutation.baseText,
        nextText: mutation.nextText,
      })),
      ...(signal === undefined ? {} : { signal }),
    })
    const after = this.requireDocument(id)
    this.fenceGateMutation(after.document, request.baseRevision)
    const project = this.requireProject(after.document.projectId)
    const opened = await this.projectOpen(
      project,
      after.document,
      after.nodes,
      request.sessionId,
      signal,
      DocumentNodeId(String(firstMutation.nodeId)),
    )
    return { ...opened, createdCommitId: commit.id }
  }

  /**
   * Run the live continuous template gate for one unchanged revision.
   * @param request - observed document projection to validate.
   * @param signal - optional cancellation signal for document-engine checks.
   * @returns the gate report tied to the unchanged revision and head commit.
   * @throws when the document is missing, the projection is stale, or gate evaluation fails.
   */
  @Remote('validate')
  async validate(
    request: PaperAIValidateDocumentRequest,
    signal?: AbortSignal,
  ): Promise<PaperAIValidateResult> {
    const id = DocumentId(String(request.documentId))
    const snapshot = this.requireDocument(id)
    this.assertProjection(snapshot.document, request.revision, request.headCommitId)
    const gateOperation = this.beginGate(snapshot.document)
    const report = await this.ctx.paperTemplates.check({ documentId: id, mode: 'continuous' }, signal)
    const contract = snapshot.document.templateId === undefined
      ? undefined
      : this.ctx.paperTemplates.getContract(snapshot.document.templateId)
    const gate = projectGate(report, contract)
    this.rememberGate(snapshot.document, gateOperation, gate)
    return {
      documentId: snapshot.document.id,
      revision: revisionOf(snapshot.document),
      headCommitId: headOf(snapshot.document),
      gate,
    }
  }

  /**
   * Restore one reachable version through a new human commit.
   * @param request - current document projection, target commit, and Session provenance.
   * @param signal - optional cancellation signal for restore, indexing, and preview work.
   * @returns the refreshed document projection and the new restoration commit identity.
   * @throws when the document has no head, the projection is stale, or the target is unreachable or cannot be restored.
   */
  @Remote('restore')
  async restore(
    request: PaperAIRestoreDocumentRequest,
    signal?: AbortSignal,
  ): Promise<PaperAIDocumentCommitResult> {
    if (request.baseCommitId === null) throw new Error('paperai-workbench: an unborn document has no version to restore')
    const id = DocumentId(String(request.documentId))
    const before = this.requireDocument(id)
    this.assertProjection(before.document, request.baseRevision, request.baseCommitId)
    const commit = await this.ctx.paperCommits.revert({
      documentId: id,
      baseCommitId: DocumentCommitId(String(request.baseCommitId)),
      targetCommitId: DocumentCommitId(String(request.targetCommitId)),
      message: `恢复版本 ${String(request.targetCommitId)}`,
      actor: {
        kind: 'human',
        name: '用户',
        client: 'paperai',
        sessionId: String(request.sessionId),
      },
      ...(signal === undefined ? {} : { signal }),
    })
    const after = this.requireDocument(id)
    this.fenceGateMutation(after.document, request.baseRevision)
    const project = this.requireProject(after.document.projectId)
    const opened = await this.projectOpen(project, after.document, after.nodes, request.sessionId, signal)
    return { ...opened, createdCommitId: commit.id }
  }

  private async projectForWorkspace(workspaceId: WorkspaceId): Promise<{ workspace: Workspace; project: ProjectRecord }> {
    const workspace = this.ctx.workspaceRegistry.get(WorkspaceId(String(workspaceId)))
    if (workspace === undefined) throw new Error(`paperai-workbench: Workspace '${workspaceId}' does not exist`)
    const initialized = await this.ctx.paperProjects.create({ rootPath: workspace.path, name: workspace.title })
    if (initialized.project.workspaceId !== String(workspace.id)) {
      throw new Error(`paperai-workbench: project '${initialized.project.id}' is associated with another Workspace`)
    }
    return { workspace, project: initialized.project }
  }

  private templateCatalog(workspaceId: WorkspaceId, project: ProjectRecord): PaperAITemplateCatalog {
    return {
      workspaceId,
      packs: this.ctx.paperTemplates.listPacks().map(pack => ({
        packId: String(pack.id),
        name: pack.name,
        description: pack.description,
        version: pack.version,
        members: pack.members.map(member => ({
          memberId: String(member.id),
          name: member.name,
          description: member.description,
          appliesToRoles: [...member.appliesToRoles],
          usage: member.usage,
          originalFileName: member.originalFileName,
        })),
      })),
      contracts: this.ctx.paperTemplates.listContracts(project.id).map(contractChoice),
    }
  }

  private async withUploadedWord<T>(
    project: ProjectRecord,
    fileName: string,
    contentBase64: string,
    operation: (sourcePath: string) => Promise<T>,
  ): Promise<T> {
    const normalizedName = this.uploadFileName(fileName)
    const bytes = this.decodeUpload(contentBase64)
    const stagingParent = join(project.rootPath, '.paperai', 'uploads', 'v1')
    await mkdir(stagingParent, { recursive: true })
    const requestRoot = await mkdtemp(join(stagingParent, 'request-'))
    const sourcePath = join(requestRoot, normalizedName)
    try {
      await writeFile(sourcePath, bytes, { flag: 'wx' })
      return await operation(sourcePath)
    } finally {
      await rm(requestRoot, { recursive: true, force: true })
    }
  }

  private uploadFileName(value: string): string {
    const name = value.normalize('NFC')
    const extension = extname(name).toLocaleLowerCase('en-US')
    if (basename(name) !== name
      || !SAFE_UPLOAD_NAME.test(name)
      || (extension !== '.doc' && extension !== '.docx')) {
      throw new Error(`paperai-workbench: upload '${value}' must be a safe .doc or .docx file name`)
    }
    return name
  }

  private exportFileName(value: string): string {
    const name = value.normalize('NFC')
    if (basename(name) !== name
      || !SAFE_UPLOAD_NAME.test(name)
      || extname(name).toLocaleLowerCase('en-US') !== '.docx') {
      throw new Error(`paperai-workbench: export '${value}' must be a safe .docx file name`)
    }
    return name
  }

  private decodeUpload(value: string): Uint8Array {
    const estimatedBytes = Math.floor(value.length * 3 / 4)
    if (estimatedBytes > this.maxUploadBytes || value.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) {
      throw new Error(`paperai-workbench: upload is not canonical base64 within ${this.maxUploadBytes} bytes`)
    }
    const bytes = Buffer.from(value, 'base64')
    if (bytes.length === 0
      || bytes.length > this.maxUploadBytes
      || bytes.toString('base64') !== value) {
      throw new Error(`paperai-workbench: upload is not canonical base64 within ${this.maxUploadBytes} bytes`)
    }
    return bytes
  }

  private requireDocument(documentId: DocumentId) {
    const snapshot = this.ctx.paperDocuments.readDocument(documentId)
    if (snapshot === undefined) throw new Error(`paperai-workbench: document '${documentId}' does not exist`)
    return snapshot
  }

  private requireProject(projectId: ProjectRecord['id']): ProjectRecord {
    const project = this.ctx.paperProjects.get(projectId)
    if (project === undefined) throw new Error(`paperai-workbench: project '${projectId}' does not exist`)
    return project
  }

  private assertProjection(
    document: DocumentRecord,
    revision: PaperAIDocumentRevision,
    headCommitId: PaperAIDocumentCommitId | null,
  ): void {
    if (revisionOf(document) !== revision || !sameHead(document, headCommitId)) {
      throw new Error(`paperai-workbench: document '${document.id}' changed; reload before applying this action`)
    }
  }

  private bufferFor(
    document: DocumentRecord,
    nodes: readonly DocumentNode[],
    nodeId: DocumentNode['id'],
  ): PaperAISelectedNodeBuffer {
    const node = nodes.find(candidate => candidate.id === nodeId)
    if (node === undefined) throw new Error(`paperai-workbench: node '${nodeId}' does not belong to document '${document.id}'`)
    const summary = nodeSummary(node)
    if (!summary.editable) throw new Error(`paperai-workbench: node '${nodeId}' is not text-editable`)
    return {
      documentId: document.id,
      nodeId: node.id,
      label: summary.label,
      kind: summary.kind,
      baseRevision: revisionOf(document),
      baseCommitId: headOf(document),
      format: 'text',
      text: node.text,
    }
  }

  private async projectOpen(
    project: ProjectRecord,
    document: DocumentRecord,
    nodes: readonly DocumentNode[],
    sessionId: SessionId,
    signal?: AbortSignal,
    selectedNodeId?: DocumentNode['id'],
  ): Promise<PaperAIDocumentOpenResult> {
    const previewHtml = await this.ctx.paperDocuments.previewHtml(document.id, signal)
    const history = this.ctx.paperCommits.listHistory(document.id)
    const contract = document.templateId === undefined
      ? undefined
      : this.ctx.paperTemplates.getContract(document.templateId)
    const snapshot: PaperAIDocumentSnapshot = {
      documentId: document.id,
      resourceId: resourceId(document.id),
      workspaceId: WorkspaceId(project.workspaceId),
      sessionId,
      title: document.name,
      role: document.role,
      path: relativeDisplayPath(project, document.workingPath),
      revision: revisionOf(document),
      headCommitId: headOf(document),
      previewHtml,
      nodes: nodes.map(nodeSummary),
      versions: history.map(commit => versionOf(commit, document.headCommitId)),
      template: templateSummary(contract),
      gate: this.gateFor(document) ?? { status: 'not-run', findings: [] },
    }
    const selected = selectedNodeId === undefined
      ? nodes.find(node => nodeSummary(node).editable)
      : nodes.find(node => node.id === selectedNodeId)
    return {
      document: snapshot,
      selectedNode: selected === undefined ? null : this.bufferFor(document, nodes, selected.id),
    }
  }

  private gateFor(document: DocumentRecord): PaperAITemplateGateReport | undefined {
    const cached = this.gateCache.get(document.id)?.cached
    return cached?.revision === revisionOf(document) ? cached.report : undefined
  }

  private beginGate(document: DocumentRecord): GateOperation {
    const operation = { id: Symbol(), sourceRevision: revisionOf(document) }
    const cached = this.gateCache.get(document.id)?.cached
    this.gateCache.set(document.id, cached === undefined ? { operation } : { operation, cached })
    return operation
  }

  private rememberGate(
    document: DocumentRecord,
    operation: GateOperation,
    report: PaperAITemplateGateReport,
  ): void {
    const revision = revisionOf(document)
    const active = this.gateCache.get(document.id)?.operation
    const ownsSlot = active?.id === operation.id
    // A milestone invalidates every gate claim that began from its exported source revision.
    const advancesActiveSource = operation.sourceRevision !== revision
      && active?.sourceRevision === operation.sourceRevision
    if (!ownsSlot && !advancesActiveSource) return
    const current = this.ctx.paperDocuments.readDocument(document.id)
    if (current === undefined || revisionOf(current.document) !== revision) return
    this.gateCache.set(document.id, {
      operation: { id: operation.id, sourceRevision: revision },
      cached: { revision, report },
    })
  }

  private fenceGateMutation(document: DocumentRecord, sourceRevision: PaperAIDocumentRevision): void {
    if (this.gateCache.get(document.id)?.operation.sourceRevision !== sourceRevision) return
    this.gateCache.set(document.id, {
      operation: { id: Symbol(), sourceRevision: revisionOf(document) },
    })
  }
}

export default PaperAiWorkbenchService
