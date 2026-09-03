import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DocumentId,
  ProjectId,
  TemplateContractId,
  TemplateRuleId,
} from '@paperai/domain'
import type { DocumentRecord, TemplateContract, TemplateRule } from '@paperai/domain'
import {
  CHARTER_BLOCK_END,
  CHARTER_BLOCK_START_PREFIX,
  PAPERAI_AGENTS_FILE,
  PAPERAI_CLAUDE_FILE,
  PAPERAI_CLAUDE_TEMPLATE,
  composeAgentsContent,
  composeClaudeContent,
  renderWritingCharter,
} from '../src/index.ts'
import { projectHarness } from './helpers.ts'

const temporaryRoots: string[] = []

async function temporaryRoot(label: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `paperai-charter-${label}-`))
  temporaryRoots.push(path)
  return path
}

afterEach(async () => {
  for (const path of temporaryRoots.splice(0)) {
    if (!path.startsWith(tmpdir())) throw new Error(`refusing to clean non-temporary path '${path}'`)
    await rm(path, { recursive: true, force: true })
  }
})

function documentRecord(overrides: Partial<DocumentRecord> = {}): DocumentRecord {
  return {
    id: DocumentId('document-1'),
    projectId: ProjectId('project-1'),
    name: '硕士论文',
    role: 'manuscript',
    immutableSourcePath: 'documents/source/thesis.docx',
    workingPath: 'documents/working/thesis.docx',
    mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    sourceSha256: '0'.repeat(64),
    nodeCount: 3,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  }
}

function templateRule(label: string, severity: TemplateRule['severity'], enabled = true): TemplateRule {
  return {
    id: TemplateRuleId(`rule-${label}`),
    kind: 'font',
    label,
    description: label,
    severity,
    evidence: [],
    confidence: 1,
    enabled,
  }
}

function templateContract(rules: TemplateRule[]): TemplateContract {
  return {
    id: TemplateContractId('contract-1'),
    projectId: ProjectId('project-1'),
    name: 'HIT 硕士模板',
    sourceDocumentId: DocumentId('template-source-1'),
    version: 1,
    rules,
    slots: [],
    fixedNodeIds: [],
    instructionNodeIds: [],
    pageSetup: {},
    styleMap: {},
    origin: { kind: 'built-in', label: 'HIT 硕士模板包', originalFileName: 'hit.docx', packId: 'hit' },
    appliesToRoles: ['manuscript'],
    usage: 'format-reference',
    status: 'confirmed',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  }
}

describe('renderWritingCharter', () => {
  it('renders workflow, red lines, and one line per working document', () => {
    const attached = documentRecord({ templateId: TemplateContractId('contract-1') })
    const free = documentRecord({ id: DocumentId('document-2'), name: '开题报告', role: 'proposal' })
    const evidence = documentRecord({ id: DocumentId('document-3'), documentKind: 'template-source' })
    const contract = templateContract([
      templateRule('正文宋体', 'error'),
      templateRule('段后间距', 'warning'),
      templateRule('禁用规则', 'info', false),
    ])
    const charter = renderWritingCharter([attached, free, evidence], () => contract)

    expect(charter).toContain('# PaperAI 论文写作规程')
    expect(charter).toContain('paperai_commit_document')
    expect(charter).toContain('《硕士论文》（角色 manuscript）已关联模板《HIT 硕士模板》')
    expect(charter).toContain('门禁规则 2 条（error 1 / warning 1 / info 0）')
    expect(charter).toContain('正文宋体；段后间距')
    expect(charter).toContain('《开题报告》（角色 proposal）未关联模板：自由写作模式')
    expect(charter).not.toContain('document-3')
  })

  it('summarizes an all-disabled contract and lists an empty project explicitly', () => {
    const attached = documentRecord({ templateId: TemplateContractId('contract-1') })
    const contract = templateContract([templateRule('禁用规则', 'error', false)])
    expect(renderWritingCharter([attached], () => contract)).toContain('契约未包含启用规则')
    expect(renderWritingCharter([], () => undefined)).toContain('项目尚无 Working 文档')
  })

  it('fails loud when a document references a missing template contract', () => {
    const attached = documentRecord({ templateId: TemplateContractId('contract-missing') })
    expect(() => renderWritingCharter([attached], () => undefined))
      .toThrow(/references missing template contract 'contract-missing'/)
  })
})

