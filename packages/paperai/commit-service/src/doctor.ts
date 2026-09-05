/** Read-only project integrity diagnostics and revision-bound recovery plans. */

import { lstat, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { DocumentId, ProjectRecord } from '@paperai/domain'
import type PaperRepository from '@paperai/repository'
import { readFileImage, readSnapshot, resolveCommitFilePaths } from './files.ts'

import type { ProjectIntegrityIssue, ProjectIntegrityReport, WorkingRecoveryPlan } from './doctor-types.ts'
export type { ProjectIntegrityIssue, ProjectIntegrityReport, WorkingRecoveryPlan } from './doctor-types.ts'

/**
 * Verify a project-owned path and its existing ancestors without following a link outside the project.
 * @param root - absolute project root.
 * @param file - absolute artifact path, which may not exist yet.
 * @returns after all existing ancestors are verified as contained non-symlinks.
 */
export async function verifyProjectPath(root: string, file: string): Promise<void> {
  const base = resolve(root)
  const target = resolve(file)
  const suffix = relative(base, target)
  if (!isAbsolute(file) || suffix === '' || suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) {
    throw new Error('artifact path is outside the project')
  }
  const canonicalRoot = await realpath(base)
  let cursor = target
  while (cursor !== base) {
    let info
    try { info = await lstat(cursor) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (info !== undefined) {
      if (info.isSymbolicLink()) throw new Error('artifact path contains a symbolic link')
      const actual = relative(canonicalRoot, await realpath(cursor))
      if (actual === '..' || actual.startsWith(`..${sep}`) || isAbsolute(actual)) throw new Error('artifact resolves outside the project')
    }
    cursor = dirname(cursor)
  }
}

/**
 * Read document ownership, immutable sources, working bytes, and all retained snapshots.
 * @param repository - authoritative project records.
 * @param project - project to inspect without initializing or editing artifacts.
 * @param signal - cancellation between filesystem reads.
 * @returns issues and separately actionable recovery plans.
 */
export async function inspectProject(
  repository: Pick<PaperRepository, 'listDocuments' | 'listCommits' | 'getCommit'>,
  project: ProjectRecord,
  signal?: AbortSignal,
): Promise<ProjectIntegrityReport> {
  const documents = repository.listDocuments(project.id)
  const issues: ProjectIntegrityIssue[] = []
  const repairs: WorkingRecoveryPlan[] = []
  const ownership = new Map<string, Set<DocumentId>>()
  const key = (path: string): string => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
  for (const document of documents) {
    for (const path of [document.workingPath, document.immutableSourcePath]) {
      const owners = ownership.get(key(path)) ?? new Set<DocumentId>()
      owners.add(document.id)
      ownership.set(key(path), owners)
    }
  }
  for (const document of documents) {
    signal?.throwIfAborted()
    const before = issues.length
    const issue = (code: ProjectIntegrityIssue['code'], path: string, detail: string): void => {
      issues.push({ documentId: document.id, code, path, detail })
    }
    let missingWorking = false
    let workingSha256: string | undefined
    for (const [kind, path] of [['source', document.immutableSourcePath], ['working', document.workingPath]] as const) {
      if ((ownership.get(key(path))?.size ?? 0) > 1 || key(document.workingPath) === key(document.immutableSourcePath)) {
        issue('duplicate-path', path, 'multiple document roles own the same path')
      }
      try { await verifyProjectPath(project.rootPath, path) } catch (error) {
        issue('unsafe-path', path, String(error))
        continue
      }
      let info
      try { info = await lstat(path) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          issue('unreadable-file', path, String(error))
          continue
        }
      }
      if (info === undefined) {
        issue(kind === 'source' ? 'missing-source' : 'missing-working', path, 'file does not exist')
        if (kind === 'working') missingWorking = true
        continue
      }
      try {
        const image = await readFileImage(path, 'INVALID_REQUEST', kind)
        if (kind === 'working') workingSha256 = image.sha256
        else if (image.sha256 !== document.sourceSha256) issue('source-changed', path, 'original bytes differ from the imported digest')
      } catch (error) { issue('unreadable-file', path, String(error)) }
    }
    const head = document.headCommitId === undefined ? undefined : repository.getCommit(document.headCommitId)
    if (document.documentKind !== 'template-source' && (head === undefined || head.documentId !== document.id)) {
      issue('invalid-head', document.workingPath, 'current head does not resolve to an owned commit')
    }
    let headVerified = false
    for (const commit of repository.listCommits(document.id)) {
      signal?.throwIfAborted()
      try {
        await verifyProjectPath(project.rootPath, commit.snapshotPath)
        await readSnapshot(resolveCommitFilePaths(project.rootPath, document.workingPath), commit.snapshotPath, commit.documentSha256)
        if (commit.id === head?.id) headVerified = true
      } catch (error) { issue('invalid-snapshot', commit.snapshotPath, String(error)) }
    }
    if (head !== undefined && workingSha256 !== undefined && head.documentSha256 !== workingSha256) {
      issue('working-changed', document.workingPath, 'working bytes differ from the current version; capture the external edit before writing')
    }
    const unsafe = issues.slice(before).some(item => item.code === 'duplicate-path' || item.code === 'unsafe-path')
    if (missingWorking && head !== undefined && head.documentId === document.id && headVerified && !unsafe) {
      repairs.push({ documentId: document.id, headCommitId: head.id, sha256: head.documentSha256, workingPath: document.workingPath })
    }
  }
  return { checkedAt: new Date().toISOString(), documents: documents.length, issues, repairs }
}
