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
  if (Object.keys(fields).length !== 6
    || !['document', 'path', 'revision', 'text'].every(key => typeof fields[key] === 'string')
    || (fields.version !== null && typeof fields.version !== 'string')
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
        <blockquote>{part.citation.text}</blockquote>
        <details>
          <summary>{t('selection.source')}</summary>
          <span className={css.path}>{part.citation.path}</span>
          <pre>{JSON.stringify(part.citation, null, 2)}</pre>
        </details>
      </div>)}
  </div>
}
