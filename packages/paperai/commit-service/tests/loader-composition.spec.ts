/** Startup recovery isolation through a Loader composition of the PaperAI rows commit-service depends on. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageSqlite from '@deepseek-ai/dsh-storage-sqlite'
import * as LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import { DocumentEngine } from '@paperai/document-engine'
import type { EngineMutation, EngineTextNode, EngineValidation } from '@paperai/document-engine'
import * as PaperDocumentService from '@paperai/document-service'
import type { CapabilityHealth, DocumentId, DocumentRecord } from '@paperai/domain'
import * as PaperProjectService from '@paperai/project-service'
import * as PaperRepository from '@paperai/repository'
import type { DocumentCommitPublication } from '@paperai/repository'
import * as PaperTemplateService from '@paperai/template-service'
import { afterEach, expect, it } from 'vitest'
import * as PaperCommitService from '../src/index.ts'
import { readFileImage, resolveCommitFilePaths, storeSnapshot } from '../src/files.ts'

const actor = { kind: 'human', name: 'ly' } as const
const TEST_HOST = 'test-paperai-host-services'
const TEST_ENGINE = 'test-paperai-document-engine'

/** OfficeCLI is an external native process; this engine treats each Word file as one plain-text paragraph. */
class TextDocumentEngine extends DocumentEngine {
  override health(): Promise<CapabilityHealth> {
    return Promise.resolve({ status: 'ready' })
  }

  override async readTextNodes(filePath: string): Promise<EngineTextNode[]> {
    return [{ officePath: '/body/p[1]', text: await readFile(filePath, 'utf8'), kind: 'paragraph' }]
  }

  override readParagraphStyles(): Promise<[]> {
    return Promise.resolve([])
  }

  override async previewHtml(filePath: string): Promise<string> {
    return `<p>${await readFile(filePath, 'utf8')}</p>`
  }

  override inspect(): Promise<Record<string, unknown>> {
    return Promise.resolve({})
  }

  override async applyMutations(filePath: string, mutations: readonly EngineMutation[]): Promise<void> {
    for (const mutation of mutations) {
      if (mutation.type !== 'replace-text') throw new Error(`unsupported test mutation '${mutation.type}'`)
      await writeFile(filePath, mutation.text, 'utf8')
    }
  }

  override validate(): Promise<EngineValidation> {
    return Promise.resolve({ success: true, details: {} })
  }
}

const MODULES = new Map<string, unknown>([
  [TEST_HOST, {
    name: TEST_HOST,
    apply(ctx: Context) {
      // Host-owned Session history, read by the workspace registry.
      ctx.provide('sessionPersistence', { list: async () => [] } as never)
    },
  }],
  [TEST_ENGINE, TextDocumentEngine],
  ['@deepseek-ai/dsh-subprocess-local', LocalSubprocessRuntime],
  ['@deepseek-ai/dsh-storage', Storage],
  ['@deepseek-ai/dsh-storage-sqlite', StorageSqlite],
  ['@deepseek-ai/dsh-storage-domain', StorageDomain],
  ['@deepseek-ai/dsh-workspace', WorkspaceRegistry],
  ['@paperai/repository', PaperRepository],
  ['@paperai/project-service', PaperProjectService],
  ['@paperai/document-service', PaperDocumentService],
  ['@paperai/template-service', PaperTemplateService],
  ['@paperai/commit-service', PaperCommitService],
])

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  root = undefined
})

/**
 * Boot, in shipped `cordis.patch.yml` order, only the PaperAI rows commit-service depends on from a test-only
 * `cordis.yml`. `paperai-template-pack-hit` and every row after commit-service are omitted, and storage-domain
 * sends every domain to SQLite instead of the shipped `backend: json` with a `paperai: sqlite` route.
 */
