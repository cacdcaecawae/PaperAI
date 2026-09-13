/** Independent browser observations of project integrity. */

import { createSnapshotStore, type WorkspaceId } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  PaperAIDocumentId, PaperAIProjectIntegrityReport, PaperAIWorkbenchRemote, PaperAIWorkingRecoveryPlan,
} from './types.ts'

/** Read-only integrity report plus the explicit operation currently in flight. */
export interface ProjectCheckState {
  readonly busy: boolean
  readonly report: PaperAIProjectIntegrityReport | null
  readonly error: string | null
}

/** Project integrity observations by Workspace. */
export interface DiagnosticsState {
  projects: Readonly<Record<string, ProjectCheckState>>
}

/** Per-workbench controller for bounded diagnostic requests and explicit repairs. */
export class DiagnosticsController {
  /** Browser observations shared by the project check surfaces. */
  readonly store = createSnapshotStore<DiagnosticsState>({ projects: {} })
  private disposed = false

  constructor(private readonly remote: PaperAIWorkbenchRemote) {}

  /**
   * Scan a project, or apply one explicit scan-bound recovery and read the result.
   * @param workspaceId - project owning the observations and repair.
   * @param plan - optional exact repair candidate; omission performs only a read.
   */
  async inspect(workspaceId: WorkspaceId, plan?: PaperAIWorkingRecoveryPlan): Promise<void> {
    await this.report(workspaceId, () => (plan === undefined
      ? this.remote.inspectProject({ workspaceId })
      : this.remote.recoverWorking({ workspaceId, plan })))
  }

  /**
   * Record one document's Working DOCX, changed outside PaperAI, as a version and read the report again.
   * @param workspaceId - project owning the document.
   * @param documentId - the document whose working bytes become a version.
   */
  async capture(workspaceId: WorkspaceId, documentId: PaperAIDocumentId): Promise<void> {
    await this.report(workspaceId, () => this.remote.captureExternal({ workspaceId, documentId }))
  }

  private async report(
    workspaceId: WorkspaceId,
    read: () => ReturnType<PaperAIWorkbenchRemote['inspectProject']>,
  ): Promise<void> {
    if (this.isDisposed() || this.store.getSnapshot().projects[workspaceId]?.busy === true) return
    const previous = this.store.getSnapshot().projects[workspaceId]
    this.store.update((state) => {
      state.projects = { ...state.projects, [workspaceId]: { busy: true, report: previous?.report ?? null, error: null } }
    })
    try {
      const result = await read()
      if (this.isDisposed()) return
      this.store.update((state) => {
        state.projects = { ...state.projects, [workspaceId]: {
          busy: false, report: result.ok ? result.value : previous?.report ?? null,
          error: result.ok ? null : result.error.message,
        } }
      })
    } catch (error) {
      if (!this.isDisposed()) this.store.update((state) => {
        state.projects = { ...state.projects, [workspaceId]: { busy: false, report: previous?.report ?? null, error: String(error) } }
      })
    }
  }

  /** Discard stale replies after the owning plugin stops. */
  dispose(): void { this.disposed = true }
  private isDisposed(): boolean { return this.disposed }
}
