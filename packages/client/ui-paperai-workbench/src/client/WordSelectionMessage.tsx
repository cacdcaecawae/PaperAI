/** Readable Word quotations over the frozen text stored in the session log. */

import { useMemo } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './WordSelectionMessage.module.css'

interface Citation {
  document: string
  path: string
  version: string | null
  revision: string
  blocks: string[]
  text: string
  /** Absent in citations logged before the flag existed. */
  includesUnsavedEdits?: boolean
}

function citation(text: string): Citation | undefined {
  if (!text.startsWith('[Word selection]\n')) return undefined
  let value: unknown
  try { value = JSON.parse(text.slice('[Word selection]\n'.length, -'\n[/Word selection]'.length)) } catch {
    // Malformed JSON stays visible as the original message text.
    return undefined
  }
  if (value === null || typeof value !== 'object') return undefined
  const fields = value as Record<string, unknown>
  // ponytail: the six-key arm keeps citations logged before this flag renderable; drop it when those sessions stop mattering.
  if (Object.keys(fields).length !== (fields.includesUnsavedEdits === undefined ? 6 : 7)
    || !['document', 'path', 'revision', 'text'].every(key => typeof fields[key] === 'string')
    || (fields.version !== null && typeof fields.version !== 'string')
    || (fields.includesUnsavedEdits !== undefined && typeof fields.includesUnsavedEdits !== 'boolean')
    || !Array.isArray(fields.blocks) || !fields.blocks.every(block => typeof block === 'string')) return undefined
  return fields as unknown as Citation
}

/**
 * Render exact selected text with an optional source disclosure; leave malformed context visible.
 * @param props - logged text elected by the workbench selector and its locale.
 * @returns quotation presentation without changing copy, persistence, or model content.
 */
export function WordSelectionMessage({ matched, t }: PropsRuntime<'conversation.message.userText'>
  & PropsLocale<'paperai.workbench'> & { matched: string }) {
  const parts = useMemo(() => matched.split(/(\[Word selection\]\n[^\n]+\n\[\/Word selection\])/gu)
    .map(text => ({ text, citation: citation(text) })), [matched])
  return <div className={css.message} data-word-selection-message>
    {parts.map((part, index) => part.citation === undefined
      ? <span key={index}>{part.text}</span>
      : <div key={index} className={css.citation}>
        <strong>{part.citation.path.split(/[\\/]/u).at(-1)}</strong>
        <blockquote>{part.citation.text}</blockquote>
        <details>
          <summary>{t('selection.source')}</summary>
          <span className={css.path}>{part.citation.path}</span>
          <dl>
            <dt>{t('selection.document')}</dt><dd>{part.citation.document}</dd>
            <dt>{t('selection.version')}</dt>
            <dd>{part.citation.version ?? part.citation.revision}
              {part.citation.includesUnsavedEdits === true && ` · ${t('selection.unsaved')}`}</dd>
            <dt>{t('selection.blocks')}</dt><dd>{part.citation.blocks.join(', ')}</dd>
          </dl>
        </details>
      </div>)}
  </div>
}
