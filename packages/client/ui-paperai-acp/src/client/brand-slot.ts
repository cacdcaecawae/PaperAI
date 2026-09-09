/** Brand marks owned by the ACP settings directory and dispatched by channel id. */

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Decorative channel mark; the adjacent channel name supplies its accessible label. */
    'paperai.acp.channel.mark': {
      kind: 'keyed'
      scope: 'root'
      owner: AcpChannelMarkOwnerProps
    }
  }
}

/** Presentation requested from an ACP channel mark occupant. */
export interface AcpChannelMarkOwnerProps {
  /** Agent preset id corresponding to the channel's registration key. */
  presetId: string
  /** Requested square edge in pixels. */
  size: number
}
