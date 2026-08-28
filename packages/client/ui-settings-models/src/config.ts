/** Deployment controls for optional first-run model onboarding surfaces. */

/** Optional onboarding steps contributed by the Models settings plugin. */
export interface ModelsOnboardingConfig {
  /** Show the versioned DSH welcome notice. Defaults to true. */
  welcomeNotice?: boolean
  /** Prompt for an official DeepSeek credential when no LLM route is usable. Defaults to true. */
  deepSeekCredential?: boolean
}

/** Models settings plugin configuration. */
export interface Config {
  /** First-run dialogs; the Models settings page remains available when both are disabled. */
  onboarding?: ModelsOnboardingConfig
}

/** Fully resolved onboarding switches. */
export interface ResolvedModelsOnboardingConfig {
  /** Whether the versioned welcome notice is registered. */
  readonly welcomeNotice: boolean
  /** Whether the official DeepSeek credential prompt is registered. */
  readonly deepSeekCredential: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Validate and resolve deployment configuration shared by the Host and browser faces.
 * @param config - untrusted Cordis row configuration.
 * @returns immutable onboarding switches with DSH-compatible defaults.
 */
export function resolveModelsOnboardingConfig(config?: Config): ResolvedModelsOnboardingConfig {
  const input: unknown = config
  if (input !== undefined && !isRecord(input)) {
    throw new TypeError('ui-settings-models: config must be an object')
  }
  const onboarding: unknown = config?.onboarding
  if (onboarding !== undefined && !isRecord(onboarding)) {
    throw new TypeError('ui-settings-models: onboarding must be an object')
  }
  const source = onboarding ?? {}
  for (const key of ['welcomeNotice', 'deepSeekCredential'] as const) {
    const value = key in source ? source[key] : undefined
    if (value !== undefined && typeof value !== 'boolean') {
      throw new TypeError(`ui-settings-models: onboarding.${key} must be a boolean`)
    }
  }
  const resolved = config?.onboarding
  return Object.freeze({
    welcomeNotice: resolved?.welcomeNotice !== false,
    deepSeekCredential: resolved?.deepSeekCredential !== false,
  })
}
