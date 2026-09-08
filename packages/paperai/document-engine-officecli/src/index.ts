/**
 * OfficeCLI Service Provider for `ctx.documentEngine`.
 * @module @paperai/document-engine-officecli
 */

import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { readFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { SubprocessHandle, SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'
import { DocumentEngine } from '@paperai/document-engine'
import type { EngineMutation, EngineTextNode, EngineValidation } from '@paperai/document-engine'
import type { CapabilityHealth } from '@paperai/domain'
import {
  convertLegacyDocument,
  LegacyDocConversionError,
  type LegacyDocNormalizationResult,
} from './legacy-doc.ts'

export { LegacyDocConversionError }
export type { LegacyDocConversionErrorCode, LegacyDocNormalizationResult } from './legacy-doc.ts'

interface OfficePackageJson {
  bin?: string | Record<string, string>
}

interface CommandResult {
  stdout: string
  stderr: string
  outcome: SubprocessOutcome
}

/** Typed OfficeCLI failure with captured process output. */
export class OfficeCliError extends Error {
  constructor(message: string, readonly result?: CommandResult) {
    super(message)
    this.name = 'OfficeCliError'
  }
}

/** Provider configuration; every deployment-sensitive limit is explicit. */
export interface Config {
  /** Explicit OfficeCLI executable; omitting it uses the pinned npm package. */
  command?: string
  /** Positive per-command deadline. */
  timeoutMs?: number
  /** Positive in-memory cap for each output stream. */
  outputMaxBytes?: number
  /** Positive TERM-to-KILL grace delegated to the subprocess Provider. */
  terminateGraceMs?: number
  /** Positive independent deadline for closing a resident document after an operation. */
  cleanupTimeoutMs?: number
  /** PowerShell executable for Word COM conversion; false or an empty string disables legacy `.doc` import. */
  legacyDocPowerShellCommand?: string | false
  /** Positive deadline for one legacy `.doc` conversion. */
  legacyDocTimeoutMs?: number
  /** Positive in-memory cap for each legacy converter output stream. */
  legacyDocOutputMaxBytes?: number
  /** Positive TERM-to-KILL grace for the legacy converter process tree. */
  legacyDocTerminateGraceMs?: number
}

interface ResolvedConfig {
  command: string | undefined
  timeoutMs: number
  outputMaxBytes: number
  terminateGraceMs: number
  cleanupTimeoutMs: number
  legacyDocPowerShellCommand: string | false | undefined
  legacyDocTimeoutMs: number
  legacyDocOutputMaxBytes: number
  legacyDocTerminateGraceMs: number
}

const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_OUTPUT_MAX_BYTES = 32 * 1024 * 1024
const DEFAULT_TERMINATE_GRACE_MS = 2_000
const DEFAULT_CLEANUP_TIMEOUT_MS = 5_000
const DEFAULT_LEGACY_DOC_TIMEOUT_MS = 120_000
const DEFAULT_LEGACY_DOC_OUTPUT_MAX_BYTES = 1024 * 1024
const DEFAULT_LEGACY_DOC_TERMINATE_GRACE_MS = 5_000

const positiveSafeInteger = (value: number, name: string): void => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`document-engine-officecli: ${name} must be a positive safe integer`)
  }
}

/**
 * Resolve the OfficeCLI bin entry from its npm manifest.
 * @param manifest - parsed pinned package manifest.
 * @returns relative launcher path.
 */
export function officeCliBin(manifest: OfficePackageJson): string {
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.officecli
  if (bin === undefined) throw new Error('@officecli/officecli declares no officecli binary')
  return bin
}

/** Resolve the pinned package's Node launcher without invoking a shell. */
function packagedCommand(): { command: string; prefix: string[] } {
  const require = createRequire(import.meta.url)
  const entry = require.resolve('@officecli/officecli')
  const packagePath = join(dirname(dirname(entry)), 'package.json')
  const manifest = JSON.parse(readFileSync(packagePath, 'utf8')) as OfficePackageJson
  const bin = officeCliBin(manifest)
  return { command: process.execPath, prefix: [join(dirname(packagePath), bin)] }
}

