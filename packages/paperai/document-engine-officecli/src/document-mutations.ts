/** Ordered edits against original nodes in one candidate Word document XML. */

import type { Document as XmlDocument, Element as XmlElement, Node as XmlNode } from '@xmldom/xmldom'
import type { EngineMutation, EngineTextNode } from '@paperai/document-engine'
import { bindMutationTargets, resolveOfficePath } from './office-path.ts'
import { paragraphText } from './paragraph-xml.ts'

const WORD_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const XML_NS = 'http://www.w3.org/XML/1998/namespace'

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
 * earlier step rewrote must match its entry.
 * @param replaceParagraph - synchronous editor that replaces a paragraph group's joined text, preserves the first
 * paragraph object, and returns the resulting group including any split siblings.
 * @param resolveStyle - resolve an explicit paragraph style name or ID to an existing Word style ID.
 * @throws when a referenced node was removed earlier, a position is invalid, or paragraph editing fails.
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
  const indexedText = new Map<XmlElement, string>()
  for (const node of indexed) {
    try {
      indexedText.set(resolveOfficePath(root, node.officePath), node.text)
    } catch {
      // Entries outside the addressable body (content controls, headers) cannot be mutation targets.
    }
  }
  const projected = (target: XmlElement): string => group(target).map(paragraphText).join('\n')
  const assertText = (path: string, baseText: string, text: string | undefined): void => {
    if (text === undefined || text !== baseText) {
      throw new Error(`NODE_TEXT_CONFLICT: '${path}' text differs from the indexed base text; refresh the document before editing`)
    }
  }
  // Where the XML itself yields the text, it must agree with the index, so a misresolved address still conflicts.
  const identified = (target: XmlElement): string | undefined => {
    if (groups.has(target)) return projected(target)
    let text: string | undefined
    if (target.localName === 'tbl') {
      text = `[Table: ${Array.from(target.childNodes).filter(child => child.nodeType === child.ELEMENT_NODE
        && (child as XmlElement).namespaceURI === WORD_NS && (child as XmlElement).localName === 'tr').length} rows]`
    } else if (target.localName === 'p') {
      try {
        text = paragraphText(target)
      } catch {
        // Content the editor cannot project, such as an equation, leaves the index as the only reading.
      }
    }
    const indexedReading = indexedText.get(target)
    return text === undefined || text === indexedReading ? indexedReading : undefined
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
        assertText(mutation.officePath, mutation.baseText, identified(target))
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
          assertText(anchorPath, mutation.baseText, identified(anchor))
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
