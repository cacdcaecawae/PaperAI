import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle, SubprocessOutputRead, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  deliveryBlocked,
  DocumentId,
  ProjectId,
  TemplateContractId,
} from '@paperai/domain'
import type {
  ChangeConflict,
  DocumentCommit,
  DocumentNode,
  DocumentRecord,
  ProjectRecord,
  TemplateContract,
} from '@paperai/domain'
import {
  PaperTemplateService,
  TemplatePackId,
  TemplatePackMemberId,
} from '../src/index.ts'
import type { TemplatePackManifest } from '../src/index.ts'

interface EngineDataset {
  text: Array<{ officePath: string; text: string; kind: 'paragraph' | 'table' | 'unknown' }>
  children: Array<Record<string, unknown>>
}

class MemoryRepository {
  readonly projects = new Map<string, ProjectRecord>()
  readonly documents = new Map<string, DocumentRecord>()
  readonly nodes = new Map<string, DocumentNode>()
  readonly templates = new Map<string, TemplateContract>()

  getProject(id: ProjectRecord['id']): ProjectRecord | undefined { return this.projects.get(id) }
  listProjects(): ProjectRecord[] { return [...this.projects.values()] }
  putProject(record: ProjectRecord): Promise<void> { this.projects.set(record.id, record); return Promise.resolve() }
  getDocument(id: DocumentRecord['id']): DocumentRecord | undefined { return this.documents.get(id) }
  listDocuments(projectId?: ProjectRecord['id']): DocumentRecord[] {
    return [...this.documents.values()].filter(record => projectId === undefined || record.projectId === projectId)
  }
  putDocument(record: DocumentRecord): Promise<void> { this.documents.set(record.id, record); return Promise.resolve() }
  updateDocument(id: DocumentRecord['id'], update: (record: DocumentRecord) => DocumentRecord): Promise<DocumentRecord> {
    const current = this.documents.get(id)
    if (current === undefined) throw new Error('missing document')
    const next = update(current)
    this.documents.set(id, next)
    return Promise.resolve(next)
  }
  listNodes(documentId: DocumentRecord['id']): DocumentNode[] {
    return [...this.nodes.values()].filter(node => node.documentId === documentId)
  }
  putNode(record: DocumentNode): Promise<void> { this.nodes.set(record.id, record); return Promise.resolve() }
  deleteNode(id: DocumentNode['id']): Promise<boolean> { return Promise.resolve(this.nodes.delete(id)) }
  getCommit(): DocumentCommit | undefined { return undefined }
  listCommits(): DocumentCommit[] { return [] }
  putCommit(_record: DocumentCommit): Promise<void> { return Promise.resolve() }
  getTemplate(id: TemplateContract['id']): TemplateContract | undefined { return this.templates.get(id) }
  listTemplates(projectId?: ProjectRecord['id']): TemplateContract[] {
    return [...this.templates.values()].filter(record => projectId === undefined || record.projectId === projectId)
  }
  putTemplate(record: TemplateContract): Promise<void> { this.templates.set(record.id, record); return Promise.resolve() }
  listConflicts(): ChangeConflict[] { return [] }
  putConflict(_record: ChangeConflict): Promise<void> { return Promise.resolve() }
}

const bodyFormat = {
  styleName: 'Normal',
  'effective.font.eastAsia': '宋体',
  'effective.font.ascii': 'Times New Roman',
  'effective.size': '12pt',
  spaceBeforeLines: 0,
  spaceAfterLines: 0,
}

const headingFormat = {
  styleName: 'heading 1',
  'effective.font.eastAsia': '黑体',
  'effective.font.ascii': 'Times New Roman',
  'effective.size': '15pt',
  spaceBeforeLines: 0.5,
  spaceAfterLines: 0.5,
}

function node(path: string, text: string, format = bodyFormat): Record<string, unknown> {
  return {
    path,
    type: 'paragraph',
    text,
    style: format.styleName,
    format,
  }
}

