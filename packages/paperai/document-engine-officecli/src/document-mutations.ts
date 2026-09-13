/** Ordered edits against original nodes in one candidate Word document XML. */

import type { Document as XmlDocument, Element as XmlElement, Node as XmlNode } from '@xmldom/xmldom'
import type { EngineMutation } from '@paperai/document-engine'
import { bindMutationTargets, resolveOfficePath } from './office-path.ts'

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
 * @param replaceParagraph - synchronous editor that preserves its target object and inserts any split siblings.
 * @param resolveStyle - resolve an explicit paragraph style name or ID to an existing Word style ID.
 * @throws when a referenced node was removed earlier, a position is invalid, or paragraph editing fails.
 */
export function applyDocumentMutations(
  root: XmlElement,
  mutations: readonly EngineMutation[],
  replaceParagraph: (target: XmlElement, mutation: Extract<EngineMutation, { type: 'replace-text' }>) => void,
  resolveStyle: (style: string) => string,
): void {
  const body = resolveOfficePath(root, '/body')
  const targets = bindMutationTargets(root, mutations)
  const attached = (path: string): XmlElement => {
    const target = targets.get(path) as XmlElement
    let ancestor: XmlNode | null = target
    while (ancestor !== null && ancestor !== body) ancestor = ancestor.parentNode
    if (ancestor !== body || target === body) {
      throw new Error(`INVALID_OFFICE_TARGET: '${path}' is not an attached body descendant`)
    }
    return target
  }
  for (const mutation of mutations) {
    switch (mutation.type) {
      case 'replace-text': {
        const target = attached(mutation.officePath)
        if (target.localName !== 'p') throw new Error(`INVALID_OFFICE_TARGET: '${mutation.officePath}' is not a paragraph`)
        replaceParagraph(target, mutation)
        break
      }
      case 'remove': {
        const target = attached(mutation.officePath)
        const parent = target.parentNode as XmlNode
        parent.removeChild(target)
        break
      }
      case 'insert-paragraph': {
        if ([mutation.after, mutation.before, mutation.index].filter(value => value !== undefined).length > 1) {
          throw new Error('INVALID_INSERT_POSITION: supply one of after, before, or index')
        }
        let parent: XmlElement = body
        let reference: XmlNode | null
        if (mutation.after !== undefined || mutation.before !== undefined) {
          const anchor = attached(mutation.after ?? mutation.before as string)
          parent = anchor.parentNode as XmlElement
          if (parent.localName !== 'body' && parent.localName !== 'tc') {
            throw new Error('INVALID_INSERT_POSITION: paragraphs must belong to the body or a table cell')
          }
          reference = mutation.after === undefined ? anchor : anchor.nextSibling
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
