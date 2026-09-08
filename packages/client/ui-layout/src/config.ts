/**
 * Runtime configuration for the generic three-column layout. The same
 * resolver is called by both package faces so untyped Cordis configuration
 * fails before the browser frame consumes it.
 */

/** Center-column floor used when no deployment override is supplied. */
export const CENTER_MIN = 640
/** Details-column drag floor used when no deployment override is supplied. */
export const DETAILS_MIN = 300
/** Details-column opening width used when no deployment override is supplied. */
export const DETAILS_DEFAULT = 360
/** Details-column drag ceiling used when no deployment override is supplied. */
export const DETAILS_MAX = 520

/** Session states that may retain an open details column. */
export type DetailsVisibility = 'nonblank-session' | 'current-session'

/** Behavior when an open details column cannot coexist with both split-view minimums. */
export type DetailsNarrowMode = 'close' | 'focus'

/** Deployment-controlled layout options. Omitted fields preserve DSH layout behavior. */
export interface Config {
  /** Place the details surface before or after the conversation. */
  detailsPosition?: 'start' | 'end'
  /** Center-column floor in integer CSS pixels. */
  centerMin?: number
  /** Details-column drag floor in integer CSS pixels. */
  detailsMin?: number
  /** Width used when opening a closed details column, in integer CSS pixels. */
  detailsDefault?: number
  /** Details-column drag ceiling in integer CSS pixels. */
  detailsMax?: number
  /** Session eligibility for retaining an open details column. */
  detailsVisibility?: DetailsVisibility
  /** Narrow-layout behavior for an open details column. */
  detailsNarrowMode?: DetailsNarrowMode
}

/** Validated geometry consumed by the concession solver and layout store. */
export interface LayoutGeometry {
  /** Center-column floor in CSS pixels. */
  readonly centerMin: number
  /** Details-column drag floor in CSS pixels. */
  readonly detailsMin: number
  /** Width used when opening a closed details column, in CSS pixels. */
  readonly detailsDefault: number
  /** Details-column drag ceiling in CSS pixels. */
  readonly detailsMax: number
}

/** Fully resolved layout options. */
export interface ResolvedLayoutConfig extends LayoutGeometry {
  /** Position of the details surface relative to the conversation. */
  readonly detailsPosition: 'start' | 'end'
  /** Session eligibility for retaining an open details column. */
  readonly detailsVisibility: DetailsVisibility
  /** Narrow-layout behavior for an open details column. */
  readonly detailsNarrowMode: DetailsNarrowMode
}

/** Original DSH geometry, used whenever the corresponding config fields are omitted. */
export const DEFAULT_LAYOUT_GEOMETRY: Readonly<LayoutGeometry> = Object.freeze({
  centerMin: CENTER_MIN,
  detailsMin: DETAILS_MIN,
  detailsDefault: DETAILS_DEFAULT,
  detailsMax: DETAILS_MAX,
})

/** Original DSH details eligibility: a current Session must contain a nonblank turn. */
export const DEFAULT_DETAILS_VISIBILITY: DetailsVisibility = 'nonblank-session'

/** Original DSH narrow-layout behavior: hide details until the split fits again. */
export const DEFAULT_DETAILS_NARROW_MODE: DetailsNarrowMode = 'close'

function positiveInteger(source: Record<string, unknown>, key: keyof LayoutGeometry, fallback: number): number {
  const value = source[key] ?? fallback
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new TypeError(`ui-layout: ${key} must be a positive safe integer`)
  }
  return value as number
}

function visibilityOf(source: Record<string, unknown>): DetailsVisibility {
  const value = source.detailsVisibility ?? DEFAULT_DETAILS_VISIBILITY
  if (value !== 'nonblank-session' && value !== 'current-session') {
    throw new TypeError(
      'ui-layout: detailsVisibility must be "nonblank-session" or "current-session"',
    )
  }
  return value
}

function narrowModeOf(source: Record<string, unknown>): DetailsNarrowMode {
  const value = source.detailsNarrowMode ?? DEFAULT_DETAILS_NARROW_MODE
  if (value !== 'close' && value !== 'focus') {
    throw new TypeError('ui-layout: detailsNarrowMode must be "close" or "focus"')
  }
  return value
}

/**
 * Resolve and validate layout configuration. Every field defaults
 * independently, while the details range must satisfy
 * `detailsMin <= detailsDefault <= detailsMax`.
 * @param config - untrusted Cordis config, or undefined for the DSH defaults.
 * @returns immutable options safe for the store and concession solver.
 * @throws {TypeError} when the config is not an object, a width is not a positive safe integer, or a details mode is unknown.
 * @throws {RangeError} when the details range cannot contain its opening width.
 */
export function resolveLayoutConfig(config?: Config): Readonly<ResolvedLayoutConfig> {
  const input: unknown = config
  if (input !== undefined && (typeof input !== 'object' || input === null || Array.isArray(input))) {
    throw new TypeError('ui-layout: config must be an object')
  }
  const source = (input ?? {}) as Record<string, unknown>
  const detailsPosition = source.detailsPosition ?? 'end'
  if (detailsPosition !== 'start' && detailsPosition !== 'end') {
    throw new TypeError('ui-layout: detailsPosition must be "start" or "end"')
  }
  const centerMin = positiveInteger(source, 'centerMin', CENTER_MIN)
  const detailsMin = positiveInteger(source, 'detailsMin', DETAILS_MIN)
  const detailsDefault = positiveInteger(source, 'detailsDefault', DETAILS_DEFAULT)
  const detailsMax = positiveInteger(source, 'detailsMax', DETAILS_MAX)
  if (detailsMin > detailsDefault) {
    throw new RangeError(
      `ui-layout: detailsMin (${String(detailsMin)}) must not exceed detailsDefault (${String(detailsDefault)})`,
    )
  }
  if (detailsDefault > detailsMax) {
    throw new RangeError(
      `ui-layout: detailsDefault (${String(detailsDefault)}) must not exceed detailsMax (${String(detailsMax)})`,
    )
  }
  return Object.freeze({
    detailsPosition,
    centerMin,
    detailsMin,
    detailsDefault,
    detailsMax,
    detailsVisibility: visibilityOf(source),
    detailsNarrowMode: narrowModeOf(source),
  })
}
