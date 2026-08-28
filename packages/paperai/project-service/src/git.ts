/**
 * Best-effort Git initialization through the managed DSH subprocess service.
 * @module @paperai/project-service/git
 */

import type { Context } from '@deepseek-ai/cordis'
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessRuntime,
} from '@deepseek-ai/dsh-subprocess'

/** Resolved Git execution settings. */
export interface GitInitializationConfig {
  /** Executable name or absolute path resolved by the subprocess Provider. */
  readonly command: string
  /** Branch assigned when a repository is initialized. */
  readonly initialBranch: string
  /** Positive deadline for each Git command. */
  readonly timeoutMs: number
  /** Positive in-memory cap for each output stream. */
  readonly outputMaxBytes: number
  /** Positive process-tree termination grace. */
  readonly terminateGraceMs: number
}

/** Git readiness returned without failing an otherwise committed project. */
export type ProjectGitStatus =
  | { readonly status: 'ready'; readonly state: 'existing' | 'initialized' }
  | { readonly status: 'degraded'; readonly detail: string }

interface GitCommandResult {
  readonly outcome: SubprocessOutcome
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
}

function output(handle: SubprocessHandle, maxBytes: number): { stdout: string; stderr: string } {
  const stdout = handle.collected.stdout?.readFrom(0)
  const stderr = handle.collected.stderr?.readFrom(0)
  if (stdout?.lossy === true || stderr?.lossy === true) {
    throw new Error(`Git output exceeded ${maxBytes} bytes`)
  }
  return { stdout: stdout?.text ?? '', stderr: stderr?.text ?? '' }
}

async function runGit(
  runtime: SubprocessRuntime,
  executable: string,
  rootPath: string,
  args: readonly string[],
  config: GitInitializationConfig,
): Promise<GitCommandResult> {
  const timeout = AbortSignal.timeout(config.timeoutMs)
  const handle = runtime.spawn({
    argv: [executable, ...args],
    cwd: rootPath,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: config.outputMaxBytes },
      stderr: { maxBytes: config.outputMaxBytes },
    },
    graceMs: config.terminateGraceMs,
    signal: timeout,
  })
  const outcome = await handle.done
  return { outcome, ...output(handle, config.outputMaxBytes), timedOut: timeout.aborted }
}

function commandFailure(result: GitCommandResult): string {
  const diagnostic = result.stderr.trim() || result.stdout.trim()
  if (diagnostic.length > 0) return diagnostic
  if (result.outcome.signal !== null) return `Git stopped with signal ${result.outcome.signal}`
  return `Git exited with code ${result.outcome.exitCode}`
}

/**
 * Reuse an enclosing repository or initialize one at the project root.
 * Missing Providers, missing Git, timeouts, and non-zero initialization exits
 * are returned as degradation because project publication already committed.
 * @param ctx - Cordis context that may carry `ctx.subprocess`.
 * @param rootPath - Canonical project directory.
 * @param config - Resolved command and output limits.
 * @returns Git readiness; this function does not reject.
 */
export async function ensureGitRepository(
  ctx: Context,
  rootPath: string,
  config: GitInitializationConfig,
): Promise<ProjectGitStatus> {
  try {
    const runtime = ctx.get('subprocess')
    if (runtime === undefined) {
      return {
        status: 'degraded',
        detail: 'DSH subprocess Provider is unavailable; Git initialization was skipped',
      }
    }
    const executable = await runtime.resolveExecutable(config.command)
    const probe = await runGit(runtime, executable, rootPath, ['rev-parse', '--show-toplevel'], config)
    if (probe.timedOut) {
      return { status: 'degraded', detail: `Git repository probe timed out after ${config.timeoutMs} ms` }
    }
    if (probe.outcome.signal !== null) {
      return { status: 'degraded', detail: commandFailure(probe) }
    }
    if (probe.outcome.exitCode === 0) return { status: 'ready', state: 'existing' }

    const initialized = await runGit(
      runtime,
      executable,
      rootPath,
      ['init', '--initial-branch', config.initialBranch],
      config,
    )
    if (initialized.timedOut) {
      return { status: 'degraded', detail: `Git initialization timed out after ${config.timeoutMs} ms` }
    }
    if (initialized.outcome.exitCode !== 0) {
      return { status: 'degraded', detail: commandFailure(initialized) }
    }
    return { status: 'ready', state: 'initialized' }
  } catch (error) {
    return { status: 'degraded', detail: error instanceof Error ? error.message : String(error) }
  }
}
