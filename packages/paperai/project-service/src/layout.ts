/**
 * Conservative filesystem initialization for one PaperAI project directory.
 * @module @paperai/project-service/layout
 */

import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rmdir,
  stat,
  unlink,
} from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

/** Stable name of the Agent-readable project context file. */
export const PAPERAI_CONTEXT_FILE = 'PAPERAI.md'

/**
 * Initial context written only when the project has no `PAPERAI.md`.
 * Later edits belong to users and Agents and are never regenerated.
 */
export const PAPERAI_CONTEXT_TEMPLATE = `# PaperAI 项目上下文

## 当前目标

- 在此记录论文或课题的当前目标。

## 当前进展

- PaperAI 项目结构已初始化；请在完成重要工作后更新本节。

## 工作约定

- \`documents/source/\` 保存导入原件，不直接修改。
- \`documents/working/\` 保存当前可编辑的 Working DOCX。
- \`.paperai/\` 保存版本快照与内部数据，勿手动修改。
- \`templates/\` 保存学校模板和自定义模板；\`exports/\` 只保存导出结果。
- 后续 Agent 开始工作前先阅读本文件，并记录关键进展、决定和下一步。

## 下一步

- 在此记录下一个可执行动作。
`

/** Required relative directories in a new or adopted PaperAI project. */
export const PAPERAI_PROJECT_DIRECTORIES = [
  'documents/source',
  'documents/working',
  'templates',
  'references',
  'figures',
  'experiments/data',
  'experiments/results',
  'code',
  'exports/drafts',
  'exports/delivery',
] as const

interface CreatedFile {
  readonly path: string
  readonly dev: number
  readonly ino: number
  readonly content: string
}

interface FilesystemJournal {
  readonly directories: string[]
  readonly files: CreatedFile[]
}

/** Prepared project paths plus a rollback operation for unpublished work. */
export interface PreparedProjectLayout {
  /** Canonical project directory used by DSH and the repository. */
  readonly rootPath: string
  /** Whether this call created or preserved the context file. */
  readonly contextFile: 'created' | 'preserved'
  /** Remove only unchanged files and empty directories created by this call. */
  rollback(): Promise<void>
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code
}

async function ensureDirectory(path: string, journal: FilesystemJournal): Promise<void> {
  try {
    await mkdir(path, { mode: 0o755 })
    journal.directories.push(path)
    return
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      const parent = dirname(path)
      await ensureDirectory(parent, journal)
      await ensureDirectory(path, journal)
      return
    }
    if (!isErrno(error, 'EEXIST')) throw error
  }

  if (!(await stat(path)).isDirectory()) {
    throw new Error(`PaperAI project path '${path}' exists but is not a directory`)
  }
}

async function ensureContextFile(rootPath: string, journal: FilesystemJournal): Promise<'created' | 'preserved'> {
  const path = join(rootPath, PAPERAI_CONTEXT_FILE)
  let handle
  try {
    handle = await open(path, 'wx', 0o600)
  } catch (error) {
    if (isErrno(error, 'EEXIST')) {
      if (!(await stat(path)).isFile()) {
        throw new Error(`PaperAI context path '${path}' exists but is not a regular file`)
      }
      return 'preserved'
    }
    throw error
  }

  const identity = await handle.stat()
  journal.files.push({
    path,
    dev: identity.dev,
    ino: identity.ino,
    content: PAPERAI_CONTEXT_TEMPLATE,
  })
  try {
    await handle.writeFile(PAPERAI_CONTEXT_TEMPLATE, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  return 'created'
}

async function rollbackFile(file: CreatedFile): Promise<void> {
  let identity
  try {
    identity = await lstat(file.path)
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return
    throw error
  }
  if (!identity.isFile() || identity.dev !== file.dev || identity.ino !== file.ino) return

  let content
  try {
    content = await readFile(file.path, 'utf8')
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return
    throw error
  }
  if (content !== file.content) return
  try {
    await unlink(file.path)
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) throw error
  }
}

async function rollbackDirectory(path: string): Promise<void> {
  let identity
  try {
    identity = await lstat(path)
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return
    throw error
  }
  if (!identity.isDirectory()) return
  try {
    await rmdir(path)
  } catch (error) {
    if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTEMPTY') || isErrno(error, 'EEXIST')) return
    throw error
  }
}

async function rollbackJournal(journal: FilesystemJournal): Promise<void> {
  const failures: unknown[] = []
  for (const file of [...journal.files].reverse()) {
    try {
      await rollbackFile(file)
    } catch (error) {
      failures.push(error)
    }
  }
  for (const path of [...journal.directories].reverse()) {
    try {
      await rollbackDirectory(path)
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'PaperAI project filesystem rollback did not complete')
  }
}

/**
 * Create missing project directories and an exclusive context file.
 * Existing directories and files are retained byte-for-byte.
 * @param inputPath - User-selected or supplied project directory.
 * @returns canonical paths and a rollback operation for later publication failures.
 */
export async function prepareProjectLayout(inputPath: string): Promise<PreparedProjectLayout> {
  if (inputPath.trim().length === 0) throw new Error('PaperAI project path must not be blank')
  const journal: FilesystemJournal = { directories: [], files: [] }
  try {
    const requested = resolve(inputPath)
    if (dirname(requested) === requested) {
      throw new Error(`PaperAI project path '${requested}' must not be a filesystem root`)
    }
    await ensureDirectory(requested, journal)
    const rootPath = await realpath(requested)
    for (const relative of PAPERAI_PROJECT_DIRECTORIES) {
      await ensureDirectory(join(rootPath, ...relative.split('/')), journal)
    }
    const contextFile = await ensureContextFile(rootPath, journal)
    return {
      rootPath,
      contextFile,
      rollback: () => rollbackJournal(journal),
    }
  } catch (error) {
    try {
      await rollbackJournal(journal)
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        'PaperAI project filesystem initialization and rollback both failed',
      )
    }
    throw error
  }
}
