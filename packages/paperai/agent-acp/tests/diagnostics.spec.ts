import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { afterEach, describe, expect, it } from 'vitest'
import { AcpDiagnostics } from '../src/diagnostics.ts'
import type { AcpProviderDefinition } from '../src/runtime.ts'

const resources: Array<{ ctx: Context; diagnostics: AcpDiagnostics; root: string }> = []
afterEach(async () => {
  for (const { ctx, diagnostics, root } of resources.splice(0)) {
    await diagnostics.dispose()
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'paperai-diagnostics-test-'))
  const ctx = new Context()
  await ctx.plugin(LocalSubprocessRuntime)
  const diagnostics = new AcpDiagnostics(ctx)
  resources.push({ ctx, diagnostics, root })
  const log = join(root, 'probe.jsonl')
  const provider: AcpProviderDefinition = {
    id: 'codex', name: 'Codex', packageName: '@agentclientprotocol/codex-acp', binName: 'codex-acp',
    command: process.execPath,
    args: [fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url))],
    env: { FAKE_ACP_LABEL: 'codex', FAKE_ACP_LOG: log },
  }
  return { diagnostics, provider, log }
}

describe('independent ACP diagnostics', () => {
  it('shares concurrent prompt-free probes and retains only matching model metadata', async () => {
    const { diagnostics, provider, log } = await setup()
    expect(diagnostics.read(provider).status).toBe('discovered')
    const limits = { probeTimeoutMs: 5000, failureCooldownMs: 60_000 }
    const first = diagnostics.probe(provider, limits, false)
    expect(diagnostics.probe(provider, limits, false)).toBe(first)
    const result = await first
    expect(result).toMatchObject({ status: 'ready', models: [{ id: 'fake-alpha', name: 'Fake Alpha' }, { id: 'fake-beta', name: 'Fake Beta' }] })
    expect(await diagnostics.probe(provider, limits, false)).toBe(result)
    const events = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { event: string; mcpServers?: unknown[]; cwd?: string })
    expect(events.filter(event => event.event === 'initialize')).toHaveLength(1)
    expect(events.some(event => event.event === 'prompt')).toBe(false)
    const session = events.find(event => event.event === 'new-session')!
    expect(session.mcpServers).toEqual([])
    await expect(lstat(session.cwd!)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(diagnostics.read({ ...provider, env: { ...provider.env, NEW_SETTING: 'changed' } }).models).toEqual([])
  })

  it('times out stalled initialization, cools down failures, and permits explicit retry', async () => {
    const { diagnostics, provider } = await setup()
    const stalled = { ...provider, args: ['-e', 'setInterval(() => {}, 1000)'] }
    const limits = { probeTimeoutMs: 100, failureCooldownMs: 60_000 }
    const first = await diagnostics.probe(stalled, limits, false)
    expect(first).toMatchObject({ status: 'error', error: 'timeout' })
    expect(first.retryAt).toBeGreaterThan(Date.now())
    expect(await diagnostics.probe(stalled, limits, false)).toBe(first)
    const next = await diagnostics.probe(stalled, limits, true)
    expect(next.checkedAt).toBeGreaterThan(first.checkedAt!)
    await diagnostics.dispose()
    expect(() => diagnostics.probe(provider, limits, true)).toThrow()
  })
})
