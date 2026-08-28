/** Host loader entry for the browser implementation exported from `./client`. */

import type { Context } from '@deepseek-ai/cordis'
import type { Config } from './config.ts'
import { resolveModelsOnboardingConfig } from './config.ts'

export type { Config, ModelsOnboardingConfig, ResolvedModelsOnboardingConfig } from './config.ts'

/**
 * Validate deployment configuration; presentation remains browser-owned.
 * @param _ctx - Host plugin context, unused by this browser-only package face.
 * @param config - optional onboarding switches.
 */
export function apply(_ctx?: Context, config?: Config): void {
  resolveModelsOnboardingConfig(config)
}
