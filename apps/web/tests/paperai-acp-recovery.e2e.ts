/** The shipped PaperAI composition restores confirmed ACP settings across process and turn retirement. */
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@paperai/agent-acp'
import {
  assertFixtureInventory, compareOrRefreshGolden, launchWebScaffold, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'

const OVERLAY = fileURLToPath(new URL('../../../packages/bundle/paperai-web/cordis.patch.yml', import.meta.url))
const FAKE_ACP = fileURLToPath(new URL('../../../packages/paperai/agent-acp/tests/fixtures/fake-acp-agent.mjs', import.meta.url))
const SNAPSHOTS = fileURLToPath(new URL('./snapshots/paperai-acp-recovery', import.meta.url))

describe('web e2e: ACP conversation recovery', () => {
  let scaffold: WebScaffold
  let fixtureRoot: string
  let logPath: string

  beforeAll(async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), 'paperai-acp-recovery-'))
    logPath = join(fixtureRoot, 'provider.jsonl')
    scaffold = await launchWebScaffold({
      extraOverlayPath: OVERLAY,
      paperAiAcp: { providers: { codex: {
        command: process.execPath, args: [FAKE_ACP], env: {
          FAKE_ACP_LABEL: 'codex', FAKE_ACP_LOG: logPath, FAKE_ACP_CRASH_ON_PROMPT: 'once',
          FAKE_ACP_GENERAL_OPTION: '1', FAKE_ACP_NOTIFY_CONFIG_UPDATES: '1', FAKE_ACP_MODEL_RESETS_EFFORT: '1',
          FAKE_ACP_CANCEL_FINAL_TOOL: '1', FAKE_ACP_CANCEL_FINAL_TOOL_ONCE_FILE: join(fixtureRoot, 'cancelled'),
        },
      } } },
    })
  }, 120_000)

  afterAll(async () => {
    await scaffold?.close()
    if (fixtureRoot !== undefined) await rm(fixtureRoot, { recursive: true, force: true })
  })

  it('continues one conversation with its confirmed model, effort, switches and general options', async () => {
    const handle = await scaffold.ctx.agents.create({
      sessionId: SessionId('acp-recovery'), factoryRoute: 'codex', meta: { cwd: scaffold.workspaceCwd },
    })
    const agent = handle.agent
    const controller = agent.modelController
    if (controller === undefined) throw new Error('expected ACP model controls')
    const send = (text: string): void => {
      agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
    }
    await controller.selectModel('fake-beta', { reasoningEffort: 'high', switches: { fast: true } })
    await scaffold.ctx.paperAiAcpAgents.selectOption(agent.session.id, 'collaboration', 'team')
    const selectionCount = agent.session.events.filter(event => event.type === 'paperai/acp/config').length
    send('First request interrupted by provider exit.')
    await agent.whenIdle()
    expect(scaffold.ctx.paperAiAcpAgents.sessionDetails(agent.session.id)?.connected).toBe(false)
    await controller.listModels()
    expect(scaffold.ctx.paperAiAcpAgents.sessionDetails(agent.session.id)?.connected).toBe(true)
    send('Cancel this request after the provider starts editing.')
    await expect.poll(async () => (await readFile(logPath, 'utf8')).includes('cancel-tool-start'), { timeout: 10_000 }).toBe(true)
    agent.cancel({ kind: 'user' })
    await agent.whenIdle()
    send('Continue with the same saved settings.')
    await agent.whenIdle()
    expect(agent.session.events.filter(event => event.type === 'paperai/acp/config')).toHaveLength(selectionCount)
    expect(agent.session.requestHeader()?.config).toMatchObject({ model: 'fake-beta', reasoningEffort: 'high' })
    const providerLog = (await readFile(logPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { event: string })
    expect(providerLog.filter(entry => entry.event === 'initialize')).toHaveLength(3)
    expect(providerLog.filter(entry => entry.event === 'new-session')).toHaveLength(1)
    expect(providerLog.filter(entry => entry.event === 'load-session')).toHaveLength(2)
    const transcript = agent.session.events.flatMap((event) => {
      if (event.type === 'user/message') return [{ role: 'user', content: event.data.content }]
      if (event.type === 'assistant/message') return [{ role: 'assistant', content: event.data.message.content }]
      return []
    })
    const snapshot = JSON.stringify({
      connected: scaffold.ctx.paperAiAcpAgents.sessionDetails(agent.session.id)?.connected,
      selection: agent.session.events.findLast(event => event.type === 'paperai/acp/config')?.data,
      transcript,
    }, null, 2)
    await mkdir(SNAPSHOTS, { recursive: true })
    await compareOrRefreshGolden(join(SNAPSHOTS, 'recovered.expected.md'), snapshot, webSnapshotMode())
    await assertFixtureInventory(SNAPSHOTS, ['recovered.expected.md'])
    await handle.dispose()
  }, 30_000)
})
