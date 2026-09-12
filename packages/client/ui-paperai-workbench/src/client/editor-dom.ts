/** Temporary editable DOM operations over the Host preview; commits remain node-addressed DOCX mutations. */
import type { PaperAIDocumentParagraph, PaperAIParagraphFormat } from './types.ts'
import type { EditorFormat } from './EditorRibbon.tsx'
import {
  applyParagraphFormat, boldOf, fontOf, paragraphFormatOf, paragraphsOf, pointsOf, runsOf, underlinedWithin,
} from './preview-html.ts'

/**
 * Restrict a document selection to one editable paragraph.
 * @param source - current document selection.
 * @param block - paragraph intersected by the selection.
 * @returns a range that never reaches another paragraph.
 */
export function clippedRange(source: Range, block: HTMLElement): Range {
  const range = block.ownerDocument.createRange()
  range.selectNodeContents(block)
  if (block.contains(source.startContainer)) range.setStart(source.startContainer, source.startOffset)
  if (block.contains(source.endContainer)) range.setEnd(source.endContainer, source.endOffset)
  return range
}

/** The nearest draft paragraph, or the original mapped paragraph. */
function paragraphAt(node: Node, block: HTMLElement): HTMLElement {
  const element = node instanceof HTMLElement ? node : node.parentElement
  return element?.closest<HTMLElement>('[data-paperai-paragraph]') ?? block
}

/**
 * Read selected draft paragraphs without including untouched neighbours.
 * @param range - current range over one or more mapped blocks.
 * @param blocks - mapped blocks intersecting it.
 * @returns each selected paragraph and its local range.
 */
export function selectedParagraphs(range: Range, blocks: readonly HTMLElement[]): readonly { block: HTMLElement; range: Range }[] {
  return blocks.flatMap(block => paragraphsOf(block).filter(part => range.collapsed
    ? part.contains(range.startContainer) : range.intersectsNode(part))
    .map(part => ({ block: part, range: clippedRange(range, part) })))
}

function elementsIn(range: Range, block: HTMLElement): Element[] {
  if (range.collapsed) {
    const element = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement
    return [element ?? block]
  }
  const walker = block.ownerDocument.createTreeWalker(block, NodeFilter.SHOW_TEXT)
  const elements: Element[] = []
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (node.nodeValue !== '' && range.intersectsNode(node) && node.parentElement !== null) elements.push(node.parentElement)
  }
  return elements.length > 0 ? elements : [block]
}

function explicit(element: Element, block: HTMLElement, property: string): boolean {
  for (let current: Element | null = element; current !== null && current !== block; current = current.parentElement) {
    if (current instanceof HTMLElement && current.style.getPropertyValue(property) !== '') return true
  }
  return false
}

/**
 * Read all selected text instead of showing only the first run's formatting.
 * @param range - caret or selection.
 * @param blocks - mapped blocks intersecting it.
 * @returns character values, inheritance, and common or mixed paragraph settings.
 */
export function selectionReading(range: Range, blocks: readonly HTMLElement[]): EditorFormat | null {
  const parts = selectedParagraphs(range, blocks)
  const readings = parts.flatMap(({ block, range: part }) => elementsIn(part, block).map((element) => {
    const style = getComputedStyle(element)
    const size = pointsOf(style)
    return {
      bold: boldOf(style), italic: style.fontStyle === 'italic', underline: underlinedWithin(element, block),
      size: Number.isFinite(size) ? `${size}pt` : '', font: fontOf(style),
      sizeSource: explicit(element, block, 'font-size') ? 'explicit' as const : 'inherited' as const,
      fontSource: explicit(element, block, 'font-family') ? 'explicit' as const : 'inherited' as const,
    }
  }))
  const first = readings[0]
  if (first === undefined) return null
  const common = <K extends keyof typeof first>(key: K): typeof first[K] | 'mixed' =>
    readings.every(reading => reading[key] === first[key]) ? first[key] : 'mixed'
  const formats: PaperAIParagraphFormat[] = parts.map(({ block }) => {
    const style = getComputedStyle(block)
    const align = style.textAlign
    const indent = parseFloat(style.marginLeft)
    return {
      ...(align === 'left' || align === 'center' || align === 'right' || align === 'justify' ? { align } : {}),
      ...(Number.isFinite(indent) ? { indent: `${style.marginLeft.endsWith('pt') ? indent : indent * 0.75}pt` } : {}),
      ...paragraphFormatOf(block),
    }
  })
  const paragraph = formats[0] ?? {}
  const paragraphMixed = formats.some(format =>
    (['style', 'align', 'indent', 'lineSpacing'] as const).some(key => format[key] !== paragraph[key]))
  return {
    bold: common('bold'), italic: common('italic'), underline: common('underline'),
    size: common('size'), font: common('font'), sizeSource: common('sizeSource'), fontSource: common('fontSource'),
    collapsed: range.collapsed,
    paragraph: paragraphMixed ? {} : paragraph,
    paragraphMixed,
  }
}

