/**
 * PaperAI project service (`ctx.paperProjects`): idempotent directory adoption,
 * DSH workspace association, durable project publication, and Git readiness.
 * @module @paperai/project-service
 */

import { randomUUID } from 'node:crypto'
import { basename, resolve } from 'node:path'
import { realpath } from 'node:fs/promises'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import { ProjectId, type ProjectRecord } from '@paperai/domain'
import type {} from '@paperai/repository'
import type {} from '@deepseek-ai/dsh-subprocess'
import {
  ensureGitRepository,
  type GitInitializationConfig,
  type ProjectGitStatus,
} from './git.ts'
import {
  prepareProjectLayout,
  type PreparedProjectLayout,
} from './layout.ts'

export {
  PAPERAI_CONTEXT_FILE,
  PAPERAI_CONTEXT_TEMPLATE,
  PAPERAI_PROJECT_DIRECTORIES,
} from './layout.ts'
export type { ProjectGitStatus } from './git.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    paperProjects: PaperProjectService
  }
}

/** Project-service deployment settings. */
export interface Config {
  /** Git executable name or absolute path. */
  gitCommand?: string
  /** Initial branch for a repository created by PaperAI. */
  gitInitialBranch?: string
  /** Positive deadline for each Git command. */
  gitTimeoutMs?: number
  /** Positive in-memory cap for each Git output stream. */
  gitOutputMaxBytes?: number
  /** Positive Git process-tree termination grace. */
  gitTerminateGraceMs?: number
}

interface ResolvedConfig extends GitInitializationConfig {}

/** User intent for the single create-or-adopt project operation. */
export interface CreatePaperProjectInput {
  /** Existing or not-yet-created directory selected for the project. */
  readonly rootPath: string
  /** Display name used only when no project record exists for the directory. */
  readonly name?: string
}

/** Result of one idempotent project initialization. */
export interface CreatePaperProjectResult {
  /** Durable project record associated with the canonical DSH workspace. */
  readonly project: ProjectRecord
  /** Whether this call created the durable project record. */
  readonly projectCreated: boolean
  /** Whether this call created or preserved `PAPERAI.md`. */
  readonly contextFile: 'created' | 'preserved'
  /** Git readiness, including non-fatal degradation. */
  readonly git: ProjectGitStatus
}

const DEFAULT_GIT_TIMEOUT_MS = 15_000
const DEFAULT_GIT_OUTPUT_MAX_BYTES = 256 * 1024
const DEFAULT_GIT_TERMINATE_GRACE_MS = 2_000

function positiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`paperai-project-service: ${name} must be a positive safe integer`)
  }
}

function nonBlank(value: string, name: string): string {
  const trimmed = value.trim()
  if (trimmed.length === 0) throw new Error(`paperai-project-service: ${name} must not be blank`)
  return trimmed
}

