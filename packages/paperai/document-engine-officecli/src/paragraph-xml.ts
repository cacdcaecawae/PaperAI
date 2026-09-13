/** Preserve Word run metadata while editing the paragraph's projected text. */

import type { Document as XmlDocument, Element as XmlElement, Node as XmlNode } from '@xmldom/xmldom'
import { diffArrays } from 'diff'
import type { EngineMutation, EngineTextRun } from '@paperai/document-engine'
import type { DocumentParagraph, DocumentParagraphFormat } from '@paperai/domain'

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const W14 = 'http://schemas.microsoft.com/office/word/2010/wordml'
const XML = 'http://www.w3.org/XML/1998/namespace'
const RUN_ORDER = 'rStyle rFonts b bCs i iCs caps smallCaps strike dstrike outline shadow emboss imprint noProof snapToGrid vanish webHidden color spacing w kern position sz szCs highlight u effect bdr shd fitText vertAlign rtl cs em lang eastAsianLayout specVanish oMath rPrChange'.split(' ')
const PARAGRAPH_ORDER = 'pStyle keepNext keepLines pageBreakBefore framePr widowControl numPr suppressLineNumbers pBdr shd tabs suppressAutoHyphens kinsoku wordWrap overflowPunct topLinePunct autoSpaceDE autoSpaceDN bidi adjustRightInd snapToGrid spacing ind contextualSpacing mirrorIndents suppressOverlap jc textDirection textAlignment textboxTightWrap outlineLvl divId cnfStyle rPr sectPr pPrChange'.split(' ')

interface Character { text: string; run: XmlElement | undefined; inline?: XmlElement }
interface Marker { offset: number; element: XmlElement; run?: XmlElement }

function children(node: XmlElement): XmlElement[] {
  return Array.from(node.childNodes).filter((child): child is XmlElement => child.nodeType === child.ELEMENT_NODE)
}

function child(node: XmlElement, name: string): XmlElement | undefined {
  return children(node).find(item => item.namespaceURI === W && item.localName === name)
}

function element(node: XmlElement, name: string): XmlElement {
  return (node.ownerDocument as XmlDocument).createElementNS(W, `w:${name}`)
}

function clone(node: XmlElement, deep: boolean): XmlElement {
  return node.cloneNode(deep) as XmlElement
}

function property(parent: XmlElement, name: string): XmlElement {
  const found = child(parent, name)
  if (found !== undefined) return found
  const created = element(parent, name)
  const order = parent.localName === 'rPr' ? RUN_ORDER : PARAGRAPH_ORDER
  parent.insertBefore(created, children(parent).find(item => order.indexOf(item.localName ?? '') > order.indexOf(name)) ?? null)
  return created
}

function value(node: XmlElement | undefined): string | null {
  return node?.getAttributeNS(W, 'val') ?? null
}

function setValue(parent: XmlElement, name: string, val: string): void {
  property(parent, name).setAttributeNS(W, 'w:val', val)
}

function ensureProperties(node: XmlElement, name: 'pPr' | 'rPr'): XmlElement {
  const found = child(node, name)
  if (found !== undefined) return found
  const created = element(node, name)
  node.insertBefore(created, node.firstChild)
  return created
}

function points(input: string): number {
  const match = /^(-?\d+(?:\.\d+)?)(pt|px|in|cm|mm|pc)?$/u.exec(input)
  if (match === null) throw new Error(`INVALID_DOCUMENT_FORMAT: '${input}' is not a Word length`)
  const units: Record<string, number> = { pt: 1, px: 0.75, in: 72, cm: 72 / 2.54, mm: 72 / 25.4, pc: 12 }
  const result = Number(match[1]) * (units[match[2] ?? 'pt'] as number)
  if (!Number.isFinite(result)) throw new Error(`INVALID_DOCUMENT_FORMAT: '${input}' must be finite`)
  return result
}

function positive(value: number, input: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`INVALID_DOCUMENT_FORMAT: '${input}' must be positive`)
  return value
}

