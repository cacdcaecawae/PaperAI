/** PaperAI DSH workbench Host Remote over authoritative domain services. */

import { Buffer } from 'node:buffer'
import { basename, extname, join, relative, sep } from 'node:path'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type { Workspace } from '@deepseek-ai/dsh-workspace/types'
import type {} from '@paperai/commit-service'
import type {} from '@paperai/document-engine'
import type {} from '@paperai/document-service'
import { PaperExportError, type ExportDocumentResult } from '@paperai/export-service'
import {
  DocumentCommitId,
  DocumentId,
  DocumentNodeId,
} from '@paperai/domain'
import type {
  DocumentCommit,
  DocumentMutation,
  DocumentNode,
  DocumentRecord,
  DocumentRole,
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
import type { TemplateLibraryPack, TemplatePackSummary } from '@paperai/template-service'
import { diffParagraphs } from './diff.ts'
import type {
  PaperAIAddTemplateFormatRequest,
  PaperAIApplyTemplateRequest,
  PaperAICommitDocumentRequest,
  PaperAICreateFromTemplateRequest,
  PaperAICreateTemplateSetRequest,
  PaperAIDeleteTemplateSetRequest,
  PaperAIDetachTemplateRequest,
  PaperAIDiffVersionRequest,
  PaperAIDocumentCommitId,
  PaperAIDocumentCommitResult,
  PaperAIDocumentChangedEvent,
  PaperAIDocumentId,
  PaperAIDocumentNodeSummary,
  PaperAIDocumentOpenResult,
  PaperAIDocumentRevision,
  PaperAIDocumentRow,
  PaperAIDocumentSnapshot,
  PaperAIDocumentType,
  PaperAIDocumentTypeSuggestion,
  PaperAIDocumentVersion,
  PaperAIExportDocumentRequest,
  PaperAIExportDocumentResult,
  PaperAIFormatChoice,
  PaperAIGateFinding,
  PaperAIImportDocumentRequest,
  PaperAIImportDocumentResult,
  PaperAIOpenDocumentRequest,
  PaperAIOverviewRequest,
  PaperAIProjectOverview,
  PaperAIReadNodeRequest,
  PaperAIRemoveTemplateFormatRequest,
  PaperAIResourceId,
  PaperAIRestoreDocumentRequest,
  PaperAISelectedNodeBuffer,
  PaperAISetProjectTemplateRequest,
  PaperAISuggestDocumentTypeRequest,
  PaperAITemplateGateReport,
  PaperAITemplateLibrary,
  PaperAITemplateSetChoice,
  PaperAITemplateSummary,
  PaperAIValidateDocumentRequest,
  PaperAIValidateResult,
  PaperAIVersionDiff,
} from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    paperaiWorkbench: PaperAiWorkbenchService
  }
}

const RESOURCE_PREFIX = 'document:'
const DEFAULT_MAX_UPLOAD_BYTES = 128 * 1024 * 1024
/** Characters Windows and POSIX file systems reject in a file name, plus control characters. */
const FORBIDDEN_NAME_CHARACTERS = new Set(['<', '>', ':', '"', '/', String.fromCharCode(92), '|', '?', '*'])

function isSafeFileName(name: string): boolean {
  if (name.length === 0) return false
  for (const character of name) {
    const code = character.codePointAt(0) ?? 0
    if (FORBIDDEN_NAME_CHARACTERS.has(character) || code <= 0x1f || code === 0x7f) return false
  }
  return true
}
/** Paragraphs inspected when guessing a document type from its opening text. */
const TYPE_GUESS_PARAGRAPHS = 12
/** Title or opening-text keywords that name a document type, most specific first. */
const TYPE_KEYWORDS: readonly (readonly [RegExp, PaperAIDocumentType])[] = [
  [/开题/u, 'proposal'],
  [/中期/u, 'midterm'],
  [/结题|答辩|验收/u, 'final'],
  [/学位论文|毕业论文|论文/u, 'manuscript'],
]

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
    text: node.text,
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

