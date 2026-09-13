/**
 * The root entry's layout store: panel geometry as plain widths in
 * px (0 = closed). Module level exports the factory only — a module-level
 * handle would pin the store's identity in the module
 * cache (a de-facto singleton surviving plugin reloads). register() receives
 * the factory (exclusive use: the framework instantiates per entry), AppFrame
 * derives its PropsStore share from the return type, and the service face
 * receives the bound actions through the registration's inject hook.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'
import type { LayoutGeometry } from '../config.ts'
import { DEFAULT_LAYOUT_GEOMETRY } from '../config.ts'
import {
  clampWidth, SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN,
} from './columns.ts'

/**
 * Layout store state: panel width preferences in px (0 = closed), plus the
 * narrow-viewport pair — `narrow` mirrors AppFrame's breakpoint reading
 * (viewport < SIDEBAR_AUTO_COLLAPSE) so toggleSidebar can pick semantics, and
 * `narrowExpanded` is the manual override that re-expands the auto-collapsed
 * sidebar over the squeezed center without rewriting the width preference.
 */
type LayoutState = {
  sidebar: number
  details: number
  sidebarWidth: number
  detailsWidth: number | null
  narrow: boolean
  narrowExpanded: boolean
  /** Explicit focus demand: an open details panel takes the whole content area regardless of viewport width. */
  detailsFocus: boolean
  /** Prefer the conversation when both content panels cannot fit. */
  conversationFocus: boolean
}

const PREFERENCE_KEY = 'dsh.layout.preferences'

/** Only user geometry survives reload; open document views and focus demands are transient. */
function preferences(): Pick<LayoutState, 'sidebar' | 'sidebarWidth' | 'detailsWidth'> {
  const fallback = { sidebar: SIDEBAR_DEFAULT, sidebarWidth: SIDEBAR_DEFAULT, detailsWidth: null }
  try {
    if (typeof localStorage === 'undefined') return fallback
    const raw: unknown = JSON.parse(localStorage.getItem(PREFERENCE_KEY) ?? 'null')
    if (raw === null || typeof raw !== 'object') return fallback
    const value = raw as Record<string, unknown>
    const sidebarWidth = typeof value.sidebarWidth === 'number' && Number.isFinite(value.sidebarWidth)
      ? clampWidth(value.sidebarWidth, SIDEBAR_MIN, SIDEBAR_MAX) : SIDEBAR_DEFAULT
    return {
      sidebar: value.sidebar === 0 ? 0 : sidebarWidth,
      sidebarWidth,
      detailsWidth: typeof value.detailsWidth === 'number' && Number.isFinite(value.detailsWidth) && value.detailsWidth > 0
        ? value.detailsWidth : null,
    }
  } catch {
    // Invalid JSON and unavailable browser storage leave the layout usable with default widths.
    return fallback
  }
}

function remember(state: LayoutState): void {
  if (typeof localStorage === 'undefined') return
  const serialized = JSON.stringify({ sidebar: state.sidebar, sidebarWidth: state.sidebarWidth, detailsWidth: state.detailsWidth })
  try {
    localStorage.setItem(PREFERENCE_KEY, serialized)
  } catch {
    // Storage quota and privacy restrictions leave the current in-memory preference usable.
  }
}

/**
 * Annotation twin of the actions literal below (the export needs a declared
 * return type); drift fails assignability at the defineStore call.
 */
type LayoutActions = {
  setSidebar: (draft: LayoutState, px: number) => void
  setDetails: (draft: LayoutState, px: number, activeGeometry?: LayoutGeometry) => void
  toggleSidebar: (draft: LayoutState) => void
  setNarrow: (draft: LayoutState, narrow: boolean) => void
  openDetails: (draft: LayoutState, activeGeometry?: LayoutGeometry) => void
  closeDetails: (draft: LayoutState) => void
  setDetailsFocus: (draft: LayoutState, active: boolean) => void
  revealConversation: (draft: LayoutState) => void
}

/**
 * Create the layout panel store handle. Closed panels retain their preferred
 * widths in browser storage. Actions are the complete write set: drag writes clamp
 * into the panel's contract range and never cross the open/closed line;
 * open/close transitions preserve the last width. Below the
 * auto-collapse breakpoint (AppFrame feeds setNarrow) the sidebar toggle
 * flips the narrowExpanded override instead of the preference.
 * @param geometry - validated center/details geometry; omitted for the original DSH values.
 * @returns the store handle (spec + type + identity + factory in one).
 */
export function createLayoutStore(
  geometry: LayoutGeometry = DEFAULT_LAYOUT_GEOMETRY,
): EngineStoreHandle<LayoutState, LayoutActions>  {
  const handle = defineStore({
    init: (): LayoutState => ({
      ...preferences(), details: 0, narrow: false, narrowExpanded: false, detailsFocus: false, conversationFocus: false,
    }),
    actions: {
      setSidebar: (d, px: number) => {
        d.sidebar = d.sidebarWidth = clampWidth(px, SIDEBAR_MIN, SIDEBAR_MAX)
        remember(d)
      },
      setDetails: (d, px: number, activeGeometry: LayoutGeometry = geometry) => {
        d.details = clampWidth(px, activeGeometry.detailsMin, activeGeometry.detailsMax)
        d.detailsWidth = d.details
        remember(d)
      },
      // Narrow toggles flip only the override: the width preference survives
      // untouched, so re-widening restores the pre-squeeze layout.
      toggleSidebar: (d) => {
        if (d.narrow) d.narrowExpanded = !d.narrowExpanded
        else {
          d.sidebar = d.sidebar === 0 ? d.sidebarWidth : 0
          remember(d)
        }
      },
      // Crossing the breakpoint in either direction drops the override: the
      // narrow default is auto-collapsed, the wide state is the preference.
      setNarrow: (d, narrow: boolean) => {
        if (d.narrow === narrow) return
        d.narrow = narrow
        d.narrowExpanded = false
      },
      openDetails: (d, activeGeometry: LayoutGeometry = geometry) => {
        d.conversationFocus = false
        if (d.details === 0) {
          d.details = clampWidth(d.detailsWidth ?? activeGeometry.detailsDefault, activeGeometry.detailsMin, activeGeometry.detailsMax)
        }
      },
      // Closing also drops the focus demand: a later reopen starts split.
      closeDetails: (d) => {
        d.details = 0
        d.detailsFocus = false
        d.conversationFocus = false
      },
      setDetailsFocus: (d, active: boolean) => {
        d.detailsFocus = active
        if (active) d.conversationFocus = false
      },
      revealConversation: (d) => {
        d.detailsFocus = false
        d.conversationFocus = true
      },
    },
  })
  return handle
}
