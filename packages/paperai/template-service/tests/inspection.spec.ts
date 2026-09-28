import { describe, expect, it } from 'vitest'
import { isHeadingParagraph, parseBodyInspection, sectionKey } from '../src/inspection.ts'

describe('parseBodyInspection', () => {
  it('returns no nodes for absent or malformed body results', () => {
    expect(parseBodyInspection({})).toEqual([])
    expect(parseBodyInspection({ results: 'invalid' })).toEqual([])
    expect(parseBodyInspection({ results: [] })).toEqual([])
  })

  it('uses the first result as a fallback and filters malformed children and raw XML', () => {
    expect(parseBodyInspection({
      results: [{
        type: 'unexpected',
        children: [
          null,
          'invalid',
          { path: 12 },
          {
            path: '/body/p[1]',
            type: 'paragraph',
            text: 42,
            format: 'invalid',
          },
          {
            path: '/body/p[2]',
            type: 'paragraph',
            text: '正文',
            style: 'Normal',
            format: { size: '12pt', xml: '<w:rPr/>', 'markRPr.xml': '<w:rPr/>' },
          },
        ],
      }],
    })).toEqual([
      { path: '/body/p[1]', type: 'paragraph', text: '', format: {} },
      { path: '/body/p[2]', type: 'paragraph', text: '正文', styleName: 'Normal', format: { size: '12pt' } },
    ])
  })

  it('selects the explicit body result when other results precede it', () => {
    expect(parseBodyInspection({
      results: [
        { type: 'metadata', children: [{ path: '/ignored' }] },
        { type: 'body', children: [{ path: '/body/p[1]', type: 'paragraph', text: '保留', format: {} }] },
      ],
    })).toEqual([{ path: '/body/p[1]', type: 'paragraph', text: '保留', format: {} }])
  })
})

describe('isHeadingParagraph', () => {
  it('reads every supported section number in body text as a heading, but not a numbered sentence', () => {
    for (const text of ['第五章 结论', '第一节  研究背景', '1、研究背景', '1) 研究方法', '①研究内容', '一、研究背景',
      'Chapter 1 Introduction', '1.1 研究背景', '1.2.1 国内研究现状（示例，可删除）', '3 结论']) {
      expect(isHeadingParagraph(text, 'Normal'), text).toBe(true)
    }
    for (const text of ['1、首先分析数据，然后建立模型。', '2019年研究进展', '12 个样本表明，结果显著',
      '①'.padEnd(45, '长')]) {
      expect(isHeadingParagraph(text, 'Normal'), text).toBe(false)
    }
  })

  it('compares section titles without their number, whitespace, or case', () => {
    expect(sectionKey('第6章 结  论')).toBe(sectionKey('结论'))
    expect(sectionKey('Chapter 3 METHODS')).toBe(sectionKey('methods'))
    expect(sectionKey('第1章')).toBe('')
  })
})
