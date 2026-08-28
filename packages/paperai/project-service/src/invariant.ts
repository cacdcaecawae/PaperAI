/**
 * Package-owned invariant companion for `@paperai/project-service`.
 * @module @paperai/project-service/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { DomainChanged } from '@deepseek-ai/dsh-storage-domain'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { ProjectId } from '@paperai/domain'
import type {} from '@paperai/repository'
import type {} from './index.ts'

const PACKAGE_NAME = '@paperai/project-service'

/** Cordis companion plugin name. */
export const name = 'paperai-project-service-invariant'
/** Service required before the companion can register. */
export const inject = ['invariants']

/** Every published project must name the DSH workspace for its canonical root. */
const install: InvariantInstaller = Object.assign(
  (ctx: Context, fail: (message: string) => never) => {
    ctx.on('domain/changed', (change: DomainChanged) => {
      if (change.domain !== 'paperai' || change.table !== 'projects' || change.operation === 'deleted') return
      const project = ctx.paperRepository.getProject(ProjectId(change.key))
      if (project === undefined) {
        fail(`project '${change.key}' was published without a readable repository record`)
      }
      const workspace = ctx.workspaceRegistry.get(WorkspaceId(project.workspaceId))
      if (workspace === undefined) {
        fail(`project '${change.key}' references missing workspace '${project.workspaceId}'`)
      }
      if (workspace.path !== project.rootPath) {
        fail(
          `project '${change.key}' root '${project.rootPath}' does not match `
          + `workspace '${project.workspaceId}' path '${workspace.path}'`,
        )
      }
    })
  },
  { inject: ['paperProjects', 'paperRepository', 'workspaceRegistry'] },
)

/**
 * Register the project/workspace invariant.
 * @param ctx - Cordis context carrying the invariant registry.
 * @returns the registration disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
