/** Frozen Word excerpts serialized by the existing composer reference pipeline. */

import type { ReferenceInsert, InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { PaperAIDocumentNodeId, PaperAIDocumentSnapshot } from './types.ts'

/** Exact text and semantic blocks selected in the document preview. */
export interface WordExcerpt {
  readonly nodeIds: readonly PaperAIDocumentNodeId[]
  readonly text: string
}

/**
 * Capture document provenance and text at the user gesture, before asynchronous submission.
 * @param document - preview revision the user selected from.
 * @param excerpt - exact text and intersecting block identities.
 * @returns removable inline reference whose model and persistence forms contain the same frozen context.
 */
export function wordSelectionReference(document: PaperAIDocumentSnapshot, excerpt: WordExcerpt): ReferenceInsert {
  const context = `${document.title}\n[Word selection]\n${JSON.stringify({
    document: document.documentId, path: document.path, version: document.headCommitId,
    revision: document.revision, blocks: excerpt.nodeIds, text: excerpt.text,
  })}\n[/Word selection]\n`
  return {
    source: 'paperai-selection', ref: context, clipboardText: context,
    label: `${document.title} · ${excerpt.text.replace(/\s+/gu, ' ').slice(0, 32)}`,
    appearance: 'file',
  }
}

/**
 * Create the codec for explicitly inserted Word selections; it performs no document reads.
 * @returns source owned by the workbench plugin's effect lifetime.
 */
export function selectionSource(): InputTriggerSource {
  return {
    name: 'paperai-selection', trigger: '@',
    candidates: () => Promise.resolve([]), onPick: () => undefined,
    codec: { clipboardText: ref => ref, serialize: ref => Promise.resolve(ref) },
  }
}
