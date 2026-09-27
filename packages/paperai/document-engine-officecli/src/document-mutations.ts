/** Ordered edits against original nodes in one candidate Word document XML. */

import type { Document as XmlDocument, Element as XmlElement, Node as XmlNode } from '@xmldom/xmldom'
import type { EngineMutation, EngineTextNode } from '@paperai/document-engine'
import { bindMutationTargets, resolveOfficePath } from './office-path.ts'
import { child, paragraphText } from './paragraph-xml.ts'

const WORD_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const WORD_ID_NS = 'http://schemas.microsoft.com/office/word/2010/wordml'
const XML_NS = 'http://www.w3.org/XML/1998/namespace'

// Direct children only: properties under w:pPrChange are tracked-change history, not the current state.
const property = (node: XmlElement | undefined, ...names: string[]): XmlElement | undefined =>
  names.reduce<XmlElement | undefined>((parent, name) => parent && child(parent, name), node)
const numId = (properties: XmlElement | undefined): string | null | undefined => property(properties, 'numPr', 'numId')?.getAttributeNS(WORD_NS, 'val')

/**
 * Read a paragraph's own style ID.
 * @param paragraph - Word paragraph, or any other element, which has none.
 * @returns the `w:pStyle` value of its direct paragraph properties.
 */
export function paragraphStyle(paragraph: XmlElement): string | undefined {
  return property(paragraph, 'pPr', 'pStyle')?.getAttributeNS(WORD_NS, 'val') || undefined
}

// Word numbers a paragraph by its own numId, else the nearest numId on its style's basedOn chain; numId 0 removes it.
function numbered(paragraph: XmlElement, styles: XmlElement | undefined): boolean {
  let id = numId(property(paragraph, 'pPr'))
  let style = paragraphStyle(paragraph)
  const definitions = new Map(Array.from(styles?.getElementsByTagNameNS(WORD_NS, 'style') ?? [],
    node => [node.getAttributeNS(WORD_NS, 'styleId'), node]))
  const seen = new Set<string>()
  while (id === undefined && style !== undefined && !seen.has(style)) {
    seen.add(style)
    const definition = definitions.get(style)
    id = numId(property(definition, 'pPr'))
    style = property(definition, 'basedOn')?.getAttributeNS(WORD_NS, 'val') || undefined
  }
  return Boolean(id) && Number(id) !== 0
}

function insertedParagraph(body: XmlElement, text: string, style: string | undefined): XmlElement {
  const document = body.ownerDocument as XmlDocument
  const paragraph = document.createElementNS(WORD_NS, 'w:p')
  if (style !== undefined) {
    const properties = document.createElementNS(WORD_NS, 'w:pPr')
    const paragraphStyle = document.createElementNS(WORD_NS, 'w:pStyle')
    paragraphStyle.setAttributeNS(WORD_NS, 'w:val', style)
    properties.appendChild(paragraphStyle)
    paragraph.appendChild(properties)
  }
  const run = document.createElementNS(WORD_NS, 'w:r')
  for (const token of text.split(/([\t\v])/u)) {
    if (token === '') continue
    const child = document.createElementNS(WORD_NS, token === '\t' ? 'w:tab' : token === '\v' ? 'w:br' : 'w:t')
    if (child.localName === 't') {
      child.setAttributeNS(XML_NS, 'xml:space', 'preserve')
      child.appendChild(document.createTextNode(token))
    }
    run.appendChild(child)
  }
  paragraph.appendChild(run)
  return paragraph
}

/**
 * Apply a batch in caller order while retaining all original node identities.
 * @param root - independently parsed candidate Word document element.
 * @param mutations - original-address mutations; insertion indices refer to the current body.
 * @param indexed - the engine's text index of the unmodified document; a removal or insertion anchor that no
 * earlier step rewrote must match its entry, found under the address as the index spells it.
 * @param replaceParagraph - synchronous editor that replaces a paragraph group's joined text, preserves the first
 * paragraph object, and returns the resulting group including any split siblings.
 * @param resolveStyle - resolve an explicit paragraph style name or ID to an existing Word style ID.
 * @param styles - the styles part, needed when a removal or anchor target has a paragraph style that may number it.
 * @throws when a referenced node was removed earlier, a removal or anchor address is not in the index, a position is
 * invalid, or paragraph editing fails.
 */
