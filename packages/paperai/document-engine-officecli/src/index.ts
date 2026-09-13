/**
 * OfficeCLI Service Provider for `ctx.documentEngine`.
 * @module @paperai/document-engine-officecli
 */

import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, rmdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { DOMParser, onWarningStopParsing, XMLSerializer, type Element as XmlElement } from '@xmldom/xmldom'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { SubprocessHandle, SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'
import { DocumentEngine } from '@paperai/document-engine'
import type { EngineMutation, EngineParagraphStyle, EngineTextNode, EngineValidation } from '@paperai/document-engine'
import type { CapabilityHealth } from '@paperai/domain'
import { applyDocumentMutations } from './document-mutations.ts'
import { resolveOfficePath } from './office-path.ts'
import { replaceParagraphXml } from './paragraph-xml.ts'
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

const WORD_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'

function parseWordXml(xml: unknown, part: string): XmlElement {
  if (typeof xml !== 'string') throw new OfficeCliError(`OfficeCLI did not return ${part} XML`)
  const root = new DOMParser({ onError: onWarningStopParsing }).parseFromString(xml, 'application/xml').documentElement
  if (root === null || root.namespaceURI !== WORD_NS || root.localName !== part) {
    throw new OfficeCliError(`OfficeCLI returned invalid ${part} XML`)
  }
  return root
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
  /** Positive independent deadline for one best-effort `close` of a resident document. */
  cleanupTimeoutMs?: number
  /** Positive idle time after the last operation before a resident document is closed. */
  residentIdleMs?: number
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
  residentIdleMs: number
  legacyDocPowerShellCommand: string | false | undefined
  legacyDocTimeoutMs: number
  legacyDocOutputMaxBytes: number
  legacyDocTerminateGraceMs: number
}

const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_OUTPUT_MAX_BYTES = 32 * 1024 * 1024
const DEFAULT_TERMINATE_GRACE_MS = 2_000
const DEFAULT_CLEANUP_TIMEOUT_MS = 5_000
const DEFAULT_RESIDENT_IDLE_MS = 2_000
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

/** OfficeCLI-backed `ctx.documentEngine`: every operation runs through the pinned launcher under one per-file lease. */
export class OfficeCliDocumentEngine extends DocumentEngine {
  static inject = ['subprocess']
  static Config: z<Config> = z.object({
    command: z.string(),
    timeoutMs: z.number().default(DEFAULT_TIMEOUT_MS),
    outputMaxBytes: z.number().default(DEFAULT_OUTPUT_MAX_BYTES),
    terminateGraceMs: z.number().default(DEFAULT_TERMINATE_GRACE_MS),
    cleanupTimeoutMs: z.number().default(DEFAULT_CLEANUP_TIMEOUT_MS),
    residentIdleMs: z.number().default(DEFAULT_RESIDENT_IDLE_MS),
    legacyDocPowerShellCommand: z.union([z.const(false), z.string()]),
    legacyDocTimeoutMs: z.number().default(DEFAULT_LEGACY_DOC_TIMEOUT_MS),
    legacyDocOutputMaxBytes: z.number().default(DEFAULT_LEGACY_DOC_OUTPUT_MAX_BYTES),
    legacyDocTerminateGraceMs: z.number().default(DEFAULT_LEGACY_DOC_TERMINATE_GRACE_MS),
  })

  private readonly config: ResolvedConfig
  private readonly leases = new Map<string, Promise<void>>()
  private readonly idle = new Map<string, ReturnType<typeof setTimeout>>()
  private resolvedCommand?: Promise<{ command: string; prefix: string[] }>

  constructor(ctx: Context, config: Config) {
    super(ctx)
    const resolved: ResolvedConfig = {
      command: config.command,
      timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      outputMaxBytes: config.outputMaxBytes ?? DEFAULT_OUTPUT_MAX_BYTES,
      terminateGraceMs: config.terminateGraceMs ?? DEFAULT_TERMINATE_GRACE_MS,
      cleanupTimeoutMs: config.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS,
      residentIdleMs: config.residentIdleMs ?? DEFAULT_RESIDENT_IDLE_MS,
      legacyDocPowerShellCommand: config.legacyDocPowerShellCommand,
      legacyDocTimeoutMs: config.legacyDocTimeoutMs ?? DEFAULT_LEGACY_DOC_TIMEOUT_MS,
      legacyDocOutputMaxBytes: config.legacyDocOutputMaxBytes ?? DEFAULT_LEGACY_DOC_OUTPUT_MAX_BYTES,
      legacyDocTerminateGraceMs: config.legacyDocTerminateGraceMs ?? DEFAULT_LEGACY_DOC_TERMINATE_GRACE_MS,
    }
    positiveSafeInteger(resolved.timeoutMs, 'timeoutMs')
    positiveSafeInteger(resolved.outputMaxBytes, 'outputMaxBytes')
    positiveSafeInteger(resolved.terminateGraceMs, 'terminateGraceMs')
    positiveSafeInteger(resolved.cleanupTimeoutMs, 'cleanupTimeoutMs')
    positiveSafeInteger(resolved.residentIdleMs, 'residentIdleMs')
    positiveSafeInteger(resolved.legacyDocTimeoutMs, 'legacyDocTimeoutMs')
    positiveSafeInteger(resolved.legacyDocOutputMaxBytes, 'legacyDocOutputMaxBytes')
    positiveSafeInteger(resolved.legacyDocTerminateGraceMs, 'legacyDocTerminateGraceMs')
    this.config = resolved
    ctx.effect(() => () => this.releaseAll(), 'document-engine-officecli: resident documents')
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
    })
  }

  override previewHtml(filePath: string, signal?: AbortSignal): Promise<string> {
    return this.withLease(filePath, async () => (await this.run(['view', filePath, 'html'], signal)).stdout)
  }

  override readParagraphStyles(filePath: string, signal?: AbortSignal): Promise<EngineParagraphStyle[]> {
    return this.withLease(filePath, () => this.paragraphStyles(filePath, signal))
  }

  private async paragraphStyles(filePath: string, signal?: AbortSignal): Promise<EngineParagraphStyle[]> {
    const result = await this.run(['raw', filePath, '/styles', '--json'], signal)
    const data = this.parseEnvelope(result.stdout).data
    if (data === '(no styles)') return []
    const root = parseWordXml(data, 'styles')
    return Array.from(root.getElementsByTagNameNS(WORD_NS, 'style')).flatMap((style) => {
      if (style.getAttributeNS(WORD_NS, 'type') !== 'paragraph') return []
      const id = style.getAttributeNS(WORD_NS, 'styleId')
      if (id === null || id === '') return []
      const name = style.getElementsByTagNameNS(WORD_NS, 'name')[0]?.getAttributeNS(WORD_NS, 'val')
      return [{ id, name: name || id }]
    })
  }

  override inspect(filePath: string, officePath: string, depth = 2, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.withLease(filePath, async () => {
      const result = await this.run(['get', filePath, officePath, '--depth', String(depth), '--json'], signal)
      return this.parseEnvelope(result.stdout)
    })
  }

  override applyMutations(filePath: string, mutations: readonly EngineMutation[], signal?: AbortSignal): Promise<void> {
    return this.withLease(filePath, async () => {
      if (mutations.length === 0) return
      const raw = await this.run(['raw', filePath, '/document', '--json'], signal)
      const data = this.parseEnvelope(raw.stdout).data
      const root = parseWordXml(data, 'document')
      const stylesNeeded = mutations.some(mutation => mutation.type === 'insert-paragraph'
        ? mutation.style !== undefined
        : mutation.type === 'replace-text' && mutation.paragraphs?.some(paragraph => paragraph.format?.style !== undefined))
      const styles = stylesNeeded ? await this.paragraphStyles(filePath, signal) : []
      const resolveStyle = (name: string): string => {
        const style = styles.find(style => style.id === name)
          ?? styles.find(style => style.id.toLowerCase() === name.toLowerCase())
          ?? styles.find(style => style.name.toLowerCase() === name.toLowerCase())
        if (style === undefined) throw new OfficeCliError(`UNKNOWN_PARAGRAPH_STYLE: '${name}' is not a paragraph style in this document`)
        return style.id
      }
      applyDocumentMutations(root, mutations,
        (paragraph, mutation) => { replaceParagraphXml(paragraph, mutation, resolveStyle) }, resolveStyle)
      const body = resolveOfficePath(root, '/body')
      // The package part preserves legacy attributes; the /document alias reparses typed OpenXML and renames them.
      const commands = [{ command: 'raw-set', part: '/word/document.xml', xpath: '/w:document/w:body', action: 'replace',
        xml: new XMLSerializer().serializeToString(body) }]
      const directory = await mkdtemp(join(tmpdir(), 'paperai-officecli-'))
      const input = join(directory, 'commands.json')
      try {
        await writeFile(input, JSON.stringify(commands), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
        const batch = await this.run(['batch', filePath, '--input', input, '--json'], signal)
        const response = this.parseEnvelope(batch.stdout)
        const summary = response.summary as Record<string, unknown> | null | undefined
        const results = response.results as Array<Record<string, unknown> | null> | undefined
        if (summary?.total !== 1 || summary.executed !== 1 || summary.succeeded !== 1
          || summary.failed !== 0 || summary.skipped !== 0
          || !Array.isArray(results) || results.length !== 1 || results[0]?.index !== 0 || results[0].success !== true) {
          throw new OfficeCliError('OfficeCLI did not apply the complete document batch', batch)
        }
        await this.run(['save', filePath, '--json'], signal)
      } finally {
        await rm(input, { force: true })
        await rmdir(directory)
      }
    })
  }
  override validate(filePath: string, signal?: AbortSignal): Promise<EngineValidation> {
    return this.withLease(filePath, async () => {
      const result = await this.run(['validate', filePath, '--json'], signal, true)
      const details = result.stdout.trim() === ''
        ? { stderr: result.stderr }
        : this.parseEnvelope(result.stdout)
      const declared = typeof details.success === 'boolean' ? details.success : undefined
      return { success: declared ?? result.outcome.exitCode === 0, details }
    })
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

  /**
   * Close the resident OfficeCLI process for one file so the next operation reads the bytes on disk.
   * Callers replace or delete the file only after this resolves; without a resident there is nothing to do.
   * @param filePath - canonical DOCX path about to be replaced or removed.
   */
  override release(filePath: string): Promise<void> {
    if (!this.idle.has(filePath) && !this.leases.has(filePath)) return Promise.resolve()
    return this.withLease(filePath, () => this.closeBestEffort(filePath), false)
  }

  private async releaseAll(): Promise<void> {
    const paths = new Set([...this.idle.keys(), ...this.leases.keys()])
    await Promise.all([...paths].map(filePath => this.release(filePath)))
  }

  /**
   * Serialize operations per file. Every OfficeCLI command leaves a resident process holding the
   * document in memory, so the lease keeps it running between operations and closes it after
   * `residentIdleMs` without work; `release` closes it immediately and schedules nothing.
   */
  private withLease<T>(filePath: string, operation: () => Promise<T>, retain = true): Promise<T> {
    clearTimeout(this.idle.get(filePath))
    this.idle.delete(filePath)
    const prior = this.leases.get(filePath) ?? Promise.resolve()
    const run = prior.then(operation)
    const tail = run.then(() => undefined, () => undefined)
    this.leases.set(filePath, tail)
    return run.finally(() => {
      if (this.leases.get(filePath) !== tail) return
      this.leases.delete(filePath)
      if (!retain) return
      const timer = setTimeout(() => { void this.release(filePath) }, this.config.residentIdleMs)
      timer.unref()
      this.idle.set(filePath, timer)
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
