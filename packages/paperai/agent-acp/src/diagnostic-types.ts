/** Transport-safe ACP diagnostic metadata; no credentials or project capabilities. */

import type { Branded } from '@deepseek-ai/dsh-brand'

type SessionId = Branded<'SessionId'>

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * ACP controls or provider-owned status changed for one live conversation.
     * @mode emit
     * @param sessionId - owning PaperAI session.
     */
    'paperai/acp-changed'(sessionId: SessionId): void
  }
}

/** One installed adapter and its last observed model catalog. */
export interface AcpDiagnostic {
  readonly provider: string
  readonly executable: string | null
  readonly adapterVersion: string | null
  readonly agentVersion: string | null
  readonly status: 'discovered' | 'ready' | 'error'
  readonly models: readonly { readonly id: string; readonly name: string }[]
  readonly checkedAt: number | null
  readonly retryAt: number | null
  readonly elapsedMs: number | null
  readonly error: 'unavailable' | 'timeout' | 'authentication' | 'protocol' | null
  readonly stage?: 'handshake' | 'session' | 'prompt'
  readonly connected?: boolean
  readonly capabilities?: Readonly<Record<string, boolean>>
  readonly authMethods?: readonly {
    readonly id: string
    readonly name: string
    readonly description: string | null
    readonly type: 'agent' | 'terminal'
  }[]
}

/** Validated deployment limits for independent ACP probes. */
export interface AcpDiagnosticLimits {
  readonly probeTimeoutMs: number
  readonly failureCooldownMs: number
  readonly concurrency?: number
}

/** Directory row combining explicit configuration with observed installation and protocol state. */
export interface AcpCatalogEntry {
  readonly id: string
  readonly name: string
  readonly template: string
  readonly enabled: boolean
  readonly connected: boolean
  readonly startup: { readonly stage: string; readonly elapsedMs: number } | null
  readonly host: string
  readonly command: string
  readonly args: readonly string[]
  readonly cli: string | null
  readonly adapter: string | null
  readonly source: 'bundled' | 'managed' | 'external' | 'remote'
  readonly documentation: string | null
  readonly login: string | null
  readonly installable: boolean
  readonly diagnostic: AcpDiagnostic
  readonly busy: string | null
  readonly output: string | null
}

/** Explicit, capability-gated management requests for one ACP connection. */
export type AcpManagementRequest =
  | { readonly kind: 'authenticate'; readonly methodId: string }
  | { readonly kind: 'logout' }
  | { readonly kind: 'history'; readonly cwd?: string; readonly cursor?: string }
  | { readonly kind: 'delete'; readonly sessionId: string }
  | { readonly kind: 'providers' }
  | {
    readonly kind: 'set-provider'
    readonly providerId: string
    readonly apiType: string
    readonly baseUrl: string
    readonly headers: Readonly<Record<string, string>>
  }
  | { readonly kind: 'disable-provider'; readonly providerId: string }

/** Provider history remains distinct from PaperAI's local session index. */
export interface AcpHistoryEntry {
  readonly sessionId: string
  readonly cwd: string
  readonly title: string | null
  readonly updatedAt: string | null
  readonly additionalDirectories: readonly string[]
}

/** Non-secret routing fields returned by providers/list. */
export interface AcpRoutingProvider {
  readonly id: string
  readonly supported: readonly string[]
  readonly required: boolean
  readonly current: { readonly apiType: string; readonly baseUrl: string } | null
}

/** Management results discard arbitrary SDK metadata and credentials. */
export interface AcpManagementResult {
  readonly sessions?: readonly AcpHistoryEntry[]
  readonly nextCursor?: string | null
  readonly providers?: readonly AcpRoutingProvider[]
}

/** Provider-owned status retained across turns and reloads. */
export interface AcpSessionState {
  readonly commands: readonly { readonly name: string; readonly description: string; readonly hint: string | null }[]
  readonly plans: readonly {
    readonly id: string
    readonly text: string
    readonly entries: readonly { readonly content: string; readonly status: 'pending' | 'in_progress' | 'completed' }[]
  }[]
  readonly compactions: readonly {
    readonly id: string
    readonly status: string
    readonly summary: string
    readonly error: string | null
  }[]
  readonly title: string | null
  readonly updatedAt: string | null
  readonly usage: {
    readonly used: number
    readonly size: number
    readonly cost: { readonly amount: number; readonly currency: string } | null
  } | null
  readonly stopReason: string | null
}

/** Current conversation controls derived only from the active provider connection. */
export interface AcpSessionDetails {
  readonly provider: string
  readonly name: string
  readonly connected: boolean
  readonly externalSessionId: string | null
  readonly capabilities: Readonly<Record<string, boolean>>
  readonly options: readonly {
    readonly id: string
    readonly name: string
    readonly description: string | null
    readonly category: string | null
    readonly value: string | boolean
    readonly choices: readonly { readonly value: string; readonly name: string }[]
    readonly editable: boolean
  }[]
  readonly state: AcpSessionState
}
