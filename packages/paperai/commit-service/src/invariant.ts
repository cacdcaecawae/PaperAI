/** Package-owned runtime invariant for PaperAI document head publication. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { DomainChanged } from '@deepseek-ai/dsh-storage-domain'
import { DocumentId } from '@paperai/domain'

const PACKAGE_NAME = '@paperai/commit-service'

/** Cordis companion plugin name. */
export const name = 'paperai-commit-service-invariant'
/** Services required before the companion reserves package ownership. */
export const inject = ['invariants']

/**
 * Owned relationship: each durably published document head resolves to a
 * commit for the same document. Commit objects land before the head update,
 * while failed publication leaves the old head unchanged.
 */
const install: InvariantInstaller = Object.assign(
  (ctx: Context, fail: (message: string) => never) => {
    ctx.on('domain/changed', (change: DomainChanged) => {
      if (change.domain !== 'paperai'
        || change.table !== 'documents'
        || change.operation !== 'put') return
      const document = ctx.paperRepository.getDocument(DocumentId(change.key))
      if (document?.headCommitId === undefined) return
      const commit = ctx.paperRepository.getCommit(document.headCommitId)
      if (commit === undefined || commit.documentId !== document.id) {
        fail(
          `document '${document.id}' published head '${document.headCommitId}' without a matching commit object`,
        )
      }
    })
  },
  { inject: ['paperRepository'] },
)

/**
 * Register the package invariant companion.
 * @param ctx - Cordis context carrying the invariant registry.
 * @returns the effect-scoped registration disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
