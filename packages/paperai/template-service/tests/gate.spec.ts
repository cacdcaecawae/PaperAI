import { describe, expect, it, vi } from 'vitest'
import {
  DocumentId,
  ProjectId,
  TemplateContractId,
  TemplateRuleId,
} from '@paperai/domain'
import type {
  DocumentRecord,
  TemplateContract,
  TemplateRule,
  TemplateRuleKind,
} from '@paperai/domain'
import { checkTemplateContract } from '../src/gate.ts'

function rejectWireValue(reason: unknown): Promise<never> {
  return new Promise((_resolve, reject) => {
    Reflect.apply(reject, undefined, [reason])
  })
}

const document: DocumentRecord = {
  id: DocumentId('document-1'),
  projectId: ProjectId('project-1'),
  name: '论文',
  role: 'proposal',
  immutableSourcePath: 'source.docx',
  workingPath: 'working.docx',
  mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  sourceSha256: '0'.repeat(64),
  nodeCount: 0,
  createdAt: '2026-08-28T00:00:00.000Z',
  updatedAt: '2026-08-28T00:00:00.000Z',
}

describe('checkTemplateContract', () => {
  it('reports a missing template without opening Word', async () => {
    const engine = { readTextNodes: vi.fn() }
    const report = await checkTemplateContract(engine as never, document, undefined, 'delivery-export')
    expect(report).toMatchObject({ status: 'fail', findings: [{ code: 'template_missing' }] })
    expect(engine.readTextNodes).not.toHaveBeenCalled()
  })

  it('returns all minimum delivery failures from live text, styles, pages, and structure', async () => {
    const rules: TemplateRule[] = [
      rule('fixed-text', { text: '哈尔滨工业大学' }),
      rule('required-section', { text: '研究意义' }),
      rule('required-field', { officePath: '/body/p[1]', label: '题目', templateText: '题目：' }),
      rule('font', { target: 'body', eastAsia: '宋体', latin: 'Times New Roman' }),
      rule('font-size', { target: 'body', points: 12 }),
      rule('paragraph-spacing', { target: 'body', beforeLines: 0, afterLines: 0 }, 'warning'),
      rule('page-setup', { header: false }),
      rule('page-setup', { sections: [{ pageWidth: '21cm', marginTop: '3cm' }] }),
      rule('minimum-characters', { minimum: 20 }),
      rule('minimum-characters', { minimum: 5, heading: '不存在章节' }),
      rule('reference-count', { minimum: 2 }),
      rule('table-structure', { minimumTables: 1 }),
      rule('placeholder', {}),
      rule('file-integrity', {}),
      rule('template-identity', {}),
      rule('cross-document-fact', {}),
      rule('visual-layout', {}),
      rule('custom', {}),
      { ...rule('fixed-text', { text: 'ignored' }), enabled: false },
    ]
    const report = await checkTemplateContract(engine({
      text: [{ officePath: '/body/p[1]', text: '题目：{{title}}', kind: 'paragraph' }],
      children: [{
        path: '/body/p[1]',
        type: 'paragraph',
        text: '题目：{{title}}',
        style: 'Normal',
        format: {
          'effective.font.eastAsia': '微软雅黑',
          'effective.font.ascii': 'Arial',
          'effective.size': '10pt',
          spaceBeforeLines: 1,
          spaceAfterLines: 2,
        },
      }, {
        path: '/body/sectPr[1]',
        type: 'section',
        format: { pageWidth: '20cm', marginTop: '2cm', headerRef: '/header[1]' },
      }],
      valid: false,
    }), document, contract(rules, { status: 'draft', appliesToRoles: ['manuscript'] }), 'delivery-export')

    expect(report.findings.map(item => item.code)).toEqual(expect.arrayContaining([
      'template_unconfirmed',
      'template_role_mismatch',
      'document_invalid',
      'fixed_text_missing',
      'required_section_missing',
      'required_field_empty',
      'font_mismatch',
      'latin_font_mismatch',
      'font_size_mismatch',
      'paragraph_before_mismatch',
      'paragraph_after_mismatch',
      'header_present',
      'page_setup_mismatch',
      'minimum_characters',
      'reference_count',
      'table_structure_missing',
      'placeholder_remaining',
    ]))
  })

  it('reports missing style and section evidence but ignores absent optional expected fields', async () => {
    const rules = [
      rule('font', { target: 'heading', eastAsia: '黑体' }),
      rule('font-size', { target: 'heading-2', points: 14 }),
      rule('paragraph-spacing', { target: 'heading-3', beforeLines: 0, afterLines: 0 }),
      rule('page-setup', { sections: [{ pageWidth: '21cm' }] }),
      rule('fixed-text', null),
      rule('required-field', {}),
      rule('font-size', {}),
      rule('reference-count', {}),
      rule('table-structure', {}),
    ]
    const report = await checkTemplateContract(engine({ text: [], children: [], valid: true }), document, contract(rules), 'continuous')
    expect(report.findings.map(item => item.code)).toEqual(expect.arrayContaining([
      'font_mismatch',
      'font_size_mismatch',
      'page_setup_missing',
    ]))
  })

  it('turns an inspection rejection into one blocking finding', async () => {
    const broken = {
      readTextNodes: vi.fn(() => rejectWireValue('broken engine')),
      inspect: vi.fn(async () => ({})),
      validate: vi.fn(async () => ({ success: true, details: {} })),
    }
    const report = await checkTemplateContract(broken as never, document, contract([]), 'delivery-export')
    expect(report.findings).toHaveLength(1)
    expect(report.findings[0]?.code).toBe('template_inspection_failed')
    expect(report.findings[0]?.message).toContain('broken engine')

    broken.readTextNodes.mockImplementationOnce(() => Promise.reject(new Error('engine error')))
    const errorReport = await checkTemplateContract(broken as never, document, contract([]), 'delivery-export')
    expect(errorReport.findings[0]?.code).toBe('template_inspection_failed')
    expect(errorReport.findings[0]?.message).toContain('engine error')
  })

  it('passes satisfied defaults and keeps warning-only style evidence non-blocking', async () => {
    const rules: TemplateRule[] = [
      rule('font', { eastAsia: '宋体', latin: 'Times New Roman' }),
      rule('font', { target: 'custom', eastAsia: '黑体' }),
      rule('font', { target: 'heading', latin: 'Times New Roman' }, 'warning'),
      rule('font-size', { points: 12 }),
      rule('font-size', { target: 'heading', points: 15 }, 'warning'),
      rule('paragraph-spacing', { beforeLines: 0 }),
      rule('paragraph-spacing', { target: 'body', afterLines: 0 }),
      rule('minimum-characters', {}),
      rule('minimum-characters', { minimum: 1, heading: '研究内容' }),
      rule('reference-count', { minimum: 1 }),
      rule('table-structure', { minimumTables: 1 }),
      rule('placeholder', {}),
    ]
    const report = await checkTemplateContract(engine({
      text: [
        { officePath: '/body/p[1]', text: '研究内容', kind: 'paragraph' },
        { officePath: '/body/p[2]', text: '有效正文', kind: 'paragraph' },
        { officePath: '/body/p[3]', text: '[1] 参考文献', kind: 'paragraph' },
        { officePath: '/body/p[4]', text: '下一章节', kind: 'paragraph' },
        { officePath: '/body/tbl[1]', text: '[Table]', kind: 'table' },
      ],
      children: [
        {
          path: '/body/p[1]',
          type: 'paragraph',
          text: '研究内容',
          style: 'heading 1',
          format: { 'effective.font.eastAsia': '黑体', 'effective.size': 'not-a-point-size' },
        },
        {
          path: '/body/p[3]',
          type: 'paragraph',
          text: '[1] 参考文献',
          style: 'Normal',
          format: {
            'effective.font.eastAsia': '宋体',
            'effective.font.ascii': 'Times New Roman',
            'effective.size': '12pt',
          },
        },
        {
          path: '/body/p[4]',
          type: 'paragraph',
          text: '下一章节',
          style: 'heading 1',
          format: { 'effective.font.eastAsia': '黑体', 'effective.size': 15 },
        },
      ],
      valid: true,
    }), document, contract(rules), 'delivery-export')

    expect(report.status).toBe('pass-with-exceptions')
    expect(report.findings.every(item => item.severity === 'warning')).toBe(true)
  })
})

