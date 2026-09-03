/**
 * Pure concession-chain column solver for the three-column AppFrame.
 * Split mode keeps center at its configured floor by shrinking details. When
 * the minimum split no longer fits, the configured narrow mode either closes
 * details or focuses it beside the current sidebar. Width preferences
 * are never rewritten, so widening the frame restores the split. Inputs are
 * the layout store's plain width
 * preferences (0 = closed); a closed sidebar resolves to the fixed
 * SIDEBAR_COLLAPSED control rail while closed details resolve to zero width.
 * The SIDEBAR_AUTO_COLLAPSE breakpoint is consumed by AppFrame, which decides
 * the effective sidebar preference before solving; the solver itself stays
 * breakpoint-free.
 */

import type { DetailsNarrowMode, LayoutGeometry } from '../config.ts'
import { DEFAULT_DETAILS_NARROW_MODE, DEFAULT_LAYOUT_GEOMETRY } from '../config.ts'

export { CENTER_MIN, DETAILS_DEFAULT, DETAILS_MAX, DETAILS_MIN } from '../config.ts'

/** Resolved widths and active presentation mode for one frame. */
export interface Columns {
  /** Rendered sidebar width. */
  sidebar: number
  /** Rendered center width. */
  center: number
  /** Rendered details width. */
  details: number
  /** Whether details owns the content area beside the current sidebar. */
  detailsFocused: boolean
}

// Sidebar geometry stays fixed; center/details geometry comes from LayoutGeometry.
/** Sidebar drag clamp floor. */
export const SIDEBAR_MIN = 264
/** Sidebar drag clamp ceiling. */
export const SIDEBAR_MAX = 420
/** Sidebar width before any user drag. */
export const SIDEBAR_DEFAULT = 280
/** Closed-sidebar rail: a 24px icon column between 16px horizontal paddings. */
export const SIDEBAR_COLLAPSED = 56
/** Viewport width below which the sidebar auto-collapses to the rail (deepsuite
 * LG breakpoint); a manual toggle below it re-expands over the squeezed center
 * (stores.ts narrowExpanded). */
export const SIDEBAR_AUTO_COLLAPSE = 1024
/**
 * Clamp a panel width into its contract range.
 * @param px - requested width.
 * @param min - range lower bound.
 * @param max - range upper bound.
 * @returns the clamped width.
 */
export function clampWidth(px: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(px)))
}

/**
 * Solve the three column widths for one viewport frame. Pure: no hysteresis —
 * the output is a function of (viewport, preferences) only, so recovery on
 * re-widening is automatic. Preferences re-clamp here because they cross the
 * store boundary and callers may still supply stale ranges.
 * @param viewport - available frame width in px.
 * @param sidebar - sidebar width preference in px (0 = closed).
 * @param details - details width preference in px (0 = closed).
 * @param geometry - validated center/details geometry; omitted for the original DSH values.
 * @param detailsNarrowMode - behavior when the minimum split does not fit.
 * @param focusRequested - explicit focus demand: an open details panel takes
 * the whole content area at any viewport width; ignored while details are closed.
 * @returns resolved widths and focus state; details 0 means visually closed but never unmounted.
 */
export function computeColumns(
  viewport: number,
  sidebar: number,
  details: number,
  geometry: LayoutGeometry = DEFAULT_LAYOUT_GEOMETRY,
  detailsNarrowMode: DetailsNarrowMode = DEFAULT_DETAILS_NARROW_MODE,
  focusRequested = false,
): Columns {
  // The sidebar is fixed at its preference (or the rail) — it never concedes.
  const s = sidebar === 0 ? SIDEBAR_COLLAPSED : clampWidth(sidebar, SIDEBAR_MIN, SIDEBAR_MAX)
  const d0 = details === 0 ? 0 : clampWidth(details, geometry.detailsMin, geometry.detailsMax)

  if (focusRequested && d0 > 0) {
    return { sidebar: s, center: 0, details: Math.max(0, viewport - s), detailsFocused: true }
  }

  // Step 1: everything fits at preferred widths.
  if (s + d0 + geometry.centerMin <= viewport) {
    return { sidebar: s, center: viewport - s - d0, details: d0, detailsFocused: false }
  }

  // Step 2: shrink details toward its minimum.
  const d1 = d0 === 0 ? 0 : Math.max(geometry.detailsMin, viewport - s - geometry.centerMin)
  if (s + d1 + geometry.centerMin <= viewport) {
    return { sidebar: s, center: geometry.centerMin, details: d1, detailsFocused: false }
  }

  if (d0 > 0 && detailsNarrowMode === 'focus') {
    return {
      sidebar: s,
      center: 0,
      details: Math.max(0, viewport - s),
      detailsFocused: true,
    }
  }

  // Closing is derived from the current frame; the stored preference remains
  // open and restores automatically when the minimum split fits again.
  return {
    sidebar: s,
    center: Math.max(0, viewport - s),
    details: 0,
    detailsFocused: false,
  }
}
