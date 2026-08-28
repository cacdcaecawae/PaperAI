// Keyless replay of a real two-round Goal run. Each autonomous round ends as
// its own turn, so the first answer must keep its IconActions when Goal opens
// round two and the final answer must own a second, distinct action row.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { loadReplayScript, parseSessionLog, type ReplayEntry } from '@deepseek-ai/dsh-llm-replay'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-goal'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, recordFixture, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/goal-multi-turn-actions', import.meta.url))
const FIXTURE = join(SNAPSHOT_DIR, 'session.jsonl')
const OVERRIDE = join(SNAPSHOT_DIR, 'replay.override.json')
const UI_EXPECTED = join(SNAPSHOT_DIR, 'ui.expected.md')
const MODE = webSnapshotMode()
const NATIVE_SHELL_TOOL = process.platform === 'win32' ? 'pwsh' : 'bash'

const PROMPT = '做两个turn，每个turn输出随机一个包的文件结构。注意你做完一个turn之后，直接输出内容，停止，我们的系统会帮你再开一个turn，你看着做一个类似的'
const COMMAND = `/goal ${PROMPT}`

const PACKAGE_DIRECTORY_COMMAND = "$packageDirs = @(Get-ChildItem -LiteralPath 'packages' -Directory | ForEach-Object { Get-ChildItem -LiteralPath $_.FullName -Directory } | Sort-Object FullName)"
const SHELL_DESCRIPTIONS = [
  'Show working directory and its contents',
  'List packages directory contents',
  'Randomly pick one package directory',
  'Randomly select one package with Python',
  'List all files in session-reference package',
  'Randomly select another package with Python',
  'Re-roll excluding the package from turn 1',
  'List all files in token-meter package',
] as const
const WINDOWS_COMMAND_BY_DESCRIPTION: Readonly<Record<(typeof SHELL_DESCRIPTIONS)[number], string>> = {
  'Show working directory and its contents':
    '$PWD.Path; Get-ChildItem -Force | Sort-Object Name | ForEach-Object { $_.Name }',
  'List packages directory contents':
    "Get-ChildItem -LiteralPath 'packages' -Directory | Sort-Object Name | ForEach-Object { $_.Name }; '---'; "
    + `${PACKAGE_DIRECTORY_COMMAND}; $packageDirs | ForEach-Object { [IO.Path]::GetRelativePath($PWD.Path, $_.FullName).Replace([char]92, [char]47) }`,
  'Randomly pick one package directory':
    `${PACKAGE_DIRECTORY_COMMAND}; for ($index = 0; $index -lt $packageDirs.Count; $index += 1) { `
    + "'{0}: {1}' -f ($index + 1), ([IO.Path]::GetRelativePath($PWD.Path, $packageDirs[$index].FullName).Replace([char]92, [char]47)) }; "
    + "'---random pick---'; [Console]::Error.WriteLine('shuf is unavailable in this fixture'); exit 1",
  'Randomly select one package with Python':
    `${PACKAGE_DIRECTORY_COMMAND}; [IO.Path]::GetRelativePath($PWD.Path, $packageDirs[1].FullName).Replace([char]92, [char]47)`,
  'List all files in session-reference package':
    "Get-ChildItem -LiteralPath 'packages/context/session-reference' -File -Recurse | Sort-Object FullName | ForEach-Object { [IO.Path]::GetRelativePath($PWD.Path, $_.FullName).Replace([char]92, [char]47) }",
  'Randomly select another package with Python':
    `${PACKAGE_DIRECTORY_COMMAND}; [IO.Path]::GetRelativePath($PWD.Path, $packageDirs[1].FullName).Replace([char]92, [char]47)`,
  'Re-roll excluding the package from turn 1':
    `${PACKAGE_DIRECTORY_COMMAND}; $candidates = @($packageDirs | Where-Object { `
    + "[IO.Path]::GetRelativePath($PWD.Path, $_.FullName).Replace([char]92, [char]47) -ne 'packages/context/session-reference' }); "
    + '[IO.Path]::GetRelativePath($PWD.Path, $candidates[1].FullName).Replace([char]92, [char]47)',
  'List all files in token-meter package':
    "Get-ChildItem -LiteralPath 'packages/llm/token-meter' -File -Recurse | Sort-Object FullName | ForEach-Object { [IO.Path]::GetRelativePath($PWD.Path, $_.FullName).Replace([char]92, [char]47) }",
}

