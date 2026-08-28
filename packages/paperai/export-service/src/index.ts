/**
 * Checked PaperAI DOCX publication (`ctx.paperExports`). Exports create a
 * recoverable milestone, then atomically publish only that commit's immutable
 * snapshot without changing the imported source or authoritative Working DOCX.
 * @module @paperai/export-service
 */

import { createHash, randomUUID } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import {
  copyFile,
  lstat,
  open,
  realpath,
  rename,
  rm,
  stat,
} from 'node:fs/promises'
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  resolve,
} from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { deliveryBlocked } from '@paperai/domain'
import type { DocumentCommit, GateReport } from '@paperai/domain'
import type PaperCommitService from '@paperai/commit-service'
import type {
  PaperMcpExportAdapter,
  PaperMcpExportResult,
} from '@paperai/mcp'
import type PaperMcpService from '@paperai/mcp'
import type PaperTemplateService from '@paperai/template-service'
import type {
  ExportDocumentRequest,
  ExportDocumentResult,
  PaperExportErrorCode,
} from './types.ts'

export type {
  ExportDocumentRequest,
  ExportDocumentResult,
  PaperExportErrorCode,
  PaperExportMode,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    paperExports: PaperExportService
  }
}

type ExportContext = Context & {
  readonly paperCommits: PaperCommitService
  readonly paperMcp: PaperMcpService
  readonly paperTemplates: PaperTemplateService
}

/** Export-service deployment limits and publication policy. */
export interface Config {
  /** Maximum immutable snapshot size accepted for one export. */
  readonly maxExportBytes?: number
  /** Whether an explicitly selected existing regular DOCX may be replaced. */
  readonly overwriteExisting?: boolean
}

interface ResolvedConfig {
  readonly maxExportBytes: number
  readonly overwriteExisting: boolean
}

interface ResolvedExportRequest {
  readonly document: ExportDocumentRequest['document']
  readonly destinationPath: string
  readonly mode: ExportDocumentRequest['mode']
  readonly actor: ExportDocumentRequest['actor']
  readonly signal: AbortSignal | undefined
}

interface FileIdentity {
  readonly realPath: string
  readonly device: bigint
  readonly inode: bigint
}

const DEFAULT_MAX_EXPORT_BYTES = 512 * 1024 * 1024

/** Coded export failure suitable for Host UI and MCP diagnostics. */
export class PaperExportError extends Error {
  /**
   * @param code - stable machine-readable failure category.
   * @param message - actionable caller-facing explanation.
   * @param report - delivery report when template errors blocked publication.
   */
  constructor(
    readonly code: PaperExportErrorCode,
    message: string,
    readonly report?: GateReport,
  ) {
    super(message)
    this.name = 'PaperExportError'
  }
}

function resolveConfig(config: Config): ResolvedConfig {
  const maxExportBytes = config.maxExportBytes ?? DEFAULT_MAX_EXPORT_BYTES
  if (!Number.isSafeInteger(maxExportBytes) || maxExportBytes <= 0) {
    throw new Error('paperai-export-service: maxExportBytes must be a positive safe integer')
  }
  return {
    maxExportBytes,
    overwriteExisting: config.overwriteExisting ?? true,
  }
}

