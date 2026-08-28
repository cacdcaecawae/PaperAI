/** React-free active-view controller for the conversation details column. */
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import {
  createSnapshotStore, type SessionId, type SnapshotStore,
} from '@deepseek-ai/dsh-client-runtime/client'

/** Built-in view id reserved for the selected Tool call panel. */
export const TOOL_DETAILS_VIEW_ID = 'tool'

/** Public cross-plugin actions for the details view host. */
export interface IConversationDetails {
  /**
   * Select a registered details view and open the column.
   * @param viewId - Built-in `tool` or a live `conversation.details.view` entry id.
   * @param sessionId - Target Session; omitted resolves the current Session.
   * @throws when no target Session exists or the view id is not registered.
   */
  open(viewId: string, sessionId?: SessionId): void
  /** Close the details column without discarding its per-session selected view. */
  close(): void
}

/** Runtime dependencies kept as closures so the controller stays framework-free. */
export interface ConversationDetailsControllerOptions {
  /** Current Session at the exact open gesture. */
  currentSession: () => SessionId | undefined
  /** Whether an additive details view id is currently registered. */
  hasView: (viewId: string) => boolean
  /** Open the layout-owned details column. */
  openPanel: () => void
  /** Close the layout-owned details column. */
  closePanel: () => void
}

/** Per-session active details view with layout orchestration. */
export class ConversationDetailsController implements IConversationDetails {
  private readonly sources = new Map<SessionId, SnapshotStore<string>>()
  private disposed = false

  /**
   * @param options - Current-session, slot-ledger, and layout operations.
   */
  constructor(private readonly options: ConversationDetailsControllerOptions) {}

  /**
   * Stable observable source consumed by the session-scoped details host.
   * @param sessionId - Session whose selected details view is observed.
   * @returns the stable per-session view-id source.
   */
  source(sessionId: SessionId): HostObservable<string> {
    this.assertLive()
    return this.writableSource(sessionId)
  }

  private writableSource(sessionId: SessionId): SnapshotStore<string> {
    let source = this.sources.get(sessionId)
    if (source === undefined) {
      source = createSnapshotStore(TOOL_DETAILS_VIEW_ID)
      this.sources.set(sessionId, source)
    }
    return source
  }

  /** Select one live details view and open the column. */
  open(viewId: string, sessionId?: SessionId): void {
    this.assertLive()
    const target = sessionId ?? this.options.currentSession()
    if (target === undefined) throw new Error('conversation details: no current session')
    if (viewId !== TOOL_DETAILS_VIEW_ID && !this.options.hasView(viewId)) {
      throw new Error(`conversation details: unknown view "${viewId}"`)
    }
    this.writableSource(target).set(viewId)
    this.options.openPanel()
  }

  /** Close the layout-owned column. */
  close(): void {
    this.assertLive()
    this.options.closePanel()
  }

  /** Restore stale selections after an additive view unloads. */
  reconcile(): void {
    if (this.disposed) return
    for (const source of this.sources.values()) {
      const active = source.getSnapshot()
      if (active !== TOOL_DETAILS_VIEW_ID && !this.options.hasView(active)) {
        source.set(TOOL_DETAILS_VIEW_ID)
      }
    }
  }

  /** Release retained Session sources and reject stale callbacks. */
  dispose(): void {
    this.disposed = true
    this.sources.clear()
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('conversation details: controller disposed')
  }
}
