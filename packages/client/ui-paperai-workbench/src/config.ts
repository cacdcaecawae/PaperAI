/** Deployment limits for the document workspace's browser resources. */

/** PaperAI browser workspace configuration. */
export interface Config {
  /** Maximum number of mounted document previews, including the active document. */
  readonly retainedPreviews?: number
}

/**
 * Validate the retained-preview budget shared by the Node and browser faces.
 * @param config - Cordis configuration.
 * @returns the positive preview budget, defaulting to two documents.
 */
export function resolvePreviewBudget(config: Config = {}): number {
  const count = config.retainedPreviews ?? 2
  if (!Number.isSafeInteger(count) || count < 1) throw new TypeError('retainedPreviews must be a positive integer')
  return count
}