const sourceDataset: EngineDataset = {
  text: [
    { officePath: '/body/p[1]', text: '哈尔滨工业大学', kind: 'paragraph' },
    { officePath: '/body/p[2]', text: '硕士学位论文开题报告', kind: 'paragraph' },
    { officePath: '/body/p[3]', text: '题 目：                         ', kind: 'paragraph' },
    { officePath: '/body/p[4]', text: '一、开题报告应包括下列主要内容', kind: 'paragraph' },
    { officePath: '/body/p[5]', text: '1．研究意义（不少于3字）', kind: 'paragraph' },
    { officePath: '/body/p[6]', text: '报告中所用中文字体为宋体，各级标题用黑体；数字、英文为新罗马字体。', kind: 'paragraph' },
    { officePath: '/body/p[7]', text: '节标题 小3号字，建议段前0.5行，段后0.5行；', kind: 'paragraph' },
    { officePath: '/body/p[8]', text: '正文 小4号字，建议段前0行，段后0行。', kind: 'paragraph' },
    { officePath: '/body/p[9]', text: '报告不要设置页眉。', kind: 'paragraph' },
  ],
  children: [
    node('/body/p[1]', '哈尔滨工业大学', headingFormat),
    node('/body/p[2]', '硕士学位论文开题报告', headingFormat),
    node('/body/p[3]', '题 目：                         '),
    node('/body/p[4]', '一、开题报告应包括下列主要内容'),
    node('/body/p[5]', '1．研究意义（不少于3字）', headingFormat),
    node('/body/p[6]', '报告中所用中文字体为宋体，各级标题用黑体；数字、英文为新罗马字体。'),
    node('/body/p[7]', '节标题 小3号字，建议段前0.5行，段后0.5行；'),
    node('/body/p[8]', '正文 小4号字，建议段前0行，段后0行。'),
    node('/body/p[9]', '报告不要设置页眉。'),
    {
      path: '/body/sectPr[1]',
      type: 'section',
      format: { pageWidth: '21cm', pageHeight: '29.7cm', marginTop: '3cm', marginBottom: '3cm' },
    },
  ],
}

const validTarget: EngineDataset = {
  text: [
    { officePath: '/body/p[1]', text: '哈尔滨工业大学', kind: 'paragraph' },
    { officePath: '/body/p[2]', text: '硕士学位论文开题报告', kind: 'paragraph' },
    { officePath: '/body/p[3]', text: '题目：面向论文的智能体工作台', kind: 'paragraph' },
    { officePath: '/body/p[5]', text: '1．研究意义', kind: 'paragraph' },
    { officePath: '/body/p[10]', text: '研究内容充分完整', kind: 'paragraph' },
  ],
  children: [
    node('/body/p[1]', '哈尔滨工业大学', headingFormat),
    node('/body/p[2]', '硕士学位论文开题报告', headingFormat),
    node('/body/p[3]', '题目：面向论文的智能体工作台'),
    node('/body/p[5]', '1．研究意义', headingFormat),
    node('/body/p[10]', '研究内容充分完整'),
    {
      path: '/body/sectPr[1]',
      type: 'section',
      format: { pageWidth: '21cm', pageHeight: '29.7cm', marginTop: '3cm', marginBottom: '3cm' },
    },
  ],
}

const invalidTarget: EngineDataset = {
  text: [
    { officePath: '/body/p[3]', text: '题目：', kind: 'paragraph' },
    { officePath: '/body/p[10]', text: '短', kind: 'paragraph' },
  ],
  children: [
    node('/body/p[3]', '题目：', { ...bodyFormat, 'effective.font.eastAsia': '微软雅黑' }),
    node('/body/p[10]', '短', { ...bodyFormat, 'effective.font.eastAsia': '微软雅黑' }),
    {
      path: '/body/sectPr[1]',
      type: 'section',
      format: { pageWidth: '20cm', pageHeight: '29.7cm', marginTop: '2cm', marginBottom: '3cm', headerRef: '/header[1]' },
    },
  ],
}

function output(text: string): SubprocessOutputRead {
  return { text, nextOffset: Buffer.byteLength(text), lossy: false }
}

function processHandle(): SubprocessHandle {
  return {
    pid: 1,
    stdin: undefined,
    stdout: undefined,
    stderr: undefined,
    collected: {
      stdout: { readFrom: () => output('') },
      stderr: { readFrom: () => output('') },
    },
    done: Promise.resolve({ exitCode: 0, signal: null }),
    terminate: () => {},
    waitForExit: () => Promise.resolve(true),
  }
}