describe('composeAgentsContent', () => {
  it('creates a fresh block, appends after user content, and replaces an existing block', () => {
    const fresh = composeAgentsContent(undefined, 'BODY')
    expect(fresh.startsWith(CHARTER_BLOCK_START_PREFIX)).toBe(true)
    expect(fresh.endsWith(`${CHARTER_BLOCK_END}\n`)).toBe(true)
    expect(composeAgentsContent('', 'BODY')).toBe(fresh)

    const appended = composeAgentsContent('# 我的项目说明\n\n手写内容。\n', 'BODY')
    expect(appended.startsWith('# 我的项目说明\n\n手写内容。\n\n')).toBe(true)
    expect(appended).toContain('BODY')

    const replaced = composeAgentsContent(`前言\n\n${fresh}尾注\n`, 'NEXT')
    expect(replaced.startsWith('前言\n\n')).toBe(true)
    expect(replaced.endsWith('尾注\n')).toBe(true)
    expect(replaced).toContain('NEXT')
    expect(replaced).not.toContain('BODY')
  })

  it('rejects a half-present or reversed marker pair', () => {
    expect(() => composeAgentsContent(`${CHARTER_BLOCK_START_PREFIX} -->\n`, 'BODY')).toThrow(/broken/)
    expect(() => composeAgentsContent(`${CHARTER_BLOCK_END}\n`, 'BODY')).toThrow(/broken/)
    expect(() => composeAgentsContent(`${CHARTER_BLOCK_END}\n${CHARTER_BLOCK_START_PREFIX} -->\n`, 'BODY'))
      .toThrow(/broken/)
  })
})

