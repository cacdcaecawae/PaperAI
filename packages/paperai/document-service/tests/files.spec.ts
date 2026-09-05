import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import {
  cleanupStagedDocument,
  copyDocxWorkingFile,
  ImmutableSourceIntegrityError,
  publishStagedDocument,
  removePublishedDocument,
  sha256File,
  stageSourceFile,
  verifyImmutableSourceFile,
  type StagedDocumentFiles,
} from '../src/files.ts'

const roots: string[] = []

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'paperai-files-'))
  roots.push(value)
  return value
}

afterEach(async () => {
  const tempRoot = `${resolve(tmpdir())}${sep}`.toLocaleLowerCase('en-US')
  for (const value of roots.splice(0)) {
    if (!resolve(value).toLocaleLowerCase('en-US').startsWith(tempRoot)) {
      throw new Error(`Refusing to remove non-temporary test root '${value}'`)
    }
    await rm(value, { recursive: true, force: true })
  }
})

describe('document file publication', () => {
  it('cleans staging when source copying fails or cancellation is already requested', async () => {
    const project = await root()
    await expect(stageSourceFile(project, join(project, 'missing.docx'), '.docx')).rejects.toMatchObject({ code: 'ENOENT' })
    const staging = join(project, '.paperai', 'documents', 'v1', '.staging')
    expect(await readdir(staging)).toEqual([])

    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    await expect(stageSourceFile(project, join(project, 'missing.docx'), '.docx', controller.signal))
      .rejects.toThrow('cancelled')
  })

  it('resolves source and Working-path collisions without replacing either file', async () => {
    const project = await root()
    const input = join(project, 'input.docx')
    await writeFile(input, 'source')
    const first = await stageSourceFile(project, input, '.docx')
    await copyDocxWorkingFile(first)
    const firstSha256 = await sha256File(first.sourcePath)
    const published = await publishStagedDocument(project, first, '论文', firstSha256, [])
    await cleanupStagedDocument(first)

    const second = await stageSourceFile(project, input, '.docx')
    await copyDocxWorkingFile(second)
    const secondSha256 = await sha256File(second.sourcePath)
    const conflict = await publishStagedDocument(project, second, '论文', secondSha256, [])
    expect(conflict.name).toBe('论文 (2)')
    expect(await readFile(published.immutableSourcePath, 'utf8')).toBe('source')
    expect(await readFile(published.workingPath, 'utf8')).toBe('source')
    await cleanupStagedDocument(second)
    await cleanupStagedDocument(second)

    await removePublishedDocument(conflict)
    await removePublishedDocument(conflict)
  })

  it('publishes a read-only source on an inode independent from Working and detects later tampering', async () => {
    const project = await root()
    const input = join(project, 'input.docx')
    await writeFile(input, 'source')
    const staged = await stageSourceFile(project, input, '.docx')
    await copyDocxWorkingFile(staged)
    const sourceSha256 = await sha256File(staged.sourcePath)
    const published = await publishStagedDocument(project, staged, 'separated', sourceSha256, [])
    await cleanupStagedDocument(staged)

    const sourceMetadata = await lstat(published.immutableSourcePath)
    const workingMetadata = await lstat(published.workingPath)
    expect(sourceMetadata.mode & 0o222).toBe(0)
    expect([sourceMetadata.dev, sourceMetadata.ino]).not.toEqual([workingMetadata.dev, workingMetadata.ino])
    await expect(verifyImmutableSourceFile(published.immutableSourcePath, sourceSha256))
      .resolves.toBe(sourceSha256)

    if (process.platform === 'win32') {
      await expect(writeFile(published.immutableSourcePath, 'overwritten'))
        .rejects.toMatchObject({ code: 'EPERM' })
      await expect(readFile(published.workingPath, 'utf8')).resolves.toBe('source')
    }

    await writeFile(published.workingPath, 'working edit')
    await expect(readFile(published.immutableSourcePath, 'utf8')).resolves.toBe('source')
    await chmod(published.immutableSourcePath, 0o600)
    await writeFile(published.immutableSourcePath, 'tampered source')
    await chmod(published.immutableSourcePath, 0o400)
    await expect(verifyImmutableSourceFile(published.immutableSourcePath, sourceSha256))
      .rejects.toBeInstanceOf(ImmutableSourceIntegrityError)
    await expect(readFile(published.workingPath, 'utf8')).resolves.toBe('working edit')

    await removePublishedDocument(published)
  })

  it('rolls back the source link when the staged Working file is missing', async () => {
    const project = await root()
    const input = join(project, 'input.docx')
    await writeFile(input, 'source')
    const staged = await stageSourceFile(project, input, '.docx')
    const sourceSha256 = await sha256File(staged.sourcePath)
    await expect(publishStagedDocument(project, staged, 'broken', sourceSha256, [])).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readdir(join(project, 'documents', 'source'))).toEqual([])
    await cleanupStagedDocument(staged)

    const missingSource: StagedDocumentFiles = {
      ...staged,
      directory: join(project, 'missing-stage'),
      sourcePath: join(project, 'missing-source.docx'),
      workingPath: input,
    }
    await expect(publishStagedDocument(project, missingSource, 'missing', sourceSha256, [])).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('surfaces exact cleanup failures and hashes staged bytes', async () => {
    const project = await root()
    const input = join(project, 'input.docx')
    await writeFile(input, 'source')
    const staged = await stageSourceFile(project, input, '.docx')
    expect(await sha256File(staged.sourcePath)).toMatch(/^[a-f0-9]{64}$/u)

    await mkdir(staged.workingPath)
    await expect(cleanupStagedDocument(staged)).rejects.toBeInstanceOf(Error)
    await rm(staged.workingPath, { recursive: true })
    await writeFile(join(staged.directory, 'extra'), 'x')
    await unlink(staged.sourcePath)
    await expect(cleanupStagedDocument(staged)).rejects.toMatchObject({ code: 'ENOTEMPTY' })
  })
})