describe('PaperTemplateService', () => {
  let ctx: Context
  let root: string
  let repository: MemoryRepository
  let selectedTarget: EngineDataset
  let service: PaperTemplateService
  const applyMutations = vi.fn()
  const readTextNodes = vi.fn(async (path: string) => path.endsWith('target.docx') ? selectedTarget.text : sourceDataset.text)
  const inspect = vi.fn(async (path: string) => ({
    results: [{ type: 'body', children: path.endsWith('target.docx') ? selectedTarget.children : sourceDataset.children }],
  }))

  beforeEach(async () => {
    ctx = new Context()
    root = await mkdtemp(join(tmpdir(), 'paperai-template-service-'))
    repository = new MemoryRepository()
    selectedTarget = validTarget
    repository.projects.set('project-1', {
      id: ProjectId('project-1'),
      workspaceId: 'workspace-1',
      name: '论文项目',
      rootPath: root,
      createdAt: '2026-08-28T00:00:00.000Z',
      updatedAt: '2026-08-28T00:00:00.000Z',
    })
    ctx.provide('paperRepository', repository as never)
    ctx.provide('documentEngine', {
      readTextNodes,
      inspect,
      validate: vi.fn(async () => ({ success: true, details: {} })),
      applyMutations,
      previewHtml: vi.fn(),
      health: vi.fn(),
    } as never)
    ctx.provide('subprocess', {
      resolveExecutable: vi.fn(async (command: string) => command),
      spawn: vi.fn((spec: SubprocessSpawnSpec) => {
        const outputPath = spec.argv.at(-1)
        if (outputPath !== undefined) requireWrite(outputPath, Buffer.from('normalized-docx'))
        return processHandle()
      }),
    } as never)
    service = new PaperTemplateService(ctx, {
      storageRoot: join(root, 'templates'),
      maxUploadBytes: 32 * 1024 * 1024,
      converterTimeoutMs: 10_000,
      converterOutputMaxBytes: 100_000,
      converterTerminateGraceMs: 1_000,
      wordComPowerShellCommand: 'powershell.exe',
    })
  })

  afterEach(async () => {
    vi.clearAllMocks()
    await ctx.fiber.dispose()
  })

  it('registers, lists, installs, and reuses one verified pack member', async () => {
    const sourcePath = join(root, 'source.doc')
    const normalizedPath = join(root, 'normalized.docx')
    await writeFile(sourcePath, 'source-doc')
    await writeFile(normalizedPath, 'normalized-docx')
    const manifest = packManifest(sourcePath, normalizedPath, 'form-template', ['proposal'])
    const dispose = service.registerPack(manifest)
    const member = manifest.members[0]
    if (member === undefined) throw new Error('fixture pack has no member')
    const anotherManifest: TemplatePackManifest = {
      ...manifest,
      id: TemplatePackId('another-pack'),
      name: 'Another Fixture Pack',
      members: [{ ...member, id: TemplatePackMemberId('another-member') }],
    }
    const disposeAnother = service.registerPack(anotherManifest)

    expect(service.listPacks()).toEqual([
      expect.objectContaining({ id: TemplatePackId('another-pack') }),
      expect.objectContaining({
        id: TemplatePackId('fixture-pack'),
        members: [expect.objectContaining({ originalFileName: 'fixture.doc' })],
      }),
    ])
    const selection = [TemplatePackMemberId('fixture-member')]
    const first = await service.installPack({ projectId: ProjectId('project-1'), packId: manifest.id, memberIds: selection })
    const second = await service.installPack({ projectId: ProjectId('project-1'), packId: manifest.id, memberIds: selection })

    expect(second).toEqual(first)
    expect(first[0]).toMatchObject({ status: 'draft', origin: { kind: 'built-in', packId: 'fixture-pack' } })
    expect(readTextNodes).toHaveBeenCalledTimes(1)
    expect(repository.templates.size).toBe(1)
    dispose()
    dispose()
    expect(service.listPacks()).toEqual([expect.objectContaining({ id: anotherManifest.id })])
    disposeAnother()
    expect(service.listPacks()).toEqual([])
  })

  it('uploads immutable DOCX and legacy DOC sources as reviewable drafts', async () => {
    const docxPath = join(root, 'custom.docx')
    await writeFile(docxPath, 'first-version')
    const upload = {
      projectId: ProjectId('project-1'),
      name: '自定义开题模板',
      sourcePath: docxPath,
      appliesToRoles: ['proposal'] as const,
      usage: 'form-template' as const,
    }
    const [draft, duplicate] = await Promise.all([
      service.upload(upload),
      service.upload(upload),
    ])
    const source = repository.documents.get(draft.sourceDocumentId)

    expect(draft.status).toBe('draft')
    expect(duplicate).toEqual(draft)
    await writeFile(docxPath, 'changed-after-upload')
    expect(service.getContract(draft.id)).toEqual(draft)
    expect(service.listContracts(ProjectId('project-1'))).toContainEqual(draft)
    expect(draft.slots).toEqual([expect.objectContaining({ key: 'title', required: true })])
    expect(draft.rules.map(rule => rule.kind)).toEqual(expect.arrayContaining([
      'fixed-text', 'required-field', 'font', 'font-size', 'paragraph-spacing', 'page-setup',
    ]))
    await expect(readFile(source?.immutableSourcePath ?? '')).resolves.toEqual(Buffer.from('first-version'))
    expect((await stat(source?.immutableSourcePath ?? '')).isFile()).toBe(true)

    const legacyPath = join(root, 'legacy.doc')
    await writeFile(legacyPath, 'legacy-source')
    const legacy = await service.upload({
      projectId: ProjectId('project-1'),
      name: '旧版 Word 模板',
      sourcePath: legacyPath,
      appliesToRoles: ['midterm'],
      usage: 'form-template',
    })
    expect(repository.documents.get(legacy.sourceDocumentId)?.immutableSourcePath).toMatch(/\.doc$/u)
    expect(repository.documents.get(legacy.sourceDocumentId)?.workingPath).toMatch(/\.docx$/u)
    expect(repository.documents.get(legacy.sourceDocumentId)?.documentKind).toBe('template-source')
  })

  it('validates confirmation and matching roles without bypassing the commit owner', async () => {
    const sourcePath = join(root, 'source.doc')
    const normalizedPath = join(root, 'normalized.docx')
    await writeFile(sourcePath, 'source-doc')
    await writeFile(normalizedPath, 'normalized-docx')
    const manifest = packManifest(sourcePath, normalizedPath, 'format-reference', ['manuscript'])
    service.registerPack(manifest)
    const [draft] = await service.installPack({ projectId: ProjectId('project-1'), packId: manifest.id })
    if (draft === undefined) throw new Error('fixture did not install')
    const manuscript = targetDocument('manuscript-1', 'manuscript')
    const proposal = targetDocument('proposal-1', 'proposal')
    repository.documents.set(manuscript.id, manuscript)
    repository.documents.set(proposal.id, proposal)

    expect(() => service.validateAssociation({ documentId: manuscript.id, templateId: draft.id }))
      .toThrow('must be confirmed')
    const [confirmed, repeatedConfirmation] = await Promise.all([
      service.confirm(draft.id),
      service.confirm(draft.id),
    ])
    expect(repeatedConfirmation).toEqual(confirmed)
    expect(() => service.validateAssociation({ documentId: proposal.id, templateId: confirmed.id }))
      .toThrow('does not apply')
    expect(service.validateAssociation({ documentId: manuscript.id, templateId: confirmed.id })).toEqual(manuscript)
    expect(repository.documents.get(manuscript.id)?.templateId).toBeUndefined()
    expect(applyMutations).not.toHaveBeenCalled()
  })

  it('allows draft export reports but blocks formal delivery on confirmation, fields, fixed text, and styles', async () => {
    const unattached = targetDocument('unattached-target', 'proposal')
    repository.documents.set(unattached.id, unattached)
    await expect(service.check({ documentId: unattached.id, mode: 'delivery-export' })).resolves.toMatchObject({
      status: 'fail',
      findings: [expect.objectContaining({ code: 'template_missing' })],
    })

    const uploadPath = join(root, 'gate.docx')
    await writeFile(uploadPath, 'gate-template')
    const draft = await service.upload({
      projectId: ProjectId('project-1'),
      name: '交付模板',
      sourcePath: uploadPath,
      appliesToRoles: ['proposal'],
      usage: 'form-template',
    })
    const target = { ...targetDocument('target-1', 'proposal'), templateId: draft.id }
    repository.documents.set(target.id, target)

    const draftReport = await service.check({ documentId: target.id, mode: 'draft-export' })
    expect(draftReport.findings).toContainEqual(expect.objectContaining({ code: 'template_unconfirmed' }))
    expect(deliveryBlocked(draftReport)).toBe(false)

    await service.confirm(draft.id)
    const valid = await service.check({ documentId: target.id, mode: 'delivery-export' })
    expect(valid.status).toBe('pass')
    expect(deliveryBlocked(valid)).toBe(false)

    const candidatePath = join(root, 'candidate-target.docx')
    await writeFile(candidatePath, 'candidate')
    const candidate = await service.checkCandidate({
      document: target,
      candidatePath,
      templateId: draft.id,
      mode: 'continuous',
    })
    expect(candidate.status).toBe('pass')
    expect(repository.documents.get(target.id)?.workingPath).toBe(target.workingPath)

    selectedTarget = invalidTarget
    const invalid = await service.check({ documentId: target.id, mode: 'delivery-export' })
    expect(invalid.findings.map(item => item.code)).toEqual(expect.arrayContaining([
      'fixed_text_missing',
      'required_field_empty',
      'required_section_missing',
      'font_mismatch',
      'page_setup_mismatch',
    ]))
    expect(deliveryBlocked(invalid)).toBe(true)
  })

  it('rejects invalid installation selections and role inputs before publishing contracts', async () => {
    const sourcePath = join(root, 'source.doc')
    const normalizedPath = join(root, 'normalized.docx')
    await writeFile(sourcePath, 'source-doc')
    await writeFile(normalizedPath, 'normalized-docx')
    const manifest = packManifest(sourcePath, normalizedPath, 'form-template', ['proposal'])
    service.registerPack(manifest)
    expect(() => service.registerPack(manifest)).toThrow('already registered')
    await expect(service.installPack({
      projectId: ProjectId('project-1'),
      packId: TemplatePackId('missing-pack'),
    })).rejects.toThrow('unknown template pack')
    await expect(service.installPack({
      projectId: ProjectId('project-1'),
      packId: manifest.id,
      memberIds: [],
    })).rejects.toThrow('must not be empty')
    await expect(service.installPack({
      projectId: ProjectId('project-1'),
      packId: manifest.id,
      memberIds: [TemplatePackMemberId('fixture-member'), TemplatePackMemberId('fixture-member')],
    })).rejects.toThrow('contains duplicates')
    await expect(service.installPack({
      projectId: ProjectId('project-1'),
      packId: manifest.id,
      memberIds: [TemplatePackMemberId('missing-member')],
    })).rejects.toThrow('unknown template member')
    await expect(service.upload({
      projectId: ProjectId('project-1'),
      name: '无角色',
      sourcePath: normalizedPath,
      appliesToRoles: [],
      usage: 'form-template',
    })).rejects.toThrow('appliesToRoles')
    await expect(service.upload({
      projectId: ProjectId('project-1'),
      name: '重复角色',
      sourcePath: normalizedPath,
      appliesToRoles: ['proposal', 'proposal'],
      usage: 'form-template',
    })).rejects.toThrow('contains duplicates')
    await expect(service.upload({
      projectId: ProjectId('missing-project'),
      name: '不存在项目',
      sourcePath: normalizedPath,
      appliesToRoles: ['proposal'],
      usage: 'form-template',
    })).rejects.toThrow('project not found')
    await expect(service.confirm(TemplateContractId('missing-template'))).rejects.toThrow('template not found')
    expect(() => service.validateAssociation({
      documentId: DocumentId('missing-document'),
      templateId: TemplateContractId('missing-template'),
    })).toThrow('template not found')
    await expect(service.check({ documentId: DocumentId('missing-document'), mode: 'continuous' })).rejects.toThrow('document not found')
    expect(repository.templates.size).toBe(0)
  })

  it('rejects invalid pack metadata and deployment limits at their owning boundary', () => {
    const source = {
      path: join(root, 'source.doc'),
      originalFileName: 'source.doc',
      sha256: '0'.repeat(64),
      size: 1,
    }
    const normalized = { path: join(root, 'source.docx'), sha256: '0'.repeat(64), size: 1 }
    const base = {
      id: TemplatePackId('valid-pack'),
      name: 'Valid',
      description: 'Valid',
      version: '1',
      sourceLabel: 'Valid',
      members: [{
        id: TemplatePackMemberId('member'),
        name: 'Member',
        description: 'Member',
        appliesToRoles: ['proposal'] as const,
        usage: 'form-template' as const,
        sourceVersion: '1',
        source,
        normalized,
      }],
    }
    expect(() => service.registerPack({ ...base, id: TemplatePackId('INVALID') })).toThrow('invalid template pack id')
    expect(() => service.registerPack({ ...base, name: ' ' })).toThrow('name must not be empty')
    expect(() => service.registerPack({ ...base, members: [] })).toThrow('has no members')
    expect(() => service.registerPack({
      ...base,
      members: [{ ...base.members[0]!, id: TemplatePackMemberId('INVALID') }],
    })).toThrow('invalid template member id')
    expect(() => service.registerPack({
      ...base,
      members: [base.members[0]!, base.members[0]!],
    })).toThrow('duplicate template member id')
    expect(() => service.registerPack({
      ...base,
      members: [{ ...base.members[0]!, name: ' ' }],
    })).toThrow('name must not be empty')
    expect(() => service.registerPack({
      ...base,
      members: [{ ...base.members[0]!, appliesToRoles: [] }],
    })).toThrow('appliesToRoles')

    const construct = (config: ConstructorParameters<typeof PaperTemplateService>[1]) => {
      const isolated = new Context()
      isolated.provide('paperRepository', repository as never)
      isolated.provide('documentEngine', {} as never)
      isolated.provide('subprocess', {} as never)
      return new PaperTemplateService(isolated, config)
    }
    expect(() => construct({ storageRoot: join(root, 'invalid'), maxUploadBytes: 0 })).toThrow('maxUploadBytes')
    expect(() => construct({ storageRoot: join(root, 'invalid'), converterTimeoutMs: 1.5 })).toThrow('converterTimeoutMs')
    expect(() => construct({ storageRoot: ' ' })).toThrow('storageRoot must not be empty')
    expect(() => construct({ storageRoot: join(root, 'defaults') })).not.toThrow()
  })
})

