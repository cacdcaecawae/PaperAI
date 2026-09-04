/**
 * PaperAI template service (`ctx.paperTemplates`): built-in pack registry,
 * immutable imports, OfficeCLI contract compilation, confirmation, role-safe
 * association, and live delivery checks.
 * @module @paperai/template-service
 */

import { createHash } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  DocumentId,
  TemplateContractId,
} from '@paperai/domain'
import type {
  DocumentRecord,
  GateReport,
  ProjectId,
  TemplateContract,
  TemplateOrigin,
} from '@paperai/domain'
import type PaperRepository from '@paperai/repository'
import { compileTemplateDraft } from './compiler.ts'
import type { CompiledTemplateDraft } from './compiler.ts'
import { checkTemplateContract } from './gate.ts'
import { TemplateLibrary } from './library.ts'
import type { AddLibraryFormatInput, TemplateLibraryPack } from './library.ts'
import { TemplateAssetStore } from './storage.ts'
import type { TemplateAssetStoreConfig } from './storage.ts'
import type {
  AssociateTemplateInput,
  CheckTemplateCandidateInput,
  CheckTemplateInput,
  InstallTemplatePackInput,
  TemplatePackId as TemplatePackIdType,
  TemplatePackKind,
  TemplatePackManifest,
  TemplatePackMember,
  TemplatePackMemberId as TemplatePackMemberIdType,
  TemplatePackSummary,
  UploadTemplateInput,
} from './types.ts'

export type {
  AddLibraryFormatInput,
  TemplateLibraryAsset,
  TemplateLibraryFormat,
  TemplateLibraryPack,
} from './library.ts'
export type {
  AssociateTemplateInput,
  CheckTemplateCandidateInput,
  CheckTemplateInput,
  InstallTemplatePackInput,
  TemplatePackKind,
  TemplatePackManifest,
  TemplatePackMember,
  TemplatePackMemberSummary,
  TemplatePackNormalizedAsset,
  TemplatePackSourceAsset,
  TemplatePackSummary,
  UploadTemplateInput,
} from './types.ts'

const DEFAULT_MAX_UPLOAD_BYTES = 128 * 1024 * 1024
const DEFAULT_CONVERTER_TIMEOUT_MS = 120_000
const DEFAULT_CONVERTER_OUTPUT_MAX_BYTES = 1024 * 1024
const DEFAULT_CONVERTER_TERMINATE_GRACE_MS = 2_000
const PACK_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u

/** Opaque identity of one registered template pack. */
export type TemplatePackId = TemplatePackIdType
/**
 * Brand a validated pack id at a parser or configuration boundary.
 * @param value - validated lowercase kebab-case identity.
 * @returns the opaque template-pack identity.
 */
export const TemplatePackId = (value: string): TemplatePackId => value as TemplatePackId

/** Opaque identity of one member inside a template pack. */
export type TemplatePackMemberId = TemplatePackMemberIdType
/**
 * Brand a validated pack-member id at a parser or configuration boundary.
 * @param value - validated lowercase kebab-case identity.
 * @returns the opaque pack-member identity.
 */
export const TemplatePackMemberId = (value: string): TemplatePackMemberId => value as TemplatePackMemberId

/** Template service deployment configuration. */
export interface Config {
  /** Absolute root for content-addressed template source and inspection copies. */
  readonly storageRoot: string
  /** Maximum accepted source or normalized asset size. */
  readonly maxUploadBytes?: number
  /** Deadline for a legacy `.doc` to DOCX conversion. */
  readonly converterTimeoutMs?: number
  /** Per-stream output cap for the legacy converter. */
  readonly converterOutputMaxBytes?: number
  /** TERM-to-KILL grace for the legacy converter process tree. */
  readonly converterTerminateGraceMs?: number
  /** Windows PowerShell executable used for Word COM conversion; empty disables `.doc` upload. */
  readonly wordComPowerShellCommand?: string
}

interface ResolvedConfig extends TemplateAssetStoreConfig {}

declare module '@deepseek-ai/cordis' {
  interface Context {
    paperTemplates: PaperTemplateService
    paperRepository: PaperRepository
  }
}