const PACKAGE_FILES: Readonly<Record<string, string>> = {
  'packages/client/ui-conversation/README.md': '# UI conversation\n',
  'packages/client/ui-conversation/package.json': '{"name":"@deepseek-ai/dsh-client-ui-conversation"}\n',
  'packages/client/ui-conversation/src/client.ts': 'export {}\n',
  'packages/client/ui-conversation/tests/chat-view.client.spec.tsx': 'export {}\n',
  'packages/context/session-reference/README.md': '# Session reference\n',
  'packages/context/session-reference/package.json': '{"name":"@deepseek-ai/dsh-session-reference"}\n',
  'packages/context/session-reference/src/index.ts': 'export {}\n',
  'packages/context/session-reference/src/uri.ts': 'export {}\n',
  'packages/context/session-reference/tests/session-reference.spec.ts': 'export {}\n',
  'packages/llm/token-meter/README.md': '# Token meter\n',
  'packages/llm/token-meter/package.json': '{"name":"@deepseek-ai/dsh-token-meter"}\n',
  'packages/llm/token-meter/src/index.ts': 'export {}\n',
  'packages/llm/token-meter/tests/token-meter.spec.ts': 'export {}\n',
  'packages/skill/skill-filesystem/README.md': '# Local skill provider\n',
  'packages/skill/skill-filesystem/package.json': '{"name":"@deepseek-ai/dsh-skill-filesystem"}\n',
  'packages/skill/skill-filesystem/src/index.ts': 'export {}\n',
  'packages/skill/skill-filesystem/src/invariant.ts': 'export {}\n',
  'packages/skill/skill-filesystem/tests/skill-filesystem.spec.ts': 'export {}\n',
}

/** Materialize a stable package inventory inside the isolated session workspace. */
async function seedPackageInventory(workspaceRoot: string): Promise<void> {
  for (const [relativePath, content] of Object.entries(PACKAGE_FILES)) {
    const path = join(workspaceRoot, 'workspace', relativePath)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content)
  }
}

interface ShellArguments {
  readonly command: string
  readonly description: string
}

/** Decode the durable shell argument JSON before replacing its platform command. */
function shellArguments(argumentsJson: string): ShellArguments {
  const value: unknown = JSON.parse(argumentsJson)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Goal replay shell arguments must be an object')
  }
  const { command, description } = value as Record<string, unknown>
  if (typeof command !== 'string' || typeof description !== 'string') {
    throw new Error('Goal replay shell arguments must contain command and description strings')
  }
  return { command, description }
}

/** Replace one recorded bash call with its real PowerShell equivalent. */
function windowsReplayEntry(entry: ReplayEntry): ReplayEntry {
  if (entry.kind !== 'chunks') return entry
  const replacements = new Map<string, string>()
  for (const chunk of entry.chunks) {
    if (chunk.type !== 'block-end' || chunk.block.type !== 'tool-call' || chunk.block.name !== 'bash') continue
    const args = shellArguments(chunk.block.arguments)
    if (!Object.hasOwn(WINDOWS_COMMAND_BY_DESCRIPTION, args.description)) {
      throw new Error(`Goal replay has no PowerShell command for ${JSON.stringify(args.description)}`)
    }
    const command = WINDOWS_COMMAND_BY_DESCRIPTION[args.description as keyof typeof WINDOWS_COMMAND_BY_DESCRIPTION]
    replacements.set(chunk.block.id, JSON.stringify({ command, description: args.description }))
  }
  if (replacements.size === 0) return entry

  const emittedArguments = new Set<string>()
  const chunks = entry.chunks.map((chunk) => {
    if (chunk.type === 'tool-call-delta') {
      const replacement = replacements.get(chunk.id)
      if (replacement === undefined) return chunk
      const argumentsDelta = emittedArguments.has(chunk.id) ? '' : replacement
      emittedArguments.add(chunk.id)
      return { ...chunk, name: 'pwsh', argumentsDelta }
    }
    if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
      const replacement = replacements.get(chunk.block.id)
      if (replacement !== undefined) {
        return { ...chunk, block: { ...chunk.block, name: 'pwsh', arguments: replacement } }
      }
    }
    return chunk
  })
  for (const callId of replacements.keys()) {
    if (!emittedArguments.has(callId)) throw new Error(`Goal replay shell call ${callId} has no argument delta`)
  }
  return { ...entry, chunks }
}

