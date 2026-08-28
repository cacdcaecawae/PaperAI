/** Shell-free Windows Word COM normalization for legacy binary `.doc` files. */

import { lstat, unlink } from 'node:fs/promises'
import { dirname, extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Stats } from 'node:fs'
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessRuntime,
} from '@deepseek-ai/dsh-subprocess'

/** Packaged PowerShell program used by the runtime and package invariant. */
export const LEGACY_DOC_CONVERTER_ASSET = fileURLToPath(new URL('../assets/convert-legacy-doc.ps1', import.meta.url))

const WORD_COM_UNAVAILABLE_EXIT_CODE = 42
const WORD_COM_UNAVAILABLE_MARKER = 'PAPERAI_WORD_COM_UNAVAILABLE:'

/** Result expected by the document service's structural legacy normalizer. */
export type LegacyDocNormalizationResult =
  | { status: 'normalized' }
  | { status: 'degraded'; detail: string }

/** Stable legacy conversion failure categories. */
export type LegacyDocConversionErrorCode =
  | 'CANCELLED'
  | 'TIMED_OUT'
  | 'OUTPUT_TRUNCATED'
  | 'PROCESS_FAILED'
  | 'TARGET_INVALID'

/** Failure from an attempted conversion rather than an unavailable capability. */
export class LegacyDocConversionError extends Error {
  /**
   * @param code - stable caller-facing failure category.
   * @param message - actionable failure description.
   * @param options - optional underlying process or filesystem failure.
   */
  constructor(
    readonly code: LegacyDocConversionErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'LegacyDocConversionError'
  }
}

/** Fully resolved converter limits and command selection. */
export interface LegacyDocConverterConfig {
  readonly command: string | false | undefined
  readonly timeoutMs: number
  readonly outputMaxBytes: number
  readonly terminateGraceMs: number
}

interface CollectedConversion {
  readonly stdout: string
  readonly stderr: string
  readonly lossy: boolean
  readonly outcome: SubprocessOutcome
}

/**
 * Normalize one legacy Word file without modifying it.
 * @param subprocess - managed execution-world process Provider.
 * @param config - command selection and bounded process limits.
 * @param sourceDocPath - existing legacy `.doc`, opened read-only by Word.
 * @param targetDocxPath - absent path receiving an independent DOCX.
 * @param signal - optional caller cancellation.
 * @param platform - host platform fact, injectable for deterministic tests.
 * @returns normalized on success, or degraded when the required Windows capability is unavailable.
 * @throws LegacyDocConversionError for cancellation, timeout, truncation, conversion failure, or invalid output.
 */
export async function convertLegacyDocument(
  subprocess: SubprocessRuntime,
  config: LegacyDocConverterConfig,
  sourceDocPath: string,
  targetDocxPath: string,
  signal?: AbortSignal,
  platform: NodeJS.Platform = process.platform,
): Promise<LegacyDocNormalizationResult> {
  if (platform !== 'win32') {
    return { status: 'degraded', detail: `Legacy .doc conversion requires Windows and Microsoft Word; current platform is ${platform}` }
  }
  const command = config.command === undefined ? 'powershell.exe' : config.command
  if (command === false || command.trim().length === 0) {
    return { status: 'degraded', detail: 'Legacy .doc conversion is disabled because no PowerShell command is configured' }
  }

  const paths = conversionPaths(sourceDocPath, targetDocxPath)
  await assertAbsentTarget(paths.target)
  if (aborted(signal)) throw cancelled(signal?.reason)

  let executable: string
  try {
    executable = await subprocess.resolveExecutable(command, undefined, signal)
  } catch (error) {
    if (aborted(signal)) throw cancelled(signal?.reason, error)
    return {
      status: 'degraded',
      detail: `Legacy .doc conversion cannot start PowerShell '${command}': ${errorText(error)}`,
    }
  }

  let retainTarget = false
  let primaryFailure: unknown
  try {
    const timeout = AbortSignal.timeout(config.timeoutMs)
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    let result: CollectedConversion
    try {
      const handle = subprocess.spawn({
        argv: [
          executable,
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          LEGACY_DOC_CONVERTER_ASSET,
          paths.source,
          paths.target,
        ],
        cwd: dirname(paths.target),
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: config.outputMaxBytes },
          stderr: { maxBytes: config.outputMaxBytes },
        },
        graceMs: config.terminateGraceMs,
        signal: combined,
        env: {},
      })
      result = await collect(handle)
    } catch (error) {
      if (aborted(signal)) throw cancelled(signal?.reason, error)
      if (timeout.aborted) {
        throw new LegacyDocConversionError(
          'TIMED_OUT',
          `Legacy .doc conversion timed out after ${config.timeoutMs} ms`,
          { cause: error },
        )
      }
      throw new LegacyDocConversionError('PROCESS_FAILED', 'Legacy .doc converter process failed to start or settle', { cause: error })
    }

    if (aborted(signal)) throw cancelled(signal?.reason)
    if (timeout.aborted) {
      throw new LegacyDocConversionError('TIMED_OUT', `Legacy .doc conversion timed out after ${config.timeoutMs} ms`)
    }
    if (result.lossy) {
      throw new LegacyDocConversionError(
        'OUTPUT_TRUNCATED',
        `Legacy .doc converter output exceeded ${config.outputMaxBytes} bytes`,
      )
    }
    if (result.outcome.exitCode === WORD_COM_UNAVAILABLE_EXIT_CODE
      || result.stderr.includes(WORD_COM_UNAVAILABLE_MARKER)) {
      return {
        status: 'degraded',
        detail: `Microsoft Word COM is unavailable: ${stripMarker(result.stderr)}`,
      }
    }
    if (result.outcome.exitCode !== 0) {
      const disposition = result.outcome.exitCode === null
        ? `signal ${String(result.outcome.signal)}`
        : `exit ${String(result.outcome.exitCode)}`
      throw new LegacyDocConversionError(
        'PROCESS_FAILED',
        `Legacy .doc conversion failed: ${result.stderr.trim() || disposition}`,
      )
    }
    await assertUsableTarget(paths.target)
    retainTarget = true
    return { status: 'normalized' }
  } catch (error) {
    primaryFailure = error
    throw error
  } finally {
    if (!retainTarget) {
      try {
        await unlinkIfPresent(paths.target)
      } catch (cleanupError) {
        if (primaryFailure !== undefined) {
          throw new AggregateError([primaryFailure, cleanupError], `Legacy .doc conversion failed and could not remove '${paths.target}'`)
        }
        throw cleanupError
      }
    }
  }
}

