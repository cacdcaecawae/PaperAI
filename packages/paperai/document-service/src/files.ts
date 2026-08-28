/** Private staging and atomic publication for PaperAI document files. */

import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  rmdir,
  unlink,
} from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { join, resolve } from 'node:path'

/** Source formats admitted by the document service. */
export type WordSourceExtension = '.doc' | '.docx'

/** One private import staging directory below the project document root. */
export interface StagedDocumentFiles {
  directory: string
  sourcePath: string
  workingPath: string
  sourceExtension: WordSourceExtension
}

/** Atomically published immutable source and independently writable DOCX. */
export interface PublishedDocumentFiles {
  name: string
  immutableSourcePath: string
  workingPath: string
  sourceSha256: string
}

/** Immutable-source bytes or file metadata no longer match their durable record. */
export class ImmutableSourceIntegrityError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ImmutableSourceIntegrityError'
  }
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

async function syncFile(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDWR)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function syncDirectory(path: string): Promise<void> {
  /* v8 ignore next -- Windows journals directory entries and cannot open directory handles through this API. */
  if (process.platform === 'win32') return
  /* v8 ignore start -- The Windows branch above is exercised on the product's primary platform. */
  const handle = await open(path, constants.O_RDONLY)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
  /* v8 ignore stop */
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  await chmod(path, 0o700)
}

function layout(projectRoot: string): {
  sources: string
  working: string
  staging: string
} {
  const root = join(resolve(projectRoot), '.paperai', 'documents', 'v1')
  return {
    sources: join(root, 'sources'),
    working: join(root, 'working'),
    staging: join(root, '.staging'),
  }
}

/**
 * Copy the submitted source into a private same-filesystem staging directory.
 * @param projectRoot - existing absolute PaperAI project root.
 * @param sourcePath - submitted Word file path.
 * @param sourceExtension - validated lowercase source extension.
 * @param signal - optional import cancellation.
 * @returns staging paths; only `sourcePath` exists on return.
 */
export async function stageSourceFile(
  projectRoot: string,
  sourcePath: string,
  sourceExtension: WordSourceExtension,
  signal?: AbortSignal,
): Promise<StagedDocumentFiles> {
  signal?.throwIfAborted()
  const paths = layout(projectRoot)
  await ensurePrivateDirectory(paths.sources)
  await ensurePrivateDirectory(paths.working)
  await ensurePrivateDirectory(paths.staging)
  const directory = await mkdtemp(join(paths.staging, 'import-'))
  const staged: StagedDocumentFiles = {
    directory,
    sourcePath: join(directory, `source${sourceExtension}`),
    workingPath: join(directory, 'working.docx'),
    sourceExtension,
  }
  try {
    await copyFile(sourcePath, staged.sourcePath, constants.COPYFILE_EXCL)
    signal?.throwIfAborted()
    await chmod(staged.sourcePath, 0o600)
    await syncFile(staged.sourcePath)
    return staged
  } catch (error) {
    await cleanupStagedDocument(staged)
    throw error
  }
}

/**
 * Create an independent Working DOCX from a staged DOCX source.
 * @param staged - staged DOCX source and empty working target.
 * @param signal - optional import cancellation.
 */
export async function copyDocxWorkingFile(staged: StagedDocumentFiles, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  await copyFile(staged.sourcePath, staged.workingPath, constants.COPYFILE_EXCL)
  signal?.throwIfAborted()
  await finalizeWorkingFile(staged.workingPath)
}

/**
 * Verify and sync a working file produced by a legacy-document normalizer.
 * @param workingPath - expected newly created DOCX path.
 * @throws when the provider did not produce one regular non-empty file.
 */
export async function finalizeWorkingFile(workingPath: string): Promise<void> {
  const metadata = await lstat(workingPath)
  if (!metadata.isFile() || metadata.size === 0) {
    throw new Error('Document engine did not produce a regular non-empty Working DOCX')
  }
  await chmod(workingPath, 0o600)
  await syncFile(workingPath)
}

/**
 * Hash the immutable staged source bytes.
 * @param sourcePath - staged immutable source.
 * @param signal - optional import cancellation.
 * @returns lowercase SHA-256 digest.
 */
export async function sha256File(sourcePath: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256')
  const stream = createReadStream(sourcePath, { signal })
  for await (const chunk of stream as AsyncIterable<Buffer>) hash.update(chunk)
  signal?.throwIfAborted()
  return hash.digest('hex')
}

/**
 * Verify that a published source is a read-only regular file with the recorded bytes.
 * @param sourcePath - published immutable source path.
 * @param expectedSha256 - lowercase SHA-256 recorded for the imported source.
 * @param signal - optional verification cancellation.
 * @returns the verified lowercase SHA-256 digest.
 * @throws ImmutableSourceIntegrityError when metadata or bytes diverge.
 */