/** Materialize a full Windows replay override without touching committed fixtures. */
async function writeWindowsReplayOverride(directory: string): Promise<string> {
  const path = join(directory, 'replay.override.json')
  const entries = loadReplayScript({ file: FIXTURE, overrideFile: OVERRIDE }).map(windowsReplayEntry)
  await writeFile(path, JSON.stringify(entries))
  return path
}

/** Normalize the platform shell title before comparing with the recorded ARIA baseline. */
function normalizeShellAria(value: string): string {
  if (process.platform !== 'win32') return value
  const normalized = value.replaceAll('pwsh', 'bash').replaceAll('Pwsh', 'Bash')
  const description = 'Randomly pick one package directory'
  return normalized.replace(
    [
      '- text: Failed',
      `- button "Bash ${description}":`,
      '  - img',
      `  - text: Bash ${description}`,
    ].join('\n'),
    [
      `- button "Failed Bash ${description}":`,
      '  - img',
      `  - text: Failed Bash ${description}`,
    ].join('\n'),
  )
}

/** Await exactly the requested number of durable turn ends, then flush the session. */
function whenTurnsSettled(scaffold: WebScaffold, count: number, timeoutMs: number): Promise<SessionId> {
  return new Promise<SessionId>((resolve, reject) => {
    let completed = 0
    const timer = setTimeout(() => {
      off()
      reject(new Error(`only ${completed}/${count} Goal turns ended within ${timeoutMs}ms`))
    }, timeoutMs)
    const off = scaffold.ctx.on('session/event', (session, event: SessionEvent) => {
      if (event.type !== 'turn/end') return
      completed += 1
      if (completed !== count) return
      clearTimeout(timer)
      off()
      scaffold.ctx.sessions.flush(session).then(() => { resolve(session.id) }, reject)
    })
  })
}

/** Goal-owned round numbers in durable user-message order. */
function goalRounds(events: readonly SessionEvent[]): number[] {
  return events.flatMap(event => event.type === 'user/message' && event.data.source.kind === 'goal'
    ? [event.data.source.round]
    : [])
}

/** Objective written by each durable Goal creation. */
function createdObjectives(events: readonly SessionEvent[]): string[] {
  return events.flatMap(event => event.type === 'goal/change' && event.data.operation === 'create'
    ? [event.data.goal.objective]
    : [])
}

