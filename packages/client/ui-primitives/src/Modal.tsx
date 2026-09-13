// Modal: controlled full-viewport dialog (create-workspace and similar).
// The overlay portals to this document's body so ancestor stacking contexts
// cannot leave sticky page controls above the mask. This is still an in-page
// WebUI dialog; it never creates or targets another browser/native window.

import { useId, useLayoutEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { createFocusTrap } from 'focus-trap'
import clsx from 'clsx'
import { IconCloseOutline16 } from './icons/index.tsx'
import css from './Modal.module.css'

/** Multiple dialogs share one body-scroll lock, including non-LIFO teardown. */
const scrollLocks = new WeakMap<Document, { count: number; overflow: string }>()

/**
 * Render a centered modal over a blurred page mask.
 * @param props.open - whether the dialog is showing.
 * @param props.onClose - Escape or mask click.
 * @param props.title - dialog heading (aria-label in every mode).
 * @param props.closeLabel - accessible close-button label.
 * @param props.description - optional supporting sentence under the title.
 * @param props.children - body (inputs, etc.).
 * @param props.footer - action row (Cancel / Create).
 * @param props.contentClassName - optional class for a scrollable content region.
 * @param props.headless - render children directly in the card (no default
 * header/close/body chrome) for dialogs whose figma frame owns its own
 * header structure; mask, card, Escape, and aria-label remain.
 * @param props.closeLabel - close-button aria label; the owner passes
 * localized copy (this package is cordis-free, so copy arrives via props).
 * Opening traps focus, including owned body-portaled menus. Closing restores
 * the trigger without scrolling; Escape closes only the top dialog or menu.
 * @returns null when closed; otherwise the overlay tree.
 */
export function Modal({
  open, onClose, title, closeLabel = 'Close', description, children, footer, className, contentClassName, headless = false,
}: {
  open: boolean
  onClose: () => void
  title: string
  closeLabel?: string
  description?: string
  children?: ReactNode
  footer?: ReactNode
  className?: string
  contentClassName?: string
  headless?: boolean
}) {
  const id = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  const escapeRef = useRef<((event: KeyboardEvent) => void) | undefined>(undefined)
  closeRef.current = onClose
  useLayoutEffect(() => {
    if (!open) return
    const dialog = dialogRef.current
    /* v8 ignore next -- An open Modal always attaches its dialog before layout effects run. */
    if (dialog === null) return
    const doc = dialog.ownerDocument
    const lock = scrollLocks.get(doc) ?? { count: 0, overflow: doc.body.style.overflow }
    lock.count += 1
    scrollLocks.set(doc, lock)
    doc.body.style.overflow = 'hidden'
    const menus = () => [...doc.body.querySelectorAll<HTMLElement>('[data-dsw-modal-owner]')]
      .filter(menu => menu.dataset.dswModalOwner === id && !dialog.contains(menu))
    const trap = createFocusTrap([dialog, ...menus()], {
      fallbackFocus: dialog,
      preventScroll: true,
      delayInitialFocus: false,
      escapeDeactivates: false,
      allowOutsideClick: event => event.target === dialog.previousElementSibling,
      setReturnFocus: element => element.isConnected ? element : false,
    })
    const updateMenus = () => { trap.updateContainerElements([dialog, ...menus()]) }
    const observer = new MutationObserver(updateMenus)
    observer.observe(doc.body, { childList: true })
    trap.activate()
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || trap.paused || !trap.active) return
      // The menu owns its first Escape, even when portaled outside the dialog.
      if (dialog.querySelector('[role="menu"]') !== null || menus().length > 0) return
      e.preventDefault()
      e.stopImmediatePropagation()
      closeRef.current()
    }
    escapeRef.current = onKeyDown
    doc.addEventListener('keydown', onKeyDown)
    return () => {
      escapeRef.current = undefined
      observer.disconnect()
      doc.removeEventListener('keydown', onKeyDown)
      trap.deactivate()
      lock.count -= 1
      if (lock.count === 0) {
        doc.body.style.overflow = lock.overflow
        scrollLocks.delete(doc)
      }
    }
  }, [open, id])

  if (!open) return null

  return createPortal((
    <div className={css.root} role="presentation">
      <div className={css.mask} aria-hidden="true" onClick={onClose} />
      <div
        ref={dialogRef}
        data-dsw-modal={id}
        tabIndex={-1}
        className={clsx(css.dialog, className)}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onKeyDown={(event) => {
          if (event.key !== 'Escape' || event.defaultPrevented) return
          escapeRef.current?.(event.nativeEvent)
          if (event.nativeEvent.defaultPrevented) event.stopPropagation()
        }}
      >
        {headless
          ? children
          : (
            <>
              <div className={clsx(css.content, contentClassName)}>
                <div className={css.header}>
                  <h2 className={css.title}>{title}</h2>
                  <button type="button" className={css.close} aria-label={closeLabel} onClick={onClose}>
                    <IconCloseOutline16 size={14} />
                  </button>
                </div>
                {description !== undefined && description !== '' && (
                  <p className={css.description}>{description}</p>
                )}
                {children !== undefined && <div className={css.body}>{children}</div>}
              </div>
              {footer !== undefined && <div className={css.footer}>{footer}</div>}
            </>
          )}
      </div>
    </div>
  ), document.body)
}
