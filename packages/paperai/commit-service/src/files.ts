/** Private filesystem operations for candidate, snapshot, and Working DOCX publication. */

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  link,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path'
import type { PaperCommitErrorCode } from './types.ts'
import { PaperCommitError } from './errors.ts'

const PRIVATE_FILE_MODE = 0o600
const PRIVATE_DIRECTORY_MODE = 0o700

/** Immutable bytes and metadata captured from one regular file. */
export interface FileImage {
  readonly bytes: Buffer
  readonly mode: number
  readonly sha256: string
}

/** Project-local paths owned by the commit service. */
export interface CommitFilePaths {
  readonly projectRoot: string
  readonly workingPath: string
  readonly temporaryRoot: string
  readonly objectRoot: string
}

/**
 * Compute the lowercase SHA-256 digest of complete file bytes.
 * @param bytes - complete binary content.
 * @returns the 64-character lowercase digest.
 */
export function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function isContained(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

/**
 * Resolve and validate all commit-owned paths for one Working DOCX.
 * @param projectRoot - absolute PaperAI project root.
 * @param workingPath - absolute authoritative Working DOCX path.
 * @returns validated project, temporary, and object paths.
 */
export function resolveCommitFilePaths(projectRoot: string, workingPath: string): CommitFilePaths {
  if (!isAbsolute(projectRoot) || !isAbsolute(workingPath)) {
    throw new PaperCommitError('INVALID_REQUEST', 'project root and Working DOCX path must be absolute')
  }
  const resolvedRoot = resolve(projectRoot)
  const resolvedWorking = resolve(workingPath)
  if (!isContained(resolvedRoot, resolvedWorking)) {
    throw new PaperCommitError(
      'INVALID_REQUEST',
      `Working DOCX '${workingPath}' is outside project root '${projectRoot}'`,
    )
  }
  const metadataRoot = join(resolvedRoot, '.paperai')
  return {
    projectRoot: resolvedRoot,
    workingPath: resolvedWorking,
    temporaryRoot: join(metadataRoot, 'tmp', 'commits'),
    objectRoot: join(metadataRoot, 'objects', 'docx'),
  }
}

/**
 * Read one non-symlink regular file and retain its exact bytes and mode.
 * @param filePath - exact local file path.
 * @param code - PaperAI error code used for invalid or unreadable input.
 * @param label - diagnostic subject name.
 * @returns complete bytes, permission mode, and SHA-256.
 */
export async function readFileImage(
  filePath: string,
  code: PaperCommitErrorCode,
  label: string,
): Promise<FileImage> {
  let info
  try {
    info = await lstat(filePath)
  } catch (cause) {
    throw new PaperCommitError(code, `${label} '${filePath}' cannot be read`, { cause })
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new PaperCommitError(code, `${label} '${filePath}' must be a non-symlink regular file`)
  }
  const bytes = await readFile(filePath)
  return { bytes, mode: info.mode, sha256: sha256Bytes(bytes) }
}

/**
 * Create a private temporary DOCX initialized from captured authoritative bytes.
 * @param paths - validated commit-owned paths.
 * @param source - complete initial candidate bytes.
 * @returns the fresh candidate path.
 */
export async function createCandidateFile(paths: CommitFilePaths, source: Uint8Array): Promise<string> {
  await mkdir(paths.temporaryRoot, { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
  const candidatePath = join(paths.temporaryRoot, `${randomUUID()}.docx`)
  await writeFile(candidatePath, source, { flag: 'wx', mode: PRIVATE_FILE_MODE })
  return candidatePath
}

/**
 * Remove an exact temporary candidate path without following links.
 * @param paths - validated commit-owned paths.
 * @param candidatePath - exact candidate previously returned by this module.
 */
export async function removeCandidateFile(paths: CommitFilePaths, candidatePath: string): Promise<void> {
  const resolvedCandidate = resolve(candidatePath)
  if (!isContained(paths.temporaryRoot, resolvedCandidate) || resolvedCandidate === paths.temporaryRoot) {
    throw new Error(`refusing to remove candidate outside '${paths.temporaryRoot}': '${candidatePath}'`)
  }
  await rm(resolvedCandidate, { force: true })
}

function snapshotPath(paths: CommitFilePaths, digest: string): string {
  if (!/^[0-9a-f]{64}$/u.test(digest)) {
    throw new PaperCommitError('SNAPSHOT_CORRUPT', `invalid document snapshot SHA-256 '${digest}'`)
  }
  return join(paths.objectRoot, digest.slice(0, 2), `${digest}.docx`)
}

async function verifySnapshot(filePath: string, expectedSha256: string): Promise<void> {
  const image = await readFileImage(filePath, 'SNAPSHOT_CORRUPT', 'document snapshot')
  if (image.sha256 !== expectedSha256) {
    throw new PaperCommitError(
      'SNAPSHOT_CORRUPT',
      `document snapshot '${filePath}' does not match content address '${expectedSha256}'`,
    )
  }
}

/**
 * Publish immutable bytes at their project-local content address.
 * @param paths - validated commit-owned paths.
 * @param bytes - complete validated DOCX bytes.
 * @param digest - SHA-256 that addresses those bytes.
 * @returns the verified immutable snapshot path.
 */
export async function storeSnapshot(
  paths: CommitFilePaths,
  bytes: Uint8Array,
  digest: string,
): Promise<string> {
  if (sha256Bytes(bytes) !== digest) {
    throw new PaperCommitError('SNAPSHOT_CORRUPT', 'candidate bytes do not match their proposed content address')
  }
  const destination = snapshotPath(paths, digest)
  await mkdir(dirname(destination), { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
  const temporary = `${destination}.${randomBytes(8).toString('hex')}.tmp`
  await writeFile(temporary, bytes, { flag: 'wx', mode: PRIVATE_FILE_MODE })
  try {
    try {
      await link(temporary, destination)
    } catch (cause) {
      /* v8 ignore next -- Private same-filesystem directories make EEXIST the only recoverable link race. */
      if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause
    }
  } finally {
    await rm(temporary, { force: true })
  }
  await verifySnapshot(destination, digest)
  return destination
}

function normalizedPath(filePath: string): string {
  const normalized = resolve(filePath)
  /* v8 ignore next -- Windows and POSIX lanes exercise opposite path-comparison rules. */
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

/**
 * Read and verify one snapshot at the only path valid for its content address.
 * @param paths - validated commit-owned paths.
 * @param filePath - snapshot path retained by the commit object.
 * @param expectedSha256 - recorded snapshot digest.
 * @returns verified snapshot bytes and metadata.
 */
export async function readSnapshot(
  paths: CommitFilePaths,
  filePath: string,
  expectedSha256: string,
): Promise<FileImage> {
  const expectedPath = snapshotPath(paths, expectedSha256)
  if (normalizedPath(filePath) !== normalizedPath(expectedPath)) {
    throw new PaperCommitError(
      'SNAPSHOT_CORRUPT',
      `document snapshot path '${filePath}' is not the content address '${expectedPath}'`,
    )
  }
  const image = await readFileImage(filePath, 'SNAPSHOT_CORRUPT', 'document snapshot')
  if (image.sha256 !== expectedSha256) {
    throw new PaperCommitError(
      'SNAPSHOT_CORRUPT',
      `document snapshot '${filePath}' does not match recorded SHA-256 '${expectedSha256}'`,
    )
  }
  return image
}

/**
 * Atomically replace a non-symlink regular file with complete binary content.
 * @param filePath - exact existing destination path.
 * @param bytes - complete replacement bytes.
 * @param mode - permission bits for the fresh replacement inode.
 */
export async function replaceRegularFile(
  filePath: string,
  bytes: Uint8Array,
  mode: number,
): Promise<void> {
  const before = await lstat(filePath)
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new PaperCommitError(
      'WORKING_COPY_CHANGED',
      `Working DOCX '${filePath}' is no longer a non-symlink regular file`,
    )
  }
  const temporary = `${filePath}.${randomBytes(8).toString('hex')}.paperai.tmp`
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode })
    await rename(temporary, filePath)
  } finally {
    await rm(temporary, { force: true })
  }
}
