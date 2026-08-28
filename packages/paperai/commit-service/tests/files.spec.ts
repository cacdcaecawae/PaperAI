import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PaperCommitError } from '../src/errors.ts'
import {
  createCandidateFile,
  readFileImage,
  readSnapshot,
  removeCandidateFile,
  replaceRegularFile,
  resolveCommitFilePaths,
  sha256Bytes,
  storeSnapshot,
} from '../src/files.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fileFixture() {
  const root = await mkdtemp(join(tmpdir(), 'paperai-commit-files-'))
  roots.push(root)
  const workingPath = join(root, 'working.docx')
  await writeFile(workingPath, 'alpha', 'utf8')
  return {
    root,
    workingPath,
    paths: resolveCommitFilePaths(root, workingPath),
  }
}

describe('commit-service file operations', () => {
  it('resolves only absolute Working DOCX paths inside the project', async () => {
    const fixture = await fileFixture()
    expect(fixture.paths.workingPath).toBe(fixture.workingPath)
    expect(() => resolveCommitFilePaths('relative', fixture.workingPath))
      .toThrow('must be absolute')
    expect(() => resolveCommitFilePaths(fixture.root, join(fixture.root, '..', 'outside.docx')))
      .toThrow('outside project root')
  })

  it('reads regular files and rejects missing paths, directories, and symlinks', async () => {
    const fixture = await fileFixture()
    const image = await readFileImage(fixture.workingPath, 'WORKING_COPY_CHANGED', 'Working DOCX')
    expect(image.bytes.toString('utf8')).toBe('alpha')
    expect(image.sha256).toBe(sha256Bytes(Buffer.from('alpha')))
    await expect(readFileImage(join(fixture.root, 'missing.docx'), 'WORKING_COPY_CHANGED', 'Working DOCX'))
      .rejects.toMatchObject({ code: 'WORKING_COPY_CHANGED' })
    const directory = join(fixture.root, 'directory')
    await mkdir(directory)
    await expect(readFileImage(directory, 'WORKING_COPY_CHANGED', 'Working DOCX'))
      .rejects.toBeInstanceOf(PaperCommitError)
    const linked = join(fixture.root, 'linked.docx')
    await symlink(fixture.workingPath, linked, 'file')
    await expect(readFileImage(linked, 'WORKING_COPY_CHANGED', 'Working DOCX'))
      .rejects.toThrow('non-symlink regular file')
  })

  it('creates and removes candidates only within the owned temporary directory', async () => {
    const fixture = await fileFixture()
    const candidate = await createCandidateFile(fixture.paths, Buffer.from('candidate'))
    expect(await readFile(candidate, 'utf8')).toBe('candidate')
    await removeCandidateFile(fixture.paths, candidate)
    await expect(readFile(candidate)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(removeCandidateFile(fixture.paths, fixture.paths.temporaryRoot))
      .rejects.toThrow('refusing to remove candidate')
    await expect(removeCandidateFile(fixture.paths, fixture.workingPath))
      .rejects.toThrow('refusing to remove candidate')
  })

  it('publishes, reuses, and verifies content-addressed snapshots', async () => {
    const fixture = await fileFixture()
    const bytes = Buffer.from('snapshot')
    const digest = createHash('sha256').update(bytes).digest('hex')
    await expect(storeSnapshot(fixture.paths, bytes, '0'.repeat(64)))
      .rejects.toThrow('proposed content address')
    const snapshot = await storeSnapshot(fixture.paths, bytes, digest)
    expect(await storeSnapshot(fixture.paths, bytes, digest)).toBe(snapshot)
    expect((await readSnapshot(fixture.paths, snapshot, digest)).bytes).toEqual(bytes)
    await expect(readSnapshot(fixture.paths, fixture.workingPath, digest))
      .rejects.toThrow('is not the content address')
    await expect(readSnapshot(fixture.paths, snapshot, 'invalid'))
      .rejects.toThrow('invalid document snapshot SHA-256')
  })

  it('rejects a corrupt existing object during publication and direct reads', async () => {
    const fixture = await fileFixture()
    const bytes = Buffer.from('snapshot')
    const digest = sha256Bytes(bytes)
    const snapshot = await storeSnapshot(fixture.paths, bytes, digest)
    await writeFile(snapshot, 'corrupt', 'utf8')
    await expect(storeSnapshot(fixture.paths, bytes, digest))
      .rejects.toThrow('does not match content address')
    await expect(readSnapshot(fixture.paths, snapshot, digest))
      .rejects.toThrow('does not match recorded SHA-256')
  })

  it('atomically replaces regular files and refuses a directory target', async () => {
    const fixture = await fileFixture()
    const image = await readFileImage(fixture.workingPath, 'WORKING_COPY_CHANGED', 'Working DOCX')
    await replaceRegularFile(fixture.workingPath, Buffer.from('beta'), image.mode)
    expect(await readFile(fixture.workingPath, 'utf8')).toBe('beta')
    const directory = join(fixture.root, 'directory')
    await mkdir(directory)
    await expect(replaceRegularFile(directory, Buffer.from('nope'), image.mode))
      .rejects.toMatchObject({ code: 'WORKING_COPY_CHANGED' })
  })
})
