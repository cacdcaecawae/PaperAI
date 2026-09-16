/** One discrete setting as a menu-driven button: the DSH Menu in place of a native select. */
import { useState, type ReactNode } from 'react'
import { IconChevronDownOutline14, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './SettingsSection.module.css'

/** A selectable option: its stored id and the name people read. */
export interface ChoiceOption {
  readonly id: string
  readonly name: string
}

/**
 * Render a labelled choice whose options open in a DSH menu; a value outside the
 * options still reads on the button, so a provider-owned setting stays visible.
 * @param props.label - accessible name of the control.
 * @param props.value - the stored value.
 * @param props.options - the values people may pick, in display order.
 * @param props.disabled - true while the value is read-only or its owner is busy.
 * @param props.onChange - receives the picked id.
 * @returns the anchored menu with its trigger button.
 */
export function Choice({ label, value, options, disabled = false, onChange }: {
  readonly label: string
  readonly value: string
  readonly options: readonly ChoiceOption[]
  readonly disabled?: boolean
  readonly onChange: (id: string) => void
}): ReactNode {
  const [open, setOpen] = useState(false)
  const current = options.find(option => option.id === value)
  return (
    <Menu
      portal
      dense
      open={open}
      selectedId={value}
      items={options.map(option => ({ id: option.id, label: option.name }))}
      anchor={(
        <button
          type="button"
          className={css.choice}
          aria-label={label}
          aria-haspopup="menu"
          aria-expanded={open}
          disabled={disabled}
          onClick={() => { setOpen(state => !state) }}
        >
          <span>{current?.name ?? value}</span>
          <IconChevronDownOutline14 />
        </button>
      )}
      onSelect={(id) => { setOpen(false); onChange(id) }}
      onClose={() => { setOpen(false) }}
    />
  )
}
