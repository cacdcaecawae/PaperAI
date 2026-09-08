import { describe, expect, it } from 'vitest'
import {
  CENTER_MIN,
  DEFAULT_DETAILS_NARROW_MODE,
  DEFAULT_DETAILS_VISIBILITY,
  DETAILS_DEFAULT,
  DETAILS_MAX,
  DETAILS_MIN,
  resolveLayoutConfig,
} from '@deepseek-ai/dsh-client-ui-layout/src/config.ts'

describe('resolveLayoutConfig', () => {
  it('preserves every DSH default when config is omitted', () => {
    const resolved = resolveLayoutConfig()
    expect(resolved).toEqual({
      centerMin: CENTER_MIN,
      detailsMin: DETAILS_MIN,
      detailsDefault: DETAILS_DEFAULT,
      detailsMax: DETAILS_MAX,
      detailsVisibility: DEFAULT_DETAILS_VISIBILITY,
      detailsNarrowMode: DEFAULT_DETAILS_NARROW_MODE,
      detailsPosition: 'end',
    })
    expect(Object.isFrozen(resolved)).toBe(true)
  })

  it('resolves a complete product geometry and blank-Session visibility mode', () => {
    expect(resolveLayoutConfig({
      centerMin: 520,
      detailsMin: 400,
      detailsDefault: 600,
      detailsMax: 960,
      detailsVisibility: 'current-session',
      detailsNarrowMode: 'focus',
      detailsPosition: 'end',
    })).toEqual({
      centerMin: 520,
      detailsMin: 400,
      detailsDefault: 600,
      detailsMax: 960,
      detailsVisibility: 'current-session',
      detailsNarrowMode: 'focus',
      detailsPosition: 'end',
    })
  })

  it('defaults omitted fields independently', () => {
    expect(resolveLayoutConfig({ centerMin: 520 })).toEqual({
      centerMin: 520,
      detailsMin: DETAILS_MIN,
      detailsDefault: DETAILS_DEFAULT,
      detailsMax: DETAILS_MAX,
      detailsVisibility: DEFAULT_DETAILS_VISIBILITY,
      detailsNarrowMode: DEFAULT_DETAILS_NARROW_MODE,
      detailsPosition: 'end',
    })
  })

  it('rejects non-object config values at the config boundary', () => {
    expect(() => resolveLayoutConfig('wide' as never)).toThrow(/config must be an object/)
    expect(() => resolveLayoutConfig(null as never)).toThrow(/config must be an object/)
    expect(() => resolveLayoutConfig([] as never)).toThrow(/config must be an object/)
  })

  it('rejects non-integer and non-positive geometry', () => {
    expect(() => resolveLayoutConfig({ centerMin: 1.5 })).toThrow(/centerMin must be a positive safe integer/)
    expect(() => resolveLayoutConfig({ centerMin: 0 })).toThrow(/centerMin must be a positive safe integer/)
    expect(() => resolveLayoutConfig({ detailsMin: -1 })).toThrow(/detailsMin must be a positive safe integer/)
    expect(() => resolveLayoutConfig({ detailsDefault: Number.NaN })).toThrow(/detailsDefault must be a positive safe integer/)
    expect(() => resolveLayoutConfig({ detailsMax: Number.MAX_SAFE_INTEGER + 1 })).toThrow(/detailsMax must be a positive safe integer/)
  })

  it('rejects details ranges that cannot contain the opening width', () => {
    expect(() => resolveLayoutConfig({ detailsMin: 500, detailsDefault: 400, detailsMax: 600 }))
      .toThrow(/detailsMin \(500\) must not exceed detailsDefault \(400\)/)
    expect(() => resolveLayoutConfig({ detailsMin: 300, detailsDefault: 700, detailsMax: 600 }))
      .toThrow(/detailsDefault \(700\) must not exceed detailsMax \(600\)/)
  })

  it('rejects an unknown details visibility mode', () => {
    expect(() => resolveLayoutConfig({ detailsVisibility: 'always' as never }))
      .toThrow(/detailsVisibility must be "nonblank-session" or "current-session"/)
  })

  it('rejects an unknown details narrow mode', () => {
    expect(() => resolveLayoutConfig({ detailsNarrowMode: 'overlay' as never }))
      .toThrow(/detailsNarrowMode must be "close" or "focus"/)
  })
})