function pathKey(path: string): string {
  return resolve(path).toLocaleLowerCase('en-US')
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

async function fileIdentity(path: string): Promise<FileIdentity | undefined> {
  try {
    const [realPath, metadata] = await Promise.all([
      realpath(path),
      stat(path, { bigint: true }),
    ])
    return {
      realPath,
      device: metadata.dev,
      inode: metadata.ino,
    }
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
}

async function assertDistinctDestination(
  destinationPath: string,
  protectedPaths: readonly string[],
): Promise<void> {
  const destination = await fileIdentity(destinationPath)
  for (const protectedPath of protectedPaths) {
    if (pathKey(destinationPath) === pathKey(protectedPath)) {
      throw new PaperExportError(
        'DESTINATION_PROTECTED',
        `export destination '${destinationPath}' is a protected PaperAI document path`,
      )
    }
    const protectedFile = await fileIdentity(protectedPath)
    if (destination !== undefined && protectedFile !== undefined
      && (pathKey(destination.realPath) === pathKey(protectedFile.realPath)
        || (destination.device === protectedFile.device && destination.inode === protectedFile.inode))) {
      throw new PaperExportError(
        'DESTINATION_PROTECTED',
        `export destination '${destinationPath}' resolves to a protected PaperAI document file`,
      )
    }
  }
}

async function resolveDestination(
  destinationPath: string,
  protectedPaths: readonly string[],
  overwriteExisting: boolean,
): Promise<string> {
  const trimmed = destinationPath.trim()
  if (!isAbsolute(trimmed) || extname(trimmed).toLocaleLowerCase('en-US') !== '.docx') {
    throw new PaperExportError(
      'DESTINATION_INVALID',
      'export destination must be an absolute path ending in .docx',
    )
  }
  const parentPath = await realpath(dirname(trimmed))
  const parent = await lstat(parentPath)
  if (!parent.isDirectory()) {
    throw new PaperExportError('DESTINATION_INVALID', `export parent '${parentPath}' is not a directory`)
  }
  const canonical = join(parentPath, basename(trimmed))
  const existing = await fileIdentity(canonical)
  if (existing !== undefined) {
    const metadata = await lstat(canonical)
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new PaperExportError(
        'DESTINATION_INVALID',
        `export destination '${canonical}' must be a regular file when it exists`,
      )
    }
    if (!overwriteExisting) {
      throw new PaperExportError('DESTINATION_EXISTS', `export destination '${canonical}' already exists`)
    }
  }
  await assertDistinctDestination(canonical, protectedPaths)
  return canonical
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

async function publishSnapshot(
  commit: DocumentCommit,
  destinationPath: string,
  protectedPaths: readonly string[],
  config: ResolvedConfig,
): Promise<string> {
  const snapshotMetadata = await lstat(commit.snapshotPath)
  if (!snapshotMetadata.isFile() || snapshotMetadata.isSymbolicLink()) {
    throw new PaperExportError('SNAPSHOT_CORRUPT', `commit snapshot '${commit.snapshotPath}' is not a regular file`)
  }
  if (snapshotMetadata.size > config.maxExportBytes) {
    throw new PaperExportError(
      'EXPORT_TOO_LARGE',
      `commit snapshot is ${snapshotMetadata.size} bytes; the export limit is ${config.maxExportBytes} bytes`,
    )
  }
  const destination = await resolveDestination(
    destinationPath,
    [...protectedPaths, commit.snapshotPath],
    config.overwriteExisting,
  )
  const temporaryPath = join(
    dirname(destination),
    `.${basename(destination)}.paperai-${randomUUID()}.tmp`,
  )
  let published = false
  try {
    await copyFile(commit.snapshotPath, temporaryPath, constants.COPYFILE_EXCL)
    const temporary = await lstat(temporaryPath)
    if (!temporary.isFile() || temporary.size !== snapshotMetadata.size
      || await sha256(temporaryPath) !== commit.documentSha256) {
      throw new PaperExportError(
        'SNAPSHOT_CORRUPT',
        `commit snapshot '${commit.snapshotPath}' does not match commit '${commit.id}'`,
      )
    }
    const handle = await open(temporaryPath, 'r+')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
    await resolveDestination(
      destination,
      [...protectedPaths, commit.snapshotPath],
      config.overwriteExisting,
    )
    await rename(temporaryPath, destination)
    published = true
    return destination
  } finally {
    if (!published) await rm(temporaryPath, { force: true })
  }
}

function milestoneLabel(mode: ExportDocumentRequest['mode'], outputPath: string): string {
  const kind = mode === 'draft-export' ? 'Draft export' : 'Delivery export'
  return `${kind}: ${basename(outputPath)}`
}

/** Template-checked atomic publisher and MCP export provider. */
export class PaperExportService extends Service implements PaperMcpExportAdapter {
  static inject = ['paperCommits', 'paperMcp', 'paperTemplates']
  static Config: z<Config> = z.object({
    maxExportBytes: z.number().default(DEFAULT_MAX_EXPORT_BYTES),
    overwriteExisting: z.boolean().default(true),
  })

  private readonly config: ResolvedConfig
  private readonly destinations = new Map<string, Promise<void>>()

  /**
   * @param ctx - Cordis context carrying commit, MCP, and template services.
   * @param config - output size and explicit replacement policy.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'paperExports')
    this.config = resolveConfig(config)
    ctx.effect(
      () => this.dependencies.paperMcp.registerExportAdapter(this),
      'paperai-export-service: MCP export adapter',
    )
  }

  /**
   * Check template requirements, record an optimistic milestone, and publish
   * its immutable snapshot. Draft findings are returned without blocking;
   * delivery errors reject before any commit or output is created.
   * Cancellation is observed before milestone publication. Once the commit
   * completes, file publication reaches success or cleanup before settlement.
   * @param request - observed document, destination, mode, and provenance.
   * @returns canonical output path, fresh report, and recoverable commit.
   */
  exportDocument(request: ExportDocumentRequest): Promise<ExportDocumentResult & PaperMcpExportResult> {
    const retained: ResolvedExportRequest = {
      document: structuredClone(request.document),
      destinationPath: request.destinationPath,
      mode: request.mode,
      actor: structuredClone(request.actor),
      signal: request.signal,
    }
    const queueKey = pathKey(retained.destinationPath)
    return this.enqueue(queueKey, retained.signal, () => this.exportNow(retained))
  }

  private get dependencies(): ExportContext {
    return this.ctx
  }

  private enqueue<T>(key: string, signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
    const previous = this.destinations.get(key) ?? Promise.resolve()
    const run = previous.then(async () => {
      signal?.throwIfAborted()
      return await operation()
    })
    const tail = run.then(() => undefined, () => undefined)
    this.destinations.set(key, tail)
    return run.finally(() => {
      if (this.destinations.get(key) === tail) this.destinations.delete(key)
    })
  }

  private async exportNow(request: ResolvedExportRequest): Promise<ExportDocumentResult & PaperMcpExportResult> {
    request.signal?.throwIfAborted()
    const report = await this.dependencies.paperTemplates.check({
      documentId: request.document.id,
      mode: request.mode,
    }, request.signal)
    if (deliveryBlocked(report)) {
      throw new PaperExportError(
        'DELIVERY_BLOCKED',
        `formal delivery for document '${request.document.id}' is blocked by template errors`,
        structuredClone(report),
      )
    }
    const destination = await resolveDestination(
      request.destinationPath,
      [request.document.immutableSourcePath, request.document.workingPath],
      this.config.overwriteExisting,
    )
    request.signal?.throwIfAborted()
    const label = milestoneLabel(request.mode, destination)
    const commit = await this.dependencies.paperCommits.submit({
      documentId: request.document.id,
      ...(request.document.headCommitId === undefined
        ? {}
        : { baseCommitId: request.document.headCommitId }),
      message: label,
      actor: request.actor,
      mutations: [{ type: 'milestone', label }],
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    })
    const outputPath = await publishSnapshot(
      commit,
      destination,
      [request.document.immutableSourcePath, request.document.workingPath],
      this.config,
    )
    const retainedReport = structuredClone(report)
    return {
      outputPath,
      report: retainedReport,
      gate: structuredClone(retainedReport),
      commit: structuredClone(commit),
    }
  }
}

export default PaperExportService
