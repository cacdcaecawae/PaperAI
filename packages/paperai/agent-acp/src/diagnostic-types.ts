/** Transport-safe ACP diagnostic metadata; no credentials or project capabilities. */

/** One installed adapter and its last observed model catalog. */
export interface AcpDiagnostic {
  readonly provider: 'codex' | 'claude'
  readonly executable: string | null
  readonly adapterVersion: string | null
  readonly agentVersion: string | null
  readonly status: 'discovered' | 'ready' | 'error'
  readonly models: readonly { readonly id: string; readonly name: string }[]
  readonly checkedAt: number | null
  readonly retryAt: number | null
  readonly elapsedMs: number | null
  readonly error: 'unavailable' | 'timeout' | 'authentication' | 'protocol' | null
}

/** Validated deployment limits for independent ACP probes. */
export interface AcpDiagnosticLimits {
  readonly probeTimeoutMs: number
  readonly failureCooldownMs: number
}
