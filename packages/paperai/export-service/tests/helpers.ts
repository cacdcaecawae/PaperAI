import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { vi, type Mock } from 'vitest'
import {
  DocumentCommitId,
  DocumentId,
  ProjectId,
  type ActorIdentity,
  type DocumentCommit,
  type DocumentRecord,
  type GateReport,
} from '@paperai/domain'
import type { PaperMcpExportAdapter } from '@paperai/mcp'
import PaperExportService, { type Config } from '../src/index.ts'

export const humanActor: ActorIdentity = {
  kind: 'human',
  name: 'User',
  client: 'paperai',
  sessionId: 'host-session',
}

export const agentActor: ActorIdentity = {
  kind: 'agent',
  name: 'Codex',
  client: 'codex',
  provider: 'openai',
  model: 'gpt-5.6-codex',
  modelRevision: '2026-08-28',
  sessionId: 'agent-session',
  runId: 'run-1',
}

export function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export function report(
  documentId: DocumentRecord['id'],
  mode: GateReport['mode'],
  blocked = false,
): GateReport {
  return {
    status: blocked ? 'fail' : 'pass',
    mode,
    documentId,
    findings: blocked
      ? [{ id: 'finding-1', severity: 'error', code: 'REQUIRED', message: 'Required section is missing.' }]
      : mode === 'draft-export'
        ? [{ id: 'finding-1', severity: 'warning', code: 'STYLE', message: 'Review this style.' }]
        : [],
    checkedAt: '2026-08-28T00:00:00.000Z',
  }
}

export interface ExportHarness {
  readonly ctx: Context
  readonly root: string
  readonly sourcePath: string
  readonly workingPath: string
  readonly snapshotPath: string
  readonly document: DocumentRecord
  readonly snapshotBytes: Uint8Array
  readonly check: Mock<(input: { mode: GateReport['mode'] }, signal?: AbortSignal) => Promise<GateReport>>
  readonly submit: Mock<(request: Record<string, unknown>) => Promise<DocumentCommit>>
  readonly unregister: ReturnType<typeof vi.fn>
  readonly adapter: () => PaperMcpExportAdapter | undefined
  close(): Promise<void>
}

export async function exportHarness(options: {
  readonly config?: Config
  readonly blocked?: boolean
  readonly snapshotBytes?: Uint8Array
  readonly snapshotPath?: string
  readonly unborn?: boolean
  readonly submit?: (request: Record<string, unknown>) => Promise<DocumentCommit>
} = {}): Promise<ExportHarness> {
  const root = await mkdtemp(join(tmpdir(), 'paperai-export-'))
  const sourceDir = join(root, 'source')
  const workingDir = join(root, 'working')
  const historyDir = join(root, 'history')
  await Promise.all([mkdir(sourceDir), mkdir(workingDir), mkdir(historyDir)])
  const sourcePath = join(sourceDir, 'proposal.docx')
  const workingPath = join(workingDir, 'proposal.docx')
  const snapshotPath = options.snapshotPath ?? join(historyDir, 'commit-next.docx')
  const sourceBytes = new TextEncoder().encode('immutable source')
  const workingBytes = new TextEncoder().encode('authoritative working copy')
  const snapshotBytes = options.snapshotBytes ?? workingBytes
  await Promise.all([
    writeFile(sourcePath, sourceBytes),
    writeFile(workingPath, workingBytes),
    options.snapshotPath === undefined ? writeFile(snapshotPath, snapshotBytes) : Promise.resolve(),
  ])
  const headCommitId = options.unborn ? undefined : DocumentCommitId('commit-head')
  const document: DocumentRecord = {
    id: DocumentId('document-1'),
    projectId: ProjectId('project-1'),
    name: 'proposal',
    role: 'proposal',
    immutableSourcePath: sourcePath,
    workingPath,
    mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    sourceSha256: digest(sourceBytes),
    ...(headCommitId === undefined ? {} : { headCommitId }),
    nodeCount: 1,
    createdAt: '2026-08-28T00:00:00.000Z',
    updatedAt: '2026-08-28T00:00:00.000Z',
  }
  const check = vi.fn(async ({ mode }: { mode: GateReport['mode'] }) => (
    report(document.id, mode, options.blocked)
  ))
  const submit = vi.fn(async (request: Record<string, unknown>): Promise<DocumentCommit> => {
    if (options.submit !== undefined) return await options.submit(request)
    return {
      id: DocumentCommitId('commit-next'),
      documentId: document.id,
      ...(headCommitId === undefined ? {} : { parentId: headCommitId }),
      message: String(request.message),
      actor: structuredClone(request.actor as ActorIdentity),
      snapshotPath,
      documentSha256: digest(snapshotBytes),
      gate: report(document.id, 'continuous'),
      operations: [{ type: 'milestone', before: null, after: request.message }],
      createdAt: '2026-08-28T00:01:00.000Z',
    }
  })
  let registered: PaperMcpExportAdapter | undefined
  const unregister = vi.fn(() => { registered = undefined })
  const registerExportAdapter = vi.fn((adapter: PaperMcpExportAdapter) => {
    registered = adapter
    return unregister
  })
  const ctx = new Context()
  ctx.provide('paperTemplates', { check } as never)
  ctx.provide('paperCommits', { submit } as never)
  ctx.provide('paperMcp', { registerExportAdapter } as never)
  try {
    await ctx.plugin(PaperExportService, options.config ?? {})
  } catch (error) {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
    throw error
  }
  const base: ExportHarness = {
    ctx,
    root,
    sourcePath,
    workingPath,
    snapshotPath,
    document,
    snapshotBytes,
    check,
    submit,
    unregister,
    adapter: () => registered,
    async close() {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    },
  }
  return base
}

export async function contents(path: string): Promise<string> {
  return (await readFile(path)).toString()
}
