/** Original Word node bindings for an ordered mutation batch. */

import type { Element as XmlElement } from '@xmldom/xmldom'
import type { EngineMutation } from '@paperai/document-engine'

const WORD_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const WORD_ID_NS = 'http://schemas.microsoft.com/office/word/2010/wordml'

/**
 * Resolve one OfficeCLI body address against the unmodified document XML.
 * @param root - Word document element whose descendants are addressed.
 * @param officePath - numeric or paraId address, optionally prefixed by /document.
 * @returns the uniquely addressed original element.
 * @throws when the address is unsupported, missing, or ambiguous.
 */
export function resolveOfficePath(root: XmlElement, officePath: string): XmlElement {
  const reject: () => never = () => { throw new Error(`INVALID_OFFICE_PATH: '${officePath}' does not identify one Word body node`) }
  if (root.namespaceURI !== WORD_NS || root.localName !== 'document') reject()
  const path = officePath.replace(/^\/document(?=\/)/u, '')
  if (!path.startsWith('/body')) reject()
  let node = root
  for (const segment of path.slice(1).split('/')) {
    const match = /^(body|tbl|tr|tc|p)(?:\[(?:(\d+)|@paraId=(['"]?)([A-Za-z0-9]+)\3)\])?$/u.exec(segment)
    if (match === null || (match[4] !== undefined && match[1] !== 'p')) reject()
    const candidates = Array.from(node.childNodes).filter((child): child is XmlElement =>
      child.nodeType === child.ELEMENT_NODE && child.namespaceURI === WORD_NS && child.localName === match[1])
    const found = match[4] !== undefined
      ? candidates.filter(child => child.getAttributeNS(WORD_ID_NS, 'paraId') === match[4])
      : match[2] === undefined ? candidates : candidates.slice(Number(match[2]) - 1, Number(match[2]))
    const [target, duplicate] = found
    if (target === undefined || duplicate !== undefined) reject()
    node = target
  }
  return node
}

/**
 * Bind every batch reference before any insertion, removal, or paragraph split.
 * @param root - unmodified Word document element.
 * @param mutations - mutations in caller order; repeated paths share one node.
 * @returns original DOM elements keyed by their supplied OfficeCLI paths.
 * @throws when any referenced original node cannot be uniquely resolved.
 */
export function bindMutationTargets(root: XmlElement, mutations: readonly EngineMutation[]): Map<string, XmlElement> {
  const targets = new Map<string, XmlElement>()
  const bind = (path: string | undefined): void => {
    if (path !== undefined && !targets.has(path)) targets.set(path, resolveOfficePath(root, path))
  }
  for (const mutation of mutations) {
    switch (mutation.type) {
      case 'replace-text':
      case 'remove':
        bind(mutation.officePath)
        break
      case 'insert-paragraph':
        bind(mutation.after)
        bind(mutation.before)
        break
      /* v8 ignore next 4 -- EngineMutation is a closed same-process union. */
      default: {
        const unsupported: never = mutation
        throw new Error(`Unsupported engine mutation: ${String(unsupported)}`)
      }
    }
  }
  return targets
}
