/**
 * Composer blocks: the one way another plugin stops a session's input.
 *
 * The composer cannot read the plugins that would know — the dependency runs
 * ui-model-selection → ui-conversation, never back — so a blocker pushes here and the
 * bar reads its own session's store. A block carries the localized reason it
 * exists, because the plugin that raised it owns that copy. Draft-permitting
 * holds keep editing available while submission and model changes wait.
 *
 * This is an affordance, not enforcement: the Host refuses a prompt it cannot
 * route regardless of what any client disables.
 */

import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId, SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'

/** Submission restriction and draft policy for one session. */
export interface ComposerBlock {
  /**
   * Localized placeholder replacing the composer's own, owned by the plugin
   * that raised the block.
   */
  readonly reason: string
  /** Keep the draft editable while submission waits for a replacement Session. */
  readonly allowDraft?: boolean
}

/** The registry face other plugins reach through `ctx.conversation.blocks`. */
export interface ComposerBlocks {
  /**
   * Hold submission through an asynchronous transition, independently of the ordinary model block.
   * @param sessionId - affected session.
   * @param block - transition reason and draft policy.
   * @returns idempotent release restoring the latest ordinary block.
   */
  hold(sessionId: SessionId, block: ComposerBlock): () => void
  /**
   * Raise or clear this session's block. Idempotent: setting a block equal to
   * the current one, or clearing an absent one, notifies nobody.
   * @param sessionId - the session whose composer is affected.
   * @param block - the block to raise, or undefined to clear it.
   */
  set(sessionId: SessionId, block: ComposerBlock | undefined): void
  /**
   * The store the composer subscribes to for one session. Created on first
   * read from either side, so a blocker may raise a block before the session's
   * composer mounts and the composer still sees it.
   * @param sessionId - the session to observe.
   * @returns that session's block store (undefined value = not blocked).
   */
  storeFor(sessionId: SessionId): SnapshotStore<ComposerBlock | undefined>
  /**
   * Drop one session's store. The session scope's disposer calls this; a
   * blocker never needs to.
   * @param sessionId - the session being torn down.
   */
  forget(sessionId: SessionId): void
}

/** The per-session composer-block registry (one instance per plugin fiber). */
export class ComposerBlockRegistry implements ComposerBlocks {
  private readonly stores = new Map<SessionId, SnapshotStore<ComposerBlock | undefined>>()
  private readonly defaults = new Map<SessionId, ComposerBlock>()
  private readonly holds = new Map<SessionId, Map<symbol, ComposerBlock>>()

  /** @inheritdoc */
  hold(sessionId: SessionId, block: ComposerBlock): () => void {
    const holds = this.holds.get(sessionId) ?? new Map<symbol, ComposerBlock>()
    const token = Symbol()
    this.holds.set(sessionId, holds)
    holds.set(token, block)
    this.publish(sessionId)
    return () => {
      if (!holds.delete(token) || this.holds.get(sessionId) !== holds) return
      if (holds.size === 0) this.holds.delete(sessionId)
      this.publish(sessionId)
    }
  }

  /** @inheritdoc */
  set(sessionId: SessionId, block: ComposerBlock | undefined): void {
    if (block === undefined) this.defaults.delete(sessionId)
    else this.defaults.set(sessionId, block)
    this.publish(sessionId)
  }

  private publish(sessionId: SessionId): void {
    const block = this.holds.get(sessionId)?.values().next().value ?? this.defaults.get(sessionId)
    const store = this.storeFor(sessionId)
    const current = store.getSnapshot()
    if (current?.reason === block?.reason && current?.allowDraft === block?.allowDraft) return
    store.set(block)
  }

  /** @inheritdoc */
  storeFor(sessionId: SessionId): SnapshotStore<ComposerBlock | undefined> {
    const existing = this.stores.get(sessionId)
    if (existing !== undefined) return existing
    const created = createSnapshotStore<ComposerBlock | undefined>(undefined)
    this.stores.set(sessionId, created)
    return created
  }

  /** @inheritdoc */
  forget(sessionId: SessionId): void {
    this.stores.delete(sessionId)
    this.defaults.delete(sessionId)
    this.holds.delete(sessionId)
  }
}
