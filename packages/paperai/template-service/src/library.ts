/**
 * User template library: custom template sets kept per installation, each a
 * pack of formats keyed by document type. Files land in the shared
 * content-addressed asset store; this module owns only the durable manifest.
 */

import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Logger } from '@deepseek-ai/cordis'
import type { DocumentRole, TemplateUsage } from '@paperai/domain'
import type { StoredTemplateAssets, TemplateAssetStore } from './storage.ts'
import type {
  TemplatePackId,
  TemplatePackManifest,
  TemplatePackMember,
  TemplatePackMemberId,
} from './types.ts'

const LIBRARY_FILE = 'library.json'
const LIBRARY_VERSION = 1
/** Pack version stays fixed so adding one format never re-compiles the others. */
const LIBRARY_PACK_VERSION = 'custom'
const DOCUMENT_ROLES: readonly DocumentRole[] = ['manuscript', 'proposal', 'midterm', 'final', 'other']
const TEMPLATE_USAGES: readonly TemplateUsage[] = ['form-template', 'format-reference']
const MAX_NAME_LENGTH = 120

/** One durable asset reference stored relative to the asset-store root. */
export interface TemplateLibraryAsset {
  readonly path: string
  readonly sha256: string
  readonly size: number
}

/** One Word format inside a custom template set, keyed by its document type. */
export interface TemplateLibraryFormat {
  /** Member id inside the pack; one format per document type, so the type is the id. */
  readonly id: DocumentRole
  readonly name: string
  readonly usage: TemplateUsage
  readonly originalFileName: string
  readonly source: TemplateLibraryAsset
  readonly normalized: TemplateLibraryAsset
  readonly addedAt: string
}

/** One custom template set. */
export interface TemplateLibraryPack {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly formats: readonly TemplateLibraryFormat[]
}

/** Adds or replaces the format for one document type. */
export interface AddLibraryFormatInput {
  readonly packId: string
  readonly role: DocumentRole
  readonly usage: TemplateUsage
  /** Display name; defaults to the file name without its extension. */
  readonly name?: string
  readonly upload: {
    readonly fileName: string
    readonly bytes: Uint8Array
  }
}

interface LibraryFile {
  readonly version: typeof LIBRARY_VERSION
  readonly packs: readonly TemplateLibraryPack[]
}

/** Characters Windows and POSIX file systems reject in a file name, plus control characters. */
const FORBIDDEN_NAME_CHARACTERS = new Set(['<', '>', ':', '"', '/', String.fromCharCode(92), '|', '?', '*'])

function isSafeUploadName(name: string): boolean {
  if (name.length === 0) return false
  for (const character of name) {
    const code = character.codePointAt(0) ?? 0
    if (FORBIDDEN_NAME_CHARACTERS.has(character) || code <= 0x1f || code === 0x7f) return false
  }
  return true
}

function nonBlankName(value: string, what: string): string {
  const trimmed = value.trim()
  if (trimmed.length === 0) throw new Error(`template-service: ${what} must not be empty`)
  if (trimmed.length > MAX_NAME_LENGTH) throw new Error(`template-service: ${what} must be at most ${MAX_NAME_LENGTH} characters`)
  return trimmed
}

