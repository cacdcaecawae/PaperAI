/** Immutable template-asset storage and legacy Word normalization. */

import { createHash, randomUUID } from 'node:crypto'
import {
  chmod,
  link,
  lstat,
  mkdir,
  readFile,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { basename, extname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import type {
  TemplatePackNormalizedAsset,
  TemplatePackSourceAsset,
} from './types.ts'

const SHA256_PATTERN = /^[a-f0-9]{64}$/u
const LEGACY_CONVERTER_SCRIPT = fileURLToPath(new URL('../assets/convert-legacy-doc.ps1', import.meta.url))

/** Deployment limits and the optional Windows Word converter command. */
export interface TemplateAssetStoreConfig {
  readonly storageRoot: string
  readonly maxUploadBytes: number
  readonly converterTimeoutMs: number
  readonly converterOutputMaxBytes: number
  readonly converterTerminateGraceMs: number
  readonly wordComPowerShellCommand?: string
}

/** Content-addressed source and inspection copies retained for one contract. */
export interface StoredTemplateAssets {
  readonly immutableSourcePath: string
  readonly normalizedPath: string
  readonly originalFileName: string
  readonly sourceSha256: string
  readonly normalizedSha256: string
}

interface BoundedAsset {
  bytes: Buffer
  sha256: string
  size: number
}

/**
 * Stores exact source bytes separately from the DOCX inspected by OfficeCLI.
 * Every published path is content-addressed and never overwritten.
 */
export class TemplateAssetStore {
  private readonly root: string

  constructor(
    private readonly ctx: Context,
    private readonly config: TemplateAssetStoreConfig,
  ) {
    if (!isAbsolute(config.storageRoot)) {
      throw new Error('template-service: storageRoot must be an absolute path')
    }
    this.root = resolve(config.storageRoot)
  }

  /**
   * Verify and retain a built-in member's source and normalized assets.
   * @param source - exact institutional source asset and manifest digest.
   * @param normalized - DOCX inspection asset and manifest digest.
   * @param signal - optional cancellation signal.
   * @returns immutable content-addressed paths and verified digests.
   */
  async importBuiltIn(
    source: TemplatePackSourceAsset,
    normalized: TemplatePackNormalizedAsset,
    signal?: AbortSignal,
  ): Promise<StoredTemplateAssets> {
    const sourceAsset = await this.readBounded(source.path, signal)
    this.assertManifestAsset('source', source.path, sourceAsset, source.sha256, source.size)
    const normalizedAsset = await this.readBounded(normalized.path, signal)
    this.assertManifestAsset('normalized', normalized.path, normalizedAsset, normalized.sha256, normalized.size)
    if (extname(normalized.path).toLowerCase() !== '.docx') {
      throw new Error(`template-service: normalized asset must be DOCX: ${normalized.path}`)
    }
    const sourceExtension = acceptedWordExtension(source.originalFileName)
    return {
      immutableSourcePath: await this.publish('sources', sourceAsset, sourceExtension),
      normalizedPath: await this.publish('normalized', normalizedAsset, '.docx'),
      originalFileName: source.originalFileName,
      sourceSha256: sourceAsset.sha256,
      normalizedSha256: normalizedAsset.sha256,
    }
  }

  /**
   * Copy a user-selected Word file before any inspection or conversion.
   * @param sourcePath - absolute or process-relative file selected by the user.
   * @param signal - optional cancellation signal.
   * @returns immutable source and OfficeCLI-readable inspection paths.
   */
  async importUpload(sourcePath: string, signal?: AbortSignal): Promise<StoredTemplateAssets> {
    const extension = acceptedWordExtension(sourcePath)
    const source = await this.readBounded(sourcePath, signal)
    const immutableSourcePath = await this.publish('sources', source, extension)
    if (extension === '.docx') {
      return {
        immutableSourcePath,
        normalizedPath: await this.publish('normalized', source, '.docx'),
        originalFileName: basename(sourcePath),
        sourceSha256: source.sha256,
        normalizedSha256: source.sha256,
      }
    }

    const convertedPath = await this.convertLegacyDoc(immutableSourcePath, signal)
    try {
      const normalized = await this.readBounded(convertedPath, signal)
      return {
        immutableSourcePath,
        normalizedPath: await this.publish('normalized', normalized, '.docx'),
        originalFileName: basename(sourcePath),
        sourceSha256: source.sha256,
        normalizedSha256: normalized.sha256,
      }
    } finally {
      await unlinkIfPresent(convertedPath)
    }
  }

  private async readBounded(path: string, signal?: AbortSignal): Promise<BoundedAsset> {
    throwIfAborted(signal)
    const stat = await lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`template-service: template source must be a regular file: ${path}`)
    }
    if (stat.size > this.config.maxUploadBytes) {
      throw new Error(`template-service: template source exceeds ${this.config.maxUploadBytes} bytes: ${path}`)
    }
    const bytes = await readFile(path)
    throwIfAborted(signal)
    /* v8 ignore next 2 -- this guard requires an external writer to race the
     * adjacent stat and read; immutable assets and copied uploads do not. */
    if (bytes.byteLength !== stat.size) {
      throw new Error(`template-service: template source changed while being read: ${path}`)
    }
    return {
      bytes,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size: bytes.byteLength,
    }
  }

  private assertManifestAsset(
    kind: string,
    path: string,
    actual: BoundedAsset,
    expectedSha256: string,
    expectedSize: number,
  ): void {
    if (!SHA256_PATTERN.test(expectedSha256)) {
      throw new Error(`template-service: ${kind} manifest has an invalid SHA-256: ${path}`)
    }
    if (actual.size !== expectedSize || actual.sha256 !== expectedSha256) {
      throw new Error(`template-service: ${kind} asset does not match its manifest: ${path}`)
    }
  }

  private async publish(directory: string, asset: BoundedAsset, extension: '.doc' | '.docx'): Promise<string> {
    const parent = join(this.root, directory)
    const target = join(parent, `${asset.sha256}${extension}`)
    await mkdir(parent, { recursive: true })
    const temporary = join(parent, `.${asset.sha256}.${randomUUID()}.tmp`)
    await writeFile(temporary, asset.bytes, { flag: 'wx', mode: 0o600 })
    try {
      try {
        await link(temporary, target)
      } catch (error) {
        /* v8 ignore next -- EEXIST is the only recoverable link race in this
         * private content-addressed directory; other failures pass through. */
        if (!isAlreadyExists(error)) throw error
        const existing = await this.readBounded(target)
        if (existing.sha256 !== asset.sha256) {
          throw new Error(`template-service: immutable asset path contains different bytes: ${target}`)
        }
      }
    } finally {
      await unlinkIfPresent(temporary)
    }
    await chmod(target, 0o444)
    return target
  }

  private async convertLegacyDoc(sourcePath: string, signal?: AbortSignal): Promise<string> {
    const command = this.config.wordComPowerShellCommand
    if (command === undefined || command.trim().length === 0) {
      throw new Error('template-service: legacy .doc upload requires the Windows Word converter')
    }
    const conversionRoot = join(this.root, 'conversion')
    await mkdir(conversionRoot, { recursive: true })
    const outputPath = join(conversionRoot, `${randomUUID()}.docx`)
    const resolved = await this.ctx.subprocess.resolveExecutable(command)
    const timeout = AbortSignal.timeout(this.config.converterTimeoutMs)
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    const handle = this.ctx.subprocess.spawn({
      argv: [
        resolved,
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        LEGACY_CONVERTER_SCRIPT,
        sourcePath,
        outputPath,
      ],
      cwd: this.root,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: this.config.converterOutputMaxBytes },
        stderr: { maxBytes: this.config.converterOutputMaxBytes },
      },
      graceMs: this.config.converterTerminateGraceMs,
      signal: combined,
    })
    const result = await collect(handle)
    if (timeout.aborted) {
      await unlinkIfPresent(outputPath)
      throw new Error(`template-service: legacy Word conversion timed out after ${this.config.converterTimeoutMs} ms`)
    }
    if (signal?.aborted === true) {
      await unlinkIfPresent(outputPath)
      throw abortError(signal.reason)
    }
    if (result.lossy) {
      await unlinkIfPresent(outputPath)
      throw new Error(`template-service: legacy Word converter output exceeded ${this.config.converterOutputMaxBytes} bytes`)
    }
    if (result.exitCode !== 0) {
      await unlinkIfPresent(outputPath)
      throw new Error(`template-service: legacy Word conversion failed: ${result.stderr.trim() || `exit ${String(result.exitCode)}`}`)
    }
    return outputPath
  }
}

interface CollectedProcess {
  exitCode: number | null
  stderr: string
  lossy: boolean
}

async function collect(handle: SubprocessHandle): Promise<CollectedProcess> {
  const outcome = await handle.done
  const stdout = handle.collected.stdout?.readFrom(0)
  const stderr = handle.collected.stderr?.readFrom(0)
  return {
    exitCode: outcome.exitCode,
    stderr: stderr?.text ?? '',
    lossy: stdout?.lossy === true || stderr?.lossy === true,
  }
}

function acceptedWordExtension(path: string): '.doc' | '.docx' {
  const extension = extname(path).toLowerCase()
  if (extension === '.doc' || extension === '.docx') return extension
  throw new Error(`template-service: Word template must use .doc or .docx: ${path}`)
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw abortError(signal.reason)
}

function abortError(reason: unknown): Error {
  if (reason instanceof Error) return reason
  if (typeof reason === 'string') return new Error(reason)
  return new Error('template operation aborted')
}

function isAlreadyExists(error: unknown): boolean {
  return error !== null
    && typeof error === 'object'
    && 'code' in error
    && (error as { code?: unknown }).code === 'EEXIST'
}

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch (error) {
    if (!isMissing(error)) throw error
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}
