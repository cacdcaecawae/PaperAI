// Web e2e scenario: a Code Mode round trip. The scaffold boots the SAME
// shipped tree with the tools row patched to mode: code (the run_code-only
// wire), a real chromium sends a prompt engineered to elicit one run_code
// program with several sub-calls, and the UI must render the code-variant
// parent row with its always-visible nested sub-rows — each sub-row the same
// component a native call renders through — plus details-panel resolution for
// a clicked sub-row. Drive steps wait only on generic completion
// (whenTurnSettled); assertion steps run in replay/refresh only.
// Record: DSH_SNAPSHOT=record rewrites session.jsonl, then a keyless
// DSH_SNAPSHOT=refresh regenerates ui.expected.md.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  captureStableAria, compareOrRefreshGolden, fixtureUserPrompts,
  launchWebScaffold, recordFixture, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const FIXTURE = fileURLToPath(new URL('./snapshots/code-mode-round/session.jsonl', import.meta.url))
const UI_EXPECTED = fileURLToPath(new URL('./snapshots/code-mode-round/ui.expected.md', import.meta.url))
const MODE = webSnapshotMode()
const WINDOWS_REPLAY = process.platform === 'win32' && MODE !== 'record'
const NATIVE_SHELL_TOOL = process.platform === 'win32' ? 'pwsh' : 'bash'
const SHELL_ROW_SELECTOR = process.platform === 'win32'
  ? '[data-tool="pwsh"] [data-expandable]'
  : '[data-sample="bash"]'

// The scenario's one drive prompt: elicits one program with a shell sub-call
// and a failing read the program tolerates — the sub-row set the assertions
// need. Never asserted against model prose.
const PROMPT = 'Using ONE run_code program: run bash `echo CODE_ROUND_OK`, then read the file missing.txt '
  + 'catching its error in the program. Return an object with both outcomes. Then reply DONE and stop.'

function windowsShellText(text: string): string {
  return text
    .replaceAll('Bash', 'Pwsh')
    .replaceAll('bash', 'pwsh')
    .replaceAll('echo', 'Write-Output')
}

function mapStrings(value: unknown, transform: (text: string) => string): unknown {
  if (typeof value === 'string') return transform(value)
  if (Array.isArray(value)) return value.map(item => mapStrings(item, transform))
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapStrings(item, transform)]))
}

function repartition(transformed: string, source: readonly string[]): string[] {
  let offset = 0
  return source.map((fragment, index) => {
    if (index === source.length - 1) return transformed.slice(offset)
    const next = offset + fragment.length
    const result = transformed.slice(offset, next)
    offset = next
    return result
  })
}

function windowsReplayFixture(fixture: string): string {
  return fixture.split(/\r?\n/).map((line) => {
    if (line.length === 0) return line
    const source = JSON.parse(line) as unknown
    const transformed = mapStrings(source, windowsShellText)
    if (
      source !== null && typeof source === 'object'
      && 'type' in source && source.type === 'tool-call-chunks'
      && 'data' in source && source.data !== null && typeof source.data === 'object'
      && 'args' in source.data && Array.isArray(source.data.args)
      && source.data.args.every(fragment => typeof fragment === 'string')
      && transformed !== null && typeof transformed === 'object'
      && 'data' in transformed && transformed.data !== null && typeof transformed.data === 'object'
    ) {
      const data = transformed.data as Record<string, unknown>
      const fragments = source.data.args
      data.args = repartition(windowsShellText(fragments.join('')), fragments)
    }
    return JSON.stringify(transformed)
  }).join('\n')
}

function normalizeShellSnapshot(value: string): string {
  if (!WINDOWS_REPLAY) return value
  return value
    .replaceAll('Write-Output', 'echo')
    .replaceAll('Pwsh', 'Bash')
    .replaceAll('pwsh', 'bash')
    .replace(
      '- button "Bash Echo CODE_ROUND_OK":\n'
      + '  - img\n'
      + '  - img\n'
      + '  - text: Bash Echo CODE_ROUND_OK\n'
      + '- text: Failed',
      '- img\n- text: Bash Echo CODE_ROUND_OK Failed',
    )
    .replaceAll('{{cwd}}\\\\workspace\\\\missing.txt', '{{cwd}}/workspace/missing.txt')
    .replaceAll('{{cwd}}\\workspace\\missing.txt', '{{cwd}}/workspace/missing.txt')
}