/** Host service owning institutional and uploaded template lifecycle. */
export class PaperTemplateService extends Service {
  static inject = ['paperRepository', 'documentEngine', 'subprocess']
  static Config: z<Config> = z.object({
    storageRoot: z.string().required(),
    maxUploadBytes: z.number().default(DEFAULT_MAX_UPLOAD_BYTES),
    converterTimeoutMs: z.number().default(DEFAULT_CONVERTER_TIMEOUT_MS),
    converterOutputMaxBytes: z.number().default(DEFAULT_CONVERTER_OUTPUT_MAX_BYTES),
    converterTerminateGraceMs: z.number().default(DEFAULT_CONVERTER_TERMINATE_GRACE_MS),
    wordComPowerShellCommand: z.string(),
  })

  private readonly packs = new Map<TemplatePackIdType, TemplatePackManifest>()
  private readonly leases = new Map<string, Promise<void>>()
  private readonly assets: TemplateAssetStore
  private readonly library: TemplateLibrary

  constructor(ctx: Context, config: Config) {
    super(ctx, 'paperTemplates')
    const resolved = resolveConfig(config)
    this.assets = new TemplateAssetStore(ctx, resolved)
    this.library = new TemplateLibrary(resolved.storageRoot, this.assets, ctx.logger)
  }

  /**
   * Register one immutable built-in pack until the returned disposer runs.
   * @param manifest - validated same-process pack contribution.
   * @returns disposer removing only this exact registration.
   */
  registerPack(manifest: TemplatePackManifest): () => void {
    const retained = retainManifest(manifest)
    if (this.packs.has(retained.id)) {
      throw new Error(`template-service: template pack already registered: ${retained.id}`)
    }
    this.packs.set(retained.id, retained)
    return () => {
      if (this.packs.get(retained.id) === retained) this.packs.delete(retained.id)
    }
  }