function wordStem(fileName: string): string {
  return fileName.replace(/\.(docx?|DOCX?)$/u, '')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isAsset(value: unknown): value is TemplateLibraryAsset {
  return isRecord(value)
    && typeof value.path === 'string' && !isAbsolute(value.path) && !value.path.split(/[\\/]/u).includes('..')
    && typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(value.sha256)
    && typeof value.size === 'number' && Number.isSafeInteger(value.size) && value.size >= 0
}

function isFormat(value: unknown): value is TemplateLibraryFormat {
  return isRecord(value)
    && DOCUMENT_ROLES.includes(value.id as DocumentRole)
    && typeof value.name === 'string' && value.name.trim().length > 0
    && TEMPLATE_USAGES.includes(value.usage as TemplateUsage)
    && typeof value.originalFileName === 'string' && value.originalFileName.length > 0
    && isAsset(value.source) && isAsset(value.normalized)
    && typeof value.addedAt === 'string'
}

function isPack(value: unknown): value is TemplateLibraryPack {
  if (!isRecord(value)) return false
  if (typeof value.id !== 'string' || !/^custom-[a-f0-9]{8}$/u.test(value.id)) return false
  if (typeof value.name !== 'string' || value.name.trim().length === 0) return false
  if (typeof value.description !== 'string') return false
  if (typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string') return false
  if (!Array.isArray(value.formats) || !value.formats.every(isFormat)) return false
  const roles = new Set(value.formats.map(format => format.id))
  return roles.size === value.formats.length
}

function parseLibrary(text: string): LibraryFile {
  const parsed: unknown = JSON.parse(text)
  if (!isRecord(parsed) || parsed.version !== LIBRARY_VERSION || !Array.isArray(parsed.packs)) {
    throw new Error('template-service: library manifest has an unknown shape')
  }
  if (!parsed.packs.every(isPack)) throw new Error('template-service: library manifest contains an invalid pack')
  const ids = new Set(parsed.packs.map(pack => pack.id))
  if (ids.size !== parsed.packs.length) throw new Error('template-service: library manifest contains duplicate pack ids')
  return { version: LIBRARY_VERSION, packs: parsed.packs }
}

/**
 * Durable custom template sets. The manifest is read once at construction and
 * rewritten atomically after every change; a manifest that fails validation
 * is preserved beside a fresh empty library instead of being overwritten.
 */
export class TemplateLibrary {
  private readonly root: string
  private readonly assetRoot: string
  private readonly file: string
  private packs: readonly TemplateLibraryPack[]
  private tail: Promise<void> = Promise.resolve()
  /** Set when the manifest failed validation; the next write moves it aside first. */
  private unreadable = false

  /**
   * @param assetRoot - absolute asset-store root; the library directory lives under it.
   * @param assets - shared content-addressed asset store that retains uploaded Word files.
   * @param logger - warning sink for a manifest that cannot be read.
   */
  constructor(
    assetRoot: string,
    private readonly assets: Pick<TemplateAssetStore, 'importUpload'>,
    private readonly logger: Pick<Logger, 'warn'>,
  ) {
    this.assetRoot = resolve(assetRoot)
    this.root = join(this.assetRoot, 'library')
    this.file = join(this.root, LIBRARY_FILE)
    this.packs = this.load()
  }

  /**
   * List every custom template set in creation order.
   * @returns fresh pack records; assets stay relative to the store root.
   */
  list(): TemplateLibraryPack[] {
    return this.packs.map(pack => structuredClone(pack))
  }

  /**
   * Project one custom set with at least one format as an installable pack manifest.
   * @param packId - custom pack id.
   * @returns the manifest with absolute asset paths, or `undefined` when unknown or empty.
   */
  manifest(packId: string): TemplatePackManifest | undefined {
    const pack = this.packs.find(candidate => candidate.id === packId)
    return pack === undefined ? undefined : this.toManifest(pack)
  }

  /**
   * Project every non-empty custom set as an installable pack manifest.
   * @returns manifests in creation order.
   */
  manifests(): TemplatePackManifest[] {
    return this.packs.flatMap((pack) => {
      const manifest = this.toManifest(pack)
      return manifest === undefined ? [] : [manifest]
    })
  }

  /**
   * Create an empty custom set.
   * @param input - display name and optional description.
   * @returns the created pack.
   */
  async createPack(input: { readonly name: string; readonly description?: string }): Promise<TemplateLibraryPack> {
    const name = nonBlankName(input.name, 'template set name')
    const description = (input.description ?? '').trim()
    return await this.enqueue(async () => {
      if (this.packs.some(pack => pack.name === name)) {
        throw new Error(`template-service: a template set named '${name}' already exists`)
      }
      const now = new Date().toISOString()
      const pack: TemplateLibraryPack = {
        id: `custom-${randomUUID().replace(/-/gu, '').slice(0, 8)}`,
        name,
        description,
        createdAt: now,
        updatedAt: now,
        formats: [],
      }
      await this.persist([...this.packs, pack])
      return structuredClone(pack)
    })
  }

  /**
   * Remove a custom set. Retained asset files stay in the content-addressed
   * store because installed contracts may still reference them.
   * @param packId - custom pack id.
   */
  deletePack(packId: string): Promise<void> {
    return this.enqueue(async () => {
      this.requirePack(packId)
      await this.persist(this.packs.filter(pack => pack.id !== packId))
    })
  }

  /**
   * Add a Word file as the format for one document type, replacing the
   * previous format of that type. The upload is staged under the library
   * directory, retained immutably by the asset store, then the staging is removed.
   * @param input - pack, document type, usage, optional name, and the upload.
   * @param signal - optional cancellation signal for staging and normalization.
   * @returns the updated pack.
   */
  async addFormat(input: AddLibraryFormatInput, signal?: AbortSignal): Promise<TemplateLibraryPack> {
    if (!DOCUMENT_ROLES.includes(input.role)) throw new Error(`template-service: unknown document type: ${input.role}`)
    if (!TEMPLATE_USAGES.includes(input.usage)) throw new Error(`template-service: unknown template usage: ${input.usage}`)
    const fileName = input.upload.fileName.normalize('NFC')
    if (!isSafeUploadName(fileName) || !/\.docx?$/iu.test(fileName)) {
      throw new Error(`template-service: upload '${input.upload.fileName}' must be a safe .doc or .docx file name`)
    }
    if (input.upload.bytes.byteLength === 0) throw new Error('template-service: upload must not be empty')
    const name = nonBlankName(input.name ?? wordStem(fileName), 'format name')
    return await this.enqueue(async () => {
      const pack = this.requirePack(input.packId)
      const stored = await this.retainUpload(fileName, input.upload.bytes, signal)
      const [sourceStat, normalizedStat] = await Promise.all([stat(stored.immutableSourcePath), stat(stored.normalizedPath)])
      const now = new Date().toISOString()
      const format: TemplateLibraryFormat = {
        id: input.role,
        name,
        usage: input.usage,
        originalFileName: fileName,
        source: { path: this.relativeAsset(stored.immutableSourcePath), sha256: stored.sourceSha256, size: sourceStat.size },
        normalized: { path: this.relativeAsset(stored.normalizedPath), sha256: stored.normalizedSha256, size: normalizedStat.size },
        addedAt: now,
      }
      const updated: TemplateLibraryPack = {
        ...pack,
        updatedAt: now,
        formats: [...pack.formats.filter(existing => existing.id !== input.role), format],
      }
      await this.persist(this.packs.map(candidate => candidate.id === pack.id ? updated : candidate))
      return structuredClone(updated)
    })
  }

  /**
   * Remove the format for one document type from a custom set.
   * @param packId - custom pack id.
   * @param role - document type whose format is removed.
   * @returns the updated pack.
   */
  removeFormat(packId: string, role: DocumentRole): Promise<TemplateLibraryPack> {
    return this.enqueue(async () => {
      const pack = this.requirePack(packId)
      if (!pack.formats.some(format => format.id === role)) {
        throw new Error(`template-service: template set '${packId}' has no format for '${role}'`)
      }
      const updated: TemplateLibraryPack = {
        ...pack,
        updatedAt: new Date().toISOString(),
        formats: pack.formats.filter(format => format.id !== role),
      }
      await this.persist(this.packs.map(candidate => candidate.id === pack.id ? updated : candidate))
      return structuredClone(updated)
    })
  }

  /** Stage the upload under the library directory, retain it immutably, and drop the staging. */
  private async retainUpload(fileName: string, bytes: Uint8Array, signal?: AbortSignal): Promise<StoredTemplateAssets> {
    const staging = join(this.root, 'uploads', randomUUID())
    await mkdir(staging, { recursive: true })
    try {
      const stagedPath = join(staging, fileName)
      await writeFile(stagedPath, bytes, { flag: 'wx' })
      return await this.assets.importUpload(stagedPath, signal)
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  }

  private load(): readonly TemplateLibraryPack[] {
    if (!existsSync(this.file)) return []
    try {
      return parseLibrary(readFileSync(this.file, 'utf8')).packs
    } catch (error) {
      // Never overwrite a manifest we could not read: the first write moves
      // it aside so the user's records survive for manual recovery.
      this.logger.warn(`template-service: template library at '${this.file}' is unreadable and starts empty: ${String(error)}`)
      this.unreadable = true
      return []
    }
  }

  private async persist(packs: readonly TemplateLibraryPack[]): Promise<void> {
    await mkdir(this.root, { recursive: true })
    if (this.unreadable) {
      await rename(this.file, `${this.file}.unreadable-${Date.now()}`)
      this.unreadable = false
    }
    const temporary = join(dirname(this.file), `.${LIBRARY_FILE}.${randomUUID()}.tmp`)
    const payload: LibraryFile = { version: LIBRARY_VERSION, packs }
    await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { flag: 'wx' })
    try {
      await rename(temporary, this.file)
    } catch (error) {
      await rm(temporary, { force: true })
      throw error
    }
    this.packs = packs
  }

  private requirePack(packId: string): TemplateLibraryPack {
    const pack = this.packs.find(candidate => candidate.id === packId)
    if (pack === undefined) throw new Error(`template-service: unknown template set: ${packId}`)
    return pack
  }

  private toManifest(pack: TemplateLibraryPack): TemplatePackManifest | undefined {
    if (pack.formats.length === 0) return undefined
    const members = pack.formats.map((format): TemplatePackMember => ({
      id: format.id as unknown as TemplatePackMemberId,
      name: format.name,
      description: format.usage === 'form-template' ? '自定义内容表单模板' : '自定义排版参考范例',
      appliesToRoles: [format.id],
      usage: format.usage,
      sourceVersion: format.addedAt,
      source: {
        path: join(this.assetRoot, format.source.path),
        originalFileName: format.originalFileName,
        sha256: format.source.sha256,
        size: format.source.size,
      },
      normalized: {
        path: join(this.assetRoot, format.normalized.path),
        sha256: format.normalized.sha256,
        size: format.normalized.size,
      },
    }))
    return {
      id: pack.id as unknown as TemplatePackId,
      name: pack.name,
      description: pack.description,
      version: LIBRARY_PACK_VERSION,
      sourceLabel: '用户添加',
      members,
    }
  }

  private relativeAsset(absolutePath: string): string {
    const relativePath = relative(this.assetRoot, absolutePath)
    if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
      throw new Error(`template-service: retained asset '${absolutePath}' lies outside the template store`)
    }
    return relativePath.split(sep).join('/')
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.tail.then(operation, operation)
    this.tail = run.then(() => undefined, () => undefined)
    return run
  }
}