function normalizeSnapshotPath(value: string, path: string, token: string): string {
  const variants = [...new Set([
    path.replaceAll('\\', '\\\\'),
    path.replaceAll('\\', '/'),
    path,
  ])].sort((left, right) => right.length - left.length)
  let normalized = value
  for (const variant of variants) normalized = normalized.replaceAll(variant, token)
  return normalized
}

describe('web e2e: Code Mode round renders nested sub-calls', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let replayFixture = FIXTURE
  let derivedFixtureDir: string | undefined
  const sessionEvents: SessionEvent[] = []

  beforeAll(async () => {
    if (WINDOWS_REPLAY) {
      derivedFixtureDir = await mkdtemp(join(tmpdir(), 'dsh-web-code-mode-pwsh-'))
      replayFixture = join(derivedFixtureDir, 'session.jsonl')
      await writeFile(replayFixture, windowsReplayFixture(await readFile(FIXTURE, 'utf8')))
    }
    scaffold = await launchWebScaffold({
      toolsMode: 'code',
      ...(MODE === 'record' ? {} : { replayFixture, paceMs: 15 }),
    })
    scaffold.ctx.on('session/event', (_session, event: SessionEvent) => { sessionEvents.push(event) })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    // Fresh world: connect a Workspace so the composer scenarios start live.
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    const failures: unknown[] = []
    await browser?.close().catch((error: unknown) => failures.push(error))
    await scaffold?.close().catch((error: unknown) => failures.push(error))
    if (derivedFixtureDir !== undefined) {
      await rm(derivedFixtureDir, { recursive: true, force: true }).catch((error: unknown) => failures.push(error))
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'code-mode round teardown failed')
  })

  it('drives the recorded prompt to a settled turn (all modes)', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-code-mode-drive'))
    if (MODE !== 'record') {
      // Drift guard: the committed fixture must carry exactly the drive prompt.
      expect(fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))).toEqual([PROMPT])
      if (WINDOWS_REPLAY) {
        expect(fixtureUserPrompts(await readFile(replayFixture, 'utf8'))).toEqual([windowsShellText(PROMPT)])
      }
    }
    const input = page.locator('textarea').first()
    await input.waitFor({ timeout: 10_000 })
    const settled = scaffold.whenTurnSettled()
    await input.fill(WINDOWS_REPLAY ? windowsShellText(PROMPT) : PROMPT)
    await input.press('Enter')
    const sessionId = await settled
    if (MODE === 'record') {
      await recordFixture(scaffold, sessionId, FIXTURE)
    }
  }, 200_000)

  it.skipIf(MODE === 'record')('the durable log carries run_code with full-content sub-dispatches', () => {
    // Wire discipline: code mode collapsed the call surface to run_code.
    const calls = sessionEvents.filter(event => event.type === 'tool/call')
    expect(calls.length).toBeGreaterThanOrEqual(1)
    expect(new Set(calls.map(call => (call.data as { name: string }).name))).toEqual(new Set(['run_code']))
    // Sub-dispatches logged with the complete tool/result vocabulary.
    const dispatches = sessionEvents.filter(event => (event.type as string) === 'tool/code-dispatch')
    expect(dispatches).toHaveLength(2)
    for (const dispatch of dispatches) {
      const data = dispatch.data as unknown as {
        parentCallId: string
        subCallId: string
        name: string
        isError: boolean
        content: { type: string }[]
      }
      expect(data.subCallId.startsWith(`${data.parentCallId}:code:`)).toBe(true)
      expect(Array.isArray(data.content)).toBe(true)
      expect(typeof data.isError).toBe('boolean')
    }
    const shell = dispatches.find(dispatch => (dispatch.data as { name: string }).name === NATIVE_SHELL_TOOL)
    expect(shell).toBeDefined()
    const shellData = shell!.data as { isError: boolean; content: { type: string; text?: string }[] }
    expect(shellData.isError).toBe(false)
    expect(shellData.content.filter(block => block.type === 'text').map(block => block.text).join(''))
      .toContain('CODE_ROUND_OK')
    const read = dispatches.find(dispatch => (dispatch.data as { name: string }).name === 'read')
    expect(read).toBeDefined()
    const readData = read!.data as { isError: boolean; content: { type: string; text?: string }[] }
    expect(readData.isError).toBe(true)
    expect(readData.content.filter(block => block.type === 'text').map(block => block.text).join(''))
      .toContain('missing.txt')
  })

  it.skipIf(MODE === 'record')('renders the code parent row with always-visible nested sub-rows', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-code-mode-rows'))
    await expect.poll(() => page.getByText('DONE', { exact: true }).count(), { timeout: 15_000 }).toBeGreaterThanOrEqual(1)
    // The parent run_code row wears the code variant with the model-authored
    // description as its summary (the presentCall contract).
    const codeRow = page.locator('[data-variant="code"]').first()
    await codeRow.waitFor({ timeout: 10_000 })
    // Nested rows are visible WITHOUT any expand interaction, inside the
    // sub-call nest, each rendered by the same components as native rows:
    // the shell sub-call landed in its platform-specific row registration.
    const nest = page.locator('[data-subcalls]').first()
    await nest.waitFor({ timeout: 10_000 })
    expect(await nest.locator(SHELL_ROW_SELECTOR).count()).toBeGreaterThanOrEqual(1)
    // The failing read sub-call wears the same error state a native failed
    // row wears (the recorded program tolerates a read of missing.txt).
    expect(await nest.locator('[data-state="error"]').count()).toBeGreaterThanOrEqual(1)
  }, 60_000)

  it.skipIf(MODE === 'record')('expands and collapses the run_code program through its row click target', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-code-mode-expand'))
    const codeRow = page.locator('[data-variant="code"]').first()
    const toggle = codeRow.locator('[data-expandable]').first()
    await toggle.waitFor({ timeout: 10_000 })
    expect(await toggle.getAttribute('aria-expanded')).toBe('false')
    await toggle.click()
    try {
      await expect.poll(() => toggle.getAttribute('aria-expanded'), { timeout: 5_000 }).toBe('true')
      await expect.poll(() => codeRow.locator('pre.shiki').textContent(), { timeout: 5_000 })
        .toContain(`tools.${NATIVE_SHELL_TOOL}`)
    } finally {
      if (await toggle.getAttribute('aria-expanded') === 'true') await toggle.click()
    }
    await expect.poll(() => toggle.getAttribute('aria-expanded'), { timeout: 5_000 }).toBe('false')
  })

  it.skipIf(MODE === 'record')('a native-shell sub-row click leaves the default details panel closed', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-code-mode-details'))
    const nest = page.locator('[data-subcalls]').first()
    const frame = page.locator('[style*="grid-template-columns"]').first()
    const shellRow = nest.locator(SHELL_ROW_SELECTOR).first()
    expect(await frame.getAttribute('data-details-collapsed')).toBe('true')
    expect(await shellRow.getAttribute('aria-expanded')).toBe('false')
    await shellRow.click()
    await expect.poll(() => shellRow.getAttribute('aria-expanded'), { timeout: 5_000 }).toBe('true')
    // Tool rows do not drive layout geometry; the Session's default panel stays closed.
    await expect.poll(() => frame.getAttribute('data-details-collapsed'), { timeout: 5_000 }).toBe('true')
    await shellRow.click()
    await expect.poll(() => shellRow.getAttribute('aria-expanded'), { timeout: 5_000 }).toBe('false')
  })

  it.skipIf(MODE === 'record')('matches the conversation aria golden with stable anchors', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-code-mode-aria'))
    const snapshot = normalizeShellSnapshot(normalizeSnapshotPath(
      await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd),
      join(scaffold.workspaceCwd, 'workspace', 'missing.txt'),
      '{{cwd}}/workspace/missing.txt',
    ))
    await compareOrRefreshGolden(UI_EXPECTED, snapshot, MODE)
  })

  it.skipIf(MODE === 'record')('stayed clean: no page errors, no reconnect churn', () => {
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})
