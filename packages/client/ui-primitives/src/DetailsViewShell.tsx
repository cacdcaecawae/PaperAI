/** Shared token-native chrome for full-column details surfaces. */
import type { ReactNode } from 'react'
import clsx from 'clsx'
import { IconCloseOutline16 } from './icons/index.tsx'
import css from './DetailsViewShell.module.css'

/** One tab rendered by the shared details shell. */
export interface DetailsViewShellTab {
  readonly id: string
  readonly label: string
}

/** Stable chrome shared by built-in and product-specific details views. */
export interface DetailsViewShellProps {
  readonly title: string
  readonly titleHint?: string
  /** Caption under the title: a string is clipped with its own tooltip, a node lays itself out. */
  readonly subtitle?: ReactNode
  /** Controls seated before the close action. */
  readonly actions?: ReactNode
  readonly closeLabel: string
  readonly onClose: () => void
  readonly tabs?: readonly DetailsViewShellTab[]
  readonly activeTab?: string
  readonly onSelectTab?: (id: string) => void
  readonly className?: string
  readonly children: ReactNode
}

/** Render the DSH details header, close action, and accessible tab strip. */
export function DetailsViewShell({
  title, titleHint, subtitle, actions, closeLabel, onClose, tabs = [], activeTab, onSelectTab, className, children,
}: DetailsViewShellProps): ReactNode {
  return (
    <div className={clsx(css.root, className)} data-dsh-details-shell>
      <header className={css.header}>
        <div className={css.heading}>
          <strong title={titleHint ?? title}>{title}</strong>
          {typeof subtitle === 'string'
            ? <span title={subtitle}>{subtitle}</span>
            : subtitle == null ? null : <div className={css.subtitle}>{subtitle}</div>}
        </div>
        {actions != null && <div className={css.actions}>{actions}</div>}
        <button type="button" className={css.close} aria-label={closeLabel} onClick={onClose}>
          <IconCloseOutline16 />
        </button>
      </header>
      {tabs.length > 0 && (
        <div className={css.tabs} role="tablist" aria-label={title}>
          {tabs.map(tab => (
            <button
              type="button"
              role="tab"
              key={tab.id}
              className={clsx(css.tab, activeTab === tab.id && css.tabActive)}
              aria-selected={activeTab === tab.id}
              tabIndex={activeTab === tab.id ? 0 : -1}
              onClick={() => { onSelectTab?.(tab.id) }}
            >
              {tab.label}
            </button>
          ))}
        </div>
      )}
      {children}
    </div>
  )
}
