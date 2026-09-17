import { describe, expect, it } from 'vitest'
import type { PaperAIDocumentNodeId, PaperAIDocumentNodeSummary } from '../src/client/types.ts'
import { outlineOf } from '../src/client/outline.ts'

function node(text: string, overrides: Partial<PaperAIDocumentNodeSummary> = {}): PaperAIDocumentNodeSummary {
  return { nodeId: `node-${text}` as PaperAIDocumentNodeId, kind: 'paragraph', label: text, depth: 0, editable: true, text, ...overrides }
}

describe('outlineOf', () => {
  it('reads chapters, numbered sections and named parts with their levels, in reading order', () => {
    const outline = outlineOf([
      node('摘  要'),
      node('Abstract'),
      node('第1章  绪论'),
      node('1.1 研究背景'),
      node('1.1.1 国内现状'),
      node('1.1.1.1 too deep still reads as level three'),
      node('本文围绕……展开研究。'),
      node('2 相关工作'),
      node('一、课题来源及研究的目的和意义'),
      node('（一）课题来源'),
      node('参考文献'),
      node('致谢'),
    ])
    expect(outline.map(entry => [entry.text, entry.level])).toEqual([
      ['摘 要', 1], ['Abstract', 1], ['第1章 绪论', 1], ['1.1 研究背景', 2], ['1.1.1 国内现状', 3],
      ['1.1.1.1 too deep still reads as level three', 3], ['2 相关工作', 1], ['一、课题来源及研究的目的和意义', 1], ['（一）课题来源', 2], ['参考文献', 1], ['致谢', 1],
    ])
  })

  it('skips tables, cells, nested blocks, sentences, years and long paragraphs', () => {
    const long = `1 ${'很'.repeat(70)}长的段落`
    expect(outlineOf([
      node('1 结果', { kind: 'table' }),
      node('1 单元格', { kind: 'table-cell', depth: 1 }),
      node('1 嵌套', { depth: 1 }),
      node('1 这一句以句号结尾。'),
      node('2026 年的工作安排'),
      node('3.14 是圆周率，'),
      node(long),
      node(''),
    ])).toEqual([])
  })

  it('trusts a heading node whatever its text says', () => {
    expect(outlineOf([node('Introduction', { kind: 'heading' })])).toEqual([
      { nodeId: 'node-Introduction', text: 'Introduction', level: 1 },
    ])
  })
})
