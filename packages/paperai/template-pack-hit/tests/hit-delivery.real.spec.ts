/**
 * HIT pack composition through the Loader, and opt-in delivery through the native OfficeCLI and persisted PaperAI services.
 *
 * The first case boots the PaperAI rows of the shipped `cordis.patch.yml`, in order, from a test-only `cordis.yml`
 * through the Loader, and checks that the pack registers. The opt-in case compiles the shipped thesis example and
 * exports independent research to the project's `exports/` directory through that composition. Run it with
 * `DSH_PAPERAI_OFFICECLI_REAL=1` and, for an external OfficeCLI 1.0.145 binary, `DSH_PAPERAI_OFFICECLI_COMMAND`.
 * Without the opt-in, the keyless browser snapshot `apps/web/tests/snapshots/paperai-workbench/hit-delivery.expected.md`
 * pins the same outcome in the assembled app.
 */
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageSqlite from '@deepseek-ai/dsh-storage-sqlite'
import * as LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import * as PaperCommitService from '@paperai/commit-service'
import * as OfficeCliDocumentEngine from '@paperai/document-engine-officecli'
import * as PaperDocumentService from '@paperai/document-service'
import * as PaperExportService from '@paperai/export-service'
import * as PaperProjectService from '@paperai/project-service'
import * as PaperRepository from '@paperai/repository'
import * as PaperTemplateService from '@paperai/template-service'
import { DOMParser, XMLSerializer, onWarningStopParsing } from '@xmldom/xmldom'
import { afterEach, expect, it } from 'vitest'
import * as HitTemplatePack from '../src/index.ts'

const { HIT_TEMPLATE_PACK } = HitTemplatePack
const WORD = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const actor = { kind: 'human', name: 'HIT author' } as const
const TEST_HOST = 'test-paperai-host-services'
const MODULES = new Map<string, unknown>([
  [TEST_HOST, {
    name: TEST_HOST,
    apply(ctx: Context) {
      // Host-owned services outside this composition: Session history and the MCP route.
      ctx.provide('sessionPersistence', { list: async () => [] } as never)
      ctx.provide('paperMcp', { registerExportAdapter: () => () => {} } as never)
    },
  }],
  ['@deepseek-ai/dsh-subprocess-local', LocalSubprocessRuntime],
  ['@deepseek-ai/dsh-storage', Storage],
  ['@deepseek-ai/dsh-storage-sqlite', StorageSqlite],
  ['@deepseek-ai/dsh-storage-domain', StorageDomain],
  ['@deepseek-ai/dsh-workspace', WorkspaceRegistry],
  ['@paperai/repository', PaperRepository],
  ['@paperai/document-engine-officecli', OfficeCliDocumentEngine],
  ['@paperai/project-service', PaperProjectService],
  ['@paperai/document-service', PaperDocumentService],
  ['@paperai/template-service', PaperTemplateService],
  ['@paperai/template-pack-hit', HitTemplatePack],
  ['@paperai/commit-service', PaperCommitService],
  ['@paperai/export-service', PaperExportService],
])

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  root = undefined
})