  /**
   * List every installable template set without exposing Host asset paths:
   * built-in packs in display-name order, then the user's custom sets that
   * hold at least one format, in creation order.
   * @returns asset-free pack summaries.
   */
  listPacks(): TemplatePackSummary[] {
    const builtIn = [...this.packs.values()]
      .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))
      .map(pack => summarizePack(pack, 'built-in'))
    const custom = this.library.manifests().map(pack => summarizePack(pack, 'custom'))
    return [...builtIn, ...custom]
  }

  /**
   * List the user's custom template sets, including sets that hold no format yet.
   * @returns fresh library records in creation order.
   */
  listLibraryPacks(): TemplateLibraryPack[] {
    return this.library.list()
  }

  /**
   * Create an empty custom template set.
   * @param input - display name and optional description.
   * @returns the created set.
   */
  createLibraryPack(input: { readonly name: string; readonly description?: string }): Promise<TemplateLibraryPack> {
    return this.library.createPack(input)
  }

  /**
   * Remove a custom template set; contracts already installed from it stay valid.
   * @param packId - custom set id.
   */
  deleteLibraryPack(packId: string): Promise<void> {
    return this.library.deletePack(packId)
  }

  /**
   * Add or replace the Word format for one document type in a custom set.
   * @param input - set, document type, usage, optional name, and the upload bytes.
   * @param signal - optional cancellation signal for staging and normalization.
   * @returns the updated set.
   */
  addLibraryFormat(input: AddLibraryFormatInput, signal?: AbortSignal): Promise<TemplateLibraryPack> {
    return this.library.addFormat(input, signal)
  }

  /**
   * Remove the format for one document type from a custom set.
   * @param packId - custom set id.
   * @param role - document type whose format is removed.
   * @returns the updated set.
   */
  removeLibraryFormat(packId: string, role: TemplateLibraryPack['formats'][number]['id']): Promise<TemplateLibraryPack> {
    return this.library.removeFormat(packId, role)
  }

  /**
   * Return one installed draft or confirmed contract.
   * @param templateId - durable contract identity.
   * @returns the stored contract, or `undefined` when absent.
   */
  getContract(templateId: TemplateContractId): TemplateContract | undefined {
    return this.ctx.paperRepository.getTemplate(templateId)
  }

  /**
   * List installed contracts for one project.
   * @param projectId - owning PaperAI project.
   * @returns all draft and confirmed contracts in repository order.
   */
  listContracts(projectId: ProjectId): TemplateContract[] {
    return this.ctx.paperRepository.listTemplates(projectId)
  }

  /**
   * Install selected members, verifying package bytes before OfficeCLI inspection.
   * Repeating the same project, pack version, member, and source digest returns
   * the existing draft or confirmed contract without another compilation.
   * @param input - project, pack, and optional member selection.
   * @param signal - optional cancellation signal.
   * @returns contracts in manifest order.
   */
  async installPack(input: InstallTemplatePackInput, signal?: AbortSignal): Promise<TemplateContract[]> {
    this.requireProject(input.projectId)
    const pack = this.packs.get(input.packId) ?? this.library.manifest(input.packId)
    if (pack === undefined) throw new Error(`template-service: unknown template pack: ${input.packId}`)
    const members = selectedMembers(pack, input.memberIds)
    const contracts: TemplateContract[] = []
    for (const member of members) {
      const seed = `built-in\0${input.projectId}\0${pack.id}\0${pack.version}\0${member.id}\0${member.source.sha256}`
      const templateId = deterministicTemplateId(seed)
      contracts.push(await this.withLease(templateId, async () => {
        const existing = this.ctx.paperRepository.getTemplate(templateId)
        if (existing !== undefined) return existing
        const assets = await this.assets.importBuiltIn(member.source, member.normalized, signal)
        const origin: TemplateOrigin = {
          kind: 'built-in',
          label: `${pack.name} / ${member.name}`,
          originalFileName: member.source.originalFileName,
          packId: pack.id,
          memberId: member.id,
          sourceVersion: member.sourceVersion,
          normalizedSha256: assets.normalizedSha256,
        }
        return await this.compileAndPublish({
          projectId: input.projectId,
          templateId,
          sourceDocumentId: deterministicDocumentId(seed),
          name: member.name,
          appliesToRoles: member.appliesToRoles,
          usage: member.usage,
          assets,
          origin,
        }, signal)
      }))
    }
    return contracts
  }

  /**
   * Import a custom `.doc` or `.docx` without mutating the selected file.
   * The returned contract always remains draft until {@link confirm} is called.
   * @param input - project, display name, source path, roles, and usage.
   * @param signal - optional cancellation signal.
   * @returns the reviewable draft contract.
   */
  async upload(input: UploadTemplateInput, signal?: AbortSignal): Promise<TemplateContract> {
    this.requireProject(input.projectId)
    validateName(input.name)
    const roles = validateRoles(input.appliesToRoles)
    const assets = await this.assets.importUpload(input.sourcePath, signal)
    const seed = `upload\0${input.projectId}\0${assets.sourceSha256}\0${roles.join(',')}\0${input.usage}`
    const templateId = deterministicTemplateId(seed)
    return await this.withLease(templateId, async () => {
      const existing = this.ctx.paperRepository.getTemplate(templateId)
      if (existing !== undefined) return existing
      return await this.compileAndPublish({
        projectId: input.projectId,
        templateId,
        sourceDocumentId: deterministicDocumentId(seed),
        name: input.name.trim(),
        appliesToRoles: roles,
        usage: input.usage,
        assets,
        origin: {
          kind: 'upload',
          label: input.name.trim(),
          originalFileName: assets.originalFileName,
          normalizedSha256: assets.normalizedSha256,
        },
      }, signal)
    })
  }

  /**
   * Perform the explicit user confirmation transition for a draft.
   * @param templateId - draft contract selected by the user.
   * @returns the confirmed durable contract; confirming twice is idempotent.
   */
  async confirm(templateId: TemplateContractId): Promise<TemplateContract> {
    return await this.withLease(templateId, async () => {
      const contract = this.requireTemplate(templateId)
      if (contract.status === 'confirmed') return contract
      const confirmed: TemplateContract = {
        ...contract,
        status: 'confirmed',
        updatedAt: new Date().toISOString(),
      }
      await this.ctx.paperRepository.putTemplate(confirmed)
      return confirmed
    })
  }

  /**
   * Validate a proposed template binding. Publication belongs exclusively to
   * `paperCommits.submit({ mutations: [{ type: 'bind-template', ... }] })` so
   * the association always receives a recoverable version and provenance.
   * @param input - target document and confirmed contract identities.
   * @returns isolated target metadata when the binding is valid.
   */
  validateAssociation(input: AssociateTemplateInput): DocumentRecord {
    const template = this.requireTemplate(input.templateId)
    if (template.status !== 'confirmed') {
      throw new Error(`template-service: template must be confirmed before association: ${template.id}`)
    }
    const document = this.requireDocument(input.documentId)
    if (document.documentKind === 'template-source') {
      throw new Error(`template-service: template sources cannot receive template associations: ${document.id}`)
    }
    if (template.projectId !== document.projectId) {
      throw new Error(`template-service: template ${template.id} belongs to another project`)
    }
    const role = input.role ?? document.role
    if (!template.appliesToRoles.includes(role)) {
      throw new Error(`template-service: template ${template.id} does not apply to document role ${role}`)
    }
    return structuredClone(document)
  }

  /**
   * Check current Working DOCX content and styles against its attached contract.
   * Draft export callers may continue with a failing report; `delivery-export`
   * callers use the domain's `deliveryBlocked()` result before publishing.
   * @param input - document identity and requested check mode.
   * @param signal - optional cancellation signal.
   * @returns complete findings with the attached template identity when present.
   */
  async check(input: CheckTemplateInput, signal?: AbortSignal): Promise<GateReport> {
    const document = this.requireDocument(input.documentId)
    const template = document.templateId === undefined
      ? undefined
      : this.ctx.paperRepository.getTemplate(document.templateId)
    return await checkTemplateContract(this.ctx.documentEngine, document, template, input.mode, signal)
  }

  /**
   * Check an unpublished commit candidate against an explicit prospective
   * template binding. Repository metadata and the authoritative Working DOCX
   * remain unchanged while the gate runs.
   * @param input - current document metadata, candidate path, prospective template, and check mode.
   * @param signal - optional cancellation signal for document-engine work.
   * @returns complete findings for the isolated candidate and prospective binding.
   * @throws when the document or template is missing, candidate metadata is inconsistent, or the template belongs to another project.
   */
  async checkCandidate(input: CheckTemplateCandidateInput, signal?: AbortSignal): Promise<GateReport> {
    const current = this.requireDocument(input.document.id)
    if (current.documentKind === 'template-source') {
      throw new Error(`template-service: template sources cannot be checked as Working documents: ${current.id}`)
    }
    if (current.projectId !== input.document.projectId || current.workingPath !== input.document.workingPath) {
      throw new Error(`template-service: candidate metadata does not match document: ${current.id}`)
    }
    const template = input.templateId === undefined ? undefined : this.requireTemplate(input.templateId)
    if (template !== undefined && template.projectId !== current.projectId) {
      throw new Error(`template-service: template ${template.id} belongs to another project`)
    }
    const candidate: DocumentRecord = structuredClone(input.document)
    candidate.workingPath = input.candidatePath
    if (input.templateId === undefined) delete candidate.templateId
    else candidate.templateId = input.templateId
    return await checkTemplateContract(this.ctx.documentEngine, candidate, template, input.mode, signal)
  }

  private async compileAndPublish(
    input: Omit<Parameters<typeof compileTemplateDraft>[1], 'now'>,
    signal?: AbortSignal,
  ): Promise<TemplateContract> {
    const compiled = await compileTemplateDraft(this.ctx.documentEngine, {
      ...input,
      now: new Date().toISOString(),
    }, signal)
    await this.publish(compiled)
    return compiled.contract
  }

  private async publish(compiled: CompiledTemplateDraft): Promise<void> {
    await this.ctx.paperRepository.putDocument(compiled.document)
    for (const node of compiled.nodes) await this.ctx.paperRepository.putNode(node)
    await this.ctx.paperRepository.putTemplate(compiled.contract)
  }

  private requireProject(projectId: ProjectId): void {
    if (this.ctx.paperRepository.getProject(projectId) === undefined) {
      throw new Error(`template-service: project not found: ${projectId}`)
    }
  }

  private requireDocument(documentId: DocumentId): DocumentRecord {
    const document = this.ctx.paperRepository.getDocument(documentId)
    if (document === undefined) throw new Error(`template-service: document not found: ${documentId}`)
    return document
  }

  private requireTemplate(templateId: TemplateContractId): TemplateContract {
    const template = this.ctx.paperRepository.getTemplate(templateId)
    if (template === undefined) throw new Error(`template-service: template not found: ${templateId}`)
    return template
  }

  private withLease<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.leases.get(key) ?? Promise.resolve()
    const run = prior.then(operation, operation)
    const tail = run.then(() => undefined, () => undefined)
    this.leases.set(key, tail)
    return run.finally(() => {
      if (this.leases.get(key) === tail) this.leases.delete(key)
    })
  }
}

