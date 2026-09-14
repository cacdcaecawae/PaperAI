// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { insertParagraphText, readParagraphs } from '../src/client/editor-dom.ts'
import { paragraphsOf, textOf } from '../src/client/preview-html.ts'

function paragraph(html: string): HTMLElement {
  const block = document.createElement('p')
  block.innerHTML = html
  document.body.replaceChildren(block)
  return block
}

function endOf(node: Node): Range {
  const range = document.createRange()
  range.selectNodeContents(node)
  range.collapse(false)
  return range
}

describe('empty paragraph insertion', () => {
  it('keeps a visible caret inside the inherited inline formatting after Enter', () => {
    const block = paragraph('<span style="font-weight:bold;font-family:Arial;font-size:18pt">报告</span>')
    const caret = insertParagraphText(endOf(block.firstChild!.firstChild!), block, ['', ''])
    const parts = paragraphsOf(block)
    const placeholder = parts[1]!.querySelector<HTMLElement>('br[data-paperai-placeholder]')!

    expect(parts.map(textOf)).toEqual(['报告', ''])
    expect(placeholder.parentElement).toBe(caret.startContainer.parentElement)
    expect(placeholder.parentElement!.style.fontWeight).toBe('bold')
    expect(placeholder.parentElement!.style.fontFamily).toBe('Arial')
    expect(placeholder.parentElement!.style.fontSize).toBe('18pt')
    expect(readParagraphs(block).map(part => part.text)).toEqual(['报告', ''])
  })

  it('keeps repeated Enter caret positions in the current format without accumulating placeholders', () => {
    const block = paragraph('<span style="font-weight:bold">报告</span>')
    const firstCaret = insertParagraphText(endOf(block.firstChild!.firstChild!), block, ['', ''])
    const lastCaret = insertParagraphText(firstCaret, block, ['', ''])
    const parts = paragraphsOf(block)

    expect(parts.map(textOf)).toEqual(['报告', '', ''])
    for (const part of parts.slice(1)) {
      expect(part.querySelectorAll('br[data-paperai-placeholder]')).toHaveLength(1)
      expect(part.querySelector<HTMLElement>('br')!.parentElement!.style.fontWeight).toBe('bold')
    }
    expect(parts[2]!.querySelector('br')!.parentNode).toBe(lastCaret.startContainer.parentNode)
    expect(readParagraphs(block).map(part => part.text)).toEqual(['报告', '', ''])
  })

  it('keeps blank pasted lines editable without encoding caret placeholders as soft breaks', () => {
    const block = paragraph('<span style="font-style:italic">报告</span>')
    insertParagraphText(endOf(block.firstChild!.firstChild!), block, ['', '', '补充', ''])

    expect(readParagraphs(block).map(part => part.text)).toEqual(['报告', '', '补充', ''])
    expect(paragraphsOf(block).map(part => part.querySelectorAll('br[data-paperai-placeholder]').length))
      .toEqual([0, 1, 0, 1])
    for (const placeholder of block.querySelectorAll<HTMLElement>('br[data-paperai-placeholder]')) {
      expect(placeholder.parentElement!.style.fontStyle).toBe('italic')
    }
  })

  it('retains real soft breaks when splitting a paragraph that already contains one', () => {
    const block = paragraph('<span style="font-weight:bold"><br></span>')
    const caret = insertParagraphText(endOf(block.firstChild!), block, ['', ''])

    expect(readParagraphs(block).map(part => part.text)).toEqual(['\v', ''])
    expect(paragraphsOf(block)[0]!.querySelector('br')!.hasAttribute('data-paperai-placeholder')).toBe(false)
    expect(paragraphsOf(block)[1]!.querySelector('br')!.parentNode).toBe(caret.startContainer.parentNode)
  })
})