/** Keep an ancestor declaration on unselected text before removing it from the selected text. */
function detach(element: HTMLElement, range: Range, property: string, value: string): void {
  element.style.removeProperty(property)
  for (const side of ['after', 'before'] as const) {
    const part = element.ownerDocument.createRange()
    part.selectNodeContents(element)
    if (side === 'after') part.setStart(range.endContainer, range.endOffset)
    else part.setEnd(range.startContainer, range.startOffset)
    if (part.toString() === '') continue
    const span = element.ownerDocument.createElement('span')
    span.style.setProperty(property, value)
    span.append(part.extractContents())
    part.insertNode(span)
  }
}

/**
 * Apply character declarations while preserving nested formatting outside the range.
 * @param range - selection restricted to one paragraph.
 * @param block - owning paragraph.
 * @param patch - CSS character declarations, or empty values to inherit.
 * @returns the range around the replacement, collapsed for insertion formatting.
 */
export function formatRange(range: Range, block: HTMLElement, patch: Readonly<Record<string, string>>): Range {
  const collapsed = range.collapsed
  const first = elementsIn(range, block)[0]
  for (let element = first ?? null; element !== null && element !== block; element = element.parentElement) {
    if (!(element instanceof HTMLElement) || !element.contains(range.endContainer)) continue
    for (const [property, value] of Object.entries(patch)) {
      const stated = element.style.getPropertyValue(property)
      if (stated !== '' && stated !== value) detach(element, range, property, stated)
    }
  }
  const fragment = range.extractContents()
  for (const element of fragment.querySelectorAll<HTMLElement>('*')) {
    for (const property of Object.keys(patch)) element.style.removeProperty(property)
  }
  const span = block.ownerDocument.createElement('span')
  for (const [property, value] of Object.entries(patch)) if (value !== '') span.style.setProperty(property, value)
  span.append(fragment)
  if (span.childNodes.length === 0) span.append(block.ownerDocument.createTextNode(''))
  range.insertNode(span)
  const result = block.ownerDocument.createRange()
  result.selectNodeContents(span)
  if (collapsed) result.collapse(false)
  return result
}

/**
 * Read the original paragraph and every temporary split paragraph in order.
 * @param block - mapped original paragraph.
 * @returns text, character runs, and selected paragraph declarations.
 */
export function readParagraphs(block: HTMLElement): PaperAIDocumentParagraph[] {
  return paragraphsOf(block).map((part) => {
    const runs = runsOf(part)
    const format = paragraphFormatOf(part)
    return { text: runs.map(run => run.text).join(''), runs, ...(format === undefined ? {} : { format }) }
  })
}

/**
 * Insert paragraphs into one original block, preserving its inline formatting on both sides.
 * @param range - selection restricted to the original block.
 * @param block - mapped original paragraph.
 * @param lines - plain text lines replacing the selection; multiple lines create paragraphs.
 * @returns the caret immediately after the inserted text.
 */
