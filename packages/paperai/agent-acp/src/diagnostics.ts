/** Adapter discovery, cached model metadata, and bounded prompt-free ACP diagnostics. */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { InitializeResponse } from '@agentclientprotocol/sdk'
import { AcpRuntime, discoverAdapter, ISOLATED_ACP_CALLBACKS, type AcpProviderDefinition, type AcpSessionStart } from './runtime.ts'
import type { AcpDiagnostic, AcpDiagnosticLimits } from './diagnostic-types.ts'
import { providerLaunchKey } from './providers.ts'

/**
 * Project advertised features without extension metadata or authentication environment values.
 * @param initialized - validated ACP initialization response.
 * @returns transport-safe capability and authentication summaries.
 */
export function diagnosticCapabilities(initialized: InitializeResponse): Pick<AcpDiagnostic, 'capabilities' | 'authMethods'> {
  const caps = initialized.agentCapabilities
  const sessions = caps?.sessionCapabilities
  return {
    capabilities: {
      load: caps?.loadSession === true,
      resume: sessions?.resume != null, list: sessions?.list != null, fork: sessions?.fork != null,
      close: sessions?.close != null, delete: sessions?.delete != null,
      additionalDirectories: sessions?.additionalDirectories != null,
      image: caps?.promptCapabilities?.image === true, audio: caps?.promptCapabilities?.audio === true,
      embeddedContext: caps?.promptCapabilities?.embeddedContext === true,
      mcpHttp: caps?.mcpCapabilities?.http === true, mcpSse: caps?.mcpCapabilities?.sse === true,
      providers: caps?.providers != null, logout: caps?.auth?.logout != null,
    },
    authMethods: (initialized.authMethods ?? []).map(method => ({
      id: method.id, name: method.name, description: method.description ?? null,
      type: 'type' in method ? 'terminal' : 'agent',
    })),
  }
}

/** Per-plugin diagnostic cache; it never owns or shares a conversation's ACP process. */
export class AcpDiagnostics {
  private readonly cache = new Map<string, { readonly key: string; readonly result: AcpDiagnostic }>()
  private readonly pending = new Map<string, { provider: string; abort: AbortController; result: Promise<AcpDiagnostic> }>()
  private readonly active = new Set<Promise<void>>()
  private readonly lifetime = new AbortController()

  constructor(private readonly ctx: Context) {}

  /**
   * Read the last matching metadata without starting a process.
   * @param provider - current adapter launch configuration.
   * @returns discovered installation and any matching session metadata.
   */
  read(provider: AcpProviderDefinition): AcpDiagnostic {
    const cached = this.cache.get(provider.id)
    if (cached?.key === providerLaunchKey(provider)) return cached.result
    try {
      return { provider: provider.id, ...discoverAdapter(provider), status: 'discovered', models: [], checkedAt: null, retryAt: null, error: null, agentVersion: null, elapsedMs: null }
    } catch {
      return { provider: provider.id, executable: null, adapterVersion: null, status: 'error', models: [], checkedAt: null, retryAt: null, error: 'unavailable', agentVersion: null, elapsedMs: null }
    }
  }

  /**
   * Cache metadata from an actual ready session without retaining its process or project capabilities.
   * @param provider - exact configuration used for startup.
   * @param started - successfully initialized ACP session.
   * @param elapsedMs - startup duration.
   * @returns the non-authoritative model preview.
   */
  remember(provider: AcpProviderDefinition, started: AcpSessionStart, elapsedMs: number): AcpDiagnostic {
    const result: AcpDiagnostic = {
      provider: provider.id, ...discoverAdapter(provider), status: 'ready',
      models: started.models.models.map(model => ({ id: model.id, name: model.name })),
      checkedAt: Date.now(), retryAt: null, error: null,
      agentVersion: started.initialized.agentInfo?.version ?? null, elapsedMs,
      stage: 'session', ...diagnosticCapabilities(started.initialized),
    }
    if (!this.lifetime.signal.aborted) this.cache.set(provider.id, { key: providerLaunchKey(provider), result })
    return result
  }

  /**
   * Probe one adapter in an empty temporary directory, with no prompt, MCP servers, or file permissions.
   * @param provider - configured adapter to inspect.
   * @param limits - validated timeout and background retry cooldown.
   * @param force - explicit user retry that bypasses cached failure cooldown.
   * @returns metadata after protocol and process teardown; concurrent requests share the same probe.
   */
  probe(provider: AcpProviderDefinition, limits: AcpDiagnosticLimits, force: boolean): Promise<AcpDiagnostic> {
    this.lifetime.signal.throwIfAborted()
    const key = providerLaunchKey(provider)
    const pending = this.pending.get(key)
    if (pending !== undefined) return pending.result
    const current = this.read(provider)
    if (!force && (current.status === 'ready' || (current.retryAt !== null && current.retryAt > Date.now()))) {
      return Promise.resolve(current)
    }
    for (const [previousKey, previous] of this.pending) {
      if (previous.provider === provider.id && previousKey !== key) previous.abort.abort(new Error('ACP configuration changed'))
    }
    const abort = new AbortController()
    const run = this.run(provider, limits, abort.signal).finally(() => { this.pending.delete(key) })
    this.pending.set(key, { provider: provider.id, abort, result: run })
    return run
  }