/** OfficeCLI-backed Word engine with one FIFO lease per exact file path. */
export class OfficeCliDocumentEngine extends DocumentEngine {
  static inject = ['subprocess']
  static Config: z<Config> = z.object({
    command: z.string(),
    timeoutMs: z.number().default(DEFAULT_TIMEOUT_MS),
    outputMaxBytes: z.number().default(DEFAULT_OUTPUT_MAX_BYTES),
    terminateGraceMs: z.number().default(DEFAULT_TERMINATE_GRACE_MS),
    cleanupTimeoutMs: z.number().default(DEFAULT_CLEANUP_TIMEOUT_MS),
    legacyDocPowerShellCommand: z.union([z.const(false), z.string()]),
    legacyDocTimeoutMs: z.number().default(DEFAULT_LEGACY_DOC_TIMEOUT_MS),
    legacyDocOutputMaxBytes: z.number().default(DEFAULT_LEGACY_DOC_OUTPUT_MAX_BYTES),
    legacyDocTerminateGraceMs: z.number().default(DEFAULT_LEGACY_DOC_TERMINATE_GRACE_MS),
  })

  private readonly config: ResolvedConfig
  private readonly leases = new Map<string, Promise<void>>()
  private resolvedCommand?: Promise<{ command: string; prefix: string[] }>

  constructor(ctx: Context, config: Config) {
    super(ctx)
    const resolved: ResolvedConfig = {
      command: config.command,
      timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      outputMaxBytes: config.outputMaxBytes ?? DEFAULT_OUTPUT_MAX_BYTES,
      terminateGraceMs: config.terminateGraceMs ?? DEFAULT_TERMINATE_GRACE_MS,
      cleanupTimeoutMs: config.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS,
      legacyDocPowerShellCommand: config.legacyDocPowerShellCommand,
      legacyDocTimeoutMs: config.legacyDocTimeoutMs ?? DEFAULT_LEGACY_DOC_TIMEOUT_MS,
      legacyDocOutputMaxBytes: config.legacyDocOutputMaxBytes ?? DEFAULT_LEGACY_DOC_OUTPUT_MAX_BYTES,
      legacyDocTerminateGraceMs: config.legacyDocTerminateGraceMs ?? DEFAULT_LEGACY_DOC_TERMINATE_GRACE_MS,
    }
    positiveSafeInteger(resolved.timeoutMs, 'timeoutMs')
    positiveSafeInteger(resolved.outputMaxBytes, 'outputMaxBytes')
    positiveSafeInteger(resolved.terminateGraceMs, 'terminateGraceMs')
    positiveSafeInteger(resolved.cleanupTimeoutMs, 'cleanupTimeoutMs')
    positiveSafeInteger(resolved.legacyDocTimeoutMs, 'legacyDocTimeoutMs')
    positiveSafeInteger(resolved.legacyDocOutputMaxBytes, 'legacyDocOutputMaxBytes')
    positiveSafeInteger(resolved.legacyDocTerminateGraceMs, 'legacyDocTerminateGraceMs')
    this.config = resolved
  }

