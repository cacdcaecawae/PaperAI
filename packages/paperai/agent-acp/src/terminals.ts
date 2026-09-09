/** Session-owned ACP terminal processes over DSH confinement, subprocess, and bounded output. */

import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {
  CreateTerminalRequest,
  TerminalOutputResponse,
  WaitForTerminalExitResponse,
} from '@agentclientprotocol/sdk'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { SubprocessHandle, SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'
import { TextRetainer } from '@deepseek-ai/dsh-output-retention'

/** Explicit limits applied before allocating an ACP terminal process. */
export interface AcpTerminalLimits {
  readonly maxTerminals: number
  readonly outputBytes: number
  readonly graceMs: number
}

interface TerminalEntry {
  readonly process: SubprocessHandle
  readonly output: TextRetainer
  outcome?: SubprocessOutcome
}

/** Terminal ids are valid only within one ACP runtime generation. */
export class AcpTerminals {
  private readonly entries = new Map<string, TerminalEntry>()
  private readonly released = new Map<string, string>()
  private closing = false
  private closed: Promise<void> | undefined
  private creating = 0
  private readonly pending = new Set<Promise<string>>()
  private readonly teardown = new AbortController()

  constructor(
    private readonly ctx: Context,
    private readonly cwd: string,
    private readonly policy: () => SandboxExecutionPolicy,
    private readonly limits: AcpTerminalLimits,
  ) {}

  /**
   * Start one command with the current session policy and turn cancellation.
   * @param request - validated ACP executable, argument vector, environment, and output budget.
   * @param signal - runtime generation and active turn cancellation.
   * @returns a fresh terminal id owned by this runtime.
   */
  create(request: CreateTerminalRequest, signal: AbortSignal): Promise<string> {
    if (this.closing || this.entries.size + this.creating >= this.limits.maxTerminals)
      return Promise.reject(new Error('ACP terminal allocation is closed or its limit has been reached'))
    this.creating += 1
    const operation = this.spawn(request, AbortSignal.any([signal, this.teardown.signal])).finally(() => {
      this.creating -= 1
      this.pending.delete(operation)
    })
    this.pending.add(operation)
    return operation
  }

  private async spawn(request: CreateTerminalRequest, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted()
    const cwd = request.cwd ?? this.cwd
    if (!isAbsolute(cwd)) throw new Error('ACP terminal cwd must be absolute')
    const env = Object.fromEntries((request.env ?? []).map(entry => [entry.name, entry.value]))
    const command = await this.ctx.subprocess.resolveExecutable(request.command, env, signal)
    signal.throwIfAborted()
    if (this.closing) throw new Error('ACP runtime is closing')
    const policy = this.policy()
    const argv = [command, ...(request.args ?? [])]
    const sandbox = this.ctx.get('sandbox')
    let confined: readonly string[] = argv
    if (policy.mode !== 'danger-full-access') {
      if (sandbox === undefined) throw new Error('ACP terminal requires the configured DSH sandbox provider')
      confined = sandbox.confine(argv, { ...policy, mode: policy.mode }).argv
    }
    const output = new TextRetainer({
      kind: 'tail',
      maxBytes: Math.min(request.outputByteLimit ?? this.limits.outputBytes, this.limits.outputBytes),
    })
    const process = this.ctx.subprocess.spawn({
      argv: confined,
      cwd,
      env,
      signal,
      graceMs: this.limits.graceMs,
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
    })
    const entry: TerminalEntry = { process, output }
    process.stdout?.on('data', (chunk: Buffer) => {
      output.push(chunk)
    })
    process.stderr?.on('data', (chunk: Buffer) => {
      output.push(chunk)
    })
    void process.done.then(
      (outcome) => {
        entry.outcome = outcome
      },
      () => {
        entry.outcome = { exitCode: null, signal: null }
      },
    )
    const id = randomUUID()
    this.entries.set(id, entry)
    return id
  }

  /**
   * Read retained combined output without consuming it.
   * @param id - terminal id returned by this runtime.
   * @returns output, truncation, and actual exit status when available.
   */
  output(id: string): TerminalOutputResponse {
    const entry = this.entry(id)
    const retained = entry.output.finish()
    return {
      output: retained.text,
      truncated: retained.truncated,
      ...(entry.outcome === undefined ? {} : { exitStatus: entry.outcome }),
    }
  }

  /**
   * Read tool-card output after a provider releases its terminal; older released snapshots expire at the terminal limit.
   * @param id - terminal reference supplied in provider tool content.
   * @returns retained output or an explicit notice when that snapshot is unavailable.
   */
  displayOutput(id: string): string {
    return (
      this.entries.get(id)?.output.finish().text ??
      this.released.get(id) ??
      '[ACP terminal output is no longer available]'
    )
  }

  /**
   * Observe process completion without killing it when only the wait is cancelled.
   * @param id - terminal owned by this runtime.
   * @param signal - cancellation of this wait request.
   * @returns actual exit code and signal.
   */
  async wait(id: string, signal: AbortSignal): Promise<WaitForTerminalExitResponse> {
    const entry = this.entry(id)
    signal.throwIfAborted()
    const cancelled = Promise.withResolvers<never>()
    const abort = (): void => {
      cancelled.reject(signal.reason)
    }
    signal.addEventListener('abort', abort, { once: true })
    try {
      return await Promise.race([entry.process.done, cancelled.promise])
    } finally {
      signal.removeEventListener('abort', abort)
    }
  }

  /**
   * Stop a terminal and retain its final output until release.
   * @param id - terminal owned by this runtime.
   */
  async kill(id: string): Promise<void> {
    const entry = this.entry(id)
    entry.process.terminate()
    await entry.process.waitForExit()
  }

  /**
   * Stop a terminal and invalidate its id after process-tree teardown.
   * @param id - terminal owned by this runtime.
   */
  async release(id: string): Promise<void> {
    const entry = this.entry(id)
    entry.process.terminate()
    await entry.process.waitForExit()
    this.released.set(id, entry.output.finish().text)
    if (this.released.size > this.limits.maxTerminals) {
      for (const oldest of this.released.keys()) {
        this.released.delete(oldest)
        break
      }
    }
    this.entries.delete(id)
  }

  /** Stop pending allocations and await every owned process tree. */
  close(): Promise<void> {
    this.closing = true
    this.teardown.abort(new Error('ACP terminals closed'))
    return (this.closed ??= Promise.resolve().then(async () => {
      await Promise.allSettled(this.pending)
      await Promise.all(
        [...this.entries.values()].map(async (entry) => {
          entry.process.terminate()
          await entry.process.waitForExit()
        }),
      )
      this.entries.clear()
      this.released.clear()
    }))
  }

  private entry(id: string): TerminalEntry {
    const entry = this.entries.get(id)
    if (entry === undefined) throw new Error('ACP terminal does not belong to this runtime or has been released')
    return entry
  }
}