/**
 * Apply explicitly supplied layout without replacing other paragraph properties.
 * @param paragraph - existing or newly split Word paragraph.
 * @param format - explicit overrides; omitted values retain the original XML.
 * @param resolveStyle - resolve a caller's style name to an existing Word style id.
 */
export function formatParagraph(paragraph: XmlElement, format: DocumentParagraphFormat, resolveStyle: (name: string) => string): void {
  if (Object.keys(format).length === 0) return
  const props = ensureProperties(paragraph, 'pPr')
  if (format.style !== undefined) setValue(props, 'pStyle', resolveStyle(format.style))
  if (format.align !== undefined) setValue(props, 'jc', format.align === 'justify' ? 'both' : format.align)
  if (format.indent !== undefined) {
    const indent = property(props, 'ind')
    indent.setAttributeNS(W, 'w:left', String(Math.round(points(format.indent) * 20)))
    indent.removeAttributeNS(W, 'leftChars')
    indent.removeAttributeNS(W, 'start')
    indent.removeAttributeNS(W, 'startChars')
  }
  if (format.lineSpacing !== undefined) {
    const spacing = property(props, 'spacing')
    const multiple = format.lineSpacing.endsWith('x')
    const amount = multiple ? Number(format.lineSpacing.slice(0, -1)) : points(format.lineSpacing)
    spacing.setAttributeNS(W, 'w:line', String(Math.round(positive(amount, format.lineSpacing) * (multiple ? 240 : 20))))
    spacing.setAttributeNS(W, 'w:lineRule', multiple ? 'auto' : 'exact')
  }
}

