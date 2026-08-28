/** Package-owned runtime checks for PaperAI document/index publication. */

import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { DomainChanged } from '@deepseek-ai/dsh-storage-domain'
import { DocumentId } from '@paperai/domain'

const PACKAGE_NAME = '@paperai/document-service'

/** Cordis companion plugin name. */
export const name = 'paperai-document-service-invariant'
/** Services required before package checks can register. */
export const inject = ['invariants']

function comparablePath(path: string): string {
  const absolute = resolve(path)
  /* v8 ignore next -- The opposite path-casing branch runs in the POSIX platform matrix. */
  return process.platform === 'win32' ? absolute.toLocaleLowerCase('en-US') : absolute
}

const install: InvariantInstaller = Object.assign(
  (ctx: Context, fail: (message: string) => never) => {
    ctx.on('domain/changed', (change: DomainChanged) => {
      if (change.domain !== 'paperai' || change.table !== 'documents' || change.operation === 'deleted') return
      const id = DocumentId(change.key)
      const document = ctx.paperRepository.getDocument(id)
      if (document === undefined) {
        fail(`document record '${change.key}' landed durably but the repository cannot read it`)
      }
      const indexed = ctx.paperRepository.listNodes(id).length
      if (document.nodeCount !== indexed) {
        fail(`document '${change.key}' declares ${String(document.nodeCount)} nodes but the repository indexes ${String(indexed)}`)
      }
      if (comparablePath(document.immutableSourcePath) === comparablePath(document.workingPath)) {
        fail(`document '${change.key}' points its immutable source and Working DOCX at the same file`)
      }
    })
  },
  { inject: ['paperRepository'] },
)

/**
 * Register document publication checks.
 * @param ctx - Cordis context carrying the invariant registry.
 * @returns the registration disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
