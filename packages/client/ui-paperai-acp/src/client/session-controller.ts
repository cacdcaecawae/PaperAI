/** Active ACP controls; every controller is owned by one existing browser session scope. */

import { createSnapshotStore, type SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@paperai/workbench-service/remote'
import type { AcpSessionDetails } from '@paperai/agent-acp/diagnostic-types'

/** Current provider controls and any rejected user action. */
export interface AcpSessionControlState {
  details: AcpSessionDetails | null
  loading: boolean
  busy: boolean
  error: string | null
}

/** Reads and edits only its bound live ACP conversation. */
export class AcpSessionController {
  /** Connection-scoped controls and the latest rejected action. */
  readonly store = createSnapshotStore<AcpSessionControlState>({
    details: null,
    loading: false,
    busy: false,
    error: null,
  })
  private generation = 0
  private disposed = false

  constructor(
    private readonly remote: Pick<TypertClientRemote['paperaiWorkbench'], 'acpSession' | 'acpSelectOption'>,
    private readonly id: SessionId,
  ) {}

  /** Refresh controls without allowing stale responses to overwrite newer values. */
  async load(): Promise<void> {
    if (this.isDisposed()) return
    const generation = ++this.generation
    this.store.update((state) => {
      state.loading = true
    })
    try {
      const response = await this.remote.acpSession({ sessionId: this.id })
      if (this.isDisposed() || generation !== this.generation) return
      if (!response.ok) throw new Error(response.error.message)
      this.store.update((state) => {
        state.details = response.value
      })
    } catch (error: unknown) {
      if (!this.isDisposed() && generation === this.generation)
        this.store.update((state) => {
          state.error = String(error)
        })
    } finally {
      if (!this.isDisposed() && generation === this.generation)
        this.store.update((state) => {
          state.loading = false
        })
    }
  }

  /**
   * Apply an advertised option and reload its dependent choices.
   * @param option - provider-declared option id.
   * @param value - selected value.
   */
  async select(option: string, value: string | boolean): Promise<void> {
    if (this.isDisposed() || this.store.getSnapshot().busy) return
    this.store.update((state) => {
      state.busy = true
      state.error = null
    })
    try {
      const response = await this.remote.acpSelectOption({ sessionId: this.id, option, value })
      if (!response.ok) throw new Error(response.error.message)
    } catch (error: unknown) {
      if (!this.isDisposed())
        this.store.update((state) => {
          state.error = String(error)
        })
    } finally {
      if (!this.isDisposed()) {
        this.store.update((state) => {
          state.busy = false
        })
        await this.load()
      }
    }
  }

  /** Invalidate live controls immediately when the owning Host connection is lost. */
  disconnected(): void {
    this.generation += 1
    this.store.update((state) => {
      state.loading = false
      if (state.details !== null) state.details = { ...state.details, connected: false }
    })
  }

  private isDisposed(): boolean {
    return this.disposed
  }

  /** Stop state writes when the owning session scope is released. */
  dispose(): void {
    this.disposed = true
    this.generation += 1
  }
}
