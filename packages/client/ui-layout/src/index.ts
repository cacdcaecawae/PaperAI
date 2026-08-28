/** Host loader entry for the browser-only layout plugin. */
import type { Context } from '@deepseek-ai/cordis'
import type { Config } from './config.ts'
import { resolveLayoutConfig } from './config.ts'

export type { Config, DetailsNarrowMode, DetailsVisibility, LayoutGeometry } from './config.ts'

/**
 * Validate the layout row on the Host; presentation remains browser-owned.
 * @param _ctx - Host plugin context, unused by this browser-only package face.
 * @param config - layout options supplied by the Cordis row.
 */
export function apply(_ctx?: Context, config?: Config): void {
  resolveLayoutConfig(config)
}
