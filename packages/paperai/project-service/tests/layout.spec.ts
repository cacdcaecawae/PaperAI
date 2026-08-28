import { access, mkdir, mkdtemp, readFile, rmdir, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PAPERAI_CONTEXT_FILE,
  PAPERAI_CONTEXT_TEMPLATE,
  prepareProjectLayout,
} from '../src/layout.ts'

const roots: string[] = []

afterEach(async () => {
  for (const path of roots.splice(0)) {
    if (!path.startsWith(tmpdir())) throw new Error(`refusing to clean non-temporary path '${path}'`)
    await import('node:fs/promises').then(fs => fs.rm(path, { recursive: true, force: true }))
  }
})

describe('project filesystem preparation', () => {
  it('creates missing parent directories and rolls back the unchanged result idempotently', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'paperai-layout-'))
    roots.push(parent)
    const root = join(parent, 'missing', 'nested')

    const prepared = await prepareProjectLayout(root)
    expect(await readFile(join(root, PAPERAI_CONTEXT_FILE), 'utf8')).toBe(PAPERAI_CONTEXT_TEMPLATE)

    await prepared.rollback()
    await prepared.rollback()
    await expect(access(join(parent, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps a context file changed after preparation and leaves its non-empty directories', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'paperai-layout-changed-'))
    roots.push(parent)
    const root = join(parent, 'project')
    const prepared = await prepareProjectLayout(root)
    await writeFile(join(root, PAPERAI_CONTEXT_FILE), 'user changed this')

    await prepared.rollback()

    expect(await readFile(join(root, PAPERAI_CONTEXT_FILE), 'utf8')).toBe('user changed this')
    expect((await stat(root)).isDirectory()).toBe(true)
  })

  it('does not remove a replaced context path or a created directory replaced by a file', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'paperai-layout-replaced-'))
    roots.push(parent)
    const root = join(parent, 'project')
    const prepared = await prepareProjectLayout(root)
    const contextPath = join(root, PAPERAI_CONTEXT_FILE)
    const dataPath = join(root, 'experiments', 'data')
    await unlink(contextPath)
    await mkdir(contextPath)
    await rmdir(dataPath)
    await writeFile(dataPath, 'replacement')

    await prepared.rollback()

    expect((await stat(contextPath)).isDirectory()).toBe(true)
    expect(await readFile(dataPath, 'utf8')).toBe('replacement')
  })

  it('rejects a blank path, invalid project root, and non-file context path without replacing them', async () => {
    await expect(prepareProjectLayout('   ')).rejects.toThrow('must not be blank')
    await expect(prepareProjectLayout(parse(process.cwd()).root)).rejects.toThrow('must not be a filesystem root')
    const parent = await mkdtemp(join(tmpdir(), 'paperai-layout-file-'))
    roots.push(parent)
    const file = join(parent, 'paper.txt')
    await writeFile(file, 'not a directory')

    await expect(prepareProjectLayout(file)).rejects.toThrow('is not a directory')

    const contextRoot = join(parent, 'context-directory')
    const contextPath = join(contextRoot, PAPERAI_CONTEXT_FILE)
    await mkdir(contextPath, { recursive: true })
    await expect(prepareProjectLayout(contextRoot)).rejects.toThrow('is not a regular file')
    expect((await stat(contextPath)).isDirectory()).toBe(true)
    await expect(access(join(contextRoot, 'documents'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
