/** Independent browser observations for Agent readiness and project integrity. */

import { createSnapshotStore, type WorkspaceId } from '@deepseek-ai/dsh-client-runtime/client'
import type { PaperAIAgentDiagnostic, PaperAIProjectIntegrityReport, PaperAIWorkbenchRemote, PaperAIWorkingRecoveryPlan } from './types.ts'

/** Read-only integrity report plus the explicit operation currently in flight. */
export interface ProjectCheckState {
  readonly busy: boolean
  readonly report: PaperAIProjectIntegrityReport | null
  readonly error: string | null
}

/** Shared diagnostic observations; these never drive live Agent model selection. */
export interface DiagnosticsState {
  agents: readonly PaperAIAgentDiagnostic[]
  probing: readonly string[]
  agentError: string | null
  projects: Readonly<Record<string, ProjectCheckState>>
}

/** Per-workbench controller for bounded diagnostic requests and explicit repairs. */
export class DiagnosticsController {
  /** Browser observations shared by the Agent status and project check surfaces. */
  readonly store = createSnapshotStore<DiagnosticsState>({ agents: [], probing: [], agentError: null, projects: {} })
  private disposed = false
  private agentRead = 0

  constructor(private readonly remote: PaperAIWorkbenchRemote) {}

  /** Read cached metadata without launching a provider process. */
  async loadAgents(): Promise<void> {
    const generation = ++this.agentRead
    try {
      const result = await this.remote.agentDiagnostics()
      if (this.isDisposed() || generation !== this.agentRead) return
      this.store.update((state) => {
        if (result.ok) { state.agents = result.value; state.agentError = null }
        else state.agentError = result.error.message
      })
    } catch (error) {
      if (!this.isDisposed() && generation === this.agentRead) this.store.update((state) => { state.agentError = String(error) })
    }
  }

  /**
   * Run an explicit prompt-free Agent diagnostic, deduplicated until it settles.
   * @param provider - selected peer provider.
   * @param force - bypass failure cooldown only for an explicit retry.
   */
  async probe(provider: 'codex' | 'claude', force: boolean): Promise<void> {
    if (this.isDisposed() || this.store.getSnapshot().probing.includes(provider)) return
    this.store.update((state) => { state.probing = [...state.probing, provider]; state.agentError = null })
    try {
      const result = await this.remote.probeAgent({ provider, force })
      if (this.isDisposed()) return
      if (!result.ok) this.store.update((state) => { state.agentError = result.error.message })
      else await this.loadAgents()
    } catch (error) {
      if (!this.isDisposed()) this.store.update((state) => { state.agentError = String(error) })
    } finally {
      if (!this.isDisposed()) this.store.update((state) => { state.probing = state.probing.filter(id => id !== provider) })
    }
  }

  /**
   * Scan a project, or apply one explicit scan-bound recovery and read the result.
   * @param workspaceId - project owning the observations and repair.
   * @param plan - optional exact repair candidate; omission performs only a read.
   */
  async inspect(workspaceId: WorkspaceId, plan?: PaperAIWorkingRecoveryPlan): Promise<void> {
    if (this.isDisposed() || this.store.getSnapshot().projects[workspaceId]?.busy === true) return
    const previous = this.store.getSnapshot().projects[workspaceId]
    this.store.update((state) => {
      state.projects = { ...state.projects, [workspaceId]: { busy: true, report: previous?.report ?? null, error: null } }
    })
    try {
      const result = plan === undefined
        ? await this.remote.inspectProject({ workspaceId })
        : await this.remote.recoverWorking({ workspaceId, plan })
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
  dispose(): void { this.disposed = true; this.agentRead += 1 }
  private isDisposed(): boolean { return this.disposed }
}
