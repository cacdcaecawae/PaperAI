// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import type { PaperAIDocumentNodeId, PaperAIDocumentNodeSummary } from '../src/client/types.ts'
import { outlineOf } from '../src/client/outline.ts'

function node(text: string, overrides: Partial<PaperAIDocumentNodeSummary> = {}): PaperAIDocumentNodeSummary {
  return { nodeId: `node-${text}` as PaperAIDocumentNodeId, kind: 'paragraph', label: text, depth: 0, editable: true, text, ...overrides }
}

describe('outlineOf', () => {
  it('reads chapters, numbered sections and named parts when the document states no heading style', () => {
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
    ], '')
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
    ], '')).toEqual([])
  })

  // Probed from packages/paperai/template-pack-hit/assets/final.docx, a real
  // doctoral thesis, through `officecli view <file> html`: a Word heading style
  // renders as h1..h6 carrying its Office path, while the generated table of
  // contents stays plain `p` and keeps its page number after a tab.
  const STYLED = '<html><head></head><body><div class="page"><div class="page-body">'
    + '<h1 data-path="/body/p[82]">摘  要</h1>'
    + '<p data-path="/body/p[107]">目  录</p>'
    + '<p data-path="/body/p[110]">第1章  绪  论\t1</p>'
    + '<p data-path="/body/p[111]">1.1  课题背景及研究的目的和意义\t1</p>'
    + '<h1 data-path="/body/p[169]">第1章  绪  论</h1>'
    + '<h2 data-path="/body/p[170]">1.1  课题背景及研究的目的和意义</h2>'
    + '<h3 data-path="/body/p[176]">1.2.1  气体润滑轴承的发展</h3>'
    + '<h1 data-path="/body/p[230]">研究方法</h1>'
    + '<h1 data-path="/body/p[320]"></h1>'
    + '<h1 data-path="/body/p[303]">参考文献</h1>'
    + '<p data-path="/body/p[304]">1. 刘暾. 静压气体润滑[M]. 哈尔滨工业大学出版社, 1990.</p>'
    + '</div></div></body></html>'

  it('reads the styled headings and none of the table of contents or the references', () => {
    const nodes = [
      node('摘  要'),
      node('目  录'),
      node('第1章  绪  论\t1'),
      node('1.1  课题背景及研究的目的和意义\t1'),
      node('第1章  绪  论'),
      node('1.1  课题背景及研究的目的和意义'),
      node('1.2.1  气体润滑轴承的发展'),
      node('研究方法'),
      node(''),
      node('参考文献'),
      node('1. 刘暾. 静压气体润滑[M]. 哈尔滨工业大学出版社, 1990.'),
    ]
    expect(outlineOf(nodes, STYLED).map(entry => [entry.text, entry.level])).toEqual([
      ['摘 要', 1], ['第1章 绪 论', 1], ['1.1 课题背景及研究的目的和意义', 2], ['1.2.1 气体润滑轴承的发展', 3],
      ['研究方法', 1], ['参考文献', 1],
    ])
  })

  it('names the styled chapter, not the table-of-contents line that repeats its text', () => {
    const nodes = [node('第1章  绪  论\t1'), node('第1章  绪  论')]
    expect(outlineOf(nodes, STYLED).map(entry => entry.nodeId)).toEqual(['node-第1章  绪  论'])
  })
})
