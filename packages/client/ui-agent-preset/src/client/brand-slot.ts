/**
 * Keyed mark slot owned by the new-session Agent-preset seat.
 *
 * A deployment registers one presentation component per preset id. The seat
 * dispatches the selected trigger and each menu row through the same key, so
 * brand packages remain independent from this package's components.
 */

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Brand mark for one Agent preset, dispatched by preset id. */
    'conversation.hero.agentPreset.mark': {
      kind: 'keyed'
      scope: 'root'
      owner: AgentPresetBrandMarkOwnerProps
    }
  }
}

/** Presentation requested from a keyed Agent-preset mark occupant. */
export interface AgentPresetBrandMarkOwnerProps {
  /** Preset id used for dispatch and supplied because keyed entries do not receive their key as a prop. */
  presetId: string
  /** Requested square edge in pixels. */
  size: number
  /** Host CSS class; occupants apply it to their outer mark element. */
  className?: string | undefined
}