export function applyDocumentMutations(
  root: XmlElement,
  mutations: readonly EngineMutation[],
  indexed: readonly Pick<EngineTextNode, 'officePath' | 'text'>[],
  replaceParagraph: (
    group: readonly [XmlElement, ...XmlElement[]],
    mutation: Extract<EngineMutation, { type: 'replace-text' }>,
  ) => readonly [XmlElement, ...XmlElement[]],
  resolveStyle: (style: string) => string,
  styles?: XmlElement,
): void {
  const body = resolveOfficePath(root, '/body')
  const targets = bindMutationTargets(root, mutations)
  // A split replacement stays one node for later mutations, as the text index records it until the next read.
  const groups = new Map<XmlElement, readonly [XmlElement, ...XmlElement[]]>()
  const group = (target: XmlElement): readonly [XmlElement, ...XmlElement[]] => groups.get(target) ?? [target]
  const attached = (path: string): XmlElement => {
    const target = targets.get(path) as XmlElement
    let ancestor: XmlNode | null = target
    while (ancestor !== null && ancestor !== body) ancestor = ancestor.parentNode
    if (ancestor !== body || target === body) {
      throw new Error(`INVALID_OFFICE_TARGET: '${path}' is not an attached body descendant`)
    }
    return target
  }
  // Removals and anchors only identify their target, so they compare the engine's own reading of it, which covers
  // equations, fields, and wrappers the editor cannot project; a node rewritten earlier compares the rewrite.
  // Keyed by path so a batch looks up only its own targets instead of resolving the whole index.
  const indexedText = new Map(indexed.map(node => [node.officePath.replace(/^\/document(?=\/)/u, ''), node.text]))
  const indexedReading = (path: string, target: XmlElement): string | undefined => {
    const key = path.replace(/^\/document(?=\/)/u, '')
    // The engine addresses a paragraph by its paraId once it has one, even when the batch used its ordinal.
    const paraId = target.localName === 'p' ? target.getAttributeNS(WORD_ID_NS, 'paraId') : null
    return indexedText.get(key) ?? (paraId ? indexedText.get(key.replace(/[^/]+$/u, `p[@paraId=${paraId}]`)) : undefined)
  }
  const projected = (target: XmlElement): string => group(target).map(paragraphText).join('\n')
  const assertText = (path: string, baseText: string, text: string | undefined): void => {
    if (text === undefined || text !== baseText) {
      throw new Error(`NODE_TEXT_CONFLICT: '${path}' text differs from the indexed base text; refresh the document before editing`)
    }
  }
  // Where the XML itself yields the text, it must agree with the index, so a misresolved address still conflicts.
  const identified = (path: string): string | undefined => {
    const target = targets.get(path) as XmlElement
    if (groups.has(target)) return projected(target)
    const reading = indexedReading(path, target)
    // Another spelling of the same node (an omitted or zero-padded index) cannot be fixed by refreshing.
    if (reading === undefined) {
      throw new Error(`INVALID_OFFICE_PATH: '${path}' is not an address in OfficeCLI's text index; use the officePath readTextNodes reports`)
    }
    let text: string | undefined
    if (target.localName === 'tbl') {
      text = `[Table: ${Array.from(target.childNodes).filter(row => row.nodeType === row.ELEMENT_NODE
        && (row as XmlElement).namespaceURI === WORD_NS && (row as XmlElement).localName === 'tr').length} rows]`
    } else if (target.localName === 'p') {
      try {
        text = paragraphText(target)
      } catch {
        // Content the editor cannot project, such as an equation, leaves the index as the only reading.
      }
    }
    // A numbered paragraph's reading starts with the engine's generated marker.
    return text === undefined || text === reading
      || (reading.length > text.length && reading.endsWith(text) && numbered(target, styles)) ? reading : undefined
  }
  for (const mutation of mutations) {
    switch (mutation.type) {
      case 'replace-text': {
        const target = attached(mutation.officePath)
        if (target.localName !== 'p') throw new Error(`INVALID_OFFICE_TARGET: '${mutation.officePath}' is not a paragraph`)
        assertText(mutation.officePath, mutation.baseText, projected(target))
        groups.set(target, replaceParagraph(group(target), mutation))
        break
      }
      case 'remove': {
        const target = attached(mutation.officePath)
        assertText(mutation.officePath, mutation.baseText, identified(mutation.officePath))
        for (const node of group(target)) (node.parentNode as XmlNode).removeChild(node)
        break
      }
      case 'insert-paragraph': {
        if ([mutation.after, mutation.before, mutation.index].filter(value => value !== undefined).length > 1) {
          throw new Error('INVALID_INSERT_POSITION: supply one of after, before, or index')
        }
        let parent: XmlElement = body
        let reference: XmlNode | null
        if (mutation.after !== undefined || mutation.before !== undefined) {
          const anchorPath = mutation.after ?? mutation.before
          const anchor = attached(anchorPath)
          parent = anchor.parentNode as XmlElement
          if (parent.localName !== 'body' && parent.localName !== 'tc') {
            throw new Error('INVALID_INSERT_POSITION: paragraphs must belong to the body or a table cell')
          }
          assertText(anchorPath, mutation.baseText, identified(anchorPath))
          const anchors = group(anchor)
          reference = mutation.after === undefined ? anchors[0] : (anchors.at(-1) as XmlElement).nextSibling
        } else {
          const children = Array.from(body.childNodes).filter((child): child is XmlElement => child.nodeType === child.ELEMENT_NODE)
          const section = children.find(child => child.namespaceURI === WORD_NS && child.localName === 'sectPr')
          const content = children.filter(child => child !== section)
          const index = mutation.index ?? content.length
          if (!Number.isSafeInteger(index) || index < 0 || index > content.length) {
            throw new Error('INVALID_INSERT_POSITION: index must address a current body position')
          }
          reference = content[index] ?? section ?? null
        }
        const style = mutation.style === undefined ? undefined : resolveStyle(mutation.style)
        for (const text of mutation.text.replace(/\r\n?/gu, '\n').split('\n')) {
          parent.insertBefore(insertedParagraph(body, text, style), reference)
        }
        break
      }
      /* v8 ignore next 4 -- EngineMutation is a closed same-process union. */
      default: {
        const unsupported: never = mutation
        throw new Error(`Unsupported engine mutation: ${String(unsupported)}`)
      }
    }
  }
}
