/** One row of document commands; the preview retains and applies their target selection. */
import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { IconChevronDownOutline14, IconSearchOutline16, Input, Menu, type MenuEntry, type MenuItem } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PaperAIDocumentWorkbenchProps } from './slots.ts'
import type { PaperAIDocumentSnapshot, PaperAIParagraphFormat } from './types.ts'
import { IconAlignCenter, IconAlignJustify, IconAlignLeft, IconAlignRight, IconRedo, IconUndo } from './editor-icons.tsx'
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
  readonly undo: boolean
  readonly redo: boolean
  readonly onUndo: () => void
  readonly onRedo: () => void
  readonly onToggle: (key: 'b' | 'i' | 'u') => void
  readonly onFormat: (patch: Readonly<Record<string, string>>) => void
  readonly onParagraph: (patch: PaperAIParagraphFormat) => void
  readonly onClear: () => void
  readonly onFind: (query: string) => boolean
  readonly t: PaperAIDocumentWorkbenchProps['t']
}

type Picker = 'font' | 'size' | 'paragraph'
type Align = NonNullable<PaperAIParagraphFormat['align']>

const SIZES = [9, 10.5, 11, 12, 14, 15, 16, 18, 22, 24, 28, 36]
const ALIGNS: readonly Align[] = ['left', 'center', 'right', 'justify']
const ALIGN_ICONS = { left: IconAlignLeft, center: IconAlignCenter, right: IconAlignRight, justify: IconAlignJustify } as const
const SPACINGS = ['1x', '1.15x', '1.5x', '2x']
const INDENTS = [0, 12, 24, 36, 48, 72]

