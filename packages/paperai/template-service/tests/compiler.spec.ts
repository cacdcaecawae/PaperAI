import { describe, expect, it, vi } from 'vitest'
import { DocumentId, ProjectId, TemplateContractId } from '@paperai/domain'
import { compileTemplateDraft } from '../src/compiler.ts'

describe('compileTemplateDraft', () => {
  it('compiles format-reference headings without form slots or copied table requirements', async () => {
    const readTextNodes = vi.fn(async () => [
      { officePath: '/body/p[1]', text: '哈 尔 滨 工 业 大 学', kind: 'paragraph' as const },
      { officePath: '/body/p[2]', text: '摘  要', kind: 'paragraph' as const },
      { officePath: '/body/p[3]', text: 'Abstract', kind: 'paragraph' as const },
      { officePath: '/body/p[4]', text: '参考文献应在2篇以上', kind: 'unknown' as const },
      { officePath: '/body/p[5]', text: '开题报告的字数应在10字以上', kind: 'paragraph' as const },
      { officePath: '/body/p[6]', text: '数字、英文为 Times New Roman，中文字体为宋体。', kind: 'paragraph' as const },
      { officePath: '/body/p[7]', text: '条标题 4号字，建议段前0.5行，段后0.5行', kind: 'paragraph' as const },
      { officePath: '/body/p[8]', text: '款、项标题 小4号字，建议段前0行，段后0行', kind: 'paragraph' as const },
      { officePath: '/body/tbl[1]', text: '[Table: 2 rows]', kind: 'table' as const },
    ])
    const inspect = vi.fn(async () => ({
      results: [{
        type: 'body',
        children: [
          inspected('/body/p[1]', '哈 尔 滨 工 业 大 学', 'Normal'),
          inspected('/body/p[2]', '摘  要', 'heading 1'),
          inspected('/body/p[3]', 'Abstract', 'heading 1'),
          inspected('/body/p[4]', '参考文献应在2篇以上', 'Normal'),
          inspected('/body/p[5]', '开题报告的字数应在10字以上', 'Normal'),
          inspected('/body/p[6]', '数字、英文为 Times New Roman，中文字体为宋体。', 'Normal'),
          inspected('/body/p[7]', '条标题 4号字，建议段前0.5行，段后0.5行', 'heading 2'),
          inspected('/body/p[8]', '款、项标题 小4号字，建议段前0行，段后0行', 'heading 3'),
          { path: '/body/tbl[1]', type: 'table', text: '', format: {} },
        ],
      }],
    }))
    const compiled = await compileTemplateDraft({ readTextNodes, inspect } as never, {
      projectId: ProjectId('project-1'),
      templateId: TemplateContractId('template-1'),
      sourceDocumentId: DocumentId('source-1'),
      name: '论文格式参考',
      appliesToRoles: [],
      usage: 'format-reference',
      assets: {
        immutableSourcePath: 'source.doc',
        normalizedPath: 'source.docx',
        originalFileName: 'source.doc',
        sourceSha256: 'a'.repeat(64),
        normalizedSha256: 'b'.repeat(64),
      },
      origin: { kind: 'upload', label: '格式参考', originalFileName: 'source.doc' },
      now: '2026-08-28T00:00:00.000Z',
    })

    expect(compiled.document.role).toBe('other')
    expect(compiled.contract.slots).toEqual([])
    expect(compiled.contract.pageSetup).toEqual({})
    expect(compiled.contract.rules.map(rule => rule.kind)).toEqual(expect.arrayContaining([
      'fixed-text', 'required-section', 'reference-count', 'minimum-characters', 'font', 'font-size', 'paragraph-spacing',
    ]))
    expect(compiled.contract.rules).not.toContainEqual(expect.objectContaining({ kind: 'table-structure' }))
    expect(compiled.nodes.at(-1)?.kind).toBe('table')
    expect(compiled.contract.styleMap).toHaveProperty('heading 1')
  })

  it('detects text and date fields plus form tables', async () => {
    const text = [
      { officePath: '/body/p[1]', text: '学 院（部）          ', kind: 'paragraph' as const },
      { officePath: '/body/p[2]', text: '中期报告日期          ', kind: 'paragraph' as const },
      { officePath: '/body/tbl[1]', text: '[Table]', kind: 'table' as const },
    ]
    const compiled = await compileTemplateDraft({
      readTextNodes: vi.fn(async () => text),
      inspect: vi.fn(async () => ({ results: [{ type: 'body', children: text.map(item => inspected(item.officePath, item.text, 'Normal')) }] })),
    } as never, {
      projectId: ProjectId('project-1'),
      templateId: TemplateContractId('template-2'),
      sourceDocumentId: DocumentId('source-2'),
      name: '表单',
      appliesToRoles: ['midterm'],
      usage: 'form-template',
      assets: {
        immutableSourcePath: 'source.docx',
        normalizedPath: 'source.docx',
        originalFileName: 'source.docx',
        sourceSha256: 'a'.repeat(64),
        normalizedSha256: 'a'.repeat(64),
      },
      origin: { kind: 'upload', label: '表单', originalFileName: 'source.docx' },
      now: '2026-08-28T00:00:00.000Z',
    })

    expect(compiled.contract.slots).toEqual([
      expect.objectContaining({ key: 'school', type: 'text' }),
      expect.objectContaining({ key: 'reportDate', type: 'date' }),
    ])
    expect(compiled.contract.rules).toContainEqual(expect.objectContaining({
      kind: 'table-structure',
      expected: { minimumTables: 1 },
    }))
  })

  it('keeps review evidence when OfficeCLI returns partial or uncommon formatting', async () => {
    const longFixed = `哈尔滨工业大学${'固定模板文字'.repeat(12)}`
    const text = [
      { officePath: '/body/p[1]', text: longFixed, kind: 'paragraph' as const },
      { officePath: '/body/p[2]', text: '内容不少于2字', kind: 'paragraph' as const },
      { officePath: '/body/p[3]', text: '中文字体使用宋体。', kind: 'paragraph' as const },
      { officePath: '/body/p[4]', text: '正文 小5号字', kind: 'paragraph' as const },
      { officePath: '/body/p[5]', text: '一、开题报告应包括下列主要内容', kind: 'paragraph' as const },
      { officePath: '/body/p[6]', text: '1．研究内容', kind: 'paragraph' as const },
      { officePath: '/body/p[7]', text: '二、其他事项', kind: 'paragraph' as const },
    ]
    const children = text.slice(1).map(item => inspected(item.officePath, item.text, 'Normal'))
    const compiled = await compileTemplateDraft({
      readTextNodes: vi.fn(async () => text),
      inspect: vi.fn(async () => ({
        results: [{
          type: 'body',
          children: [
            ...children,
            { path: '/body/sectPr[1]', type: 'section', text: '', format: { pageWidth: '21cm' } },
          ],
        }],
      })),
    } as never, input('template-3', 'source-3'))

    expect(compiled.nodes[0]?.style).toEqual({})
    expect(compiled.contract.rules).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'minimum-characters', expected: { minimum: 2, heading: undefined } }),
      expect.objectContaining({ kind: 'font-size', expected: { target: 'body', sizeLabel: '小5号' } }),
      expect.objectContaining({ kind: 'required-section', expected: { text: '研究内容' } }),
    ]))
    expect(compiled.contract.rules).not.toContainEqual(expect.objectContaining({ kind: 'paragraph-spacing' }))
    expect(compiled.contract.rules.find(rule => rule.kind === 'fixed-text')?.label.endsWith('…')).toBe(true)

    const empty = await compileTemplateDraft({
      readTextNodes: vi.fn(async () => []),
      inspect: vi.fn(async () => ({
        results: [{
          type: 'body',
          children: [{ path: '/body/sectPr[1]', type: 'section', text: '', format: { marginTop: '3cm' } }],
        }],
      })),
    } as never, input('template-4', 'source-4'))
    expect(empty.contract.rules).toContainEqual(expect.objectContaining({
      kind: 'page-setup',
      scope: '/body',
      evidence: [],
      confidence: 0.8,
    }))
  })
})

function input(templateId: string, sourceDocumentId: string) {
  return {
    projectId: ProjectId('project-1'),
    templateId: TemplateContractId(templateId),
    sourceDocumentId: DocumentId(sourceDocumentId),
    name: '边界模板',
    appliesToRoles: ['proposal'] as const,
    usage: 'form-template' as const,
    assets: {
      immutableSourcePath: 'source.docx',
      normalizedPath: 'source.docx',
      originalFileName: 'source.docx',
      sourceSha256: 'a'.repeat(64),
      normalizedSha256: 'a'.repeat(64),
    },
    origin: { kind: 'upload' as const, label: '边界模板', originalFileName: 'source.docx' },
    now: '2026-08-28T00:00:00.000Z',
  }
}

function inspected(path: string, text: string, style: string): Record<string, unknown> {
  return {
    path,
    type: 'paragraph',
    text,
    style,
    format: {
      styleName: style,
      'effective.font.eastAsia': style.startsWith('heading') ? '黑体' : '宋体',
      'effective.font.ascii': 'Times New Roman',
      'effective.size': '12pt',
    },
  }
}
