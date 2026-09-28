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
      'required-section', 'reference-count', 'minimum-characters', 'font', 'font-size', 'paragraph-spacing',
    ]))
    expect(compiled.contract.rules).not.toContainEqual(expect.objectContaining({ kind: 'table-structure' }))
    expect(compiled.nodes.at(-1)?.kind).toBe('table')
    expect(compiled.contract.styleMap).toHaveProperty('heading 1')
  })

  it('requires only the sections a pack declares, without copying research headings, annotations, citations, or TOC entries', async () => {
    const compiled = await compileFormatReference([
      ['摘  要', 'heading 1'], ['Abstract', 'heading 1'], ['目  录', 'Normal'],
      ['结  论', 'heading 1'], ['参考文献', 'heading 1'],
      ['第4章  基于FLUENT软件的轴承静态特性研究', 'heading 1'],
      ['6.2  多孔质石墨渗透率测试试验', 'heading 2'],
      ['0.023 12', 'Normal'],
      ['哈尔滨工业大学←（楷体小2号字加粗）', 'Normal'],
      ['［12］谌颖．哈尔滨工业大学，1992：8-13.', 'Normal'],
      ['摘  要\tI', '目录 1'], ['Abstract\tII', 'TOC 1'],
      ['参考文献', 'TOC 1'], ['结论', '目录 1'],
      ['（摘要应说明研究工作）', 'heading 1'],
      ['攻读博士学位期间取得创新性成果', 'heading 1'], ['致  谢', 'heading 1'],
    ], ['摘要', 'Abstract', '目录', '结论', '参考文献'])

    expect(compiled.contract.fixedNodeIds).toEqual([])
    expect(compiled.contract.rules.map(rule => [rule.kind, rule.expected])).toEqual([
      ['required-section', { text: '摘  要' }],
      ['required-section', { text: 'Abstract' }],
      ['required-section', { text: '目  录' }],
      ['required-section', { text: '结  论' }],
      ['required-section', { text: '参考文献' }],
    ])
  })

  it('requires every unnumbered heading of a formatting reference that declares no sections', async () => {
    const compiled = await compileFormatReference([
      // Section titles a sample sets in body text still count; only a heading style marks any other title.
      ['摘  要', 'heading 1'], ['ABSTRACT', 'Normal'],
      ['致  谢\t30', 'TOC 1'],
      ['第1章  绪论', 'heading 1'], ['1.1  研究背景', 'heading 2'], ['1.2.1 国内研究现状', 'heading 3'],
      ['第一章  绪论', 'heading 1'], ['一、研究背景', 'heading 2'], ['1、国内研究现状', 'heading 3'],
      ['Chapter 1 Introduction', 'heading 1'], ['第十二章 结论', 'heading 1'],
      ['第一节  研究背景', 'heading 2'], ['第2节 研究现状', 'heading 2'], ['1) 研究方法', 'heading 3'], ['①研究内容', 'heading 3'],
      ['图1-1  系统结构', 'heading 1'], ['（摘要应说明研究工作）', 'heading 1'],
      ['学位论文原创性声明', 'Normal'], ['致  谢', 'Normal'], ['本文遵守学位论文原创性声明。', 'Normal'],
      ['本人已阅读学位论文原创性声明', 'Normal'], ['本人已阅读学位论文原创性声明.', 'Normal'],
      ['条标题 4号字，建议段前0.5行，段后0.5行', 'heading 2'], ['政策建议', 'heading 1'],
      ['字体识别研究', 'heading 1'], ['页眉检测方法', '标题 1'], ['正文 1.5倍行距', 'heading 2'],
      ['1.1研究背景', 'heading 2'], ['一 研究背景', 'heading 2'], ['一级标题（小二号黑体）', 'heading 1'],
      ['实验结果（含分析）与讨论', 'heading 1'], ['二号楼设计', 'heading 1'],
      ['Figure 1 System overview', 'heading 1'], ['Table 2 Results', 'heading 1'], ['图一 系统结构', 'heading 1'],
      ['第１章　绪论', 'heading 1'],
    ])

    // The annotation compiles its own format rules, but only real headings become sections.
    expect(compiled.contract.rules.filter(rule => rule.kind === 'required-section').map(rule => [rule.kind, rule.expected])).toEqual([
      ['required-section', { text: '摘  要' }],
      ['required-section', { text: 'ABSTRACT' }],
      ['required-section', { text: '学位论文原创性声明' }],
      ['required-section', { text: '致  谢' }],
      ['required-section', { text: '政策建议' }],
      ['required-section', { text: '字体识别研究' }],
      ['required-section', { text: '页眉检测方法' }],
      ['required-section', { text: '实验结果（含分析）与讨论' }],
      ['required-section', { text: '二号楼设计' }],
    ])
  })

  it('finds a declared section under the number the formatting reference gives it', async () => {
    // Set in body text, the numbered heading is still one.
    const compiled = await compileFormatReference([['第五章  结  论', 'Normal']], ['结论'])
    expect(compiled.contract.rules.map(rule => [rule.kind, rule.expected])).toEqual([['required-section', { text: '结  论' }]])
  })

  it('rejects a declared section the formatting reference does not contain', async () => {
    await expect(compileFormatReference([['摘  要', 'heading 1']], ['摘要', '致谢']))
      .rejects.toThrow('required section not found in formatting reference: 致谢')
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

async function compileFormatReference(examples: ReadonlyArray<readonly [string, string]>, requiredSections?: readonly string[]) {
  const nodes = examples.map(([text], index) => ({ officePath: `/body/p[${index + 1}]`, text, kind: 'paragraph' as const }))
  return await compileTemplateDraft({
    readTextNodes: vi.fn(async () => nodes),
    inspect: vi.fn(async () => ({ results: [{ type: 'body', children: nodes.map((node, index) =>
      inspected(node.officePath, node.text, examples[index]![1])) }] })),
  } as never, { ...input('format', 'source'), usage: 'format-reference', ...(requiredSections === undefined ? {} : { requiredSections }) })
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
