/** Persistent native document controls; the preview retains and applies their target selection. */
import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { PaperAIDocumentWorkbenchProps } from './slots.ts'
import type { PaperAIDocumentSnapshot, PaperAIParagraphFormat } from './types.ts'
import css from './EditorRibbon.module.css'

/** Formatting of the caret or selected text; `mixed` preserves distinct readings. */
export interface EditorFormat {
  readonly bold: boolean | 'mixed'
  readonly italic: boolean | 'mixed'
  readonly underline: boolean | 'mixed'
  readonly size: string
  readonly font: string
  readonly sizeSource: 'inherited' | 'explicit' | 'mixed'
  readonly fontSource: 'inherited' | 'explicit' | 'mixed'
  readonly collapsed: boolean
  readonly paragraph: PaperAIParagraphFormat
  readonly paragraphMixed: boolean
}

/** Props for document commands over a preserved selection. */
interface EditorRibbonProps {
  readonly caret: EditorFormat | null
  readonly fonts: readonly string[]
  readonly paragraphStyles: PaperAIDocumentSnapshot['paragraphStyles']
  readonly disabled: boolean
  readonly dirty: boolean
  readonly undo: boolean
  readonly redo: boolean
  readonly onSave: () => void
  readonly onUndo: () => void
  readonly onRedo: () => void
  readonly onToggle: (key: 'b' | 'i' | 'u') => void
  readonly onFormat: (patch: Readonly<Record<string, string>>) => void
  readonly onParagraph: (patch: PaperAIParagraphFormat) => void
  readonly onClear: () => void
  readonly onFind: (query: string) => boolean
  readonly quote: boolean
  readonly onQuote: (() => void) | undefined
  readonly t: PaperAIDocumentWorkbenchProps['t']
}

