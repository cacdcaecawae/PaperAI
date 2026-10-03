/** Custom-format replacements through the Loader, SQLite, commits, and workbench entry points. */
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
import { DocumentId, TemplateContractId, type CapabilityHealth } from '@paperai/domain'
import * as PaperProjectService from '@paperai/project-service'
import * as PaperRepository from '@paperai/repository'
import * as PaperTemplateService from '@paperai/template-service'
import { afterEach, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import * as PaperWorkbenchService from '../src/index.ts'
import * as PaperExportService from '@paperai/export-service'
import * as PaperCommitService from '@paperai/commit-service'

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
      ctx.provide('paperMcp', { registerExportAdapter: () => () => {} } as never)
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
  ['@paperai/export-service', PaperExportService],
  ['@paperai/workbench-service', PaperWorkbenchService],
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
 * Boot the workbench’s document/template rows (DSH infrastructure and PaperAI services) from a test-only
 * `cordis.yml`. `paperai-template-pack-hit` and Agent providers are omitted, and storage-domain
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
    "- name: '@paperai/export-service'",
    "- name: '@paperai/workbench-service'",
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

it('uses replacement usage for new documents and keeps old bindings until reapplied', async () => {
  root = await mkdtemp(join(tmpdir(), 'paperai-template-loader-'))
  const ctx = await boot(root)
  const { project } = await ctx.paperProjects.create({ rootPath: join(root, 'project'), name: 'Custom format replacement' })
  const workspaceId = WorkspaceId(project.workspaceId)
  const sessionId = SessionId('template-test-session')
  const pack = await ctx.paperTemplates.createLibraryPack({ name: 'Custom formats' })
  const upload = { fileName: 'proposal.docx', bytes: Buffer.from('Template body') }
  await ctx.paperTemplates.addLibraryFormat({ packId: pack.id, role: 'proposal', usage: 'form-template', upload })
  await ctx.paperaiWorkbench.setProjectTemplate({ workspaceId, packId: pack.id })
  const first = await ctx.paperaiWorkbench.createFromTemplate({ workspaceId, sessionId, documentType: 'proposal' })
  if (first.status !== 'imported') throw new Error('first document did not import')
  const before = ctx.paperRepository.getDocument(DocumentId(String(first.opened.document.documentId)))!
  const oldTemplateId = before.templateId!
  const oldContract = ctx.paperTemplates.getContract(oldTemplateId)!

  await ctx.paperTemplates.addLibraryFormat({ packId: pack.id, role: 'proposal', usage: 'format-reference', upload })
  await expect(ctx.paperaiWorkbench.createFromTemplate({ workspaceId, sessionId, documentType: 'proposal' }))
    .rejects.toThrow('upload the manuscript')
  const second = await ctx.paperaiWorkbench.createFromTemplate({
    workspaceId, sessionId, documentType: 'proposal',
    upload: { fileName: 'manuscript.docx', contentBase64: Buffer.from('Independent manuscript').toString('base64') },
  })
  if (second.status !== 'imported') throw new Error('second document did not import')
  const newer = ctx.paperRepository.getDocument(DocumentId(String(second.opened.document.documentId)))!
  expect(await readFile(newer.workingPath, 'utf8')).toBe('Independent manuscript')
  expect(newer.templateId).not.toBe(oldTemplateId)
  expect(ctx.paperRepository.getDocument(before.id)?.templateId).toBe(oldTemplateId)

  const applied = await ctx.paperaiWorkbench.applyTemplate({
    documentId: first.opened.document.documentId,
    baseRevision: first.opened.document.revision,
    baseCommitId: first.opened.document.headCommitId,
    sessionId, documentType: 'proposal',
  })
  expect(ctx.paperRepository.getDocument(before.id)?.templateId).toBe(newer.templateId)
  expect(ctx.paperTemplates.getContract(oldTemplateId)).toEqual(oldContract)
  expect(await readFile(before.workingPath, 'utf8')).toBe('Template body')
  expect({
    originalUsage: oldContract.usage,
    replacementUsage: ctx.paperTemplates.getContract(TemplateContractId(String(newer.templateId)))?.usage,
    originalText: await readFile(before.workingPath, 'utf8'),
    newText: await readFile(newer.workingPath, 'utf8'),
    reapplicationCreatedVersion: applied.document.headCommitId !== first.opened.document.headCommitId,
    originalHistoryUsage: ctx.paperTemplates.getContract(oldTemplateId)?.usage,
  }).toMatchInlineSnapshot(`
    {
      "newText": "Independent manuscript",
      "originalHistoryUsage": "form-template",
      "originalText": "Template body",
      "originalUsage": "form-template",
      "reapplicationCreatedVersion": true,
      "replacementUsage": "format-reference",
    }
  `)
})