function resolveConfig(config: Config): ResolvedConfig {
  if (config.storageRoot.trim().length === 0) throw new Error('template-service: storageRoot must not be empty')
  const resolved: ResolvedConfig = {
    storageRoot: config.storageRoot,
    maxUploadBytes: config.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES,
    converterTimeoutMs: config.converterTimeoutMs ?? DEFAULT_CONVERTER_TIMEOUT_MS,
    converterOutputMaxBytes: config.converterOutputMaxBytes ?? DEFAULT_CONVERTER_OUTPUT_MAX_BYTES,
    converterTerminateGraceMs: config.converterTerminateGraceMs ?? DEFAULT_CONVERTER_TERMINATE_GRACE_MS,
    ...resolveWordComCommand(config.wordComPowerShellCommand),
  }
  assertPositiveInteger('maxUploadBytes', resolved.maxUploadBytes)
  assertPositiveInteger('converterTimeoutMs', resolved.converterTimeoutMs)
  assertPositiveInteger('converterOutputMaxBytes', resolved.converterOutputMaxBytes)
  assertPositiveInteger('converterTerminateGraceMs', resolved.converterTerminateGraceMs)
  return resolved
}

function resolveWordComCommand(configured: string | undefined): Pick<ResolvedConfig, 'wordComPowerShellCommand'> {
  /* v8 ignore next -- Windows and POSIX CI exercise opposite platform defaults; explicit configuration is platform-independent. */
  const command = configured ?? (process.platform === 'win32' ? 'powershell.exe' : undefined)
  /* v8 ignore next -- the undefined arm is the POSIX peer of the Windows default exercised in this workspace. */
  return command === undefined ? {} : { wordComPowerShellCommand: command }
}

