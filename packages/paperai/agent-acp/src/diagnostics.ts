/** Adapter discovery, cached model metadata, and bounded prompt-free ACP diagnostics. */

import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { AcpRuntime, discoverAdapter, type AcpProviderDefinition, type AcpSessionStart } from './runtime.ts'
import type { AcpDiagnostic, AcpDiagnosticLimits } from './diagnostic-types.ts'

function providerKey(provider: AcpProviderDefinition): string {
  return createHash('sha256').update(JSON.stringify(provider)).digest('hex')
}

/** Per-plugin diagnostic cache; it never owns or shares a conversation's ACP process. */
export class AcpDiagnostics {
  private readonly cache = new Map<string, { readonly key: string; readonly result: AcpDiagnostic }>()
  private readonly pending = new Map<string, Promise<AcpDiagnostic>>()
  private readonly lifetime = new AbortController()

  constructor(private readonly ctx: Context) {}

  /**
   * Read the last matching metadata without starting a process.
   * @param provider - current adapter launch configuration.
   * @returns discovered installation and any matching session metadata.
   */
  read(provider: AcpProviderDefinition): AcpDiagnostic {
    const cached = this.cache.get(provider.id)
    if (cached?.key === providerKey(provider)) return cached.result
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
    }
    if (!this.lifetime.signal.aborted) this.cache.set(provider.id, { key: providerKey(provider), result })
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
    const key = providerKey(provider)
    const pending = this.pending.get(key)
    if (pending !== undefined) return pending
    const current = this.read(provider)
    if (!force && (current.status === 'ready' || (current.retryAt !== null && current.retryAt > Date.now()))) {
      return Promise.resolve(current)
    }
    const run = this.run(provider, limits).finally(() => { this.pending.delete(key) })
    this.pending.set(key, run)
    return run
  }

  /** Abort probes and await their complete process-tree teardown. */
  async dispose(): Promise<void> {
    this.lifetime.abort()
    await Promise.allSettled(this.pending.values())
    this.cache.clear()
  }

  private async run(provider: AcpProviderDefinition, limits: AcpDiagnosticLimits): Promise<AcpDiagnostic> {
    const began = Date.now()
    const previous = this.cache.get(provider.id)
    const timeout = new AbortController()
    const timer = setTimeout(() => { timeout.abort(new Error('ACP diagnostic timed out')) }, limits.probeTimeoutMs)
    const signal = AbortSignal.any([this.lifetime.signal, timeout.signal])
    let directory: string | undefined
    let runtime: AcpRuntime | undefined
    try {
      directory = await mkdtemp(join(tmpdir(), 'paperai-acp-probe-'))
      signal.throwIfAborted()
      runtime = new AcpRuntime(this.ctx, provider, directory, {
        update: () => {}, modelChanged: () => {}, modeChanged: () => {},
        readTextFile: () => Promise.reject(new Error('diagnostics cannot read files')),
        writeTextFile: () => Promise.reject(new Error('diagnostics cannot write files')),
        permission: () => ({ outcome: { outcome: 'cancelled' } }),
      })
      const started = await runtime.start(undefined, 'read-only', signal)
      if (this.cache.get(provider.id) !== previous) return this.read(provider)
      return this.remember(provider, started, Date.now() - began)
    } catch (cause) {
      if (this.lifetime.signal.aborted) throw cause
      const text = String(cause)
      const result: AcpDiagnostic = {
        ...this.read(provider), status: 'error', checkedAt: Date.now(), retryAt: Date.now() + limits.failureCooldownMs,
        error: timeout.signal.aborted ? 'timeout' : /auth|login|credential|unauthorized/iu.test(text) ? 'authentication'
          : /ENOENT|Cannot find module|does not expose/iu.test(text) ? 'unavailable' : 'protocol',
        elapsedMs: Date.now() - began,
      }
      if (this.cache.get(provider.id) === previous) this.cache.set(provider.id, { key: providerKey(provider), result })
      return this.read(provider)
    } finally {
      clearTimeout(timer)
      await runtime?.close()
      if (directory !== undefined) await rm(directory, { recursive: true, force: true })
    }
  }
}