  override async health(signal?: AbortSignal): Promise<CapabilityHealth> {
    try {
      const result = await this.run(['--version'], signal, true)
      if (result.outcome.exitCode !== 0) {
        return { status: 'unavailable', detail: result.stderr.trim() || 'OfficeCLI returned a non-zero status' }
      }
      const version = result.stdout.trim().split(/\s+/u).at(-1)
      return {
        status: 'ready',
        detail: 'OfficeCLI 文档引擎已就绪',
        ...(version === undefined || version.length === 0 ? {} : { version }),
      }
    } catch (error) {
      return { status: 'unavailable', detail: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * Convert a legacy binary Word document into an independent DOCX.
   * @param sourceDocPath - `.doc` source opened read-only by Microsoft Word.
   * @param targetDocxPath - absent `.docx` path that receives the converted copy.
   * @param signal - optional caller cancellation propagated to executable lookup and the process tree.
   * @returns normalized on success, or degraded when Windows, PowerShell, or Word COM is unavailable.
   * @throws LegacyDocConversionError for cancellation, timeout, output truncation,
   * conversion failure, or invalid output.
   */
  async normalizeLegacyDocument(
    sourceDocPath: string,
    targetDocxPath: string,
    signal?: AbortSignal,
  ): Promise<LegacyDocNormalizationResult> {
    return await convertLegacyDocument(this.ctx.subprocess, {
      command: this.config.legacyDocPowerShellCommand,
      timeoutMs: this.config.legacyDocTimeoutMs,
      outputMaxBytes: this.config.legacyDocOutputMaxBytes,
      terminateGraceMs: this.config.legacyDocTerminateGraceMs,
    }, sourceDocPath, targetDocxPath, signal)
  }

  override readTextNodes(filePath: string, signal?: AbortSignal): Promise<EngineTextNode[]> {
    return this.withLease(filePath, async () => {
      try {
        const result = await this.run(['view', filePath, 'text', '--max-lines', '100000'], signal)
        return result.stdout.split(/\r?\n/u).flatMap((line): EngineTextNode[] => {
          const parsed = this.parseTextLine(line)
          if (parsed === undefined) return []
          return [{
            officePath: parsed.officePath,
            text: parsed.text,
            kind: parsed.officePath.includes('/tbl[')
              ? 'table'
              : parsed.officePath.includes('/p[') ? 'paragraph' : 'unknown',
          }]
        })
      } finally {
        await this.closeBestEffort(filePath)
      }
    })
  }

  override previewHtml(filePath: string, signal?: AbortSignal): Promise<string> {
    return this.withLease(filePath, async () => {
      try {
        return (await this.run(['view', filePath, 'html'], signal)).stdout
      } finally {
        await this.closeBestEffort(filePath)
      }
    })
  }

  override inspect(filePath: string, officePath: string, depth = 2, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.withLease(filePath, async () => {
      try {
        const result = await this.run(['get', filePath, officePath, '--depth', String(depth), '--json'], signal)
        return this.parseEnvelope(result.stdout)
      } finally {
        await this.closeBestEffort(filePath)
      }
    })
  }

  override applyMutations(filePath: string, mutations: readonly EngineMutation[], signal?: AbortSignal): Promise<void> {
    return this.withLease(filePath, async () => {
      try {
        for (const mutation of mutations) {
          await this.run(this.mutationArgs(filePath, mutation), signal)
        }
        await this.run(['save', filePath, '--json'], signal)
      } finally {
        await this.closeBestEffort(filePath)
      }
    })
  }

  override validate(filePath: string, signal?: AbortSignal): Promise<EngineValidation> {
    return this.withLease(filePath, async () => {
      try {
        const result = await this.run(['validate', filePath, '--json'], signal, true)
        const details = result.stdout.trim() === ''
          ? { stderr: result.stderr }
          : this.parseEnvelope(result.stdout)
        const declared = typeof details.success === 'boolean' ? details.success : undefined
        return { success: declared ?? result.outcome.exitCode === 0, details }
      } finally {
        await this.closeBestEffort(filePath)
      }
    })
  }

  private mutationArgs(filePath: string, mutation: EngineMutation): string[] {
    if (mutation.type === 'replace-text') {
      return ['set', filePath, mutation.officePath, '--prop', `text=${mutation.text}`, '--json']
    }
    if (mutation.type === 'remove') return ['remove', filePath, mutation.officePath, '--json']
    const args = ['add', filePath, '/body', '--type', 'paragraph', '--prop', `text=${mutation.text}`]
    if (mutation.style !== undefined) args.push('--prop', `style=${mutation.style}`)
    if (mutation.after !== undefined) args.push('--after', mutation.after)
    if (mutation.before !== undefined) args.push('--before', mutation.before)
    if (mutation.index !== undefined) args.push('--index', String(mutation.index))
    args.push('--json')
    return args
  }

  private async command(): Promise<{ command: string; prefix: string[] }> {
    return await (this.resolvedCommand ??= (async () => {
      const selected = this.config.command === undefined
        ? packagedCommand()
        : { command: this.config.command, prefix: [] }
      return {
        command: await this.ctx.subprocess.resolveExecutable(selected.command),
        prefix: selected.prefix,
      }
    })())
  }

  private async run(
    args: readonly string[],
    signal?: AbortSignal,
    allowFailure = false,
    timeoutMs = this.config.timeoutMs,
  ): Promise<CommandResult> {
    const command = await this.command()
    const timeout = AbortSignal.timeout(timeoutMs)
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    const handle = this.ctx.subprocess.spawn({
      argv: [command.command, ...command.prefix, ...args],
      cwd: process.cwd(),
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: this.config.outputMaxBytes },
        stderr: { maxBytes: this.config.outputMaxBytes },
      },
      graceMs: this.config.terminateGraceMs,
      signal: combined,
      env: {
        OFFICECLI_SKIP_UPDATE: '1',
        OFFICECLI_RESIDENT_FLUSH: 'each',
      },
    })
    const result = await this.collect(handle)
    if (timeout.aborted) throw new OfficeCliError(`OfficeCLI timed out after ${timeoutMs} ms`, result)
    if (signal?.aborted === true) throw new OfficeCliError('OfficeCLI operation was cancelled', result)
    if (!allowFailure && result.outcome.exitCode !== 0) {
      throw new OfficeCliError(result.stderr.trim() || `OfficeCLI failed with exit code ${result.outcome.exitCode}`, result)
    }
    return result
  }

  private async collect(handle: SubprocessHandle): Promise<CommandResult> {
    const outcome = await handle.done
    const stdout = handle.collected.stdout?.readFrom(0)
    const stderr = handle.collected.stderr?.readFrom(0)
    if (stdout?.lossy === true || stderr?.lossy === true) {
      throw new OfficeCliError(`OfficeCLI output exceeded ${this.config.outputMaxBytes} bytes`)
    }
    return { stdout: stdout?.text ?? '', stderr: stderr?.text ?? '', outcome }
  }

  private async closeBestEffort(filePath: string): Promise<void> {
    try {
      await this.run(['close', filePath, '--json'], undefined, true, this.config.cleanupTimeoutMs)
    } catch (error) {
      this.ctx.logger.warn(`OfficeCLI could not close '${filePath}': ${String(error)}`)
    }
  }

  private withLease<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.leases.get(filePath) ?? Promise.resolve()
    const run = prior.then(operation)
    const tail = run.then(() => undefined, () => undefined)
    this.leases.set(filePath, tail)
    return run.finally(() => {
      if (this.leases.get(filePath) === tail) this.leases.delete(filePath)
    })
  }

  private parseTextLine(line: string): { officePath: string; text: string } | undefined {
    if (!line.startsWith('[')) return undefined
    let nested = 0
    for (let index = 1; index < line.length; index += 1) {
      if (line[index] === '[') nested += 1
      if (line[index] !== ']') continue
      if (nested > 0) {
        nested -= 1
        continue
      }
      const officePath = line.slice(1, index)
      if (!officePath.startsWith('/')) return undefined
      return { officePath, text: line.slice(index + 1).trimStart() }
    }
    return undefined
  }

  private parseEnvelope(stdout: string): Record<string, unknown> {
    try {
      const parsed = JSON.parse(stdout) as Record<string, unknown>
      return parsed.data !== null && typeof parsed.data === 'object'
        ? parsed.data as Record<string, unknown>
        : parsed
    } catch (error) {
      throw new OfficeCliError(`OfficeCLI returned invalid JSON: ${(error as Error).message}`)
    }
  }
}

export default OfficeCliDocumentEngine