function formatRun(run: XmlElement, format: EngineTextRun | undefined): void {
  if (format === undefined) return
  const props = ensureProperties(run, 'rPr')
  for (const [key, name] of [['bold', 'b'], ['italic', 'i']] as const) {
    if (format[key] === undefined) continue
    const existing = child(props, name)
    const enabled = existing !== undefined && !['0', 'false', 'off'].includes(value(existing) ?? '1')
    if (existing === undefined || enabled !== format[key]) setValue(props, name, format[key] ? '1' : '0')
  }
  if (format.underline !== undefined) {
    const existing = child(props, 'u')
    const enabled = existing !== undefined && value(existing) !== 'none'
    if (existing === undefined || enabled !== format.underline) setValue(props, 'u', format.underline ? 'single' : 'none')
  }
  if (format.size !== undefined) {
    const size = String(Math.round(positive(points(format.size), format.size) * 2))
    if (value(child(props, 'sz')) !== size) {
      setValue(props, 'sz', size)
      setValue(props, 'szCs', size)
    }
  }
  if (format.color !== undefined) {
    const color = format.color.replace(/^#/u, '').toUpperCase()
    if (value(child(props, 'color'))?.toUpperCase() !== color) {
      const node = property(props, 'color')
      node.setAttributeNS(W, 'w:val', color)
      for (const name of ['themeColor', 'themeTint', 'themeShade']) node.removeAttributeNS(W, name)
    }
  }
  if (format.font !== undefined) {
    const fonts = property(props, 'rFonts')
    const displayed = fonts.getAttributeNS(W, 'eastAsia') ?? fonts.getAttributeNS(W, 'ascii')
    if (displayed !== format.font) {
      for (const script of ['ascii', 'hAnsi', 'eastAsia']) {
        if (format.font === '') fonts.removeAttributeNS(W, script)
        else fonts.setAttributeNS(W, `w:${script}`, format.font)
        fonts.removeAttributeNS(W, `${script}Theme`)
      }
    }
  }
  if (props.childNodes.length === 0) run.removeChild(props)
}

function projection(paragraph: XmlElement): { characters: Character[]; markers: Marker[] } {
  const characters: Character[] = []
  const markers: Marker[] = []
  const reject = (): never => { throw new Error('UNSUPPORTED_DOCUMENT_CONTENT: paragraph contains objects that require editing in Word') }
  for (const node of children(paragraph)) {
    if (node.namespaceURI !== W) reject()
    if (node.localName === 'pPr') continue
    if (['bookmarkStart', 'bookmarkEnd', 'proofErr', 'permStart', 'permEnd'].includes(node.localName ?? '')) {
      markers.push({ offset: characters.length, element: node })
      continue
    }
    if (node.localName !== 'r') reject()
    const inlines = children(node).filter(item => item.localName !== 'rPr' || item.namespaceURI !== W)
    if (inlines.length === 0) markers.push({ offset: characters.length, element: node })
    for (const inline of inlines) {
      if (inline.namespaceURI !== W) reject()
      let text: string
      if (inline.localName === 't') text = inline.textContent ?? ''
      else if (inline.localName === 'tab') text = '\t'
      else if (inline.localName === 'br' && ['', 'textWrapping'].includes(inline.getAttributeNS(W, 'type') ?? '')) text = '\v'
      else if (inline.localName === 'lastRenderedPageBreak' || inline.localName === 'br') {
        markers.push({ offset: characters.length, element: inline, run: node })
        continue
      } else { text = reject() }
      characters.push(...Array.from(text, character => ({ text: character, run: node,
        ...(inline.localName === 'br' ? { inline } : {}) })))
    }
  }
  return { characters, markers }
}

function runCopy(paragraph: XmlElement, source: XmlElement | undefined, format?: EngineTextRun): XmlElement {
  const run = source === undefined ? element(paragraph, 'r') : clone(source, false)
  const props = source === undefined ? child(child(paragraph, 'pPr') ?? paragraph, 'rPr') : child(source, 'rPr')
  if (props !== undefined) run.appendChild(props.cloneNode(true))
  formatRun(run, format)
  return run
}

function appendText(run: XmlElement, text: string): void {
  for (const part of text.split(/([\t\v\n])/u)) {
    if (part === '') continue
    const node = element(run, part === '\t' ? 'tab' : part === '\v' || part === '\n' ? 'br' : 't')
    if (node.localName === 't') {
      node.setAttributeNS(XML, 'xml:space', 'preserve')
      node.appendChild((run.ownerDocument as XmlDocument).createTextNode(part))
    }
    run.appendChild(node)
  }
}

/**
 * Edit original text and explicit formatting while retaining opaque run properties and range markers.
 * @param paragraph - original bound paragraph; its object identity remains intact for later mutations.
 * @param mutation - replacement text, optional character overrides, and optional paragraph splits.
 * @param resolveStyle - resolve explicit paragraph style names through the document's styles.
 * @throws before writing when the paragraph contains unprojected editable objects.
 */
export function replaceParagraphXml(
  paragraph: XmlElement,
  mutation: Extract<EngineMutation, { type: 'replace-text' }>,
  resolveStyle: (name: string) => string,
): void {
  const replacements = mutation.paragraphs ?? splitReplacement(mutation)
  const first = replacements[0] as DocumentParagraph
  if (replacements.length === 1 && first.runs === undefined) {
    const current = projection(paragraph)
    if (current.characters.map(item => item.text).join('') === first.text) {
      formatParagraph(paragraph, first.format ?? {}, resolveStyle)
      return
    }
  }
  const { characters: original, markers } = projection(paragraph)
  const emptyRun = children(paragraph).findLast(node => node.namespaceURI === W && node.localName === 'r')
  const text = replacements.map(item => item.text).join('\n')
  const characters: Character[] = []
  const left: number[] = [0]
  const right: number[] = [0]
  let offset = 0
  let removedAt: number | undefined
  for (const edit of diffArrays(original.map(item => item.text), Array.from(text))) {
    if (edit.removed) {
      removedAt = offset
      for (const _character of edit.value) {
        offset++
        left[offset] = characters.length
        right[offset] = characters.length
      }
    } else if (edit.added) {
      const source = original[removedAt ?? Math.max(0, offset - 1)]?.run ?? emptyRun
      characters.push(...edit.value.map(character => ({ text: character, run: source })))
      right[offset] = characters.length
      removedAt = undefined
    } else {
      removedAt = undefined
      for (const _character of edit.value) {
        characters.push(original[offset] as Character)
        offset++
        left[offset] = characters.length
        right[offset] = characters.length
      }
    }
  }
  const moved = markers.map(marker => ({ ...marker, offset:
    (marker.element.localName?.endsWith('End') === true ? right : left)[marker.offset] as number }))
  const skeleton = clone(paragraph, false)
  skeleton.removeAttributeNS(W14, 'paraId')
  skeleton.removeAttributeNS(W14, 'textId')
  const originalProperties = child(paragraph, 'pPr')
  const paragraphProperties = originalProperties === undefined ? undefined : clone(originalProperties, true)
  const section = paragraphProperties === undefined ? undefined : child(paragraphProperties, 'sectPr')
  if (section !== undefined) (paragraphProperties as XmlElement).removeChild(section)
  for (const node of Array.from(paragraph.childNodes)) paragraph.removeChild(node)
  let start = 0
  let previous = paragraph
  for (const [index, replacement] of replacements.entries()) {
    const target = index === 0 ? paragraph : clone(skeleton, false)
    if (index > 0) (previous.parentNode as XmlNode).insertBefore(target, previous.nextSibling)
    if (paragraphProperties !== undefined) target.appendChild(paragraphProperties.cloneNode(true))
    if (section !== undefined && index === replacements.length - 1) {
      const props = ensureProperties(target, 'pPr')
      props.insertBefore(section, child(props, 'pPrChange') ?? null)
    }
    formatParagraph(target, replacement.format ?? {}, resolveStyle)
    const formats = replacement.runs?.flatMap(run => Array.from(run.text, () => run))
    const length = Array.from(replacement.text).length
    let active: XmlElement | undefined
    let activeSource: XmlElement | undefined
    let activeFormat: EngineTextRun | undefined
    let pending = ''
    const flush = (): void => {
      if (active !== undefined) appendText(active, pending)
      pending = ''
      active = undefined
    }
    for (let position = 0; position <= length; position++) {
      for (const marker of moved.filter(item => item.offset === start + position)) {
        flush()
        if (marker.run === undefined) target.appendChild(marker.element.cloneNode(true))
        else {
          const markerRun = runCopy(target, marker.run)
          markerRun.appendChild(marker.element.cloneNode(true))
          target.appendChild(markerRun)
        }
      }
      if (position === length) break
      const character = characters[start + position] as Character
      const format = formats?.[position]
      if (active === undefined || activeSource !== character.run || activeFormat !== format) {
        flush()
        active = runCopy(target, character.run, format)
        target.appendChild(active)
        activeSource = character.run
        activeFormat = format
      }
      if (character.inline === undefined) pending += character.text
      else {
        appendText(active, pending)
        pending = ''
        active.appendChild(character.inline.cloneNode(true))
      }
    }
    flush()
    if (length === 0) target.appendChild(runCopy(target, characters[start - 1]?.run ?? emptyRun, replacement.runs?.[0]))
    start += length + 1
    previous = target
  }
}

function splitReplacement(mutation: Extract<EngineMutation, { type: 'replace-text' }>): DocumentParagraph[] {
  if (mutation.runs === undefined) return mutation.text.replace(/\r\n?/gu, '\n').split('\n').map(text => ({ text }))
  const paragraphs: { text: string; runs: EngineTextRun[] }[] = [{ text: '', runs: [] }]
  for (const run of mutation.runs) {
    for (const [index, text] of run.text.replace(/\r\n?/gu, '\n').split('\n').entries()) {
      if (index > 0) paragraphs.push({ text: '', runs: [] })
      const paragraph = paragraphs.at(-1) as { text: string; runs: EngineTextRun[] }
      paragraph.text += text
      paragraph.runs.push({ ...run, text })
    }
  }
  return paragraphs
}