describe('web e2e: Goal keeps one assistant action row per completed turn', () => {
  let scaffold: WebScaffold | undefined
  let browser: Browser | undefined
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let sessionEvents: SessionEvent[]
  let replayDirectory: string | undefined

  afterEach(async () => {
    const failures: unknown[] = []
    await browser?.close().catch((error: unknown) => failures.push(error))
    browser = undefined
    const closing = scaffold
    scaffold = undefined
    await closing?.close().catch((error: unknown) => failures.push(error))
    if (replayDirectory !== undefined) {
      await rm(replayDirectory, { recursive: true, force: true }).catch((error: unknown) => failures.push(error))
    }
    replayDirectory = undefined
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'goal-multi-turn-actions teardown failed')
  })

  /** Boot the real Web composition and connect a fresh package fixture workspace. */
  async function launch(): Promise<void> {
    sessionEvents = []
    let replayOverride = OVERRIDE
    if (MODE !== 'record' && process.platform === 'win32') {
      replayDirectory = await mkdtemp(join(tmpdir(), 'dsh-goal-pwsh-replay-'))
      replayOverride = await writeWindowsReplayOverride(replayDirectory)
    }
    scaffold = await launchWebScaffold(
      MODE === 'record' ? {} : { replayFixture: FIXTURE, replayOverride },
    )
    await seedPackageInventory(scaffold.workspaceCwd)
    scaffold.ctx.on('session/event', (_session, event: SessionEvent) => { sessionEvents.push(event) })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }

  /** Submit the Goal command after arming the two-turn barrier. */
  async function runGoal(timeoutMs: number): Promise<SessionId> {
    const input = page.locator('textarea').first()
    await input.waitFor({ timeout: 10_000 })
    const settled = whenTurnsSettled(scaffold!, 2, timeoutMs)
    await input.fill(COMMAND)
    await input.press('Enter')
    return settled
  }

  it.skipIf(MODE !== 'record')('records the two-round Goal through the real model', async () => {
    await launch()
    onTestFailed(() => saveFailureShot(page, 'web-e2e-goal-multi-turn-actions-record'))
    const sessionId = await runGoal(360_000)
    await recordFixture(scaffold!, sessionId, FIXTURE)
  }, 380_000)

  it.skipIf(MODE === 'record')('keeps actions on both completed Goal turn tails', async () => {
    const fixtureEvents = parseSessionLog(await readFile(FIXTURE, 'utf8'))
    expect(createdObjectives(fixtureEvents)).toEqual([PROMPT])
    expect(goalRounds(fixtureEvents)).toEqual([1, 2])

    await launch()
    onTestFailed(() => saveFailureShot(page, 'web-e2e-goal-multi-turn-actions'))
    await runGoal(120_000)

    expect(sessionEvents.flatMap(event => event.type === 'turn/end' ? [event.data.turn] : []))
      .toEqual([1, 2])
    expect(goalRounds(sessionEvents)).toEqual([1, 2])
    const shellCalls: SessionEvent<'tool/call'>[] = sessionEvents.flatMap(event =>
      event.type === 'tool/call' && event.data.name === NATIVE_SHELL_TOOL ? [event] : [])
    expect(shellCalls.map(event => shellArguments(event.data.arguments).description)).toEqual(SHELL_DESCRIPTIONS)
    const toolResults: SessionEvent<'tool/result'>[] = sessionEvents.flatMap(event =>
      event.type === 'tool/result' ? [event] : [])
    const resultByCallId = new Map(toolResults.map(event =>
      [event.data.message.source.callId, event.data.message.content[0]] as const))
    const shellResults = shellCalls.map(event => resultByCallId.get(event.data.callId))
    expect(shellResults.map(result => result?.isError)).toEqual(Array.from({ length: 8 }, () => false))
    expect(shellResults.map(result => result?.content
      .filter(block => block.type === 'text').map(block => block.text).join('').includes('[exit code: 1]')))
      .toEqual([false, false, true, false, false, false, false, false])
    expect(sessionEvents.flatMap(event =>
      event.type === 'goal/change' && event.data.operation === 'complete' ? [event.data.goal.phase] : []))
      .toEqual(['complete'])
    const branchButtons = page.getByRole('button', { name: 'Branch into a new conversation' })
    await expect.poll(() => branchButtons.count(), { timeout: 15_000 }).toBe(2)
    expect(await branchButtons.evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-disabled'))))
      .toEqual([null, null])
    await branchButtons.last().focus()
    const snapshot = normalizeShellAria(
      await captureStableAria(page, '[class*="centerCol"]', scaffold!.workspaceCwd),
    )
    await compareOrRefreshGolden(UI_EXPECTED, snapshot, MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 140_000)

  it.skipIf(MODE === 'record')('keeps a closed fixture inventory', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['replay.override.json', 'session.jsonl', 'ui.expected.md'])
  })
})
