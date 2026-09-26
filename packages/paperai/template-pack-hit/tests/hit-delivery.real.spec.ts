/** Opt-in HIT compilation and delivery through the native OfficeCLI and persisted PaperAI services. */
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageSqlite from '@deepseek-ai/dsh-storage-sqlite'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import PaperCommitService from '@paperai/commit-service'
import { OfficeCliDocumentEngine } from '@paperai/document-engine-officecli'
import PaperDocumentService from '@paperai/document-service'
import { ProjectId } from '@paperai/domain'
import PaperExportService from '@paperai/export-service'
import PaperRepository from '@paperai/repository'
import PaperTemplateService from '@paperai/template-service'
import { DOMParser, XMLSerializer, onWarningStopParsing } from '@xmldom/xmldom'
import { expect, it } from 'vitest'
import { HIT_TEMPLATE_PACK } from '../src/index.ts'

const WORD = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const actor = { kind: 'human', name: 'HIT author' } as const

it.skipIf(process.env.DSH_PAPERAI_OFFICECLI_REAL !== '1')('exports independent research under the real HIT format and rejects a missing required section', async () => {
  const root = await mkdtemp(join(tmpdir(), 'paperai-hit-delivery-'))
  const ctx = new Context()
  const source = join(root, 'independent-research.docx')
  const command = process.env.DSH_PAPERAI_OFFICECLI_COMMAND
  const require = createRequire(import.meta.url)
  const engineRequire = createRequire(require.resolve('@paperai/document-engine-officecli/package.json'))
  const argv = command === undefined
    ? [process.execPath, join(dirname(dirname(engineRequire.resolve('@officecli/officecli'))), 'officecli.js')]
    : [command]
  async function native(args: string[]): Promise<Record<string, unknown>> {
    const process = ctx.subprocess.spawn({
      argv: [...argv, ...args, '--json'], cwd: root,
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
  try {
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(OfficeCliDocumentEngine, { ...(command === undefined ? {} : { command }), timeoutMs: 30_000 })
    expect(await ctx.documentEngine.health()).toMatchObject({ status: 'ready', version: '1.0.145' })
    await ctx.plugin(Storage)
    await ctx.plugin(StorageSqlite, { path: join(root, 'paperai.sqlite'), journalMode: 'wal' })
    await ctx.plugin(StorageDomain, { backend: 'sqlite', routes: {} })
    await ctx.plugin(PaperRepository)
    await ctx.plugin(PaperDocumentService)
    await ctx.plugin(PaperTemplateService, { storageRoot: join(root, 'templates') })
    await ctx.plugin(PaperCommitService)
    ctx.provide('paperMcp', { registerExportAdapter: () => () => {} } as never)
    await ctx.plugin(PaperExportService)
    const projectId = ProjectId('hit-delivery')
    await ctx.paperRepository.putProject({
      id: projectId, name: 'Independent research', workspaceId: 'hit-workspace', rootPath: root,
      createdAt: '2026-09-26T00:00:00.000Z', updatedAt: '2026-09-26T00:00:00.000Z',
    })
    ctx.paperTemplates.registerPack(HIT_TEMPLATE_PACK)
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
    const input = join(root, 'independent-body.json')
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
    const result = await ctx.paperExports.exportDocument({ document, actor, destinationPath: join(root, 'delivery.docx'), mode: 'delivery-export' })
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
      destinationPath: join(root, 'incomplete.docx'), mode: 'delivery-export' })).rejects.toMatchObject({ code: 'DELIVERY_BLOCKED' })
    await expect(readFile(join(root, 'incomplete.docx'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}, 120_000)
