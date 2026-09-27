import { mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { exportHarness, humanActor, type ExportHarness } from './helpers.ts'

const race = vi.hoisted(() => ({
  beforeRename: undefined as ((from: string, to: string) => Promise<void>) | undefined,
  afterRename: undefined as ((from: string, to: string) => Promise<void>) | undefined,
}))

// Lets a test act as a concurrent process in the instant between the
// service's last path check and the rename that publishes the export, or
// between that rename and the service's confirmation of what it published.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    async rename(from: string, to: string): Promise<void> {
      const interleave = race.beforeRename
      race.beforeRename = undefined
      const after = race.afterRename
      race.afterRename = undefined
      await interleave?.(from, to)
      await actual.rename(from, to)
      await after?.(from, to)
    },
  }
})

const harnesses: ExportHarness[] = []

afterEach(async () => {
  race.beforeRename = undefined
  race.afterRename = undefined
  await Promise.all(harnesses.splice(0).map(harness => harness.close()))
})

describe('PaperExportService publication races', () => {
  it('withdraws an export whose directory is swapped for an escaping link during publication', async () => {
    const harness = await exportHarness()
    harnesses.push(harness)
    const chapter = join(harness.outputRoot, 'chapter')
    await mkdir(chapter)
    const outside = await mkdtemp(join(tmpdir(), 'paperai-export-escape-'))
    try {
      race.beforeRename = async (temporaryPath) => {
        // Move the verified temporary file out, then link its directory to where it went.
        await rename(temporaryPath, join(outside, basename(temporaryPath)))
        await rename(chapter, join(harness.outputRoot, 'chapter-moved'))
        await symlink(outside, chapter, 'junction')
      }
      await expect(harness.ctx.paperExports.exportDocument({
        document: harness.document,
        destinationPath: join(chapter, 'escape.docx'),
        mode: 'draft-export',
        actor: humanActor,
      })).rejects.toMatchObject({ name: 'PaperExportError', code: 'DESTINATION_PROTECTED' })
      // The rename landed outside exports/; no snapshot bytes may remain there.
      expect(await readdir(outside)).toEqual(['escape.docx'])
      expect(await readFile(join(outside, 'escape.docx'))).toHaveLength(0)
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('withdraws an export when another file takes the destination between rename and confirmation', async () => {
    const harness = await exportHarness()
    harnesses.push(harness)
    const destination = join(harness.outputRoot, 'contested.docx')
    const other = join(harness.outputRoot, 'other.docx')
    const displaced = join(harness.outputRoot, 'displaced.docx')
    const otherBytes = Buffer.from('another export reaching the same file')
    await writeFile(other, otherBytes)
    race.afterRename = async (_from, to) => {
      // A concurrent export publishes its own file in this one's place before
      // the lstat. Windows refuses to rename over a file the service holds
      // open, so the published file is moved aside first.
      await rename(to, displaced)
      await rename(other, to)
    }
    await expect(harness.ctx.paperExports.exportDocument({
      document: harness.document,
      destinationPath: destination,
      mode: 'draft-export',
      actor: humanActor,
    })).rejects.toMatchObject({ name: 'PaperExportError', code: 'DESTINATION_PROTECTED' })
    expect(await readFile(destination)).toEqual(otherBytes)
    // The withdrawn output is emptied through the handle, wherever it went.
    expect(await readFile(displaced)).toHaveLength(0)
  })
})
