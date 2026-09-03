/**
 * Agent writing-charter maintenance for one PaperAI project: renders the
 * PaperAI-owned block of `AGENTS.md` from current documents and attached
 * template contracts, and creates a `CLAUDE.md` that imports it.
 * @module @paperai/project-service/charter
 */

import { randomUUID } from 'node:crypto'
import { open, readFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { DocumentRecord, TemplateContract, TemplateContractId } from '@paperai/domain'

/** Stable name of the Codex-readable charter file at the project root. */
export const PAPERAI_AGENTS_FILE = 'AGENTS.md'

/** Stable name of the Claude Code instruction file importing the charter. */
export const PAPERAI_CLAUDE_FILE = 'CLAUDE.md'

/** Marker prefix opening the PaperAI-owned block inside `AGENTS.md`. */
export const CHARTER_BLOCK_START_PREFIX = '<!-- paperai:charter:start'

/** Marker line closing the PaperAI-owned block inside `AGENTS.md`. */
export const CHARTER_BLOCK_END = '<!-- paperai:charter:end -->'

const CHARTER_BLOCK_START = `${CHARTER_BLOCK_START_PREFIX}（本区块由 PaperAI 自动维护，模板变更时会重写；手写内容请放在区块之外） -->`

/**
 * Content of a `CLAUDE.md` PaperAI creates: Claude Code resolves the
 * `@AGENTS.md` import, so both external CLIs read one charter source.
 */
export const PAPERAI_CLAUDE_TEMPLATE = '@AGENTS.md\n'

/** One line of `CLAUDE.md` that imports the charter (`@AGENTS.md` or `@./AGENTS.md`). */
const CLAUDE_IMPORT_LINE = /^[ \t]*@(?:\.\/)?AGENTS\.md[ \t]*$/mu

/** Charter-file maintenance outcome for one sync pass. */
export interface WritingCharterSyncResult {
  /** Whether `AGENTS.md` was created, had its block rewritten, or already matched. */
  readonly agents: 'created' | 'updated' | 'unchanged'
  /**
   * Whether `CLAUDE.md` was created, gained the `@AGENTS.md` import line
   * (user content preserved), or already imported the charter.
   */
  readonly claude: 'created' | 'updated' | 'preserved'
}

/** One sync pass plus the operation that puts both files back as they were. */
export interface WritingCharterSync extends WritingCharterSyncResult {
  /** Restore the pre-pass file states; idempotent and safe after partial publication. */
  restore(): Promise<void>
}

/**
 * Render the deterministic charter block body for the current project state.
 * Working documents appear in repository order; template-source records are
 * evidence assets and never listed.
 * @param documents - all repository document records of one project.
 * @param contractOf - lookup for an attached contract id.
 * @returns markdown body between the charter markers, without the markers.
 * @throws when a document references a template contract that does not exist.
 */
export function renderWritingCharter(
  documents: readonly DocumentRecord[],
  contractOf: (id: TemplateContractId) => TemplateContract | undefined,
): string {
  const working = documents.filter(document => document.documentKind !== 'template-source')
  const lines = working.length === 0
    ? ['- 项目尚无 Working 文档；导入文档后本节自动更新。']
    : working.map(document => templateLine(document, contractOf))
  return `# PaperAI 论文写作规程

本项目由 PaperAI 管理：\`documents/working/\` 下的 Working DOCX 是唯一可编辑权威。所有文档修改必须通过 \`paperai_*\` 文档工具提交；禁止直接编辑、移动或另存任何 \`.docx\` 文件；\`documents/source/\` 与 \`templates/\` 不可变。项目目标与进展记录在 \`PAPERAI.md\`，开工前先读并及时更新。

## 写作流程

1. 先用 \`paperai_list_documents\` 与 \`paperai_read_document\` 了解文档现状；文档关联了模板时，动笔前用 \`paperai_get_template\` 读取模板契约。
2. 结构性调整先给出大纲，经用户确认后再动笔。
3. 逐章、小批量地用 \`paperai_commit_document\` 提交，提交说明写明本次修改内容。
4. 每次提交返回的 \`gate\` 门禁报告必须查看：severity 为 \`error\` 的发现要先修复再继续写作；可随时用 \`paperai_check_gate\` 自检。
5. 交付前用 \`paperai_prepare_export\` 预检；未修复的 error 会在正式导出时被服务端拦截。
6. 遇到 \`HEAD_CONFLICT\` / \`WORKING_COPY_CHANGED\` 冲突时停下向用户说明，不要强行覆盖他人修改。

## 模板要求

${lines.join('\n')}`
}

function templateLine(
  document: DocumentRecord,
  contractOf: (id: TemplateContractId) => TemplateContract | undefined,
): string {
  if (document.templateId === undefined) {
    return `- 《${document.name}》（角色 ${document.role}）未关联模板：自由写作模式，不做模板检查。`
  }
  const contract = contractOf(document.templateId)
  if (contract === undefined) {
    throw new Error(
      `PaperAI document '${document.id}' references missing template contract '${document.templateId}'`,
    )
  }
  const enabled = contract.rules.filter(rule => rule.enabled)
  const count = (severity: string): number => enabled.filter(rule => rule.severity === severity).length
  const highlights = enabled.slice(0, 6).map(rule => rule.label).join('；')
  const detail = enabled.length === 0
    ? '契约未包含启用规则'
    : `门禁规则 ${enabled.length} 条（error ${count('error')} / warning ${count('warning')} / info ${count('info')}）。要点：${highlights}`
  return `- 《${document.name}》（角色 ${document.role}）已关联模板《${contract.name}》：${detail}。`
}

/**
 * Merge the charter block into an existing `AGENTS.md` body.
 * Content outside the markers is preserved byte-for-byte; a file without
 * markers keeps its own text first and gains the block at the end.
 * @param existing - current file content, or `undefined` when absent.
 * @param charter - rendered block body from {@link renderWritingCharter}.
 * @returns the complete next file content.
 * @throws when exactly one marker is present or the markers are out of order.
 */
export function composeAgentsContent(existing: string | undefined, charter: string): string {
  const block = `${CHARTER_BLOCK_START}\n${charter}\n${CHARTER_BLOCK_END}`
  if (existing === undefined) return `${block}\n`
  const start = existing.indexOf(CHARTER_BLOCK_START_PREFIX)
  const end = existing.indexOf(CHARTER_BLOCK_END)
  if (start < 0 && end < 0) {
    const kept = existing.replace(/\s+$/u, '')
    return kept.length === 0 ? `${block}\n` : `${kept}\n\n${block}\n`
  }
  if (start < 0 || end < 0 || end < start) {
    throw new Error(
      `PaperAI charter markers in '${PAPERAI_AGENTS_FILE}' are broken; restore both '${CHARTER_BLOCK_START_PREFIX}' and '${CHARTER_BLOCK_END}' or remove them`,
    )
  }
  return existing.slice(0, start) + block + existing.slice(end + CHARTER_BLOCK_END.length)
}

/**
 * Write the charter into the project root: rewrite the `AGENTS.md` block only
 * when the content changed, and make sure `CLAUDE.md` imports it — created
 * from the template when absent, otherwise kept byte-for-byte except for an
 * appended `@AGENTS.md` line when no import exists yet, so an adopted project
 * with its own Claude instructions still routes Claude to the charter. Each
 * file is published atomically — same-directory temporary file, fsync, rename
 * — so an interrupted pass leaves either the previous file or the complete
 * new one, never a truncated body or an empty `CLAUDE.md`.
 * @param rootPath - canonical project directory.
 * @param charter - rendered block body from {@link renderWritingCharter}.
 * @returns per-file maintenance outcome plus the operation that reverts it.
 */
export async function syncWritingCharter(rootPath: string, charter: string): Promise<WritingCharterSync> {
  const agentsPath = join(rootPath, PAPERAI_AGENTS_FILE)
  const claudePath = join(rootPath, PAPERAI_CLAUDE_FILE)
  const existing = await readOptional(agentsPath)
  const next = composeAgentsContent(existing, charter)
  const agents: WritingCharterSyncResult['agents'] = next === existing
    ? 'unchanged'
    : existing === undefined ? 'created' : 'updated'
  if (agents !== 'unchanged') await publishAtomically(agentsPath, next)
  const restoreAgents = (): Promise<void> => restoreFile(agentsPath, agents, existing)

  let existingClaude: string | undefined
  let claude: WritingCharterSyncResult['claude']
  try {
    existingClaude = await readOptional(claudePath)
    claude = await ensureClaudeImport(claudePath, existingClaude)
  } catch (error: unknown) {
    // The caller has no restore handle yet: put the first file back here.
    await restoreAll([restoreAgents], error)
    throw error
  }
  const restoreClaude = (): Promise<void> => restoreFile(claudePath, claude, existingClaude)
  return { agents, claude, restore: () => restoreAll([restoreAgents, restoreClaude]) }
}

/** Revert one charter file to what the sync found: remove a created file, rewrite a changed one. */
async function restoreFile(
  path: string,
  outcome: WritingCharterSyncResult['agents'] | WritingCharterSyncResult['claude'],
  previous: string | undefined,
): Promise<void> {
  if (outcome === 'created') await unlinkIfPresent(path)
  else if (outcome === 'updated' && previous !== undefined) await publishAtomically(path, previous)
}

/**
 * Attempt every restore step even after one fails, then raise the failures
 * together with the error that triggered the restore, when there is one.
 */
async function restoreAll(steps: ReadonlyArray<() => Promise<void>>, cause?: unknown): Promise<void> {
  const failures: unknown[] = []
  for (const step of steps) {
    try {
      await step()
    } catch (error: unknown) {
      failures.push(error)
    }
  }
  if (failures.length === 0) return
  const errors = cause === undefined ? failures : [cause, ...failures]
  throw new AggregateError(errors, `PaperAI writing charter could not be restored in '${steps.length}' file(s)`)
}

/**
 * Merge the charter import into an existing `CLAUDE.md` body: content is kept
 * byte-for-byte and one `@AGENTS.md` line is appended when none is present.
 * @param existing - current file content.
 * @returns the complete next file content, identical when the import already exists.
 */
export function composeClaudeContent(existing: string): string {
  if (CLAUDE_IMPORT_LINE.test(existing)) return existing
  const kept = existing.replace(/\s+$/u, '')
  return kept.length === 0 ? PAPERAI_CLAUDE_TEMPLATE : `${kept}\n\n${PAPERAI_CLAUDE_TEMPLATE}`
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined
    throw error
  }
}

async function ensureClaudeImport(
  path: string,
  existing: string | undefined,
): Promise<WritingCharterSyncResult['claude']> {
  if (existing === undefined) {
    await publishAtomically(path, PAPERAI_CLAUDE_TEMPLATE)
    return 'created'
  }
  const next = composeClaudeContent(existing)
  if (next === existing) return 'preserved'
  await publishAtomically(path, next)
  return 'updated'
}

/** Same-directory temporary file, fsync, then rename over the target. */
async function publishAtomically(path: string, content: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(content, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(temporary, path)
  } catch (error) {
    await unlinkIfPresent(temporary)
    throw error
  }
}

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) throw error
  }
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code
}
