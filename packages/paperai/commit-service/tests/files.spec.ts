import { createHash } from 'node:crypto'
import { link, mkdtemp, mkdir, open, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
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

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return { ...fs, writeFile: vi.fn(fs.writeFile), open: vi.fn(fs.open), link: vi.fn(fs.link), rename: vi.fn(fs.rename) }
})

const roots: string[] = []

afterEach(async () => {
  vi.clearAllMocks()
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
  it('flushes complete bytes before publishing snapshots and replacing Working DOCX', async () => {
    const fixture = await fileFixture()
    const bytes = Buffer.from('durable')
    await storeSnapshot(fixture.paths, bytes, sha256Bytes(bytes))
    await replaceRegularFile(fixture.workingPath, bytes, 0o600)
    const calls = vi.mocked(writeFile).mock.calls
    expect(calls[1]?.[2]).toMatchObject({ flag: 'wx', flush: true })
    expect(calls[2]?.[2]).toMatchObject({ flag: 'wx', flush: true })
    expect(vi.mocked(writeFile).mock.invocationCallOrder[1]).toBeLessThan(vi.mocked(link).mock.invocationCallOrder[0]!)
    expect(vi.mocked(writeFile).mock.invocationCallOrder[2]).toBeLessThan(vi.mocked(rename).mock.invocationCallOrder[0]!)
    if (process.platform !== 'win32') expect(open).toHaveBeenCalledWith(fixture.root, 'r')
    expect(await readFile(fixture.workingPath)).toEqual(bytes)
  })

  it('syncs every snapshot ancestor through the project root when the bucket already exists', async () => {
    const fixture = await fileFixture()
    const bytes = Buffer.from('shared bucket')
    const bucket = join(fixture.paths.objectRoot, sha256Bytes(bytes).slice(0, 2))
    // Another publication may have created the bucket without having synced its parent entries yet.
    await mkdir(bucket, { recursive: true })
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    Object.defineProperty(process, 'platform', { ...platform, value: 'linux' })
    vi.mocked(open).mockImplementation(async () => ({ sync: async () => {}, close: async () => {} }) as never)
    try {
      await storeSnapshot(fixture.paths, bytes, sha256Bytes(bytes))
    } finally {
      Object.defineProperty(process, 'platform', platform)
      vi.mocked(open).mockImplementation(actual.open)
    }
    const synced = vi.mocked(open).mock.calls.map(([path]) => path)
    for (const directory of [bucket, fixture.paths.objectRoot, join(fixture.root, '.paperai', 'objects'), join(fixture.root, '.paperai'), fixture.root]) {
      expect(synced).toContain(directory)
    }
  })

  it.each(['snapshot', 'working'] as const)('leaves published files untouched when the %s write cannot flush', async (target) => {
    const fixture = await fileFixture()
    const bytes = Buffer.from('durable')
    vi.mocked(writeFile).mockRejectedValueOnce(new Error('flush failed'))
    const pending = target === 'snapshot'
      ? storeSnapshot(fixture.paths, bytes, sha256Bytes(bytes))
      : replaceRegularFile(fixture.workingPath, bytes, 0o600)
    await expect(pending).rejects.toThrow('flush failed')
    expect(link).not.toHaveBeenCalled()
    expect(rename).not.toHaveBeenCalled()
    expect(await readFile(fixture.workingPath, 'utf8')).toBe('alpha')
  })

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

  it('rejects corrupt snapshot reads and repairs publication from verified bytes', async () => {
    const fixture = await fileFixture()
    const bytes = Buffer.from('snapshot')
    const digest = sha256Bytes(bytes)
    const snapshot = await storeSnapshot(fixture.paths, bytes, digest)
    await writeFile(snapshot, 'corrupt', 'utf8')
    await expect(readSnapshot(fixture.paths, snapshot, digest))
      .rejects.toThrow('does not match recorded SHA-256')
    expect(await storeSnapshot(fixture.paths, bytes, digest)).toBe(snapshot)
    expect((await readSnapshot(fixture.paths, snapshot, digest)).bytes).toEqual(bytes)
  })

  it('does not repair a snapshot symlink or directory, or replace a link target', async () => {
    const fixture = await fileFixture()
    const bytes = Buffer.from('snapshot')
    const digest = sha256Bytes(bytes)
    const snapshot = await storeSnapshot(fixture.paths, bytes, digest)
    await rm(snapshot)
    await symlink(fixture.workingPath, snapshot, 'file')
    await expect(storeSnapshot(fixture.paths, bytes, digest)).rejects.toThrow('symbolic link')
    expect(await readFile(fixture.workingPath, 'utf8')).toBe('alpha')
    await rm(snapshot)
    await mkdir(snapshot)
    await expect(storeSnapshot(fixture.paths, bytes, digest)).rejects.toThrow('non-symlink regular file')
    expect(await readdir(snapshot)).toEqual([])
  })

  it.each(['.paperai', 'objects/docx', 'digest bucket'] as const)('does not create or repair a snapshot through a linked %s outside the project', async (ancestor) => {
    const fixture = await fileFixture()
    const outside = await mkdtemp(join(tmpdir(), 'paperai-commit-outside-'))
    roots.push(outside)
    const bytes = Buffer.from('snapshot')
    const digest = sha256Bytes(bytes)
    const destination = join(fixture.paths.objectRoot, digest.slice(0, 2), `${digest}.docx`)
    const linked = ancestor === '.paperai'
      ? join(fixture.root, '.paperai')
      : ancestor === 'objects/docx' ? fixture.paths.objectRoot : dirname(destination)
    // The outside file sits where the linked ancestor would place the corrupt snapshot.
    const victim = join(outside, relative(linked, destination))
    await mkdir(dirname(victim), { recursive: true })
    await writeFile(victim, 'outside', 'utf8')
    await mkdir(dirname(linked), { recursive: true })
    // A junction needs no privilege on Windows; POSIX ignores the type and creates a directory symlink.
    await symlink(outside, linked, 'junction')
    await expect(storeSnapshot(fixture.paths, bytes, digest)).rejects.toThrow(/symbolic link|outside the project/)
    expect(await readFile(victim, 'utf8')).toBe('outside')
    expect(await readdir(dirname(victim))).toEqual([`${digest}.docx`])
  })

  it('does not stage a candidate through a linked metadata directory outside the project', async () => {
    const fixture = await fileFixture()
    const outside = await mkdtemp(join(tmpdir(), 'paperai-commit-outside-'))
    roots.push(outside)
    await symlink(outside, join(fixture.root, '.paperai'), 'junction')
    await expect(createCandidateFile(fixture.paths, Buffer.from('candidate'))).rejects.toThrow('symbolic link')
    expect(await readdir(outside)).toEqual([])
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