  /** Abort probes and await their complete process-tree teardown. */
  async dispose(): Promise<void> {
    this.lifetime.abort()
    await Promise.allSettled([...this.pending.values()].map(entry => entry.result))
    this.cache.clear()
  }

  /**
   * Cancel this instance's queued or running probes.
   * @param provider - stable configured instance id.
   */
  cancel(provider: string): void {
    for (const entry of this.pending.values()) if (entry.provider === provider) entry.abort.abort(new Error('ACP diagnostic cancelled'))
  }

  /**
   * Read whether a channel has an outstanding diagnostic.
   * @param provider - stable configured instance id.
   * @returns true for either a queued or running probe.
   */
  isProbing(provider: string): boolean { return [...this.pending.values()].some(entry => entry.provider === provider) }

  /**
   * Distinguish successful model calls from handshake-only probes and session startup.
   * @param provider - exact configuration used by the successful prompt.
   */
  promptSucceeded(provider: AcpProviderDefinition): void {
    const cached = this.cache.get(provider.id)
    if (cached?.key === providerLaunchKey(provider)) this.cache.set(provider.id, { ...cached, result: { ...cached.result, stage: 'prompt' } })
  }

  private async run(provider: AcpProviderDefinition, limits: AcpDiagnosticLimits, callerSignal: AbortSignal): Promise<AcpDiagnostic> {
    const cancelled = Promise.withResolvers<never>()
    const lifetime = AbortSignal.any([callerSignal, this.lifetime.signal])
    const onAbort = (): void => { cancelled.reject(lifetime.reason) }
    lifetime.addEventListener('abort', onAbort, { once: true })
    const slot = Promise.withResolvers<void>()
    try {
      lifetime.throwIfAborted()
      while (this.active.size >= (limits.concurrency ?? 2)) await Promise.race([...this.active, cancelled.promise])
      lifetime.throwIfAborted()
      this.active.add(slot.promise)
    } finally {
      lifetime.removeEventListener('abort', onAbort)
    }
    const began = Date.now()
    const previous = this.cache.get(provider.id)
    const timeout = new AbortController()
    const timer = setTimeout(() => { timeout.abort(new Error('ACP diagnostic timed out')) }, limits.probeTimeoutMs)
    const signal = AbortSignal.any([lifetime, timeout.signal])
    let directory: string | undefined
    let runtime: AcpRuntime | undefined
    try {
      directory = await mkdtemp(join(tmpdir(), 'paperai-acp-probe-'))
      signal.throwIfAborted()
      runtime = new AcpRuntime(this.ctx, provider, directory, ISOLATED_ACP_CALLBACKS)
      const initialized = await runtime.initialize(signal)
      if (this.cache.get(provider.id) !== previous) return this.read(provider)
      const result: AcpDiagnostic = {
        ...this.read(provider), status: 'ready', checkedAt: Date.now(), retryAt: null, error: null,
        agentVersion: initialized.agentInfo?.version ?? null, elapsedMs: Date.now() - began,
        stage: 'handshake', ...diagnosticCapabilities(initialized),
      }
      this.cache.set(provider.id, { key: providerLaunchKey(provider), result })
      return result
    } catch (cause) {
      if (lifetime.aborted) throw cause
      const text = String(cause)
      const result: AcpDiagnostic = {
        ...this.read(provider), status: 'error', checkedAt: Date.now(), retryAt: Date.now() + limits.failureCooldownMs,
        error: timeout.signal.aborted ? 'timeout' : /auth|login|credential|unauthorized/iu.test(text) ? 'authentication'
          : /ENOENT|Cannot find module|does not expose/iu.test(text) ? 'unavailable' : 'protocol',
        elapsedMs: Date.now() - began,
      }
      if (this.cache.get(provider.id) === previous) this.cache.set(provider.id, { key: providerLaunchKey(provider), result })
      return this.read(provider)
    } finally {
      clearTimeout(timer)
      try { await runtime?.close() }
      finally {
        try { if (directory !== undefined) await rm(directory, { recursive: true, force: true }) }
        finally { this.active.delete(slot.promise); slot.resolve() }
      }
    }
  }
}
