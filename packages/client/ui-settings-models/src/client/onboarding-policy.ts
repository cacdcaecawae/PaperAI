/** Runtime product policy for optional Models onboarding surfaces. */

import {
  createSnapshotStore, type SnapshotStore,
} from '@deepseek-ai/dsh-client-runtime/client'
import {
  resolveModelsOnboardingConfig,
  type ModelsOnboardingConfig,
  type ResolvedModelsOnboardingConfig,
} from '../config.ts'

/** Cross-plugin face used by product profiles to tune Models onboarding. */
export interface IModelsOnboarding {
  /** Effective policy observed by every registered onboarding step. */
  readonly configuration: SnapshotStore<Readonly<ResolvedModelsOnboardingConfig>>
  /**
   * Apply one product policy and return a stale-safe disposer.
   * @param config - onboarding surfaces enabled by the product.
   * @returns idempotent disposer that restores the deployment baseline.
   */
  configure(config: ModelsOnboardingConfig): () => void
}

/** Runtime controller behind {@link IModelsOnboarding}. */
export class ModelsOnboardingController implements IModelsOnboarding {
  #generation = 0
  /** Effective product policy. */
  readonly configuration: SnapshotStore<Readonly<ResolvedModelsOnboardingConfig>>

  /**
   * Create a policy controller around the deployment baseline.
   * @param baseline - deployment-level defaults validated by the Host face.
   */
  constructor(
    private readonly baseline: Readonly<ResolvedModelsOnboardingConfig>
      = resolveModelsOnboardingConfig(),
  ) {
    this.configuration = createSnapshotStore(baseline)
  }

  /** Apply one runtime product policy and return its stale-safe disposer. */
  configure(config: ModelsOnboardingConfig): () => void {
    const resolved = resolveModelsOnboardingConfig({
      onboarding: {
        welcomeNotice: config.welcomeNotice ?? this.baseline.welcomeNotice,
        deepSeekCredential: config.deepSeekCredential ?? this.baseline.deepSeekCredential,
      },
    })
    const generation = ++this.#generation
    this.configuration.set(resolved)
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      if (generation !== this.#generation) return
      this.#generation++
      this.configuration.set(this.baseline)
    }
  }
}