/** One member applies to one or more document types; each pairing is a format the start page can offer. */
function formatChoices(member: TemplatePackSummary['members'][number]): PaperAIFormatChoice[] {
  return member.appliesToRoles.map(role => ({
    memberId: String(member.id),
    documentType: role,
    name: member.name,
    usage: member.usage,
    sourceVersion: member.sourceVersion,
    originalFileName: member.originalFileName,
  }))
}

function setChoice(pack: TemplatePackSummary): PaperAITemplateSetChoice {
  return {
    packId: String(pack.id),
    kind: pack.kind,
    name: pack.name,
    description: pack.description,
    formats: pack.members.flatMap(formatChoices),
  }
}

/** An empty custom set is not installable yet, but the library still lists it so the user can fill it. */
function emptySetChoice(pack: TemplateLibraryPack): PaperAITemplateSetChoice {
  return {
    packId: pack.id,
    kind: 'custom',
    name: pack.name,
    description: pack.description,
    formats: [],
  }
}

/** The same empty set in pack-summary form, so a project may choose it before adding formats. */
function emptyPackSummary(pack: TemplateLibraryPack): TemplatePackSummary {
  return {
    id: TemplatePackId(pack.id),
    kind: 'custom',
    name: pack.name,
    description: pack.description,
    version: 'custom',
    sourceLabel: '用户添加',
    members: [],
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

/** Guess a document type from its title, then its opening paragraphs. */
function guessDocumentType(
  document: DocumentRecord,
  nodes: readonly DocumentNode[],
): PaperAIDocumentTypeSuggestion {
  for (const [pattern, documentType] of TYPE_KEYWORDS) {
    if (pattern.test(document.name)) return { documentId: document.id, documentType, basis: 'title' }
  }
  const opening = nodes
    .map(node => node.text.trim())
    .filter(text => text.length > 0)
    .slice(0, TYPE_GUESS_PARAGRAPHS)
    .join('\n')
  for (const [pattern, documentType] of TYPE_KEYWORDS) {
    if (pattern.test(opening)) return { documentId: document.id, documentType, basis: 'content' }
  }
  return { documentId: document.id, documentType: document.role, basis: 'current' }
}

/** Strict Remote that keeps the DSH client free of PaperAI Host dependencies. */
export class PaperAiWorkbenchService extends TypertRemoteService {
  static inject = [
    'workspaceRegistry',
    'documentEngine',
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
   * Lazily initialize the selected Workspace's project and describe it: the
   * template set it writes against and its tracked documents.
   * @param request - Workspace whose project should be described.
   * @param signal - optional cancellation signal for project initialization.
   * @returns the project name, template decision, and document rows.
   * @throws when the Workspace or its PaperAI project cannot be resolved.
   */
  @Remote('overview')
  async overview(request: PaperAIOverviewRequest, signal?: AbortSignal): Promise<PaperAIProjectOverview> {
    signal?.throwIfAborted()
    const { project } = await this.projectForWorkspace(request.workspaceId)
    return this.projectOverview(request.workspaceId, project)
  }

  /**
   * Record the template set the project writes against, or the explicit
   * choice to write without one.
   * @param request - Workspace and template set id, or `null` for none.
   * @returns the refreshed overview.
   * @throws when the Workspace is unknown or the set is not in the library.
   */
  @Remote('setProjectTemplate')
  async setProjectTemplate(request: PaperAISetProjectTemplateRequest): Promise<PaperAIProjectOverview> {
    const { project } = await this.projectForWorkspace(request.workspaceId)
    if (request.packId !== null && this.findSet(request.packId) === undefined) {
      throw new Error(`paperai-workbench: template set '${request.packId}' is not in the library`)
    }
    const updated = await this.ctx.paperProjects.setTemplateChoice(project.id, request.packId)
    return this.projectOverview(request.workspaceId, updated)
  }

  /**
   * List every template set the user can choose from.
   * @returns built-in sets, then custom sets in creation order (empty ones included).
   */
  @Remote('listTemplateLibrary')
  listTemplateLibrary(): Promise<PaperAITemplateLibrary> {
    return Promise.resolve(this.templateLibrary())
  }

  /**
   * Create an empty custom template set.
   * @param request - display name and optional description.
   * @returns the refreshed library.
   * @throws when the name is blank or already used.
   */
  @Remote('createTemplateSet')
  async createTemplateSet(request: PaperAICreateTemplateSetRequest): Promise<PaperAITemplateLibrary> {
    await this.ctx.paperTemplates.createLibraryPack({
      name: request.name,
      ...(request.description === undefined ? {} : { description: request.description }),
    })
    return this.templateLibrary()
  }

  /**
   * Remove a custom template set. Projects that chose it fall back to
   * "no template" on their next overview; installed formats keep working.
   * @param request - custom set id.
   * @returns the refreshed library.
   * @throws when the set is unknown or built-in.
   */
  @Remote('deleteTemplateSet')
  async deleteTemplateSet(request: PaperAIDeleteTemplateSetRequest): Promise<PaperAITemplateLibrary> {
    await this.ctx.paperTemplates.deleteLibraryPack(request.packId)
    return this.templateLibrary()
  }

  /**
   * Add or replace the Word format for one document type in a custom set.
   * @param request - set, document type, usage, optional name, and the upload.
   * @param signal - optional cancellation signal for staging and normalization.
   * @returns the refreshed library.
   * @throws when the set is unknown, the upload is invalid, or normalization fails.
   */
  @Remote('addTemplateFormat')
  async addTemplateFormat(
    request: PaperAIAddTemplateFormatRequest,
    signal?: AbortSignal,
  ): Promise<PaperAITemplateLibrary> {
    await this.ctx.paperTemplates.addLibraryFormat({
      packId: request.packId,
      role: request.documentType,
      usage: request.usage,
      ...(request.name === undefined ? {} : { name: request.name }),
      upload: {
        fileName: this.uploadFileName(request.fileName),
        bytes: this.decodeUpload(request.contentBase64),
      },
    }, signal)
    return this.templateLibrary()
  }

  /**
   * Remove the format for one document type from a custom set.
   * @param request - custom set id and document type.
   * @returns the refreshed library.
   * @throws when the set or format is unknown.
   */
  @Remote('removeTemplateFormat')
  async removeTemplateFormat(request: PaperAIRemoveTemplateFormatRequest): Promise<PaperAITemplateLibrary> {
    await this.ctx.paperTemplates.removeLibraryFormat(request.packId, request.documentType)
    return this.templateLibrary()
  }

  /**
   * Import one browser-selected `.doc` or `.docx` as a free-writing document
   * and establish its root version. A rejected root submission is followed
   * by non-cancellable import rollback before this method settles.
   * @param request - Workspace, Session, upload bytes, and optional display name.
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
    return await this.withUploadedWord(project, request.fileName, request.contentBase64, sourcePath => (
      this.establishDocument(project, {
        sourcePath,
        role: 'other',
        ...(request.name === undefined ? {} : { name: request.name }),
      }, {
        sessionId: request.sessionId,
        messagePrefix: '导入',
        milestone: `导入 ${request.fileName}`,
      }, signal)
    ))
  }

  /**
   * Start one document of a given type from the project's template set and
   * bind that format in the root commit. A form template is imported as the
   * document itself; a formatting reference governs the uploaded manuscript
   * instead. Library formats ship reviewed requirements, so the contract is
   * confirmed here without a separate review step.
   * @param request - Workspace, Session, document type, optional manuscript upload, and display name.
   * @param signal - optional cancellation signal for installation, import, commit, and preview work.
   * @returns the opened document and root commit, or an explicit native-engine downgrade.
   * @throws when the project has no template set or no format for the type, a formatting reference
   * has no upload, or import or commit work fails; an AggregateError includes any rollback failure.
   */
  @Remote('createFromTemplate')
  async createFromTemplate(
    request: PaperAICreateFromTemplateRequest,
    signal?: AbortSignal,
  ): Promise<PaperAIImportDocumentResult> {
    const { project } = await this.projectForWorkspace(request.workspaceId)
    const { set, format } = this.requireProjectFormat(project, request.documentType)
    const contract = await this.installFormat(project, set, format, signal)
    const name = request.name ?? format.name
    const establish = (sourcePath: string): Promise<PaperAIImportDocumentResult> => (
      this.establishDocument(project, { sourcePath, role: request.documentType, name }, {
        sessionId: request.sessionId,
        messagePrefix: '从模板新建',
        milestone: `从模板新建 ${format.name}`,
        templateId: contract.id,
      }, signal)
    )
    // The format's usage decides the content source, never the caller: a form
    // template is the document, so no upload may replace it; a formatting
    // reference governs an upload, so one is required.
    if (contract.usage === 'form-template') {
      if (request.upload !== undefined) {
        throw new Error(
          `paperai-workbench: format '${format.name}' is a form template that becomes the document itself; it accepts no upload`,
        )
      }
      const source = this.ctx.paperRepository.getDocument(contract.sourceDocumentId)
      if (source === undefined) {
        throw new Error(`paperai-workbench: template '${contract.id}' has no stored source document`)
      }
      return await establish(source.workingPath)
    }
    if (request.upload === undefined) {
      throw new Error(
        `paperai-workbench: format '${format.name}' is a formatting reference; upload the manuscript it should format`,
      )
    }
    return await this.withUploadedWord(project, request.upload.fileName, request.upload.contentBase64, establish)
  }

  /**
   * Bind the project template's format for a document type through the
   * document commit path, changing the document's type in the same commit
   * when it differs.
   * @param request - document projection, Session provenance, and the document type to apply.
   * @param signal - optional cancellation signal for installation, commit, and refreshed projection work.
   * @returns the refreshed document projection and the new binding commit identity.
   * @throws when the projection is stale, the project has no template set or format for the type,
   * or the same format is already bound.
   */
  @Remote('applyTemplate')
  async applyTemplate(
    request: PaperAIApplyTemplateRequest,
    signal?: AbortSignal,
  ): Promise<PaperAIDocumentCommitResult> {
    const id = DocumentId(String(request.documentId))
    const before = this.requireDocument(id)
    this.assertProjection(before.document, request.baseRevision, request.baseCommitId)
    const project = this.requireProject(before.document.projectId)
    const { set, format } = this.requireProjectFormat(project, request.documentType)
    const contract = await this.installFormat(project, set, format, signal)
    if (before.document.templateId === contract.id && before.document.role === request.documentType) {
      throw new Error(`paperai-workbench: format '${format.name}' is already bound`)
    }
    const mutations: DocumentMutation[] = [
      ...(before.document.role === request.documentType
        ? []
        : [{ type: 'set-document-type' as const, documentType: request.documentType }]),
      { type: 'bind-template', templateId: contract.id },
    ]
    const commit = await this.ctx.paperCommits.submit({
      documentId: id,
      ...(request.baseCommitId === null ? {} : { baseCommitId: DocumentCommitId(String(request.baseCommitId)) }),
      message: `套用模板：${set.name} · ${format.name}`,
      actor: {
        kind: 'human', name: '用户', client: 'paperai', sessionId: String(request.sessionId),
      },
      mutations,
      ...(signal === undefined ? {} : { signal }),
    })
    return await this.commitResult(id, request.baseRevision, request.sessionId, commit, signal)
  }

  /**
   * Drop the bound format through the document commit path; the document
   * keeps its type and writes freely from then on.
   * @param request - document projection and Session provenance.
   * @param signal - optional cancellation signal for commit and refreshed projection work.
   * @returns the refreshed document projection and the new commit identity.
   * @throws when the projection is stale or no format is bound.
   */
  @Remote('detachTemplate')
  async detachTemplate(
    request: PaperAIDetachTemplateRequest,
    signal?: AbortSignal,
  ): Promise<PaperAIDocumentCommitResult> {
    const id = DocumentId(String(request.documentId))
    const before = this.requireDocument(id)
    this.assertProjection(before.document, request.baseRevision, request.baseCommitId)
    if (before.document.templateId === undefined) {
      throw new Error(`paperai-workbench: document '${id}' has no bound format`)
    }
    const commit = await this.ctx.paperCommits.submit({
      documentId: id,
      ...(request.baseCommitId === null ? {} : { baseCommitId: DocumentCommitId(String(request.baseCommitId)) }),
      message: '解除模板绑定',
      actor: {
        kind: 'human', name: '用户', client: 'paperai', sessionId: String(request.sessionId),
      },
      mutations: [{ type: 'unbind-template' }],
      ...(signal === undefined ? {} : { signal }),
    })
    return await this.commitResult(id, request.baseRevision, request.sessionId, commit, signal)
  }

  /**
   * Guess a document's type from its title, then its opening paragraphs.
   * @param request - document to inspect.
   * @returns the guessed type and what it was based on; the current type when nothing matches.
   * @throws when the document is unknown.
   */
  @Remote('suggestDocumentType')
  suggestDocumentType(request: PaperAISuggestDocumentTypeRequest): Promise<PaperAIDocumentTypeSuggestion> {
    return Promise.resolve().then(() => {
      const snapshot = this.requireDocument(DocumentId(String(request.documentId)))
      return guessDocumentType(snapshot.document, snapshot.nodes)
    })
  }

  /**
   * Diff one version against its parent at paragraph level, reading both
   * immutable snapshots through the document engine.
   * @param request - document and version to explain.
   * @param signal - optional cancellation signal for engine reads.
   * @returns paragraph changes in document order; a root version lists every paragraph as added.
   * @throws when the version does not belong to the document.
   */
  @Remote('diffVersion')
  async diffVersion(request: PaperAIDiffVersionRequest, signal?: AbortSignal): Promise<PaperAIVersionDiff> {
    const documentId = DocumentId(String(request.documentId))
    this.requireDocument(documentId)
    const commit = this.ctx.paperRepository.getCommit(DocumentCommitId(String(request.commitId)))
    if (commit === undefined || String(commit.documentId) !== String(documentId)) {
      throw new Error(`paperai-workbench: version '${request.commitId}' does not belong to document '${documentId}'`)
    }
    const parent = commit.parentId === undefined
      ? undefined
      : this.ctx.paperRepository.getCommit(commit.parentId)
    if (commit.parentId !== undefined && parent === undefined) {
      throw new Error(`paperai-workbench: version '${commit.id}' references missing parent '${commit.parentId}'`)
    }
    const [before, after] = await Promise.all([
      parent === undefined ? Promise.resolve([]) : this.ctx.documentEngine.readTextNodes(parent.snapshotPath, signal),
      this.ctx.documentEngine.readTextNodes(commit.snapshotPath, signal),
    ])
    const paragraphs = (nodes: readonly { text: string }[]): string[] => nodes.map(node => node.text)
    const diff = diffParagraphs(paragraphs(before), paragraphs(after))
    return {
      documentId,
      commitId: commit.id,
      parentCommitId: parent?.id ?? null,
      changes: diff.changes,
      unchangedCount: diff.unchangedCount,
    }
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
      const contract = this.contractOf(current.document)
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
    const gate = projectGate(exported.report, this.contractOf(after.document))
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
   * Apply block text mutations and create one immediate human commit.
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
    return await this.commitResult(
      id, request.baseRevision, request.sessionId, commit, signal, DocumentNodeId(String(firstMutation.nodeId)),
    )
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
    const gate = projectGate(report, this.contractOf(snapshot.document))
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
    return await this.commitResult(id, request.baseRevision, request.sessionId, commit, signal)
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

  private projectOverview(workspaceId: WorkspaceId, project: ProjectRecord): PaperAIProjectOverview {
    const template = project.templatePackId === undefined ? undefined : this.findSet(project.templatePackId)
    const documents: PaperAIDocumentRow[] = this.ctx.paperDocuments.listDocuments(project.id)
      .map((document): PaperAIDocumentRow => ({
        id: resourceId(document.id),
        documentId: document.id,
        name: document.name,
        fileName: basename(document.workingPath),
        documentType: document.role,
        templateName: this.contractOf(document)?.name ?? null,
        updatedAt: document.updatedAt,
      }))
    return {
      workspaceId,
      projectName: project.name,
      templateDecided: project.templateDecidedAt !== undefined,
      templatePackId: project.templatePackId ?? null,
      template: template === undefined ? null : setChoice(template),
      documents,
    }
  }

  private templateLibrary(): PaperAITemplateLibrary {
    const installable = this.ctx.paperTemplates.listPacks().map(setChoice)
    const listed = new Set(installable.map(set => set.packId))
    const empty = this.ctx.paperTemplates.listLibraryPacks()
      .filter(pack => !listed.has(pack.id))
      .map(emptySetChoice)
    return { sets: [...installable, ...empty] }
  }

  /** A set by id: installable packs first, then custom sets that hold no format yet. */
  private findSet(packId: string): TemplatePackSummary | undefined {
    const installable = this.ctx.paperTemplates.listPacks().find(pack => String(pack.id) === packId)
    if (installable !== undefined) return installable
    const empty = this.ctx.paperTemplates.listLibraryPacks().find(pack => pack.id === packId)
    return empty === undefined ? undefined : emptyPackSummary(empty)
  }

  private requireProjectFormat(
    project: ProjectRecord,
    documentType: PaperAIDocumentType,
  ): { set: TemplatePackSummary; format: TemplatePackSummary['members'][number] } {
    if (project.templatePackId === undefined) {
      throw new Error(`paperai-workbench: project '${project.id}' has no template set`)
    }
    const set = this.findSet(project.templatePackId)
    if (set === undefined) {
      throw new Error(`paperai-workbench: template set '${project.templatePackId}' is no longer in the library`)
    }
    const format = set.members.find(member => member.appliesToRoles.includes(documentType))
    if (format === undefined) {
      throw new Error(`paperai-workbench: template set '${set.name}' has no format for '${documentType}' documents`)
    }
    return { set, format }
  }

  /** Install one format's contract for the project and confirm it; repeat installs reuse the contract. */
  private async installFormat(
    project: ProjectRecord,
    set: TemplatePackSummary,
    format: TemplatePackSummary['members'][number],
    signal?: AbortSignal,
  ): Promise<TemplateContract> {
    const [installed] = await this.ctx.paperTemplates.installPack({
      projectId: project.id,
      packId: TemplatePackId(String(set.id)),
      memberIds: [TemplatePackMemberId(String(format.id))],
    }, signal)
    /* v8 ignore next 3 -- installPack rejects an unknown member instead of returning an empty list. */
    if (installed === undefined) {
      throw new Error(`paperai-workbench: template set '${set.name}' has no format '${format.name}'`)
    }
    return installed.status === 'confirmed'
      ? installed
      : await this.ctx.paperTemplates.confirm(installed.id)
  }

  /**
   * Import a Word source, create its root version, and open it. A rejected
   * root submission is followed by non-cancellable import rollback.
   */
  private async establishDocument(
    project: ProjectRecord,
    source: { readonly sourcePath: string; readonly role: DocumentRole; readonly name?: string },
    root: {
      readonly sessionId: SessionId
      /** Commit message verb; the published document name follows it. */
      readonly messagePrefix: string
      readonly milestone: string
      readonly templateId?: TemplateContract['id']
    },
    signal?: AbortSignal,
  ): Promise<PaperAIImportDocumentResult> {
    const imported = await this.ctx.paperDocuments.importDocument({ projectId: project.id, ...source }, signal)
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
        message: `${root.messagePrefix}：${imported.document.name}`,
        actor: {
          kind: 'human', name: '用户', client: 'paperai', sessionId: String(root.sessionId),
        },
        mutations: [
          { type: 'milestone', label: root.milestone },
          ...(root.templateId === undefined ? [] : [{ type: 'bind-template' as const, templateId: root.templateId }]),
        ],
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
    // The root commit is the commit point: the document and its version exist
    // now, so neither a preview failure nor a caller cancellation may report
    // the creation as failed (a retry would create a second document). The
    // projection runs without the caller's signal and tolerates a missing preview.
    const current = this.requireDocument(imported.document.id)
    const opened = await this.projectOpen(
      project, current.document, current.nodes, root.sessionId, undefined, undefined, 'best-effort',
    )
    return {
      status: 'imported',
      opened,
      createdCommitId: commit.id,
    }
  }

  /** Project the document after a commit, fencing stale gate claims from the pre-commit revision. */
  private async commitResult(
    id: DocumentId,
    baseRevision: PaperAIDocumentRevision,
    sessionId: SessionId,
    commit: DocumentCommit,
    signal?: AbortSignal,
    selectedNodeId?: DocumentNode['id'],
  ): Promise<PaperAIDocumentCommitResult> {
    const after = this.requireDocument(id)
    this.fenceGateMutation(after.document, baseRevision)
    const project = this.requireProject(after.document.projectId)
    const opened = await this.projectOpen(project, after.document, after.nodes, sessionId, signal, selectedNodeId)
    return { ...opened, createdCommitId: commit.id }
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
      || !isSafeFileName(name)
      || (extension !== '.doc' && extension !== '.docx')) {
      throw new Error(`paperai-workbench: upload '${value}' must be a safe .doc or .docx file name`)
    }
    return name
  }

  private exportFileName(value: string): string {
    const name = value.normalize('NFC')
    if (basename(name) !== name
      || !isSafeFileName(name)
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

  private contractOf(document: DocumentRecord): TemplateContract | undefined {
    return document.templateId === undefined
      ? undefined
      : this.ctx.paperTemplates.getContract(document.templateId)
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

  private templateSummary(contract: TemplateContract | undefined): PaperAITemplateSummary | null {
    if (contract === undefined) return null
    const pack = contract.origin.packId === undefined ? undefined : this.findSet(contract.origin.packId)
    return {
      templateId: String(contract.id),
      name: contract.name,
      kind: pack?.kind ?? (contract.origin.kind === 'built-in' ? 'built-in' : 'custom'),
      ...(contract.origin.packId === undefined ? {} : { packId: contract.origin.packId }),
      ...(pack === undefined ? {} : { packName: pack.name }),
      ...(contract.origin.memberId === undefined ? {} : { memberId: contract.origin.memberId }),
      ...(contract.origin.sourceVersion === undefined ? {} : { sourceVersion: contract.origin.sourceVersion }),
      usage: contract.usage,
      requirements: contract.rules.map(rule => ({
        ruleId: String(rule.id),
        kind: rule.kind,
        label: rule.label,
        description: rule.description,
        severity: rule.severity,
        enabled: rule.enabled,
      })),
    }
  }

  private async projectOpen(
    project: ProjectRecord,
    document: DocumentRecord,
    nodes: readonly DocumentNode[],
    sessionId: SessionId,
    signal?: AbortSignal,
    selectedNodeId?: DocumentNode['id'],
    preview: 'required' | 'best-effort' = 'required',
  ): Promise<PaperAIDocumentOpenResult> {
    const previewHtml = await this.previewFor(document.id, signal, preview)
    const history = this.ctx.paperCommits.listHistory(document.id)
    const contract = this.contractOf(document)
    const projectSet = project.templatePackId === undefined ? undefined : this.findSet(project.templatePackId)
    const snapshot: PaperAIDocumentSnapshot = {
      documentId: document.id,
      resourceId: resourceId(document.id),
      workspaceId: WorkspaceId(project.workspaceId),
      sessionId,
      title: document.name,
      documentType: document.role,
      path: relativeDisplayPath(project, document.workingPath),
      revision: revisionOf(document),
      headCommitId: headOf(document),
      previewHtml,
      nodes: nodes.map(nodeSummary),
      versions: history.map(commit => versionOf(commit, document.headCommitId)),
      template: this.templateSummary(contract),
      projectFormatAvailable: projectSet !== undefined
        && projectSet.members.some(member => member.appliesToRoles.includes(document.role)),
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

  /**
   * Render the read-only preview. After a commit point the projection must
   * still describe the document the caller now owns, so `best-effort` turns a
   * preview failure into an empty preview (the browser shows its unavailable
   * notice) and logs the cause instead of failing the whole result.
   */
  private async previewFor(
    documentId: DocumentId,
    signal: AbortSignal | undefined,
    preview: 'required' | 'best-effort',
  ): Promise<string> {
    if (preview === 'required') return await this.ctx.paperDocuments.previewHtml(documentId, signal)
    try {
      return await this.ctx.paperDocuments.previewHtml(documentId, signal)
    } catch (error: unknown) {
      this.ctx.logger.warn(
        `paperai-workbench: preview unavailable for document '${String(documentId)}' after its root commit: ${String(error)}`,
      )
      return ''
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
