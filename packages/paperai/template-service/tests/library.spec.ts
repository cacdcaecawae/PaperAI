import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TemplateLibrary } from '../src/library.ts'
import type { StoredTemplateAssets } from '../src/storage.ts'

/** Asset-store double: retains bytes under the root like the real content-addressed store. */
function fakeAssets(root: string) {
  const importUpload = vi.fn(async (sourcePath: string): Promise<StoredTemplateAssets> => {
    const bytes = await readFile(sourcePath)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    await mkdir(join(root, 'sources'), { recursive: true })
    await mkdir(join(root, 'normalized'), { recursive: true })
    const immutableSourcePath = join(root, 'sources', `${sha256}.docx`)
    const normalizedPath = join(root, 'normalized', `${sha256}.docx`)
    await writeFile(immutableSourcePath, bytes)
    await writeFile(normalizedPath, bytes)
    return {
      immutableSourcePath,
      normalizedPath,
      originalFileName: sourcePath.split(/[\\/]/u).pop() ?? sourcePath,
      sourceSha256: sha256,
      normalizedSha256: sha256,
    }
  })
  return { importUpload }
}

describe('TemplateLibrary', () => {
  let root: string
  const warn = vi.fn()

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'paperai-template-library-'))
  })

  afterEach(async () => {
    vi.clearAllMocks()
    await rm(root, { recursive: true, force: true })
  })

  it('creates sets, adds one format per document type, and persists across instances', async () => {
    const assets = fakeAssets(root)
    const library = new TemplateLibrary(root, assets, { warn })
    expect(library.list()).toEqual([])
    expect(library.manifests()).toEqual([])

    const created = await library.createPack({ name: '我们学院 2026 版', description: '学院自定' })
    expect(created).toMatchObject({ name: '我们学院 2026 版', description: '学院自定', formats: [] })
    expect(created.id).toMatch(/^custom-[a-f0-9]{8}$/u)
    // An empty set is listed but not installable.
    expect(library.list()).toHaveLength(1)
    expect(library.manifest(created.id)).toBeUndefined()
    await expect(library.createPack({ name: ' 我们学院 2026 版 ' })).rejects.toThrow('already exists')
    await expect(library.createPack({ name: '  ' })).rejects.toThrow('must not be empty')

    const filled = await library.addFormat({
      packId: created.id,
      role: 'proposal',
      usage: 'form-template',
      upload: { fileName: '开题模板.docx', bytes: Buffer.from('proposal-v1') },
    })
    expect(filled.formats).toEqual([expect.objectContaining({
      id: 'proposal', name: '开题模板', usage: 'form-template', originalFileName: '开题模板.docx',
    })])
    expect(filled.formats[0]?.source.path).toBe(`sources/${filled.formats[0]?.source.sha256}.docx`)
    expect(filled.formats[0]?.source.size).toBe(Buffer.byteLength('proposal-v1'))
    // Staging is gone once the asset store retained the bytes; only its empty parent remains.
    expect(await readdir(join(root, 'library', 'uploads'))).toEqual([])

    const manifest = library.manifest(created.id)
    expect(manifest).toMatchObject({
      id: created.id, name: '我们学院 2026 版', version: 'custom', sourceLabel: '用户添加',
      members: [expect.objectContaining({ id: 'proposal', appliesToRoles: ['proposal'], usage: 'form-template' })],
    })
    expect(manifest?.members[0]?.source.path).toBe(join(root, 'sources', `${filled.formats[0]?.source.sha256}.docx`))

    // Replacing the format for a type keeps one entry per type.
    const replaced = await library.addFormat({
      packId: created.id,
      role: 'proposal',
      usage: 'format-reference',
      name: '开题范例',
      upload: { fileName: '开题范例.docx', bytes: Buffer.from('proposal-v2') },
    })
    expect(replaced.formats.map(format => [format.id, format.name, format.usage])).toEqual([
      ['proposal', '开题范例', 'format-reference'],
    ])

    const reopened = new TemplateLibrary(root, assets, { warn })
    expect(reopened.list()).toEqual(library.list())
    expect(reopened.manifests().map(pack => pack.id)).toEqual([created.id])

    const emptied = await reopened.removeFormat(created.id, 'proposal')
    expect(emptied.formats).toEqual([])
    await expect(reopened.removeFormat(created.id, 'proposal')).rejects.toThrow('has no format')
    await reopened.deletePack(created.id)
    expect(reopened.list()).toEqual([])
    await expect(reopened.deletePack(created.id)).rejects.toThrow('unknown template set')
    expect(warn).not.toHaveBeenCalled()
  })

  it('rejects invalid uploads and identities before touching the asset store', async () => {
    const assets = fakeAssets(root)
    const library = new TemplateLibrary(root, assets, { warn })
    const pack = await library.createPack({ name: '校验' })
    const upload = { fileName: 'ok.docx', bytes: Buffer.from('x') }
    await expect(library.addFormat({ packId: 'custom-missing', role: 'proposal', usage: 'form-template', upload }))
      .rejects.toThrow('unknown template set')
    await expect(library.addFormat({ packId: pack.id, role: 'poem' as never, usage: 'form-template', upload }))
      .rejects.toThrow('unknown document type')
    await expect(library.addFormat({ packId: pack.id, role: 'proposal', usage: 'poster' as never, upload }))
      .rejects.toThrow('unknown template usage')
    await expect(library.addFormat({
      packId: pack.id, role: 'proposal', usage: 'form-template', upload: { fileName: '../x.docx', bytes: Buffer.from('x') },
    })).rejects.toThrow('safe .doc or .docx')
    await expect(library.addFormat({
      packId: pack.id, role: 'proposal', usage: 'form-template', upload: { fileName: 'notes.txt', bytes: Buffer.from('x') },
    })).rejects.toThrow('safe .doc or .docx')
    await expect(library.addFormat({
      packId: pack.id, role: 'proposal', usage: 'form-template', upload: { fileName: 'empty.docx', bytes: new Uint8Array() },
    })).rejects.toThrow('must not be empty')
    expect(assets.importUpload).not.toHaveBeenCalled()
  })

  it('keeps an unreadable manifest aside and starts empty instead of overwriting it', async () => {
    await mkdir(join(root, 'library'), { recursive: true })
    await writeFile(join(root, 'library', 'library.json'), '{"version":1,"packs":[{"id":"bad"}]}')
    const library = new TemplateLibrary(root, fakeAssets(root), { warn })
    expect(library.list()).toEqual([])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unreadable'))

    await library.createPack({ name: '恢复后' })
    const entries = await readdir(join(root, 'library'))
    expect(entries).toContain('library.json')
    expect(entries.some(entry => entry.startsWith('library.json.unreadable-'))).toBe(true)
    const persisted = JSON.parse(await readFile(join(root, 'library', 'library.json'), 'utf8')) as { packs: unknown[] }
    expect(persisted.packs).toHaveLength(1)
  })
})
