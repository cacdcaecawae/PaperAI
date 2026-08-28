/**
 * Service Definition for PaperAI's Word execution seam (`ctx.documentEngine`).
 * Providers own process lifecycle and Office format behavior; document,
 * commit, template, gate, and export consumers own academic semantics.
 * @module @paperai/document-engine
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { CapabilityHealth } from '@paperai/domain'

/** Text-bearing Word node projected by the engine. */
export interface EngineTextNode {
  officePath: string
  text: string
  kind: 'paragraph' | 'table' | 'unknown'
}

/** Office-path mutation applied atomically inside one engine document lease. */
export type EngineMutation =
  | { type: 'replace-text'; officePath: string; text: string }
  | { type: 'insert-paragraph'; text: string; style?: string; after?: string; before?: string; index?: number }
  | { type: 'remove'; officePath: string }

/** Validation payload intentionally retains OfficeCLI's structured evidence. */
export interface EngineValidation {
  success: boolean
  details: Record<string, unknown>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    documentEngine: DocumentEngine
  }
}

/**
 * Word document engine. Every method addresses an explicit file path; the
 * provider must serialize operations for the same canonical Working DOCX.
 */
export abstract class DocumentEngine extends Service {
  constructor(ctx: Context) {
    super(ctx, 'documentEngine')
  }

  /**
   * Probe the configured engine without mutating a document.
   * @param signal - optional cancellation signal for the provider probe.
   * @returns capability availability and provider diagnostic details.
   */
  abstract health(signal?: AbortSignal): Promise<CapabilityHealth>
  /**
   * Read the complete text-node index in document order.
   * @param filePath - canonical DOCX path to inspect.
   * @param signal - optional cancellation signal for provider work.
   * @returns all text-bearing nodes in document order.
   * @throws when cancelled or the provider cannot read or parse the document.
   */
  abstract readTextNodes(filePath: string, signal?: AbortSignal): Promise<EngineTextNode[]>
  /**
   * Produce generated HTML preview; HTML is never an editable authority.
   * @param filePath - canonical DOCX path to render.
   * @param signal - optional cancellation signal for provider work.
   * @returns generated preview HTML for the current document bytes.
   * @throws when cancelled or the provider cannot render the document.
   */
  abstract previewHtml(filePath: string, signal?: AbortSignal): Promise<string>
  /**
   * Read structured properties from one Office path.
   * @param filePath - canonical DOCX path to inspect.
   * @param officePath - provider-defined Office node path.
   * @param depth - optional traversal depth; the provider chooses its default when omitted.
   * @param signal - optional cancellation signal for provider work.
   * @returns the structured property tree rooted at the Office path.
   * @throws when cancelled or the document, Office path, or response cannot be read.
   */
  abstract inspect(filePath: string, officePath: string, depth?: number, signal?: AbortSignal): Promise<Record<string, unknown>>
  /**
   * Apply a batch under one exclusive file lease and save before returning.
   * @param filePath - canonical Working DOCX path to mutate.
   * @param mutations - ordered Office-path mutations in the batch.
   * @param signal - optional cancellation signal for provider work.
   * @throws when cancelled or any mutation or save operation fails.
   */
  abstract applyMutations(filePath: string, mutations: readonly EngineMutation[], signal?: AbortSignal): Promise<void>
  /**
   * Run structural Office validation and return all available evidence.
   * @param filePath - canonical DOCX path to validate.
   * @param signal - optional cancellation signal for provider work.
   * @returns structural success and the provider's complete validation evidence.
   * @throws when cancelled or the provider cannot produce structured validation evidence.
   */
  abstract validate(filePath: string, signal?: AbortSignal): Promise<EngineValidation>
}

export default DocumentEngine
