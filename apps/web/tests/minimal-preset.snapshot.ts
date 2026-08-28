import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { assertFixtureInventory, launchWebScaffold, type WebScaffold } from './scaffold.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/minimal-preset', import.meta.url))
const FIXTURE = join(SNAPSHOT_DIR, 'session.jsonl')
const PROMPT = 'Reply exactly MINIMAL_PRESET_REQUEST_OK and stop.'
const NATIVE_SHELL_TOOL = process.platform === 'win32' ? 'pwsh' : 'bash'

function shellCommands(stateDir: string): { setup: string; read: string } {
  if (process.platform === 'win32') {
    return {
      setup: `Set-Location -LiteralPath ${JSON.stringify(stateDir)}; $env:DSH_MINIMAL_STATE = 'PERSISTED'`,
      read: 'Write-Output "$($env:DSH_MINIMAL_STATE):$($PWD.Path)"',
    }
  }
  return {
    setup: `cd ${JSON.stringify(stateDir)} && export DSH_MINIMAL_STATE=PERSISTED`,
    read: 'printf \'%s:%s\n\' "$DSH_MINIMAL_STATE" "$PWD"',
  }
}

function normalizeWorkspacePaths(value: string, workspaceCwd: string): string {
  const normalizedCwd = workspaceCwd.replaceAll('\\', '/')
  return value.replaceAll('\\', '/').split(normalizedCwd).join('{{cwd}}')
}

describe('minimal agent preset', () => {
  let scaffold: WebScaffold
  let agentHandle: AgentHandle
  let disposeInjectedPrompt: () => void

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ replayFixture: FIXTURE })
    disposeInjectedPrompt = scaffold.ctx.systemPrompt.section({
      name: 'test:injected-prompt',
      order: 999,
      text: 'THIS TEXT MUST NOT REACH THE MODEL.',
    })
    agentHandle = await scaffold.ctx.agents.create({
      sessionId: SessionId('minimal-preset-smoke'),
      meta: { cwd: scaffold.workspaceCwd, agentPreset: 'minimal' },
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      setup: agentCtx => scaffold.ctx.agentPresets.mount(agentCtx, 'minimal').then(() => undefined),
    })
  })

  afterAll(async () => {
    const failures: unknown[] = []
    await agentHandle?.dispose().catch((error: unknown) => failures.push(error))
    try {
      disposeInjectedPrompt?.()
    } catch (error: unknown) {
      failures.push(error)
    }
    await scaffold?.close().catch((error: unknown) => failures.push(error))
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'minimal preset smoke teardown failed')
  })

  it('sends the exact RL prompt and schemas, then executes the persistent shell and editor', async () => {
    agentHandle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: PROMPT }],
      source: { kind: 'user' },
    }))
    await agentHandle.agent.whenIdle()

    const requestHeader = agentHandle.agent.session.requestHeader()
    if (requestHeader === undefined) throw new Error('the minimal agent issued no model request')
    expect(agentHandle.agent.session.events.some(event => event.type === 'user/message'
      && event.data.source.kind === 'plugin'
      && event.data.source.plugin === '@deepseek-ai/dsh-system-prompt')).toBe(false)
    const presetFileSystem = scaffold.ctx.agentPresets.serviceFor(agentHandle.agent, 'fs')
    expect(presetFileSystem).toBeDefined()
    expect(presetFileSystem?.sandboxMode).toBeUndefined()
    expect(scaffold.ctx.agentPresets.serviceFor(agentHandle.agent, 'compaction')).toBeUndefined()

    const stateDir = join(scaffold.workspaceCwd, 'persistent-state')
    await mkdir(stateDir)
    const signal = new AbortController().signal
    const commands = shellCommands(stateDir)
    await scaffold.ctx.tools.execute({
      signal,
      callId: CallId(`minimal-${NATIVE_SHELL_TOOL}-state-setup`),
      name: NATIVE_SHELL_TOOL,
      arguments: { command: commands.setup },
      agent: agentHandle.agent,
    })
    const shell = await scaffold.ctx.tools.execute({
      signal,
      callId: CallId(`minimal-${NATIVE_SHELL_TOOL}-state-read`),
      name: NATIVE_SHELL_TOOL,
      arguments: { command: commands.read },
      agent: agentHandle.agent,
    })
    const seedPath = join(scaffold.workspaceCwd, 'preset-smoke.txt')
    await writeFile(seedPath, 'MINIMAL_EDITOR_OK\n')
    const editor = await scaffold.ctx.tools.execute({
      signal,
      callId: CallId('minimal-editor-smoke'),
      name: 'str_replace_editor',
      arguments: { command: 'view', path: seedPath },
      agent: agentHandle.agent,
    })

    const text = (result: typeof shell): string => normalizeWorkspacePaths(result.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join(''), scaffold.workspaceCwd)
      .trim()

    expect(requestHeader.tools?.map(tool => tool.name)).toEqual([NATIVE_SHELL_TOOL, 'str_replace_editor'])
    expect(text(shell)).toBe('PERSISTED:{{cwd}}/persistent-state')
    expect({
      prompt: requestHeader.system,
      editor: text(editor),
    }).toMatchInlineSnapshot(`
      {
        "editor": "Here's the content of {{cwd}}/preset-smoke.txt with line numbers (which has a total of 2 lines):
           1  MINIMAL_EDITOR_OK
           2",
        "prompt": "You are a helpful software engineer assistant.",
      }
    `)
    expect(requestHeader.tools?.toSorted((left, right) => left.name.localeCompare(right.name)))
      .toEqual(scaffold.ctx.tools.schemas(agentHandle.agent).toSorted((left, right) => left.name.localeCompare(right.name)))
    await assertFixtureInventory(SNAPSHOT_DIR, ['session.jsonl'])
  })
})