async function boot(directory: string): Promise<Context> {
  const configPath = join(directory, 'cordis.yml')
  await writeFile(configPath, [
    `- name: ${TEST_HOST}`,
    "- name: '@deepseek-ai/dsh-subprocess-local'",
    "- name: '@deepseek-ai/dsh-storage'",
    "- name: '@deepseek-ai/dsh-storage-sqlite'",
    `  config: { path: ${JSON.stringify(join(directory, 'paperai.sqlite'))}, journalMode: wal }`,
    "- name: '@deepseek-ai/dsh-storage-domain'",
    '  config: { backend: sqlite, routes: {} }',
    "- name: '@deepseek-ai/dsh-workspace'",
    "- name: '@paperai/repository'",
    `- name: ${TEST_ENGINE}`,
    "- name: '@paperai/project-service'",
    "- name: '@paperai/document-service'",
    "- name: '@paperai/template-service'",
    `  config: { storageRoot: ${JSON.stringify(join(directory, 'templates'))} }`,
    "- name: '@paperai/commit-service'",
    '',
  ].join('\n'))
  const ctx = context = new Context()
  ctx.baseUrl = pathToFileURL(directory).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      const plugin = MODULES.get(specifier)
      if (plugin === undefined) throw new Error(`unexpected Loader import: ${specifier}`)
      return plugin
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

async function importText(ctx: Context, directory: string, projectId: DocumentRecord['projectId'], name: string, text: string): Promise<DocumentRecord> {
  const sourcePath = join(directory, `${name}.docx`)
  await writeFile(sourcePath, text, 'utf8')
  const result = await ctx.paperDocuments.importDocument({ projectId, sourcePath, role: 'manuscript' })
  if (result.status !== 'imported') throw new Error(result.detail)
  return result.document
}

function editText(ctx: Context, documentId: DocumentId, baseText: string, nextText: string) {
  const [node] = ctx.paperRepository.listNodes(documentId)
  const head = ctx.paperRepository.getDocument(documentId)?.headCommitId
  return ctx.paperCommits.submit({
    documentId, actor, message: nextText, ...(head === undefined ? {} : { baseCommitId: head }),
    mutations: [{ type: 'replace-text', nodeId: node!.id, baseText, nextText }],
  })
}

it('boots with a journal that cannot recover and keeps unrelated documents writable', async () => {
  root = await mkdtemp(join(tmpdir(), 'paperai-commit-loader-'))
  const directory = root
  const first = await boot(directory)
  const { project } = await first.paperProjects.create({ rootPath: join(directory, 'project'), name: 'Recovery isolation' })
  const blocked = await importText(first, directory, project.id, 'blocked', 'alpha')
  const healthy = await importText(first, directory, project.id, 'healthy', 'bravo')

  // Rebuild the journal a crash would leave between the committed head and its bookkeeping.
  const before = structuredClone(first.paperRepository.getDocument(blocked.id)!)
  const beforeNodes = structuredClone(first.paperRepository.listNodes(blocked.id))
  const paths = resolveCommitFilePaths(project.rootPath, blocked.workingPath)
  const working = await readFileImage(blocked.workingPath, 'RECOVERY_FAILED', 'Working DOCX')
  const workingSnapshot = await storeSnapshot(paths, working.bytes, working.sha256)
  const commit = await editText(first, blocked.id, 'alpha', 'alpha revised')
  const publication: DocumentCommitPublication = {
    version: 1,
    documentId: blocked.id,
    commit,
    before: {
      document: before,
      nodes: beforeNodes,
      working: { snapshotPath: workingSnapshot, sha256: working.sha256, mode: working.mode },
    },
    after: {
      document: structuredClone(first.paperRepository.getDocument(blocked.id)!),
      nodes: structuredClone(first.paperRepository.listNodes(blocked.id)),
    },
    createdAt: commit.createdAt,
  }
  await first.paperRepository.putCommitPublication(publication)
  // Word saved over the file before the Host came back, so neither side of the journal matches.
  await writeFile(blocked.workingPath, 'external Word edit', 'utf8')
  await first.fiber.dispose()

  const ctx = await boot(directory)
  expect(ctx.paperRepository.getCommitPublication(blocked.id)).toEqual(publication)
  await expect(editText(ctx, blocked.id, 'alpha revised', 'blocked edit')).rejects.toMatchObject({ code: 'RECOVERY_FAILED' })
  await expect(ctx.paperDocuments.rebuildIndex(blocked.id)).rejects.toMatchObject({ code: 'PUBLICATION_PENDING' })
  expect(await readFile(blocked.workingPath, 'utf8')).toBe('external Word edit')

  const next = await editText(ctx, healthy.id, 'bravo', 'bravo revised')
  expect(ctx.paperCommits.listHistory(healthy.id).map(entry => entry.id)).toEqual([next.id])
  expect(await readFile(healthy.workingPath, 'utf8')).toBe('bravo revised')
  expect(ctx.paperRepository.listNodes(healthy.id).map(node => node.text)).toEqual(['bravo revised'])
})