function summarizePack(pack: TemplatePackManifest, kind: TemplatePackKind): TemplatePackSummary {
  return {
    id: pack.id,
    kind,
    name: pack.name,
    description: pack.description,
    version: pack.version,
    sourceLabel: pack.sourceLabel,
    members: pack.members.map(member => ({
      id: member.id,
      name: member.name,
      description: member.description,
      appliesToRoles: [...member.appliesToRoles],
      usage: member.usage,
      sourceVersion: member.sourceVersion,
      originalFileName: member.source.originalFileName,
      sourceSha256: member.source.sha256,
    })),
  }
}

function retainManifest(manifest: TemplatePackManifest): TemplatePackManifest {
  if (!PACK_ID_PATTERN.test(manifest.id)) throw new Error(`template-service: invalid template pack id: ${manifest.id}`)
  validateName(manifest.name)
  validateName(manifest.version)
  if (manifest.members.length === 0) throw new Error(`template-service: template pack has no members: ${manifest.id}`)
  const memberIds = new Set<TemplatePackMemberId>()
  const members = manifest.members.map((member): TemplatePackMember => {
    if (!PACK_ID_PATTERN.test(member.id)) throw new Error(`template-service: invalid template member id: ${member.id}`)
    if (memberIds.has(member.id)) throw new Error(`template-service: duplicate template member id: ${member.id}`)
    memberIds.add(member.id)
    validateName(member.name)
    const roles = validateRoles(member.appliesToRoles)
    return Object.freeze({
      ...member,
      appliesToRoles: Object.freeze(roles),
      source: Object.freeze({ ...member.source }),
      normalized: Object.freeze({ ...member.normalized }),
    })
  })
  return Object.freeze({
    ...manifest,
    members: Object.freeze(members),
  })
}

function selectedMembers(
  pack: TemplatePackManifest,
  memberIds: readonly TemplatePackMemberId[] | undefined,
): readonly TemplatePackMember[] {
  if (memberIds === undefined) return pack.members
  if (memberIds.length === 0) throw new Error('template-service: memberIds must not be empty')
  const selected = new Set(memberIds)
  if (selected.size !== memberIds.length) throw new Error('template-service: memberIds contains duplicates')
  const members = pack.members.filter(member => selected.has(member.id))
  if (members.length !== selected.size) {
    const known = new Set(pack.members.map(member => member.id))
    const missing = memberIds.find(memberId => !known.has(memberId))
    throw new Error(`template-service: unknown template member: ${String(missing)}`)
  }
  return members
}

function validateRoles(roles: readonly TemplatePackMember['appliesToRoles'][number][]): TemplatePackMember['appliesToRoles'] {
  if (roles.length === 0) throw new Error('template-service: appliesToRoles must not be empty')
  const unique = [...new Set(roles)]
  if (unique.length !== roles.length) throw new Error('template-service: appliesToRoles contains duplicates')
  return unique
}

function validateName(value: string): void {
  if (value.trim().length === 0) throw new Error('template-service: name must not be empty')
}

function deterministicTemplateId(seed: string): TemplateContractId {
  return TemplateContractId(`template-${digest(seed).slice(0, 24)}`)
}

function deterministicDocumentId(seed: string): DocumentId {
  return DocumentId(`template-source-${digest(seed).slice(0, 24)}`)
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`template-service: ${name} must be a positive safe integer`)
  }
}

export default PaperTemplateService
