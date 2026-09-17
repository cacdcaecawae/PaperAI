/** Line icons for document commands, in the 16px 1.5-stroke idiom of the DSH icon set. */
import type { ReactNode } from 'react'

/** Size and class of one icon; every icon is decorative and named by its button. */
interface EditorIconProps {
  readonly size?: number
  readonly className?: string | undefined
}

function Line({ d, size = 16, className }: EditorIconProps & { readonly d: string }): ReactNode {
  return (
    <svg aria-hidden="true" className={className} focusable="false" width={size} height={size} viewBox="0 0 16 16"
      fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  )
}

/** An arrow curling back to the left. */
export function IconUndo(props: EditorIconProps): ReactNode {
  return <Line {...props} d="M6 4.5 3.5 7 6 9.5M3.5 7h6a3 3 0 0 1 0 6H8" />
}

/** The undo arrow mirrored. */
export function IconRedo(props: EditorIconProps): ReactNode {
  return <Line {...props} d="M10 4.5 12.5 7 10 9.5M12.5 7h-6a3 3 0 0 0 0 6h1.5" />
}

/** Three lines flush left. */
export function IconAlignLeft(props: EditorIconProps): ReactNode {
  return <Line {...props} d="M2.5 4h11M2.5 8h7M2.5 12h11" />
}

/** Three lines centred. */
export function IconAlignCenter(props: EditorIconProps): ReactNode {
  return <Line {...props} d="M2.5 4h11M4.5 8h7M2.5 12h11" />
}

/** Three lines flush right. */
export function IconAlignRight(props: EditorIconProps): ReactNode {
  return <Line {...props} d="M2.5 4h11M6.5 8h7M2.5 12h11" />
}

/** Three full-width lines. */
export function IconAlignJustify(props: EditorIconProps): ReactNode {
  return <Line {...props} d="M2.5 4h11M2.5 8h11M2.5 12h11" />
}

/** A minus sign, paired with the plus icon of the DSH set. */
export function IconZoomOut(props: EditorIconProps): ReactNode {
  return <Line {...props} d="M4 8h8" />
}