function pathKey(path: string): string {
  return resolve(path)
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

/** Idempotent PaperAI project lifecycle with no separate open-project action. */
export class PaperProjectService extends Service {
  static inject = ['workspaceRegistry', 'paperRepository']
  static Config: z<Config> = z.object({
    gitCommand: z.string().default('git'),
    gitInitialBranch: z.string().default('main'),
    gitTimeoutMs: z.number().default(DEFAULT_GIT_TIMEOUT_MS),
    gitOutputMaxBytes: z.number().default(DEFAULT_GIT_OUTPUT_MAX_BYTES),
    gitTerminateGraceMs: z.number().default(DEFAULT_GIT_TERMINATE_GRACE_MS),
  })

  private readonly config: ResolvedConfig
  private operationTail: Promise<void> = Promise.resolve()

  /**
   * @param ctx - Cordis context carrying the workspace registry and repository.
   * @param config - Git command settings; omitted values use validated defaults.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'paperProjects')
    const command = nonBlank(config.gitCommand ?? 'git', 'gitCommand')
    const initialBranch = nonBlank(config.gitInitialBranch ?? 'main', 'gitInitialBranch')
    const timeoutMs = config.gitTimeoutMs ?? DEFAULT_GIT_TIMEOUT_MS
    const outputMaxBytes = config.gitOutputMaxBytes ?? DEFAULT_GIT_OUTPUT_MAX_BYTES
    const terminateGraceMs = config.gitTerminateGraceMs ?? DEFAULT_GIT_TERMINATE_GRACE_MS
    positiveSafeInteger(timeoutMs, 'gitTimeoutMs')
    positiveSafeInteger(outputMaxBytes, 'gitOutputMaxBytes')
    positiveSafeInteger(terminateGraceMs, 'gitTerminateGraceMs')
    this.config = { command, initialBranch, timeoutMs, outputMaxBytes, terminateGraceMs }
  }

  /**
   * Create or adopt one directory, initialize missing project artifacts, and
   * publish exactly one ProjectRecord associated with its DSH workspace.
   * Repeating the operation for the same canonical path preserves the first
   * record identity, name, creation time, and all existing files.
   * @param input - Selected directory and optional first-use display name.
   * @returns the durable record, context-file outcome, and Git readiness.
   */
  create(input: CreatePaperProjectInput): Promise<CreatePaperProjectResult> {
    return this.enqueue(() => this.createNow(input))
  }

  /**
   * Read one durable project.
   * @param id - PaperAI project id.
   * @returns the record, or `undefined` when unknown.
   */
  get(id: ProjectId): ProjectRecord | undefined {
    return this.ctx.paperRepository.getProject(id)
  }

  /**
   * List durable projects in repository order.
   * @returns a fresh record array.
   */
  list(): ProjectRecord[] {
    return this.ctx.paperRepository.listProjects()
  }

  /**
   * Resolve a project by an existing directory spelling.
   * @param rootPath - Existing directory path.
   * @returns the unique record for its canonical path, or `undefined`.
   */
  async findByPath(rootPath: string): Promise<ProjectRecord | undefined> {
    if (rootPath.trim().length === 0) throw new Error('PaperAI project path must not be blank')
    const canonical = await realpath(resolve(rootPath))
    return this.uniqueProject(canonical)
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.operationTail.then(operation, operation)
    this.operationTail = run.then(() => undefined, () => undefined)
    return run
  }

  private async createNow(input: CreatePaperProjectInput): Promise<CreatePaperProjectResult> {
    const layout = await prepareProjectLayout(input.rootPath)
    let createdWorkspace: Workspace | undefined
    try {
      const existing = this.uniqueProject(layout.rootPath)
      const name = existing?.name ?? this.resolveName(input.name, layout.rootPath)
      const priorWorkspace = await this.ctx.workspaceRegistry.resolveByPath(layout.rootPath)
      const workspace = priorWorkspace ?? await this.ctx.workspaceRegistry.create(layout.rootPath, name)
      createdWorkspace = priorWorkspace === undefined ? workspace : undefined

      const projectCreated = existing === undefined
      const needsWrite = projectCreated
        || existing.workspaceId !== String(workspace.id)
        || existing.rootPath !== layout.rootPath
      const now = new Date().toISOString()
      const project: ProjectRecord = existing === undefined
        ? {
          id: ProjectId(randomUUID()),
          workspaceId: String(workspace.id),
          name,
          rootPath: layout.rootPath,
          createdAt: now,
          updatedAt: now,
        }
        : needsWrite
          ? {
            ...existing,
            workspaceId: String(workspace.id),
            rootPath: layout.rootPath,
            updatedAt: now,
          }
          : existing
      if (needsWrite) await this.ctx.paperRepository.putProject(project)

      const git = await ensureGitRepository(this.ctx, layout.rootPath, this.config)
      return { project, projectCreated, contextFile: layout.contextFile, git }
    } catch (error) {
      return await this.rollback(error, layout, createdWorkspace)
    }
  }

  private uniqueProject(rootPath: string): ProjectRecord | undefined {
    const key = pathKey(rootPath)
    const matches = this.ctx.paperRepository.listProjects()
      .filter(project => pathKey(project.rootPath) === key)
    if (matches.length > 1) {
      throw new Error(`multiple PaperAI project records reference '${rootPath}'`)
    }
    return matches[0]
  }

  private resolveName(input: string | undefined, rootPath: string): string {
    if (input !== undefined) return nonBlank(input, 'project name')
    return basename(rootPath)
  }

  private async rollback(
    error: unknown,
    layout: PreparedProjectLayout,
    createdWorkspace: Workspace | undefined,
  ): Promise<never> {
    const failures: Error[] = []
    if (createdWorkspace !== undefined) {
      try {
        const deleted = await this.ctx.workspaceRegistry.delete(createdWorkspace.id)
        if (!deleted) failures.push(new Error(`workspace '${createdWorkspace.id}' disappeared before rollback`))
      } catch (rollbackError) {
        failures.push(asError(rollbackError))
      }
    }
    try {
      await layout.rollback()
    } catch (rollbackError) {
      failures.push(asError(rollbackError))
    }
    if (failures.length > 0) {
      throw new AggregateError(
        [asError(error), ...failures],
        'PaperAI project initialization failed and rollback did not complete',
      )
    }
    throw error
  }
}

export default PaperProjectService
