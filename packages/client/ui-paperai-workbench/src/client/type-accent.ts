/** Per-row accent for a document type, read from the brand layer's --paperai-type-* tokens. */

import type { CSSProperties } from 'react'
import type { PaperAIDocumentType } from './types.ts'

/**
 * Custom properties a row sets so its icon and badge take the type's ink and
 * tint; `other` sets none, and the row's fallbacks keep the neutral labels.
 * @param type - the document's type.
 * @returns an inline style for the row, or `undefined` for `other`.
 */
export function typeAccent(type: PaperAIDocumentType): CSSProperties | undefined {
  if (type === 'other') return undefined
  return {
    '--paperai-row-accent': `var(--paperai-type-${type})`,
    '--paperai-row-tint': `var(--paperai-type-${type}-tint)`,
  } as CSSProperties
}
