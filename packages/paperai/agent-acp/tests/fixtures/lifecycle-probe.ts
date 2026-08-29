import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SandboxedFileSystem from '@deepseek-ai/dsh-fs-sandbox'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import PaperAiAcpAgents from '../../src/index.ts'

const root = await mkdtemp(join(tmpdir(), 'paperai-acp-lifecycle-probe-'))
const fakeAgentPath = fileURLToPath(new URL('./fake-acp-agent.mjs', import.meta.url))
const action = process.argv[2] ?? 'dispose'
const ctx = new Context()

try {
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: root })
  await ctx.plugin(SandboxedFileSystem, { cwd: root })
  ctx.provide('paperMcp', {
    issueDescriptor: (actor: Record<string, unknown>) => ({
      descriptor: {
        type: 'http',
        name: 'paperai',
        url: 'http://127.0.0.1:3210/api/paperai/mcp',
        headers: [{ name: 'Authorization', value: 'Bearer lifecycle-probe' }],
      },
      get actor() { return structuredClone(actor) },
      updateActor: (next: Record<string, unknown>) => structuredClone(next),
      dispose: () => Promise.resolve(),
    }),
  } as never)
  await ctx.plugin(PaperAiAcpAgents, {
    codex: {
      command: process.execPath,
      args: [fakeAgentPath],
      env: {
        FAKE_ACP_LABEL: 'codex',
        FAKE_ACP_SESSION_ID: 'lifecycle-probe',
        ...action === 'startup-rollback'
          ? { FAKE_ACP_FAIL_ONCE_FILE: join(root, 'fail-once.marker') }
          : {},
      },
    },
  })
  if (action === 'startup-rollback') {
    try {
      await ctx.agents.create({
        sessionId: SessionId('startup-rollback'),
        factoryRoute: 'codex',
        meta: { cwd: root },
      })
      throw new Error('scripted ACP startup unexpectedly succeeded')
    } catch (error: unknown) {
      if (!(error instanceof Error) || !error.message.includes('ACP failed to start')) throw error
    }
    if (ctx.agents.get(SessionId('startup-rollback')) !== undefined
      || ctx.sessions.get(SessionId('startup-rollback')) !== undefined) {
      throw new Error('failed ACP startup left the Agent or Session registered')
    }
    await ctx.agents.create({
      sessionId: SessionId('startup-rollback'),
      factoryRoute: 'codex',
      meta: { cwd: root },
    })
  } else if (action === 'dispose') {
    const handle = await ctx.agents.create({
      sessionId: SessionId('lifecycle-probe'),
      factoryRoute: 'codex',
      meta: { cwd: root },
    })
    await handle.dispose()
    if (ctx.agents.get(handle.agent.id) !== undefined || ctx.sessions.get(handle.agent.id) !== undefined) {
      throw new Error('public handle disposal left the Agent or Session registered')
    }
  } else {
    throw new Error(`unknown lifecycle probe action ${JSON.stringify(action)}`)
  }
} finally {
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
}