export function insertParagraphText(range: Range, block: HTMLElement, lines: readonly string[]): Range {
  if (paragraphsOf(block)[0] === block) {
    const startNode = range.startContainer
    const startOffset = range.startOffset
    const endNode = range.endContainer
    const endOffset = range.endOffset
    const part = block.ownerDocument.createElement('div')
    part.dataset.paperaiParagraph = ''
    const format = paragraphFormatOf(block)
    if (format !== undefined) applyParagraphFormat(part, format)
    while (block.firstChild !== null) part.append(block.firstChild)
    block.append(part)
    range.setStart(startNode === block ? part : startNode, startOffset)
    range.setEnd(endNode === block ? part : endNode, endOffset)
  }
  const collapsed = range.collapsed
  const endpoint = (node: Node, offset: number, end: boolean): [Node, number] => {
    if (node !== block) return [node, offset]
    const previous = block.childNodes[offset - 1]
    if (end && !collapsed && previous !== undefined) return [previous, previous.childNodes.length]
    const next = block.childNodes[offset]
    if (next !== undefined) return [next, 0]
    return previous === undefined ? [block, 0] : [previous, previous.childNodes.length]
  }
  const startPoint = endpoint(range.startContainer, range.startOffset, false)
  const endPoint = endpoint(range.endContainer, range.endOffset, true)
  range.setStart(...startPoint)
  range.setEnd(...endPoint)
  const first = paragraphAt(range.startContainer, block)
  const last = paragraphAt(range.endContainer, block)
  const insertionAncestors: Element[] = []
  let insertionElement = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement
  if (insertionElement === first && range.startOffset > 0) {
    let preceding: Node | undefined = first.childNodes[range.startOffset - 1]
    while (preceding?.lastChild !== null && preceding?.lastChild !== undefined) preceding = preceding.lastChild
    insertionElement = preceding instanceof Element ? preceding : preceding?.parentElement ?? first
  }
  for (let element = insertionElement; element !== null && element !== first; element = element.parentElement) {
    insertionAncestors.push(element)
  }
  const head = block.ownerDocument.createRange()
  head.selectNodeContents(first)
  head.setEnd(range.startContainer, range.startOffset)
  const before = head.cloneContents()
  const tail = block.ownerDocument.createRange()
  tail.selectNodeContents(last)
  tail.setStart(range.endContainer, range.endOffset)
  const after = tail.cloneContents()
  const parts = paragraphsOf(block)
  const startIndex = parts.indexOf(first)
  const endIndex = parts.indexOf(last)
  const format = paragraphFormatOf(first)
  const inserted = lines.map((text, index) => {
    const part = block.ownerDocument.createElement('div')
    part.dataset.paperaiParagraph = ''
    if (format !== undefined) applyParagraphFormat(part, format)
    if (index === 0) part.append(before)
    const textNode = block.ownerDocument.createTextNode(text)
    let insertion: Node = textNode
    for (const ancestor of insertionAncestors) {
      const wrapper = ancestor.cloneNode(false)
      wrapper.appendChild(insertion)
      insertion = wrapper
    }
    part.append(insertion)
    return { part, textNode }
  })
  const ending = inserted.at(-1)
  if (ending === undefined) return range
  ending.part.append(after)
  const marker = last.nextSibling
  for (const part of parts.slice(startIndex, endIndex + 1)) part.remove()
  for (const { part } of inserted) block.insertBefore(part, marker)
  const caret = block.ownerDocument.createRange()
  caret.setStart(ending.textNode, ending.textNode.length)
  caret.collapse(true)
  return caret
}

/**
 * The selected paragraph format applied to every paragraph touched by the selection.
 * @param range - caret or selection.
 * @param blocks - original mapped blocks intersecting it.
 * @param patch - explicit paragraph declarations.
 */
export function formatParagraphs(range: Range, blocks: readonly HTMLElement[], patch: PaperAIParagraphFormat): void {
  for (const { block } of selectedParagraphs(range, blocks)) applyParagraphFormat(block, patch)
}