export async function verifyImmutableSourceFile(
  sourcePath: string,
  expectedSha256: string,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted()
  try {
    const before = await lstat(sourcePath)
    if (!before.isFile() || before.isSymbolicLink()) {
      throw new ImmutableSourceIntegrityError(`Immutable source '${sourcePath}' is not a regular file`)
    }
    if ((before.mode & 0o222) !== 0) {
      throw new ImmutableSourceIntegrityError(`Immutable source '${sourcePath}' is writable`)
    }
    const actualSha256 = await sha256File(sourcePath, signal)
    const after = await lstat(sourcePath)
    if (!after.isFile()
      || after.isSymbolicLink()
      || before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs) {
      throw new ImmutableSourceIntegrityError(`Immutable source '${sourcePath}' changed while it was being verified`)
    }
    if (actualSha256 !== expectedSha256) {
      throw new ImmutableSourceIntegrityError(`Immutable source '${sourcePath}' does not match its recorded SHA-256`)
    }
    return actualSha256
  } catch (error) {
    if (error instanceof ImmutableSourceIntegrityError || signal?.aborted === true) throw error
    throw new ImmutableSourceIntegrityError(
      `Immutable source '${sourcePath}' could not be verified`,
      { cause: error },
    )
  }
}

function candidateName(stem: string, sequence: number): string {
  return sequence === 1 ? stem : `${stem} (${String(sequence)})`
}

/**
 * Publish both staged files with conflict-free names. The source is copied to
 * an exclusive final path before becoming read-only; the independent Working
 * DOCX uses same-filesystem hard-link publication. Existing paths are never
 * replaced.
 * @param projectRoot - owning project root.
 * @param staged - complete immutable source and Working DOCX staging pair.
 * @param requestedStem - validated normalized display/file stem.
 * @param expectedSourceSha256 - digest of the staged source before publication.
 * @param signal - optional import cancellation.
 * @returns final paths and the conflict-resolved display name.
 */
export async function publishStagedDocument(
  projectRoot: string,
  staged: StagedDocumentFiles,
  requestedStem: string,
  expectedSourceSha256: string,
  signal?: AbortSignal,
): Promise<PublishedDocumentFiles> {
  const paths = layout(projectRoot)
  for (let sequence = 1; ; sequence += 1) {
    signal?.throwIfAborted()
    const name = candidateName(requestedStem, sequence)
    const immutableSourcePath = join(paths.sources, `${name}${staged.sourceExtension}`)
    const workingPath = join(paths.working, `${name}.docx`)
    try {
      await copyFile(staged.sourcePath, immutableSourcePath, constants.COPYFILE_EXCL)
    } catch (error) {
      if (isCode(error, 'EEXIST')) continue
      throw error
    }
    try {
      await link(staged.workingPath, workingPath)
    } catch (error) {
      await unlink(immutableSourcePath)
      if (isCode(error, 'EEXIST')) continue
      throw error
    }
    try {
      await syncFile(immutableSourcePath)
      await chmod(immutableSourcePath, 0o400)
      const sourceSha256 = await verifyImmutableSourceFile(
        immutableSourcePath,
        expectedSourceSha256,
        signal,
      )
      await syncDirectory(paths.sources)
      await syncDirectory(paths.working)
      return { name, immutableSourcePath, workingPath, sourceSha256 }
    } catch (error) {
      /* v8 ignore next -- Requires a directory-fsync fault after two successful same-filesystem links. */
      await Promise.allSettled([unlinkReadOnlyIfPresent(immutableSourcePath), unlink(workingPath)])
      /* v8 ignore next -- Preserves the directory durability failure after exact-path cleanup. */
      throw error
    }
  }
}

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch (error) {
    if (!isCode(error, 'ENOENT')) throw error
  }
}

async function unlinkReadOnlyIfPresent(path: string): Promise<void> {
  try {
    await chmod(path, 0o600)
  } catch (error) {
    if (isCode(error, 'ENOENT')) return
    throw error
  }
  await unlinkIfPresent(path)
}

/**
 * Remove one exact published pair during an uncommitted import rollback.
 * @param files - final source and Working paths owned by the failed import.
 */
export async function removePublishedDocument(files: PublishedDocumentFiles): Promise<void> {
  await unlinkReadOnlyIfPresent(files.immutableSourcePath)
  await unlinkIfPresent(files.workingPath)
  await syncDirectory(resolve(files.immutableSourcePath, '..'))
  await syncDirectory(resolve(files.workingPath, '..'))
}

/**
 * Remove the private staging files and their exact import directory.
 * @param staged - one import-owned staging directory and its two known files.
 */
export async function cleanupStagedDocument(staged: StagedDocumentFiles): Promise<void> {
  await unlinkIfPresent(staged.workingPath)
  await unlinkIfPresent(staged.sourcePath)
  try {
    await rmdir(staged.directory)
  } catch (error) {
    if (!isCode(error, 'ENOENT')) throw error
  }
}
