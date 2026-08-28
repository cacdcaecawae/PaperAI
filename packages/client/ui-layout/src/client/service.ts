/**
 * LayoutController: the cross-plugin panel-action face behind ctx.layout.
 * Panel geometry itself lives in the root entry's layout store (stores.ts);
 * the current-session selection lives with the runtime sessions service, and
 * the per-session active view dissolved into ui-conversation's session store
 * (its only consumer). What remains here is the contract other plugins'
 * apply worlds reach for panel transitions (sidebar toggle from ui-sidebar,
 * details open/close from ui-conversation) — writes stay inside the store's
 * declared action set, delivered as the registration's bound actions.
 */
import type { BoundActions } from '@deepseek-ai/dsh-client-ui-slots'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import {
  resolveLayoutConfig,
  type Config,
  type ResolvedLayoutConfig,
} from '../config.ts'
import type { createLayoutStore } from './stores.ts'

/** The layout store's bound action set (framework-baked, draft params peeled). */
export type PanelActions = BoundActions<ReturnType<typeof createLayoutStore>>

/**
 * The outward layout face (`ctx.layout`): the panel transitions other
 * plugins may trigger — and exactly what a test fake must supply. The
 * attachPanels wiring hook stays on the concrete class (root-entry assembly
 * only).
 */
export interface ILayout {
  /** Toggle the sidebar panel (closed ⟷ contract default width). */
  toggleSidebar(): void
  /** Open the details panel (no-op when already open). */
  openDetails(): void
  /** Close the details panel. */
  closeDetails(): void
  /**
   * Apply a product-level layout profile without changing the generic DSH
   * defaults. The returned disposer restores the deployment baseline unless
   * a newer profile has replaced it.
   * @param config - product geometry and narrow-layout behavior.
   * @returns idempotent profile disposer.
   */
  configure(config: Config): () => void
}

/** Cross-plugin panel-action face (ctx.layout). */
export class LayoutController implements ILayout {
  #panels: PanelActions | undefined
  #configurationGeneration = 0
  /** Effective deployment/product layout configuration observed by the root frame. */
  readonly configuration: SnapshotStore<Readonly<ResolvedLayoutConfig>>

  /** Deployment baseline and live product-profile source. */
  constructor(private readonly baseline: Readonly<ResolvedLayoutConfig> = resolveLayoutConfig()) {
    this.configuration = createSnapshotStore(baseline)
  }

  /**
   * Adopt the root entry's bound store actions. Called from the root
   * registration's inject hook (a sanctioned assembly side effect), so the
   * face is live from the entry's first render; on entry re-register the
   * fresh actions overwrite the stale set.
   * @param actions - bound actions of the entry's layout store instance.
   */
  attachPanels(actions: PanelActions): void {
    this.#panels = actions
  }

  /** Toggle the sidebar panel (closed ⟷ contract default width). */
  toggleSidebar(): void {
    this.#require().toggleSidebar()
  }

  /** Open the details panel (no-op when already open). */
  openDetails(): void {
    this.#require().openDetails(this.configuration.getSnapshot())
  }

  /** Close the details panel. */
  closeDetails(): void {
    this.#require().closeDetails()
  }

  /** Apply one runtime product profile and return its stale-safe disposer. */
  configure(config: Config): () => void {
    const resolved = resolveLayoutConfig({ ...this.baseline, ...config })
    const generation = ++this.#configurationGeneration
    this.configuration.set(resolved)
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      if (generation !== this.#configurationGeneration) return
      this.#configurationGeneration++
      this.configuration.set(this.baseline)
    }
  }

  #require(): PanelActions {
    // Callers are UI gestures, which cannot fire before the root entry
    // rendered (the inject hook runs in its first render) — reaching this
    // unwired is a boot-order bug, not a race to tolerate.
    if (this.#panels === undefined) throw new Error('layout: panel actions not wired (root entry not mounted)')
    return this.#panels
  }
}