function targetDocument(id: string, role: DocumentRecord['role']): DocumentRecord {
  return {
    id: DocumentId(id),
    projectId: ProjectId('project-1'),
    name: id,
    role,
    immutableSourcePath: join(tmpdir(), `${id}-source.docx`),
    workingPath: join(tmpdir(), 'target.docx'),
    mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    sourceSha256: '0'.repeat(64),
    nodeCount: 0,
    createdAt: '2026-08-28T00:00:00.000Z',
    updatedAt: '2026-08-28T00:00:00.000Z',
  }
}

function packManifest(
  sourcePath: string,
  normalizedPath: string,
  usage: TemplateContract['usage'],
  roles: TemplateContract['appliesToRoles'],
): TemplatePackManifest {
  const source = Buffer.from('source-doc')
  const normalized = Buffer.from('normalized-docx')
  return {
    id: TemplatePackId('fixture-pack'),
    name: 'Fixture Pack',
    description: 'Fixture templates',
    version: '1.0.0',
    sourceLabel: 'Test fixture',
    members: [{
      id: TemplatePackMemberId('fixture-member'),
      name: 'Fixture Template',
      description: 'Fixture member',
      appliesToRoles: roles,
      usage,
      sourceVersion: 'fixture-1',
      source: {
        path: sourcePath,
        originalFileName: 'fixture.doc',
        sha256: sha256(source),
        size: source.byteLength,
      },
      normalized: {
        path: normalizedPath,
        sha256: sha256(normalized),
        size: normalized.byteLength,
      },
    }],
  }
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function requireWrite(path: string, bytes: Buffer): void {
  writeFileSync(path, bytes)
}
