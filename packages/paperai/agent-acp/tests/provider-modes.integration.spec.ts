import { afterEach, describe, expect, it } from 'vitest'
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SessionModeState } from '@agentclientprotocol/sdk'
import { ClaudeAcpAgent } from '@agentclientprotocol/claude-agent-acp'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { AcpRuntime, type AcpProviderDefinition } from '../src/runtime.ts'

const fakeCodexAppServerPath = fileURLToPath(new URL('./fixtures/fake-codex-app-server.cjs', import.meta.url))
const cleanup: Array<{ ctx: Context; root: string }> = []

afterEach(async () => {
  for (const resource of cleanup.splice(0).reverse()) {
    await resource.ctx.fiber.dispose()
    await rm(resource.root, { recursive: true, force: true })
  }
})

describe('pinned provider ACP permission modes', { concurrent: false }, () => {
  it('switches every Codex mapping through the real codex-acp adapter', async () => {
    const root = await mkdtemp(join(tmpdir(), 'paperai-real-codex-acp-'))
    await copyFile(fakeCodexAppServerPath, join(root, 'app-server'))
    const ctx = new Context()
    cleanup.push({ ctx, root })
    await ctx.plugin(LocalSubprocessRuntime)
    const provider: AcpProviderDefinition = {
      id: 'codex',
      name: 'Codex',
      packageName: '@agentclientprotocol/codex-acp',
      binName: 'codex-acp',
      env: { CODEX_PATH: process.execPath },
    }
    const runtime = new AcpRuntime(ctx, provider, root, {
      update: () => {},
      modelChanged: () => {},
      modeChanged: () => {},
      readTextFile: () => Promise.reject(new Error('unexpected read')),
      writeTextFile: () => Promise.reject(new Error('unexpected write')),
      permission: () => ({ outcome: { outcome: 'cancelled' } }),
    })

    try {
      await runtime.start(undefined, 'workspace-write', new AbortController().signal)
      await expect(runtime.selectSandboxMode('read-only')).resolves.toBeUndefined()
      await expect(runtime.selectSandboxMode('danger-full-access')).resolves.toBeUndefined()
      await expect(runtime.selectSandboxMode('workspace-write')).resolves.toBeUndefined()
    } finally {
      await runtime.close()
    }
  }, 20_000)

  it('switches every Claude mapping through the real claude-agent-acp adapter', async () => {
    const updates: unknown[] = []
    const client = {
      sessionUpdate: (params) => {
        updates.push(params)
        return Promise.resolve()
      },
      requestPermission: () => Promise.resolve({ outcome: { outcome: 'cancelled' } }),
      readTextFile: () => Promise.reject(new Error('unexpected read')),
      writeTextFile: () => Promise.reject(new Error('unexpected write')),
      unstable_createElicitation: () => Promise.reject(new Error('unexpected elicitation')),
      unstable_completeElicitation: () => Promise.resolve(),
      extNotification: () => Promise.resolve(),
    } satisfies ConstructorParameters<typeof ClaudeAcpAgent>[0]
    const adapter = new ClaudeAcpAgent(client)
    const availableModes: SessionModeState['availableModes'] = [
      { id: 'default', name: 'Manual' },
      { id: 'acceptEdits', name: 'Accept Edits' },
      { id: 'plan', name: 'Plan Mode' },
      { id: 'dontAsk', name: "Don't Ask" },
      { id: 'bypassPermissions', name: 'Bypass Permissions' },
    ]
    const selectedModes: string[] = []
    const setPermissionMode = (mode: string): Promise<void> => {
      selectedModes.push(mode)
      return Promise.resolve()
    }
    adapter.sessions['real-claude-adapter-session'] = {
      queryClosed: false,
      query: { setPermissionMode },
      modes: { currentModeId: 'default', availableModes },
      configOptions: [{
        id: 'mode',
        name: 'Mode',
        category: 'mode',
        type: 'select',
        currentValue: 'default',
        options: availableModes.map(mode => ({ value: mode.id, name: mode.name })),
      }],
    } as unknown as (typeof adapter.sessions)[string]

    for (const modeId of ['plan', 'acceptEdits', 'bypassPermissions']) {
      await adapter.setSessionMode({ sessionId: 'real-claude-adapter-session', modeId })
    }

    expect(selectedModes).toEqual(['plan', 'acceptEdits', 'bypassPermissions'])
    expect(updates).toHaveLength(3)
  })
})