/** Buttons use arrow navigation; native inputs retain arrows and use Tab to reach their neighbour. */
function moveButton(event: KeyboardEvent<HTMLDivElement>): void {
  if (!(event.target instanceof HTMLElement)) return
  const nativeInput = event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement
  if (nativeInput ? event.key !== 'Tab' : !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  const controls = [...event.currentTarget.querySelectorAll<HTMLButtonElement | HTMLSelectElement | HTMLInputElement>('button, select, input')]
    .filter(control => !control.disabled)
  const index = controls.findIndex(control => control === event.target)
  if (nativeInput) {
    const next = controls[index + (event.shiftKey ? -1 : 1)]
    if (next !== undefined) { event.preventDefault(); next.focus() }
    return
  }
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? controls.length - 1
    : (index + (event.key === 'ArrowRight' ? 1 : -1) + controls.length) % controls.length
  event.preventDefault()
  controls[next]?.focus()
}

/** Render compact commands with native keyboard controls and explicit mixed/inherited readings. */
export function EditorRibbon(props: EditorRibbonProps): ReactNode {
  const { caret, t } = props
  const [paragraphOpen, setParagraphOpen] = useState(false)
  const [findOpen, setFindOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [noMatch, setNoMatch] = useState(false)
  const toolbar = useRef<HTMLDivElement>(null)
  const tabStop = useRef<HTMLElement | null>(null)
  const setTabStop = (preferred: HTMLElement | null): void => {
    const controls = [...toolbar.current?.querySelectorAll<HTMLButtonElement | HTMLSelectElement | HTMLInputElement>('button, select, input') ?? []]
      .filter(control => !control.disabled)
    const selected = preferred !== null && controls.some(control => control === preferred) ? preferred : controls[0] ?? null
    for (const control of controls) control.tabIndex = control === selected ? 0 : -1
    tabStop.current = selected
  }
  useLayoutEffect(() => { setTabStop(tabStop.current) })
  const unavailable = props.disabled || caret === null
  const currentStyle = caret?.paragraph.style ?? ''
  const sizes = [...new Set([9, 10.5, 11, 12, 14, 15, 16, 18, 22, 24, 28, 36,
    ...(caret === null || caret.size === 'mixed' || caret.size === '' ? [] : [parseFloat(caret.size)])])].sort((a, b) => a - b)
  const sourceLabel = (source: EditorFormat['sizeSource'] | undefined): string =>
    source === 'mixed' ? t('editor.mixed') : source === 'explicit' ? t('editor.explicit') : t('editor.inherited')
  return (
    <div ref={toolbar} className={css.ribbon} role="toolbar" aria-label={t('editor.ribbon')} aria-orientation="horizontal" onKeyDown={moveButton}
      onFocusCapture={(event) => { if (event.target instanceof HTMLElement) setTabStop(event.target) }}>
      <div className={css.group} role="group" aria-label={t('editor.save')}>
        <button type="button" disabled={props.disabled || !props.dirty} title={`${t('editor.save')} (Ctrl+S)`}
          aria-keyshortcuts="Control+s Meta+s" onClick={props.onSave}>{t('block.save')}</button>
        <button type="button" disabled={props.disabled || !props.undo} aria-label={t('editor.undo')} title={`${t('editor.undo')} (Ctrl+Z)`}
          onMouseDown={(event) =>{  event.preventDefault() }} onClick={props.onUndo}>↶</button>
        <button type="button" disabled={props.disabled || !props.redo} aria-label={t('editor.redo')} title={`${t('editor.redo')} (Ctrl+Shift+Z)`}
          onMouseDown={(event) =>{  event.preventDefault() }} onClick={props.onRedo}>↷</button>
      </div>
      <div className={css.group} role="group" aria-label={t('block.format')}>
        <select className={css.font} aria-label={t('editor.font')} title={`${t('editor.font')} · ${sourceLabel(caret?.fontSource)}`}
          disabled={unavailable} value={caret?.font ?? ''} onChange={(event) =>{  props.onFormat({ 'font-family': event.target.value }) }}>
          {(caret === null || caret.font === '' || caret.font === 'mixed') && <option value={caret?.font ?? ''}>{caret === null ? '—' : t(caret.font === 'mixed' ? 'editor.mixed' : 'editor.fontUnspecified')}</option>}
          {[...new Set([...props.fonts, ...(caret === null || caret.font === 'mixed' || caret.font === '' ? [] : [caret.font])])].map(font => <option key={font} value={font}>{font}{caret?.font === font && caret.fontSource === 'inherited' ? ` · ${t('editor.inherited')}` : ''}</option>)}
        </select>
        <select className={css.size} aria-label={t('editor.size')} title={`${t('editor.size')} · ${sourceLabel(caret?.sizeSource)}`}
          disabled={unavailable} value={caret?.size ?? ''} onChange={(event) =>{  props.onFormat({ 'font-size': event.target.value }) }}>
          {(caret === null || caret.size === '' || caret.size === 'mixed') && <option value={caret?.size ?? ''}>{caret?.size === 'mixed' ? t('editor.mixed') : '—'}</option>}
          {sizes.map(size => <option key={size} value={`${size}pt`}>{size}{caret?.size === `${size}pt` && caret.sizeSource === 'inherited' ? ` · ${t('editor.inherited')}` : ''}</option>)}
        </select>
        {([['b', 'bold', 'B'], ['i', 'italic', 'I'], ['u', 'underline', 'U']] as const).map(([key, property, label]) => (
          <button type="button" key={key} data-format={key} aria-label={t(`block.${property}`)}
            style={key === 'b' ? { fontWeight: 'bold' } : key === 'i' ? { fontStyle: 'italic' } : { textDecoration: 'underline' }}
            title={`${t(`block.${property}`)} (Ctrl+${label})`} aria-pressed={caret?.[property] ?? false} disabled={unavailable}
            onMouseDown={(event) =>{  event.preventDefault() }} onClick={() =>{  props.onToggle(key) }}>{label}</button>
        ))}
        <button type="button" disabled={unavailable} aria-label={t('editor.clear')} title={t('editor.clear')} onMouseDown={(event) =>{  event.preventDefault() }} onClick={props.onClear}>Tx</button>
      </div>
      <div className={css.group}>
        <button type="button" disabled={unavailable} aria-expanded={paragraphOpen} onClick={() =>{  setParagraphOpen(open => !open) }}>{t('editor.paragraph')}</button>
        <button type="button" aria-expanded={findOpen} onClick={() =>{  setFindOpen(open => !open) }}>{t('editor.find')}</button>
        {props.onQuote !== undefined && <button type="button" disabled={!props.quote} title={t('selection.title')}
          onMouseDown={(event) => { event.preventDefault() }} onClick={props.onQuote}>{t('selection.ask')}</button>}
      </div>
      <span className={css.scope}>{caret === null ? t('editor.noCaret') : t(caret.collapsed ? 'editor.insertion' : 'editor.selection')}</span>
      {paragraphOpen && <div className={css.paragraph} role="group" aria-label={t('editor.paragraph')}>
        <label>{t('editor.style')}<select aria-label={t('editor.style')} disabled={unavailable || props.paragraphStyles.length === 0} value={currentStyle} onChange={(event) =>{  props.onParagraph({ style: event.target.value }) }}>
          <option value="" disabled>{t(caret?.paragraphMixed === true ? 'editor.mixed' : 'editor.applyStyle')}</option>
          {currentStyle !== '' && !props.paragraphStyles.some(style => style.id === currentStyle)
            && <option value={currentStyle} disabled>{currentStyle}</option>}
          {props.paragraphStyles.map(style => <option key={style.id} value={style.id}>{style.name}</option>)}
        </select></label>
        <label>{t('editor.align')}<select aria-label={t('editor.align')} disabled={unavailable} value={caret?.paragraph.align ?? ''} onChange={(event) =>{  props.onParagraph({ align: event.target.value as NonNullable<PaperAIParagraphFormat['align']> }) }}>
          <option value="" disabled>{t(caret?.paragraphMixed === true ? 'editor.mixed' : 'editor.inherited')}</option>
          {(['left', 'center', 'right', 'justify'] as const).map(align => <option key={align} value={align}>{t(`editor.${align}`)}</option>)}
        </select></label>
        <label>{t('editor.indent')}<input aria-label={t('editor.indent')} type="number" min="0" max="720" step="6" disabled={unavailable}
          value={caret?.paragraphMixed === true ? '' : parseFloat(caret?.paragraph.indent ?? '0')} onChange={(event) => { if (event.target.value !== '') props.onParagraph({ indent: `${event.target.value}pt` }) }} /></label>
        <label>{t('editor.spacing')}<select aria-label={t('editor.spacing')} disabled={unavailable} value={caret?.paragraph.lineSpacing ?? ''} onChange={(event) =>{  props.onParagraph({ lineSpacing: event.target.value }) }}>
          <option value="" disabled>{t(caret?.paragraphMixed === true ? 'editor.mixed' : 'editor.inherited')}</option>
          {['1x', '1.15x', '1.5x', '2x'].map(value => <option key={value} value={value}>{value}</option>)}
        </select></label>
      </div>}
      {findOpen && <div className={css.find} role="search">
        <input aria-label={t('editor.findPlaceholder')} placeholder={t('editor.findPlaceholder')} value={query}
          onChange={(event) => { setQuery(event.target.value); setNoMatch(false) }}
          onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); setNoMatch(!props.onFind(query)) } }} />
        <button type="button" disabled={query === ''} onClick={() =>{  setNoMatch(!props.onFind(query)) }}>{t('editor.findNext')}</button>
        {noMatch && <span role="status">{t('editor.findNone')}</span>}
      </div>}
    </div>
  )
}