/** Boot the PaperAI rows of the shipped `cordis.patch.yml`, in its order, from a test-only `cordis.yml`. */
async function boot(directory: string, command: string | undefined): Promise<Context> {
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
    "- name: '@paperai/document-engine-officecli'",
    `  config: { timeoutMs: 30000${command === undefined ? '' : `, command: ${JSON.stringify(command)}`} }`,
    "- name: '@paperai/project-service'",
    "- name: '@paperai/document-service'",
    "- name: '@paperai/template-service'",
    `  config: { storageRoot: ${JSON.stringify(join(directory, 'templates'))} }`,
    "- name: '@paperai/template-pack-hit'",
    "- name: '@paperai/commit-service'",
    "- name: '@paperai/export-service'",
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

it('registers the HIT pack through a Loader composition of the shipped PaperAI rows', async () => {
  root = await mkdtemp(join(tmpdir(), 'paperai-hit-loader-'))
  const ctx = await boot(root, undefined)

  expect(ctx.paperTemplates.listPacks().filter(pack => pack.id === HIT_TEMPLATE_PACK.id)).toMatchObject([{
    kind: 'built-in',
    version: 'provided-snapshot-2026-08-28-format-rules-v2',
    members: [{ id: 'proposal' }, { id: 'midterm' }, { id: 'thesis-format', usage: 'format-reference' }],
  }])
})

it.skipIf(process.env.DSH_PAPERAI_OFFICECLI_REAL !== '1')('exports independent research under the real HIT format and rejects a missing required section', async () => {
  root = await mkdtemp(join(tmpdir(), 'paperai-hit-delivery-'))
  const directory = root
  const source = join(directory, 'independent-research.docx')
  const command = process.env.DSH_PAPERAI_OFFICECLI_COMMAND
  const require = createRequire(import.meta.url)
  const engineRequire = createRequire(require.resolve('@paperai/document-engine-officecli/package.json'))
  const argv = command === undefined
    ? [process.execPath, join(dirname(dirname(engineRequire.resolve('@officecli/officecli'))), 'officecli.js')]
    : [command]
  const ctx = await boot(directory, command)
  async function native(args: string[]): Promise<Record<string, unknown>> {
    const process = ctx.subprocess.spawn({
      argv: [...argv, ...args, '--json'], cwd: directory,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 8_000_000 }, stderr: { maxBytes: 1_000_000 } },
      env: { OFFICECLI_SKIP_UPDATE: '1', OFFICECLI_RESIDENT_FLUSH: 'each' },
      graceMs: 1_000, signal: AbortSignal.timeout(30_000),
    })
    expect(await process.done, process.collected.stderr?.readFrom(0).text).toMatchObject({ exitCode: 0 })
    const output = process.collected.stdout?.readFrom(0)
    expect(output?.lossy).toBe(false)
    const result = JSON.parse(output?.text ?? '') as Record<string, unknown>
    expect(result.success).toBe(true)
    return result
  }

  expect(await ctx.documentEngine.health()).toMatchObject({ status: 'ready', version: '1.0.145' })
  const { project } = await ctx.paperProjects.create({ rootPath: join(directory, 'project'), name: 'Independent research' })
  const projectId = project.id
  const exportPath = (name: string) => join(project.rootPath, 'exports', name)
  const member = HIT_TEMPLATE_PACK.members.find(candidate => candidate.usage === 'format-reference')!
  const [draft] = await ctx.paperTemplates.installPack({ projectId, packId: HIT_TEMPLATE_PACK.id, memberIds: [member.id] })
  expect(draft).toBeDefined()
  const contract = await ctx.paperTemplates.confirm(draft!.id)
  expect(contract.fixedNodeIds).toEqual([])
  expect(contract.rules.map(rule => rule.kind)).toMatchInlineSnapshot(`
    [
      "required-section",
      "required-section",
      "required-section",
      "required-section",
      "required-section",
      "page-setup",
    ]
  `)
  expect(contract.rules.filter(rule => rule.kind === 'required-section').map(rule => rule.expected)).toEqual([
    { text: '摘  要' }, { text: 'Abstract' }, { text: '目  录' }, { text: '结  论' }, { text: '参考文献' },
  ])

  // Retain the supplied styles and page setup while replacing its entire research body.
  await copyFile(member.normalized.path, source)
  const raw = await native(['raw', source, '/document'])
  const xml = new DOMParser({ onError: onWarningStopParsing }).parseFromString(raw.data as string, 'application/xml')
  const body = xml.getElementsByTagNameNS(WORD, 'body')[0]!
  for (const child of Array.from(body.childNodes)) {
    if (child.nodeType === child.ELEMENT_NODE && 'localName' in child && child.localName === 'sectPr') continue
    body.removeChild(child)
  }
  const text = ['面向论文写作的交互系统', '摘  要', '本文研究文档协作。', 'Abstract', 'This thesis studies document collaboration.',
    '目  录', '第1章 文档协作研究', '用户通过版本对照保持文稿完整。', '结  论', '系统支持协同写作。', '参考文献', '［1］独立研究文献。']
  for (const content of text) {
    const paragraph = xml.createElementNS(WORD, 'w:p')
    const run = xml.createElementNS(WORD, 'w:r')
    const leaf = xml.createElementNS(WORD, 'w:t')
    leaf.textContent = content
    run.appendChild(leaf)
    paragraph.appendChild(run)
    body.insertBefore(paragraph, body.lastChild)
  }
  const input = join(directory, 'independent-body.json')
  await writeFile(input, JSON.stringify([{ command: 'raw-set', part: '/word/document.xml', xpath: '/w:document/w:body',
    action: 'replace', xml: new XMLSerializer().serializeToString(body) }]))
  await native(['batch', source, '--input', input])
  await native(['save', source])
  await native(['close', source])
  const imported = await ctx.paperDocuments.importDocument({ projectId, sourcePath: source, role: 'manuscript' })
  if (imported.status !== 'imported') throw new Error(imported.detail)
  await ctx.paperCommits.submit({ documentId: imported.document.id, actor, message: 'Apply HIT format',
    mutations: [{ type: 'bind-template', templateId: contract.id }] })
  const document = ctx.paperRepository.getDocument(imported.document.id)!
  const result = await ctx.paperExports.exportDocument({ document, actor, destinationPath: exportPath('delivery.docx'), mode: 'delivery-export' })
  expect({ status: result.report.status, codes: result.report.findings.map(finding => finding.code), operation: result.commit.operations[0]?.type }).toMatchInlineSnapshot(`
    {
      "codes": [],
      "operation": "milestone",
      "status": "pass",
    }
  `)
  expect((await readFile(result.outputPath)).equals(await readFile(result.commit.snapshotPath))).toBe(true)
  const delivered = (await ctx.documentEngine.readTextNodes(result.outputPath)).map(node => node.text)
  expect(delivered).toContain('第1章 文档协作研究')
  expect(delivered.join('\n')).not.toMatch(/FLUENT|谌颖|楷体|多孔质/u)
  await ctx.documentEngine.release(result.outputPath)

  const conclusion = ctx.paperRepository.listNodes(document.id).find(node => node.text === '结  论')!
  await ctx.paperCommits.submit({ documentId: document.id, baseCommitId: result.commit.id, actor, message: 'Remove conclusion',
    mutations: [{ type: 'delete-node', nodeId: conclusion.id, baseText: conclusion.text }] })
  await expect(ctx.paperExports.exportDocument({ document: ctx.paperRepository.getDocument(document.id)!, actor,
    destinationPath: exportPath('incomplete.docx'), mode: 'delivery-export' })).rejects.toMatchObject({ code: 'DELIVERY_BLOCKED' })
  await expect(readFile(exportPath('incomplete.docx'))).rejects.toMatchObject({ code: 'ENOENT' })
}, 120_000)