describe('PaperProjectService writing charter', () => {
  it('creates AGENTS.md and CLAUDE.md on first init and leaves them stable on re-adoption', async () => {
    const root = await temporaryRoot('create')
    const harness = await projectHarness()
    const { service } = await harness.load()

    const first = await service.create({ rootPath: root })
    expect(first.charter).toEqual({ agents: 'created', claude: 'created' })
    expect(await readFile(join(root, PAPERAI_CLAUDE_FILE), 'utf8')).toBe(PAPERAI_CLAUDE_TEMPLATE)
    const agents = await readFile(join(root, PAPERAI_AGENTS_FILE), 'utf8')
    expect(agents).toContain('# PaperAI 论文写作规程')
    expect(agents).toContain('项目尚无 Working 文档')

    const second = await service.create({ rootPath: root })
    expect(second.charter).toEqual({ agents: 'unchanged', claude: 'preserved' })
    expect(await readFile(join(root, PAPERAI_AGENTS_FILE), 'utf8')).toBe(agents)
  })

  it('preserves user-owned AGENTS.md content and routes an existing CLAUDE.md to the charter', async () => {
    const root = await temporaryRoot('preserve')
    await writeFile(join(root, PAPERAI_AGENTS_FILE), '# 我的规则\n\n先读文献。\n')
    await writeFile(join(root, PAPERAI_CLAUDE_FILE), '自定义 Claude 指令\n')
    const harness = await projectHarness()
    const { service } = await harness.load()

    const result = await service.create({ rootPath: root })
    expect(result.charter).toEqual({ agents: 'updated', claude: 'updated' })
    const agents = await readFile(join(root, PAPERAI_AGENTS_FILE), 'utf8')
    expect(agents.startsWith('# 我的规则\n\n先读文献。\n\n')).toBe(true)
    expect(agents).toContain(CHARTER_BLOCK_END)
    // User content stays byte-for-byte; only the import line is appended, once.
    expect(await readFile(join(root, PAPERAI_CLAUDE_FILE), 'utf8')).toBe('自定义 Claude 指令\n\n@AGENTS.md\n')
    const again = await service.create({ rootPath: root })
    expect(again.charter).toEqual({ agents: 'unchanged', claude: 'preserved' })
    expect(await readFile(join(root, PAPERAI_CLAUDE_FILE), 'utf8')).toBe('自定义 Claude 指令\n\n@AGENTS.md\n')
  })

  it('recognizes an existing charter import in CLAUDE.md in either spelling', () => {
    expect(composeClaudeContent('# Rules\n\n@AGENTS.md\n')).toBe('# Rules\n\n@AGENTS.md\n')
    expect(composeClaudeContent('  @./AGENTS.md  \n# more\n')).toBe('  @./AGENTS.md  \n# more\n')
    expect(composeClaudeContent('see @AGENTS.md for rules\n')).toBe('see @AGENTS.md for rules\n\n@AGENTS.md\n')
    expect(composeClaudeContent('')).toBe(PAPERAI_CLAUDE_TEMPLATE)
    expect(composeClaudeContent('   \n')).toBe(PAPERAI_CLAUDE_TEMPLATE)
  })

  it('re-renders the template section from a durable documents change', async () => {
    const root = await temporaryRoot('event')
    const harness = await projectHarness()
    const { service } = await harness.load()
    const { project } = await service.create({ rootPath: root })

    const contract = templateContract([templateRule('正文宋体', 'error')])
    const attached = documentRecord({ projectId: project.id, templateId: contract.id })
    harness.documents.push(attached)
    harness.templates.push(contract)
    harness.ctx.emit('domain/changed', {
      domain: 'paperai',
      table: 'documents',
      key: String(attached.id),
      operation: 'put',
      value: attached,
    } as never)
    await vi.waitFor(async () => {
      expect(await readFile(join(root, PAPERAI_AGENTS_FILE), 'utf8')).toContain('《HIT 硕士模板》')
    })

    harness.documents.splice(0)
    harness.ctx.emit('domain/changed', {
      domain: 'paperai',
      table: 'documents',
      key: String(attached.id),
      operation: 'deleted',
    } as never)
    await vi.waitFor(async () => {
      expect(await readFile(join(root, PAPERAI_AGENTS_FILE), 'utf8')).toContain('项目尚无 Working 文档')
    })
  })

  it('ignores unrelated changes and fails loud on an invalid documents put', async () => {
    const root = await temporaryRoot('invalid')
    const harness = await projectHarness()
    const { service } = await harness.load()
    await service.create({ rootPath: root })

    expect(() => {
      harness.ctx.emit('domain/changed', {
        domain: 'other', table: 'documents', key: 'x', operation: 'put', value: {},
      } as never)
      harness.ctx.emit('domain/changed', {
        domain: 'paperai', table: 'nodes', key: 'x', operation: 'put', value: {},
      } as never)
    }).not.toThrow()
    expect(() => {
      harness.ctx.emit('domain/changed', {
        domain: 'paperai', table: 'documents', key: 'x', operation: 'put', value: null,
      } as never)
    }).toThrow(/has no record object/)
    expect(() => {
      harness.ctx.emit('domain/changed', {
        domain: 'paperai', table: 'documents', key: 'x', operation: 'put', value: {},
      } as never)
    }).toThrow(/names no project/)
    expect(() => {
      harness.ctx.emit('domain/changed', {
        domain: 'paperai', table: 'documents', key: 'x', operation: 'put',
        value: documentRecord({ projectId: ProjectId('project-unknown') }),
      } as never)
    }).toThrow(/references missing project 'project-unknown'/)
  })

  it('reports an event-driven sync failure instead of unhandled rejection', async () => {
    const root = await temporaryRoot('warn')
    const harness = await projectHarness()
    const warn = vi.spyOn(harness.ctx.logger, 'warn')
    const { service } = await harness.load()
    const { project } = await service.create({ rootPath: root })

    await writeFile(join(root, PAPERAI_AGENTS_FILE), `${CHARTER_BLOCK_END}\n`)
    harness.ctx.emit('domain/changed', {
      domain: 'paperai',
      table: 'documents',
      key: 'document-1',
      operation: 'put',
      value: documentRecord({ projectId: project.id }),
    } as never)
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('writing-charter sync failed'))
    })
  })

  it('restores charter files when project publication fails', async () => {
    const fresh = await temporaryRoot('rollback-fresh')
    const failing = await projectHarness({ failPut: new Error('publish failed') })
    const { service } = await failing.load()
    await expect(service.create({ rootPath: fresh })).rejects.toThrow('publish failed')
    await expect(stat(join(fresh, PAPERAI_AGENTS_FILE))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(join(fresh, PAPERAI_CLAUDE_FILE))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(failing.projects).toEqual([])

    const owned = await temporaryRoot('rollback-owned')
    await writeFile(join(owned, PAPERAI_AGENTS_FILE), '# 我的规则\n')
    await writeFile(join(owned, PAPERAI_CLAUDE_FILE), '自定义\n')
    const { service: second } = await (await projectHarness({ failPut: new Error('publish failed') })).load()
    await expect(second.create({ rootPath: owned })).rejects.toThrow('publish failed')
    expect(await readFile(join(owned, PAPERAI_AGENTS_FILE), 'utf8')).toBe('# 我的规则\n')
    expect(await readFile(join(owned, PAPERAI_CLAUDE_FILE), 'utf8')).toBe('自定义\n')
  })

  it('puts AGENTS.md back when the CLAUDE.md phase fails, before the caller can roll back', async () => {
    // A directory named CLAUDE.md makes the second phase fail after the first published.
    const fresh = await temporaryRoot('claude-dir-fresh')
    await mkdir(join(fresh, PAPERAI_CLAUDE_FILE))
    const { service } = await (await projectHarness()).load()
    await expect(service.create({ rootPath: fresh })).rejects.toThrow(/EISDIR/)
    await expect(stat(join(fresh, PAPERAI_AGENTS_FILE))).rejects.toMatchObject({ code: 'ENOENT' })

    const owned = await temporaryRoot('claude-dir-owned')
    await writeFile(join(owned, PAPERAI_AGENTS_FILE), '# 我的规则\n')
    await mkdir(join(owned, PAPERAI_CLAUDE_FILE))
    const { service: second } = await (await projectHarness()).load()
    await expect(second.create({ rootPath: owned })).rejects.toThrow(/EISDIR/)
    expect(await readFile(join(owned, PAPERAI_AGENTS_FILE), 'utf8')).toBe('# 我的规则\n')
  })

  it('publishes charter files atomically without leaving temporary files behind', async () => {
    const root = await temporaryRoot('atomic')
    const harness = await projectHarness()
    const { service } = await harness.load()
    await service.create({ rootPath: root })
    await service.create({ rootPath: root })
    expect((await readdir(root)).filter(name => name.includes('.tmp'))).toEqual([])
  })

  it('fails project creation loudly when AGENTS.md is unreadable', async () => {
    const root = await temporaryRoot('unreadable')
    await mkdir(join(root, PAPERAI_AGENTS_FILE))
    const harness = await projectHarness()
    const { service } = await harness.load()
    const failure = await service.create({ rootPath: root }).then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect(String((failure as NodeJS.ErrnoException).code)).toMatch(/EISDIR|EACCES|EPERM|ENOENT/)
  })
})