function engine(input: {
  text: Array<{ officePath: string; text: string; kind: 'paragraph' | 'table' | 'unknown' }>
  children: Array<Record<string, unknown>>
  valid: boolean
}): never {
  return {
    readTextNodes: vi.fn(async () => input.text),
    inspect: vi.fn(async () => ({ results: [{ type: 'body', children: input.children }] })),
    validate: vi.fn(async () => ({ success: input.valid, details: { valid: input.valid } })),
  } as never
}

function contract(
  rules: TemplateRule[],
  overrides: Partial<TemplateContract> = {},
): TemplateContract {
  return {
    id: TemplateContractId('template-1'),
    projectId: ProjectId('project-1'),
    name: '模板',
    sourceDocumentId: DocumentId('source-1'),
    version: 1,
    rules,
    slots: [],
    fixedNodeIds: [],
    instructionNodeIds: [],
    pageSetup: {},
    styleMap: {},
    origin: { kind: 'upload', label: '模板', originalFileName: 'template.docx' },
    appliesToRoles: ['proposal'],
    usage: 'form-template',
    status: 'confirmed',
    createdAt: '2026-08-28T00:00:00.000Z',
    updatedAt: '2026-08-28T00:00:00.000Z',
    ...overrides,
  }
}

function rule(kind: TemplateRuleKind, expected: unknown, severity: TemplateRule['severity'] = 'error'): TemplateRule {
  return {
    id: TemplateRuleId(`rule-${kind}-${Math.random()}`),
    kind,
    label: kind,
    description: kind,
    severity,
    expected,
    evidence: [],
    confidence: 1,
    enabled: true,
  }
}
