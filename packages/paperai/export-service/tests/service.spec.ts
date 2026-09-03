import { link, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { DocumentCommitId, type GateReport } from '@paperai/domain'
import PaperExportService, { PaperExportError } from '../src/index.ts'
import {
  agentActor,
  contents,
  digest,
  exportHarness,
  humanActor,
  report,
  type ExportHarness,
} from './helpers.ts'

const harnesses: ExportHarness[] = []

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map(harness => harness.close()))
})

async function createHarness(...args: Parameters<typeof exportHarness>): Promise<ExportHarness> {
  const harness = await exportHarness(...args)
  harnesses.push(harness)
  return harness
}

describe('PaperExportService', () => {
  it('exports a draft with findings from the new immutable milestone snapshot', async () => {
    const harness = await createHarness()
    const outputPath = join(harness.root, 'draft.docx')
    const suppliedGate = report(harness.document.id, 'draft-export', true)
    const result = await harness.ctx.paperExports.exportDocument({
      document: harness.document,
      destinationPath: outputPath,
      mode: 'draft-export',
      actor: humanActor,
      gate: suppliedGate,
    })

    expect(harness.check).toHaveBeenCalledWith({
      documentId: harness.document.id,
      mode: 'draft-export',
    }, undefined)
    expect(result.outputPath).toBe(await realpath(outputPath))
    expect(result.report).toMatchObject({ mode: 'draft-export', status: 'pass' })
    expect(result.report.findings).toHaveLength(1)
    expect(result.gate).toEqual(result.report)
    expect(result.gate).not.toBe(result.report)
    expect(await readFile(outputPath)).toEqual(Buffer.from(harness.snapshotBytes))
    expect(await contents(harness.sourcePath)).toBe('immutable source')
    expect(await contents(harness.workingPath)).toBe('authoritative working copy')
    expect(harness.submit).toHaveBeenCalledWith({
      documentId: harness.document.id,
      baseCommitId: harness.document.headCommitId,
      message: 'Draft export: draft.docx',
      actor: humanActor,
      mutations: [{ type: 'milestone', label: 'Draft export: draft.docx' }],
    })
    expect(result.commit.actor).toEqual(humanActor)
    expect(result.commit.snapshotPath).toBe(harness.snapshotPath)
  })

  it('confines a writable-root export on real paths, so a link inside the root cannot carry it out', async () => {
    const harness = await createHarness()
    const outside = await mkdtemp(join(tmpdir(), 'paperai-export-outside-'))
    try {
      // `exports` inside the workspace is a directory link to a place outside it.
      await symlink(outside, join(harness.root, 'exports'), 'junction')
      const escape = harness.ctx.paperExports.exportDocument({
        document: harness.document,
        destinationPath: join(harness.root, 'exports', 'escape.docx'),
        writableRoot: harness.root,
        mode: 'draft-export',
        actor: humanActor,
        gate: report(harness.document.id, 'draft-export', true),
      })
      await expect(escape).rejects.toMatchObject({
        name: 'PaperExportError',
        code: 'DESTINATION_OUTSIDE_WORKSPACE',
      })
      expect(await readdir(outside)).toEqual([])
      expect(harness.submit).not.toHaveBeenCalled()

      // A link that stays inside the root is fine, and so is an unconfined export.
      await mkdir(join(harness.root, 'delivery'))
      await symlink(join(harness.root, 'delivery'), join(harness.root, 'published'), 'junction')
      const inside = await harness.ctx.paperExports.exportDocument({
        document: harness.document,
        destinationPath: join(harness.root, 'published', 'inside.docx'),
        writableRoot: harness.root,
        mode: 'draft-export',
        actor: humanActor,
        gate: report(harness.document.id, 'draft-export', true),
      })
      expect(inside.outputPath).toBe(join(await realpath(join(harness.root, 'delivery')), 'inside.docx'))
      const unconfined = await harness.ctx.paperExports.exportDocument({
        document: harness.document,
        destinationPath: join(harness.root, 'exports', 'unconfined.docx'),
        mode: 'draft-export',
        actor: humanActor,
        gate: report(harness.document.id, 'draft-export', true),
      })
      expect(unconfined.outputPath).toBe(join(await realpath(outside), 'unconfined.docx'))
      await expect(harness.ctx.paperExports.exportDocument({
        document: harness.document,
        destinationPath: join(harness.root, 'missing-root.docx'),
        writableRoot: join(harness.root, 'does-not-exist'),
        mode: 'draft-export',
        actor: humanActor,
        gate: report(harness.document.id, 'draft-export', true),
      })).rejects.toMatchObject({ code: 'DESTINATION_OUTSIDE_WORKSPACE' })
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32' || process.platform === 'darwin')(
    'keeps a sibling directory that differs only by case outside a case-sensitive writable root',
    async () => {
      const harness = await createHarness()
      // The sibling's name differs from the root's only by letter case.
      const swapped = basename(harness.root)
        .replace(/[a-z]/giu, char => (char === char.toUpperCase() ? char.toLowerCase() : char.toUpperCase()))
      const sibling = join(dirname(harness.root), swapped)
      await mkdir(sibling)
      try {
        await symlink(sibling, join(harness.root, 'exports'), 'junction')
        await expect(harness.ctx.paperExports.exportDocument({
          document: harness.document,
          destinationPath: join(harness.root, 'exports', 'escape.docx'),
          writableRoot: harness.root,
          mode: 'draft-export',
          actor: humanActor,
          gate: report(harness.document.id, 'draft-export', true),
        })).rejects.toMatchObject({ code: 'DESTINATION_OUTSIDE_WORKSPACE' })
        expect(await readdir(sibling)).toEqual([])
        expect(harness.submit).not.toHaveBeenCalled()
      } finally {
        await rm(sibling, { recursive: true, force: true })
      }
    },
  )

  it('blocks a formal delivery before creating a commit or output', async () => {
    const harness = await createHarness({ blocked: true })
    const outputPath = join(harness.root, 'delivery.docx')

    await expect(harness.ctx.paperExports.exportDocument({
      document: harness.document,
      destinationPath: outputPath,
      mode: 'delivery-export',
      actor: agentActor,
    })).rejects.toMatchObject({
      name: 'PaperExportError',
      code: 'DELIVERY_BLOCKED',
      report: { mode: 'delivery-export', status: 'fail' },
    })
    expect(harness.submit).not.toHaveBeenCalled()
    await expect(readFile(outputPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await readdir(harness.root)).some(name => name.includes('.paperai-'))).toBe(false)
  })

  it('preserves complete Agent provenance and supports an unborn document head', async () => {
    const harness = await createHarness({ unborn: true })
    const outputPath = join(harness.root, 'delivery.docx')
    const result = await harness.ctx.paperExports.exportDocument({
      document: harness.document,
      destinationPath: outputPath,
      mode: 'delivery-export',
      actor: agentActor,
    })

    expect(harness.submit).toHaveBeenCalledWith({
      documentId: harness.document.id,
      message: 'Delivery export: delivery.docx',
      actor: agentActor,
      mutations: [{ type: 'milestone', label: 'Delivery export: delivery.docx' }],
    })
    expect(result.commit.actor).toEqual(agentActor)
    expect(await readFile(outputPath)).toEqual(Buffer.from(harness.snapshotBytes))
  })

  it('passes a live cancellation signal through the check and commit', async () => {
    const harness = await createHarness()
    const controller = new AbortController()
    await harness.ctx.paperExports.exportDocument({
      document: harness.document,
      destinationPath: join(harness.root, 'signaled.docx'),
      mode: 'draft-export',
      actor: humanActor,
      signal: controller.signal,
    })
    expect(harness.check).toHaveBeenCalledWith(expect.any(Object), controller.signal)
    expect(harness.submit).toHaveBeenCalledWith(expect.objectContaining({ signal: controller.signal }))
  })

  it('retains the observed document head and provenance while an export is queued', async () => {
    const harness = await createHarness()
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    harness.check.mockImplementationOnce(async ({ mode }) => {
      await held
      return report(harness.document.id, mode)
    })
    const actor = structuredClone(agentActor)
    const document = structuredClone(harness.document)
    const exporting = harness.ctx.paperExports.exportDocument({
      document,
      destinationPath: join(harness.root, 'retained.docx'),
      mode: 'draft-export',
      actor,
    })
    actor.model = 'changed-after-call'
    document.headCommitId = DocumentCommitId('changed-after-call')
    release()
    const result = await exporting
    expect(result.commit.actor.model).toBe(agentActor.model)
    expect(harness.submit).toHaveBeenCalledWith(expect.objectContaining({
      baseCommitId: harness.document.headCommitId,
      actor: agentActor,
    }))
  })

  it('uses commit-service head conflicts without publishing output', async () => {
    const harness = await createHarness({
      submit: async () => {
        const error = new Error('document head changed') as Error & { code: string }
        error.code = 'HEAD_CONFLICT'
        throw error
      },
    })
    const outputPath = join(harness.root, 'conflict.docx')
    await expect(harness.ctx.paperExports.exportDocument({
      document: harness.document,
      destinationPath: outputPath,
      mode: 'draft-export',
      actor: humanActor,
    })).rejects.toMatchObject({ code: 'HEAD_CONFLICT' })
    await expect(readFile(outputPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each([
    ['relative.docx', 'DESTINATION_INVALID'],
    ['absolute.txt', 'DESTINATION_INVALID'],
  ])('rejects invalid destination %s', async (name, code) => {
    const harness = await createHarness()
    const destinationPath = name === 'absolute.txt' ? join(harness.root, name) : name
    await expect(harness.ctx.paperExports.exportDocument({
      document: harness.document,
      destinationPath,
      mode: 'draft-export',
      actor: humanActor,
    })).rejects.toMatchObject({ code })
    expect(harness.submit).not.toHaveBeenCalled()
  })

  it.each(['sourcePath', 'workingPath'] as const)('never overwrites the protected %s', async (property) => {
    const harness = await createHarness()
    await expect(harness.ctx.paperExports.exportDocument({
      document: harness.document,
      destinationPath: harness[property],
      mode: 'draft-export',
      actor: humanActor,
    })).rejects.toMatchObject({ code: 'DESTINATION_PROTECTED' })
    expect(harness.submit).not.toHaveBeenCalled()
  })

  it('rejects an existing hard link to the Working DOCX', async () => {
    const harness = await createHarness()
    const destinationPath = join(harness.root, 'working-link.docx')
    await link(harness.workingPath, destinationPath)
    await expect(harness.ctx.paperExports.exportDocument({
      document: harness.document,
      destinationPath,
      mode: 'draft-export',
      actor: humanActor,
    })).rejects.toMatchObject({ code: 'DESTINATION_PROTECTED' })
    expect(harness.submit).not.toHaveBeenCalled()
  })

  it('propagates non-missing filesystem failures while resolving protected files', async () => {
    const harness = await createHarness()
    const document = { ...harness.document, immutableSourcePath: '\0protected.docx' }
    await expect(harness.ctx.paperExports.exportDocument({
      document,
      destinationPath: join(harness.root, 'filesystem-error.docx'),
      mode: 'draft-export',
      actor: humanActor,
    })).rejects.toThrow()
    expect(harness.submit).not.toHaveBeenCalled()
  })

  it('requires a directory parent and a regular destination', async () => {
    const harness = await createHarness()
    const fileParent = join(harness.root, 'not-a-directory')
    await writeFile(fileParent, 'file')
    await expect(harness.ctx.paperExports.exportDocument({
      document: harness.document,
      destinationPath: join(fileParent, 'output.docx'),
      mode: 'draft-export',
      actor: humanActor,
    })).rejects.toMatchObject({ code: 'DESTINATION_INVALID' })

    const directoryTarget = join(harness.root, 'directory.docx')
    await mkdir(directoryTarget)
    await expect(harness.ctx.paperExports.exportDocument({
      document: harness.document,
      destinationPath: directoryTarget,
      mode: 'draft-export',
      actor: humanActor,
    })).rejects.toMatchObject({ code: 'DESTINATION_INVALID' })
    expect(harness.submit).not.toHaveBeenCalled()
  })

  it('replaces an explicitly selected regular DOCX atomically by default', async () => {
    const harness = await createHarness()
    const outputPath = join(harness.root, 'replace.docx')
    await writeFile(outputPath, 'old output')
    await harness.ctx.paperExports.exportDocument({
      document: harness.document,
      destinationPath: outputPath,
      mode: 'draft-export',
      actor: humanActor,
    })
    expect(await readFile(outputPath)).toEqual(Buffer.from(harness.snapshotBytes))
  })

  it('can reject replacement through configuration', async () => {
    const harness = await createHarness({ config: { overwriteExisting: false } })
    const outputPath = join(harness.root, 'existing.docx')
    await writeFile(outputPath, 'old output')
    await expect(harness.ctx.paperExports.exportDocument({
      document: harness.document,
      destinationPath: outputPath,
      mode: 'draft-export',
      actor: humanActor,
    })).rejects.toMatchObject({ code: 'DESTINATION_EXISTS' })
    expect(harness.submit).not.toHaveBeenCalled()
    expect(await contents(outputPath)).toBe('old output')
  })

  it('bounds snapshot bytes and cleans a failed publication temporary file', async () => {
    const harness = await createHarness({
      config: { maxExportBytes: 3 },
      snapshotBytes: new TextEncoder().encode('four'),
    })
    const outputPath = join(harness.root, 'too-large.docx')
    await expect(harness.ctx.paperExports.exportDocument({
      document: harness.document,
      destinationPath: outputPath,
      mode: 'draft-export',
      actor: humanActor,
    })).rejects.toMatchObject({ code: 'EXPORT_TOO_LARGE' })
    expect(harness.submit).toHaveBeenCalledOnce()
    await expect(readFile(outputPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a non-file snapshot before creating an output', async () => {
    const harness = await createHarness({ snapshotPath: '' })
    const snapshotDirectory = join(harness.root, 'snapshot-directory')
    await mkdir(snapshotDirectory)
    harness.submit.mockResolvedValueOnce({
      id: DocumentCommitId('commit-directory'),
      documentId: harness.document.id,
      ...(harness.document.headCommitId === undefined
        ? {}
        : { parentId: harness.document.headCommitId }),
      message: 'Draft export: bad-snapshot.docx',
      actor: humanActor,
      snapshotPath: snapshotDirectory,
      documentSha256: digest(new Uint8Array()),
      gate: report(harness.document.id, 'continuous'),
      operations: [],
      createdAt: '2026-08-28T00:01:00.000Z',
    })
    await expect(harness.ctx.paperExports.exportDocument({
      document: harness.document,
      destinationPath: join(harness.root, 'bad-snapshot.docx'),
      mode: 'draft-export',
      actor: humanActor,
    })).rejects.toMatchObject({ code: 'SNAPSHOT_CORRUPT' })
  })

  it('verifies snapshot hash and removes the same-directory temporary file', async () => {
    const harness = await createHarness()
    harness.submit.mockResolvedValueOnce({
      id: DocumentCommitId('commit-corrupt'),
      documentId: harness.document.id,
      ...(harness.document.headCommitId === undefined
        ? {}
        : { parentId: harness.document.headCommitId }),
      message: 'Draft export: corrupt.docx',
      actor: humanActor,
      snapshotPath: harness.snapshotPath,
      documentSha256: '0'.repeat(64),
      gate: report(harness.document.id, 'continuous'),
      operations: [],
      createdAt: '2026-08-28T00:01:00.000Z',
    })
    const outputPath = join(harness.root, 'corrupt.docx')
    await expect(harness.ctx.paperExports.exportDocument({
      document: harness.document,
      destinationPath: outputPath,
      mode: 'draft-export',
      actor: humanActor,
    })).rejects.toMatchObject({ code: 'SNAPSHOT_CORRUPT' })
    const names = await readdir(harness.root)
    expect(names).not.toContain('corrupt.docx')
    expect(names.some(name => name.includes('.paperai-'))).toBe(false)
  })

  it('honors cancellation before checking and while queued', async () => {
    const harness = await createHarness()
    const immediate = new AbortController()
    immediate.abort(new Error('cancelled'))
    await expect(harness.ctx.paperExports.exportDocument({
      document: harness.document,
      destinationPath: join(harness.root, 'cancelled.docx'),
      mode: 'draft-export',
      actor: humanActor,
      signal: immediate.signal,
    })).rejects.toThrow('cancelled')
    expect(harness.check).not.toHaveBeenCalled()

    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    harness.check.mockImplementationOnce(async ({ mode }: { mode: GateReport['mode'] }) => {
      await held
      return report(harness.document.id, mode)
    })
    const first = harness.ctx.paperExports.exportDocument({
      document: harness.document,
      destinationPath: join(harness.root, 'queued.docx'),
      mode: 'draft-export',
      actor: humanActor,
    })
    const queued = new AbortController()
    const second = harness.ctx.paperExports.exportDocument({
      document: harness.document,
      destinationPath: join(harness.root, 'queued.docx'),
      mode: 'draft-export',
      actor: humanActor,
      signal: queued.signal,
    })
    queued.abort(new Error('queued cancellation'))
    release()
    await first
    await expect(second).rejects.toThrow('queued cancellation')
  })

  it('rejects invalid size configuration and unregisters the MCP adapter on disposal', async () => {
    await expect(exportHarness({ config: { maxExportBytes: 0 } })).rejects.toThrow(/positive safe integer/)
    await expect(exportHarness({ config: { maxExportBytes: Number.MAX_SAFE_INTEGER + 1 } }))
      .rejects.toThrow(/positive safe integer/)

    const harness = await createHarness()
    expect(typeof harness.adapter()?.exportDocument).toBe('function')
    await harness.ctx.fiber.dispose()
    expect(harness.unregister).toHaveBeenCalledOnce()
    expect(harness.adapter()).toBeUndefined()
    harnesses.splice(harnesses.indexOf(harness), 1)
    await harness.close()
  })

  it('resolves constructor defaults without Schemastery normalization', async () => {
    const ctx = new Context()
    const unregister = () => {}
    ctx.provide('paperTemplates', {} as never)
    ctx.provide('paperCommits', {} as never)
    ctx.provide('paperMcp', { registerExportAdapter: () => unregister } as never)
    const service = new PaperExportService(ctx, {})
    expect(service).toBeInstanceOf(PaperExportService)
    await ctx.fiber.dispose()
  })

  it('returns coded errors with stable names', () => {
    const failure = new PaperExportError('DESTINATION_INVALID', 'bad destination')
    expect(failure).toMatchObject({
      name: 'PaperExportError',
      code: 'DESTINATION_INVALID',
      message: 'bad destination',
      report: undefined,
    })
  })
})
