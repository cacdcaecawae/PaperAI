/**
 * OfficeCLI Service Provider for `ctx.documentEngine`.
 * @module @paperai/document-engine-officecli
 */

import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { readFileSync } from 'node:fs'
import { DOMParser, onWarningStopParsing, type Element as XmlElement } from '@xmldom/xmldom'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { SubprocessHandle, SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'
import { DocumentEngine } from '@paperai/document-engine'
import type { EngineMutation, EngineTextNode, EngineTextRun, EngineValidation } from '@paperai/document-engine'
import type { CapabilityHealth, DocumentParagraph, DocumentParagraphFormat } from '@paperai/domain'
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

/** OfficeCLI `--prop` values for one run; Word writes the Latin and complex-script sizes together, so both travel. */
function runProps(run: EngineTextRun): Record<string, string> {
  return {
    ...(run.bold === undefined ? {} : { bold: String(run.bold) }),
    ...(run.italic === undefined ? {} : { italic: String(run.italic) }),
    ...(run.underline === undefined ? {} : { underline: run.underline ? 'single' : 'none' }),
    ...(run.size === undefined ? {} : { size: run.size, 'size.cs': run.size }),
    ...(run.color === undefined ? {} : { color: run.color }),
    ...(run.font === undefined ? {} : { font: run.font }),
  }
}

/**
 * Rebuild one paragraph from its runs. The paragraph setter creates the first
 * run, including soft breaks. Run setters change only formatting; appended
 * run text encodes vertical-tab soft breaks as line feeds for OfficeCLI add.
 * @param officePath - paragraph or cell paragraph being rebuilt.
 * @param runs - the block's runs in reading order.
 * @returns OfficeCLI batch items in application order.
 */
function runBatch(officePath: string, runs: readonly EngineTextRun[]): Record<string, unknown>[] {
  const [first, ...rest] = runs
  const firstProps = first === undefined ? {} : runProps(first)
  return [
    { command: 'set', path: officePath, props: { text: first?.text ?? '' } },
    ...(Object.keys(firstProps).length > 0 ? [{ command: 'set', path: `${officePath}/r[1]`, props: firstProps }] : []),
    ...rest.map(run => ({ command: 'add', parent: officePath, type: 'run', props: { text: run.text.replaceAll('\v', '\n'), ...runProps(run) } })),
  ]
}

/** Copy the supported paragraph layout, excluding engine diagnostics and effective character values. */
function paragraphProps(format: DocumentParagraphFormat): Record<string, string> {
  return {
    ...(format.style === undefined ? {} : { style: format.style }),
    ...(format.align === undefined ? {} : { align: format.align }),
    ...(format.indent === undefined ? {} : { indent: format.indent }),
    ...(format.lineSpacing === undefined ? {} : { lineSpacing: format.lineSpacing }),
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

/** Reject inline objects that paragraph replacement cannot reconstruct without losing content. */
function editableParagraph(data: Record<string, unknown>, officePath: string): Record<string, unknown> {
  const results = Array.isArray(data.results) ? data.results : [data]
  const paragraph = results.length === 1 ? record(results[0]) : undefined
  const children = paragraph?.children
  if (paragraph?.type !== 'paragraph' || !Array.isArray(children)
    || paragraph.childCount !== children.length
    || children.some((child) => {
      const run = record(child)
      return run?.type !== 'run' || run.childCount !== 0
    })) {
    throw new OfficeCliError(`UNSUPPORTED_DOCUMENT_CONTENT: paragraph '${officePath}' contains objects that require editing in Word`)
  }
  return paragraph
}

const WORD_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const WORD_ID_NS = 'http://schemas.microsoft.com/office/word/2010/wordml'

function elements(node: XmlElement): XmlElement[] {
  return Array.from(node.childNodes).filter((child): child is XmlElement => child.nodeType === child.ELEMENT_NODE)
}

/** Inspect the actual inline XML because OfficeCLI's projected run children omit breaks, fields, and symbols. */
function assertRebuildableParagraph(xml: unknown, officePath: string): void {
  const reject: () => never = () => {
    throw new OfficeCliError(`UNSUPPORTED_DOCUMENT_CONTENT: paragraph '${officePath}' contains objects that require editing in Word`)
  }
  if (typeof xml !== 'string') reject()
  const root = new DOMParser({ onError: onWarningStopParsing }).parseFromString(xml, 'application/xml').documentElement
  if (root === null || root.namespaceURI !== WORD_NS || root.localName !== 'document') reject()
  let node = root
  for (const segment of officePath.replace(/^\/document(?=\/)/u, '').split('/').filter(Boolean)) {
    const match = /^(body|tbl|tr|tc|p)(?:\[(?:(\d+)|@paraId=['"]?([A-Za-z0-9]+)['"]?)\])?$/u.exec(segment)
    if (match === null) reject()
    const candidates = elements(node).filter(child => child.namespaceURI === WORD_NS && child.localName === match[1])
    const found = match[3] === undefined ? candidates[Number(match[2] ?? '1') - 1]
      : candidates.find(child => child.getAttributeNS(WORD_ID_NS, 'paraId') === match[3])
    if (found === undefined) reject()
    node = found
  }
  if (node.localName !== 'p') reject()
  for (const child of elements(node)) {
    if (child.namespaceURI !== WORD_NS) reject()
    if (child.localName === 'pPr') continue
    if (child.localName !== 'r') reject()
    for (const inline of elements(child)) {
      if (inline.namespaceURI !== WORD_NS) reject()
      if (inline.localName === 'rPr') {
        for (const property of elements(inline)) {
          if (property.namespaceURI !== WORD_NS || elements(property).length > 0
            || !['b', 'i', 'u', 'sz', 'szCs', 'color', 'rFonts'].includes(property.localName ?? '')) reject()
          const attributes = Array.from(property.attributes).filter(attribute => attribute.namespaceURI !== 'http://www.w3.org/2000/xmlns/')
          const names = property.localName === 'rFonts' ? ['ascii', 'hAnsi', 'eastAsia'] : ['val']
          if (attributes.some(attribute => attribute.namespaceURI !== WORD_NS || !names.includes(attribute.localName ?? ''))) reject()
          if (property.localName === 'u' && !['single', 'none'].includes(property.getAttributeNS(WORD_NS, 'val') ?? 'single')) reject()
          if (property.localName === 'rFonts' && new Set(attributes.map(attribute => attribute.value)).size > 1) reject()
          if (property.localName === 'szCs' && elements(inline).find(sibling => sibling.localName === 'sz')?.getAttributeNS(WORD_NS, 'val')
            !== property.getAttributeNS(WORD_NS, 'val')) reject()
        }
        continue
      }
      if (inline.localName === 't' || inline.localName === 'tab') continue
      if (inline.localName === 'br' && ['','textWrapping'].includes(inline.getAttributeNS(WORD_NS, 'type') ?? '')
        && ['', 'none'].includes(inline.getAttributeNS(WORD_NS, 'clear') ?? '')) continue
      reject()
    }
  }
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

  override inspect(filePath: string, officePath: string, depth = 2, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.withLease(filePath, async () => {
      const result = await this.run(['get', filePath, officePath, '--depth', String(depth), '--json'], signal)
      return this.parseEnvelope(result.stdout)
    })
  }

  override applyMutations(filePath: string, mutations: readonly EngineMutation[], signal?: AbortSignal): Promise<void> {
    return this.withLease(filePath, async () => {
      for (const mutation of mutations) {
        if (mutation.type === 'replace-text') {
          const inspection = await this.run(['get', filePath, mutation.officePath, '--depth', '3', '--json'], signal)
          const paragraph = editableParagraph(this.parseEnvelope(inspection.stdout), mutation.officePath)
          const raw = await this.run(['raw', filePath, '/document', '--json'], signal)
          assertRebuildableParagraph(this.parseEnvelope(raw.stdout).data, mutation.officePath)
          if (mutation.paragraphs !== undefined) {
            await this.replaceParagraphs(filePath, mutation.officePath, mutation.paragraphs, paragraph, signal)
            continue
          }
        }
        await this.run(this.mutationArgs(filePath, mutation), signal)
      }
      await this.run(['save', filePath, '--json'], signal)
    })
  }

  private async replaceParagraphs(
    filePath: string,
    officePath: string,
    paragraphs: readonly DocumentParagraph[],
    original: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<void> {
    const originalFormat = record(original.format) ?? {}
    const inherited: Record<string, string> = {}
    for (const key of ['style', 'align', 'indent', 'lineSpacing']) {
      if (typeof originalFormat[key] === 'string') inherited[key] = originalFormat[key]
    }
    for (const key of ['font', 'font.latin', 'font.ea', 'font.cs', 'size', 'size.cs', 'bold', 'italic', 'underline', 'color']) {
      if (typeof originalFormat[key] === 'string' || typeof originalFormat[key] === 'boolean') inherited[key] = String(originalFormat[key])
    }
    const parent = officePath.replace(/\/p\[[^\]]+\]$/u, '')
    let currentPath = officePath
    for (const [index, paragraph] of paragraphs.entries()) {
      const format = paragraphProps(paragraph.format ?? {})
      if (index > 0) {
        const result = await this.run([
          'add', filePath, parent, '--type', 'paragraph', '--after', currentPath,
          ...Object.entries({ ...inherited, ...format, text: paragraph.text })
            .flatMap(([key, value]) => ['--prop', `${key}=${value}`]), '--json',
        ], signal)
        const envelope: unknown = JSON.parse(result.stdout)
        const added = record(envelope)?.data
        const path = typeof added === 'string' ? /^Added paragraph at (\/[^\r\n]+)$/u.exec(added)?.[1] : undefined
        if (path === undefined) throw new OfficeCliError('OfficeCLI did not return the inserted paragraph path')
        currentPath = path
      }
      const commands: Record<string, unknown>[] = []
      if (Object.keys(format).length > 0 && index === 0) {
        commands.push({ command: 'set', path: currentPath, props: format })
      }
      if (paragraph.runs !== undefined) commands.push(...runBatch(currentPath, paragraph.runs))
      else if (index === 0 && paragraph.text !== original.text) {
        commands.push({ command: 'set', path: currentPath, props: { text: paragraph.text } })
      }
      if (commands.length > 0) await this.run(['batch', filePath, '--commands', JSON.stringify(commands), '--json'], signal)
    }
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

  private mutationArgs(filePath: string, mutation: EngineMutation): string[] {
    if (mutation.type === 'replace-text') {
      // Plain text stays one command. Runs rebuild the paragraph, which takes
      // several OfficeCLI operations, so they travel as one batch: the resident
      // applies them in a single pass instead of one process round trip each.
      if (mutation.runs === undefined || mutation.runs.length === 0) {
        return ['set', filePath, mutation.officePath, '--prop', `text=${mutation.text}`, '--json']
      }
      return ['batch', filePath, '--commands', JSON.stringify(runBatch(mutation.officePath, mutation.runs)), '--json']
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