/** Buttons use arrow navigation; the find field keeps its arrows and uses Tab to reach a neighbour; open menus own their keys. */
function moveButton(event: KeyboardEvent<HTMLDivElement>): void {
  if (!(event.target instanceof HTMLElement) || event.target.closest('[role="menu"]') !== null) return
  const nativeInput = event.target instanceof HTMLInputElement
  if (nativeInput ? event.key !== 'Tab' : !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  const controls = [...event.currentTarget.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input')]
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

/** Split a grouped menu id at its first colon. */
function parts(id: string): [string, string] {
  const at = id.indexOf(':')
  return [id.slice(0, at), id.slice(at + 1)]
}

/** Render the commands with roving focus, a menu for every choice, and explicit mixed/inherited readings. */
export function EditorRibbon(props: EditorRibbonProps): ReactNode {
  const { caret, t } = props
  const [picker, setPicker] = useState<Picker | null>(null)
  const [findOpen, setFindOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [noMatch, setNoMatch] = useState(false)
  const toolbar = useRef<HTMLDivElement>(null)
  const tabStop = useRef<HTMLElement | null>(null)
  const setTabStop = (preferred: HTMLElement | null): void => {
    const controls = [...toolbar.current?.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input') ?? []]
      .filter(control => !control.disabled)
    const selected = preferred !== null && controls.some(control => control === preferred) ? preferred : controls[0] ?? null
    for (const control of controls) control.tabIndex = control === selected ? 0 : -1
    tabStop.current = selected
  }
  useLayoutEffect(() => { setTabStop(tabStop.current) })
  const unavailable = props.disabled || caret === null
  const sourceLabel = (source: EditorFormat['sizeSource'] | undefined): string =>
    source === 'mixed' ? t('editor.mixed') : source === 'explicit' ? t('editor.explicit') : t('editor.inherited')
  const scope = caret === null ? t('editor.noCaret') : t(caret.collapsed ? 'editor.insertion' : 'editor.selection')
  const toggle = (name: Picker): void => { setPicker(current => current === name ? null : name) }
  const close = (name: Picker): void => { setPicker(current => current === name ? null : current) }
  // The trigger reads the current value; inherited, mixed, and caretless readings are muted words, never a dash to decode.
  const trigger = (name: Picker, label: string, reading: string, muted: boolean, title: string): ReactNode => (
    <button type="button" className={css.select} aria-label={label} title={title} aria-haspopup="menu" aria-expanded={picker === name}
      disabled={unavailable} data-muted={muted || undefined} onClick={() => { toggle(name) }}>
      <span>{reading}</span>
      <IconChevronDownOutline14 />
    </button>
  )

  const fontValue = caret?.font ?? ''
  const fontMuted = fontValue === '' || fontValue === 'mixed' || caret?.fontSource === 'inherited'
  const fontReading = caret === null ? t('editor.font') : fontValue === 'mixed' ? t('editor.mixed') : fontValue === '' ? t('editor.inherited') : fontValue
  // Every list opens with the inherited reading, so a stated value can be taken back to the block's.
  const inherit: MenuEntry[] = [{ id: '', label: t('editor.inherited') }, { type: 'separator', id: 'inherit' }]
  const fontItems: MenuEntry[] = [...inherit, ...[...new Set([...props.fonts, ...(fontValue === '' || fontValue === 'mixed' ? [] : [fontValue])])]
    .map(font => ({ id: font, label: font }))]

  const sizeValue = caret?.size ?? ''
  const sizeMuted = sizeValue === '' || sizeValue === 'mixed' || caret?.sizeSource === 'inherited'
  const sizeReading = caret === null ? t('editor.size') : sizeValue === 'mixed' ? t('editor.mixed') : sizeValue === '' ? t('editor.inherited') : String(parseFloat(sizeValue))
  const sizeItems: MenuEntry[] = [...inherit, ...[...new Set([...SIZES, ...(sizeValue === '' || sizeValue === 'mixed' ? [] : [parseFloat(sizeValue)])])]
    .sort((a, b) => a - b).map(size => ({ id: `${size}pt`, label: String(size) }))]

  const currentStyle = caret?.paragraph.style ?? ''
  const styles: MenuItem[] = [
    ...(currentStyle !== '' && !props.paragraphStyles.some(style => style.id === currentStyle)
      ? [{ id: `style:${currentStyle}`, label: currentStyle, disabled: true }] : []),
    ...props.paragraphStyles.map(style => ({ id: `style:${style.id}`, label: style.name })),
  ]
  const paragraphItems: MenuEntry[] = [
    { id: 'style', label: t('editor.style'), disabled: styles.length === 0, submenu: styles },
    { id: 'align', label: t('editor.align'), submenu: ALIGNS.map((align) => {
      const Icon = ALIGN_ICONS[align]
      return { id: `align:${align}`, label: t(`editor.${align}`), icon: <Icon /> }
    }) },
    { id: 'spacing', label: t('editor.spacing'), submenu: SPACINGS.map(value => ({ id: `spacing:${value}`, label: value })) },
    { id: 'indent', label: t('editor.indent'), submenu: INDENTS.map(value => ({ id: `indent:${value}`, label: t('editor.indentValue', { value }) })) },
  ]
  const paragraph = caret === null || caret.paragraphMixed ? undefined : caret.paragraph
  const paragraphSelected = paragraph === undefined ? [] : [
    ...(paragraph.style ? [`style:${paragraph.style}`] : []),
    ...(paragraph.align ? [`align:${paragraph.align}`] : []),
    ...(paragraph.lineSpacing ? [`spacing:${paragraph.lineSpacing}`] : []),
    ...(paragraph.indent ? [`indent:${parseFloat(paragraph.indent)}`] : []),
  ]
  const pickParagraph = (id: string): void => {
    const [kind, value] = parts(id)
    if (kind === 'style') props.onParagraph({ style: value })
    else if (kind === 'align') props.onParagraph({ align: value as Align })
    else if (kind === 'spacing') props.onParagraph({ lineSpacing: value })
    else if (kind === 'indent') props.onParagraph({ indent: `${value}pt` })
    setPicker(null)
  }

  return (
    <div ref={toolbar} className={css.ribbon} role="toolbar" aria-label={t('editor.ribbon')} aria-orientation="horizontal"
      onKeyDown={moveButton} onFocusCapture={(event) => { if (event.target instanceof HTMLElement) setTabStop(event.target) }}>
      <div className={css.group} role="group" aria-label={t('editor.history')}>
        <button type="button" className={css.tool} disabled={props.disabled || !props.undo} aria-label={t('editor.undo')} title={`${t('editor.undo')} (Ctrl+Z)`}
          onMouseDown={(event) => { event.preventDefault() }} onClick={props.onUndo}><IconUndo /></button>
        <button type="button" className={css.tool} disabled={props.disabled || !props.redo} aria-label={t('editor.redo')} title={`${t('editor.redo')} (Ctrl+Shift+Z)`}
          onMouseDown={(event) => { event.preventDefault() }} onClick={props.onRedo}><IconRedo /></button>
      </div>
      <div className={css.group} role="group" aria-label={t('block.format')}>
        <Menu portal dense open={picker === 'font'} selectedId={fontValue} items={fontItems}
          anchor={trigger('font', t('editor.font'), fontReading, fontMuted, `${t('editor.font')} · ${sourceLabel(caret?.fontSource)} · ${scope}`)}
          onSelect={(id) => { setPicker(null); props.onFormat({ 'font-family': id }) }} onClose={() => { close('font') }} />
        <Menu portal dense open={picker === 'size'} selectedId={sizeValue} items={sizeItems}
          anchor={trigger('size', t('editor.size'), sizeReading, sizeMuted, `${t('editor.size')} · ${sourceLabel(caret?.sizeSource)} · ${scope}`)}
          onSelect={(id) => { setPicker(null); props.onFormat({ 'font-size': id }) }} onClose={() => { close('size') }} />
        {([['b', 'bold', 'B'], ['i', 'italic', 'I'], ['u', 'underline', 'U']] as const).map(([key, property, label]) => (
          <button type="button" key={key} className={css.tool} data-format={key} aria-label={t(`block.${property}`)}
            style={key === 'b' ? { fontWeight: 'bold' } : key === 'i' ? { fontStyle: 'italic' } : { textDecoration: 'underline' }}
            title={`${t(`block.${property}`)} (Ctrl+${label})`} aria-pressed={caret?.[property] ?? false} disabled={unavailable}
            onMouseDown={(event) => { event.preventDefault() }} onClick={() => { props.onToggle(key) }}>{label}</button>
        ))}
        <button type="button" className={css.tool} disabled={unavailable} aria-label={t('editor.clear')} title={t('editor.clear')}
          onMouseDown={(event) => { event.preventDefault() }} onClick={props.onClear}>Tx</button>
      </div>
      <div className={css.group}>
        <Menu portal dense open={picker === 'paragraph'} selectedIds={paragraphSelected} items={paragraphItems}
          anchor={(
            <button type="button" className={css.select} aria-haspopup="menu" aria-expanded={picker === 'paragraph'} disabled={unavailable}
              title={caret?.paragraphMixed === true ? `${t('editor.paragraph')} · ${t('editor.mixed')}` : t('editor.paragraph')}
              onClick={() => { toggle('paragraph') }}>
              <span>{t('editor.paragraph')}</span>
              <IconChevronDownOutline14 />
            </button>
          )}
          onSelect={pickParagraph} onClose={() => { close('paragraph') }} />
        <button type="button" className={css.tool} aria-label={t('editor.find')} title={t('editor.find')} aria-expanded={findOpen}
          onClick={() => { setFindOpen(open => !open) }}><IconSearchOutline16 /></button>
        {findOpen && <div className={css.find} role="search">
          <Input className={css.findInput ?? ''} aria-label={t('editor.findPlaceholder')} placeholder={t('editor.findPlaceholder')} value={query}
            onChange={(event) => { setQuery(event.target.value); setNoMatch(false) }}
            onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); setNoMatch(!props.onFind(query)) } }} />
          <button type="button" className={css.tool} disabled={query === ''} onClick={() => { setNoMatch(!props.onFind(query)) }}>{t('editor.findNext')}</button>
          {noMatch && <span role="status" className={css.noMatch}>{t('editor.findNone')}</span>}
        </div>}
      </div>
    </div>
  )
}