async function collect(handle: SubprocessHandle): Promise<CollectedConversion> {
  const outcome = await handle.done
  const stdout = handle.collected.stdout?.readFrom(0)
  const stderr = handle.collected.stderr?.readFrom(0)
  return {
    stdout: stdout?.text ?? '',
    stderr: stderr?.text ?? '',
    lossy: stdout?.lossy === true || stderr?.lossy === true,
    outcome,
  }
}

function conversionPaths(sourceDocPath: string, targetDocxPath: string): { source: string; target: string } {
  const source = resolve(sourceDocPath).toLocaleLowerCase('en-US')
  const target = resolve(targetDocxPath).toLocaleLowerCase('en-US')
  if (extname(source).toLocaleLowerCase('en-US') !== '.doc') {
    throw new LegacyDocConversionError('TARGET_INVALID', `Legacy Word source must use .doc: ${sourceDocPath}`)
  }
  if (extname(target).toLocaleLowerCase('en-US') !== '.docx') {
    throw new LegacyDocConversionError('TARGET_INVALID', `Legacy Word target must use .docx: ${targetDocxPath}`)
  }
  return { source: resolve(sourceDocPath), target: resolve(targetDocxPath) }
}

async function assertAbsentTarget(path: string): Promise<void> {
  try {
    await lstat(path)
  } catch (error) {
    rethrowUnlessMissing(error)
    return
  }
  throw new LegacyDocConversionError('TARGET_INVALID', `Legacy Word target already exists: ${path}`)
}

async function assertUsableTarget(path: string): Promise<void> {
  try {
    const metadata = await lstat(path)
    if (!isUsableTarget(metadata)) throw new Error('not a non-empty regular file')
  } catch (error) {
    throw new LegacyDocConversionError('TARGET_INVALID', `Legacy .doc conversion did not produce a usable DOCX at '${path}'`, { cause: error })
  }
}

/**
 * Decide whether converter output is a non-empty regular file rather than a link.
 * @param metadata - target metadata read without following links.
 * @returns true only for usable converter output.
 */
export function isUsableTarget(metadata: Pick<Stats, 'isFile' | 'isSymbolicLink' | 'size'>): boolean {
  return metadata.isFile() && !metadata.isSymbolicLink() && metadata.size > 0
}

function cancelled(reason: unknown, cause?: unknown): LegacyDocConversionError {
  const detail = reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : 'caller cancellation'
  return new LegacyDocConversionError('CANCELLED', `Legacy .doc conversion was cancelled: ${detail}`, { cause })
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function stripMarker(stderr: string): string {
  const detail = stderr.replace(WORD_COM_UNAVAILABLE_MARKER, '').trim()
  return detail.length === 0 ? 'Word.Application is not registered' : detail
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

/**
 * Accept only a missing-path filesystem failure.
 * @param error - filesystem lookup or unlink failure.
 * @throws the original failure when it is not ENOENT.
 */
export function rethrowUnlessMissing(error: unknown): void {
  if (!isMissing(error)) throw error
}

function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false
}
