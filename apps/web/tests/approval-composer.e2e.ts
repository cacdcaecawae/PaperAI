// Web e2e scenario: the composer-takeover approval panel under a long
// command. The shipped composition confines its native shell through the
// sandbox policy and routes its escalation through the approval seam, so a
// read-only session asked to write a file produces a REAL pending approval —
// the panel renders in the browser, the test measures its geometry, answers
// through it, and the escalated command then runs. Replay is deterministic:
// the denial, the escalation retry and its command text arrive from replayed
// chunks, and the answer click is the test's own gesture (the same sanctioned
// reaction to model content as the question composer: the turn cannot complete
// without it). Windows derives a temporary pwsh fixture; record stays POSIX.
//
// Geometry is the point of the scenario. The command is unbounded model text,
// and an uncapped card grows with it until the refuse/allow buttons leave the
// viewport — an approval the user could see and not answer.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
// Empty type import: carries the approval package's session-event merge, so
// the decided-outcome assertion below type-checks against the real union.
import type {} from '@deepseek-ai/dsh-user-approval'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden, fixtureUserPrompts,
  launchWebScaffold, recordFixture, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/approval-composer', import.meta.url))
const FIXTURE = join(SNAPSHOT_DIR, 'session.jsonl')
// The scenario's one golden: the waiting panel. Everything the answered state
// proves is asserted directly — see the world-state block at the end.
const UI_EXPECTED = join(SNAPSHOT_DIR, 'ui.expected.md')
const MODE = webSnapshotMode()

// Irreducible payload: the command has to be long enough to pass the card's
// height cap, which is the only command length that reproduces an action row pushed off
// screen. Unrelated tokens, not a repeated word — a repeated word is what the
// model compressed into `printf 'alpha %.0s' {1..400}` while recording, and a
// short command proves nothing here. The formula keeps the source small; the
// model receives the expanded literal it has to put in the command.
const TOKENS = Array.from({ length: 220 }, (_, index) => `tok${((index + 1) * 7919 % 99991).toString(36)}`).join(' ')
const RECORDED_PROMPT = `Write a file named notes.txt in the workspace containing exactly this text on one line: ${TOKENS}. Use one bash command with the literal text inline. Then reply with the single word DONE and stop.`
const WINDOWS_PROMPT = `Write a file named notes.txt in the workspace containing exactly this text on one line: ${TOKENS}. Use one pwsh command with the literal text inline. Then reply with the single word DONE and stop.`
const WINDOWS_REPLAY = MODE !== 'record' && process.platform === 'win32'
const PROMPT = WINDOWS_REPLAY ? WINDOWS_PROMPT : RECORDED_PROMPT
const SHELL_TOOL = WINDOWS_REPLAY ? 'pwsh' : 'bash'

/** Draft used to measure the composer's own text cap: enough lines to pass it. */
const CAP_PROBE = Array.from({ length: 40 }, (_, index) => `line ${index}`).join('\n')

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function mapStrings(value: unknown, transform: (text: string) => string): unknown {
  if (typeof value === 'string') return transform(value)
  if (Array.isArray(value)) return value.map(item => mapStrings(item, transform))
  if (!isRecord(value)) return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapStrings(item, transform)]))
}

function windowsText(text: string): string {
  return text
    .replace(/echo '([^'\r\n]*)' > notes\.txt/gu, "Set-Content -LiteralPath notes.txt -Value '$1'")
    .replaceAll('bash', 'pwsh')
    .replaceAll('Bash', 'Pwsh')
    .replaceAll('echo', 'Set-Content')
}

function packedToolArguments(value: unknown): string[] | undefined {
  if (!isRecord(value) || value['type'] !== 'tool-call-chunks' || !isRecord(value['data'])) return undefined
  const args = value['data']['args']
  if (!Array.isArray(args) || !args.every(argument => typeof argument === 'string')) return undefined
  return args
}

function replacePackedToolArguments(value: unknown, args: string[]): void {
  if (!isRecord(value) || !isRecord(value['data'])) {
    throw new Error('Windows approval replay produced an invalid packed tool-call row')
  }
  value['data']['args'] = args
}

function rechunk(transformed: string, original: readonly string[]): string[] {
  let offset = 0
  return original.map((chunk, index) => {
    if (index === original.length - 1) return transformed.slice(offset)
    const next = offset + chunk.length
    const result = transformed.slice(offset, next)
    offset = next
    return result
  })
}

function windowsReplayFixture(fixture: string): string {
  return fixture.split(/\r?\n/).map((line) => {
    if (line.length === 0) return line
    const parsed: unknown = JSON.parse(line)
    const packedArgs = packedToolArguments(parsed)
    const transformed = mapStrings(parsed, windowsText)
    if (packedArgs !== undefined) {
      replacePackedToolArguments(transformed, rechunk(windowsText(packedArgs.join('')), packedArgs))
    }
    return JSON.stringify(transformed)
  }).join('\n')
}

function normalizeApprovalSnapshot(snapshot: string): string {
  return WINDOWS_REPLAY
    ? snapshot.replace(/Set-Content -LiteralPath notes\.txt -Value '([^'\r\n]*)'/gu, "echo '$1' > notes.txt")
    : snapshot
}

function callArgs(event: Extract<SessionEvent, { type: 'tool/call' }>): Record<string, unknown> {
  return JSON.parse(event.data.arguments) as Record<string, unknown>
}

function writtenPayload(command: unknown): string {
  if (typeof command !== 'string') throw new Error(`${SHELL_TOOL} call has no string command`)
  const match = WINDOWS_REPLAY
    ? /^Set-Content -LiteralPath notes\.txt -Value '([^'\r\n]*)'$/u.exec(command)
    : /^echo '([^'\r\n]*)' > notes\.txt$/u.exec(command)
  if (match?.[1] === undefined) throw new Error(`${SHELL_TOOL} call is not the expected literal notes.txt write`)
  return match[1]
}

describe('web e2e: approval takeover keeps its actions reachable', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let replayFixture = FIXTURE
  let derivedFixtureDir: string | undefined
  const sessionEvents: SessionEvent[] = []

  beforeAll(async () => {
    if (WINDOWS_REPLAY) {
      derivedFixtureDir = await mkdtemp(join(tmpdir(), 'dsh-web-approval-pwsh-'))
      replayFixture = join(derivedFixtureDir, 'session.jsonl')
      await writeFile(replayFixture, windowsReplayFixture(await readFile(FIXTURE, 'utf8')))
    }
    scaffold = await launchWebScaffold(MODE === 'record' ? {} : { replayFixture, paceMs: 15 })
    scaffold.ctx.on('session/event', (_session, event: SessionEvent) => { sessionEvents.push(event) })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    const failures: unknown[] = []
    await browser?.close().catch((error: unknown) => failures.push(error))
    await scaffold?.close().catch((error: unknown) => failures.push(error))
    if (derivedFixtureDir !== undefined) {
      await rm(derivedFixtureDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
        .catch((error: unknown) => failures.push(error))
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'approval-composer teardown failed')
  })

  it('caps the long command, answers through the panel, and runs the escalated command', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-approval'))
    if (MODE !== 'record') {
      expect(fixtureUserPrompts(await readFile(replayFixture, 'utf8'))).toEqual([PROMPT])
    }
    const input = page.locator('textarea').first()
    await input.waitFor({ timeout: 10_000 })

    // The composer's own text cap, measured on the live draft scrollport before
    // the takeover replaces it — the box that carries the cap, while the
    // textarea inside it is as tall as the whole draft. The panel's scroll
    // region must stop at the same height (the designer's requirement: one cap
    // for the composer seat), and measuring it here keeps the assertion free of
    // the px value itself.
    await input.fill(CAP_PROBE)
    const composerCap = await input.evaluate(el => el.closest('[data-input-scroll]')?.clientHeight ?? 0)
    expect(composerCap).toBeGreaterThan(0)
    await input.fill('')

    // Read-only: the mode whose denial the model escalates from. Switched
    // through the shipped access-mode chip, not a test-only override.
    await page.locator('[aria-label^="Access mode"]').click()
    await page.getByRole('menuitem', { name: 'Read Only' }).click()
    await expect.poll(
      () => page.locator('[aria-label="Access mode, current: Read Only"]').count(),
      { timeout: 15_000 },
    ).toBe(1)

    const settled = scaffold.whenTurnSettled(MODE === 'record' ? 240_000 : 60_000)
    await input.fill(PROMPT)
    await input.press('Enter')

    // The panel takes over the input area while the tool blocks. Its presence
    // is a STABLE waiting state (it stays until answered), so waitFor is
    // race-free.
    const panel = page.locator('[data-approval-key]')
    await panel.waitFor({ timeout: MODE === 'record' ? 180_000 : 60_000 })
    const scroll = panel.locator('[data-approval-scroll]')
    await expect.poll(() => scroll.getByText(/tok/).count(), { timeout: 15_000 }).toBeGreaterThan(0)

    if (MODE !== 'record') {
      // This golden owns the stable waiting surface; the answered golden below
      // owns the resulting transcript.
      const snapshot = normalizeApprovalSnapshot(
        await captureStableAria(page, '[data-approval-key]', scaffold.workspaceCwd),
      )
      await compareOrRefreshGolden(UI_EXPECTED, snapshot, MODE)

      // The uncapped-card hazard the header names, measured at the lane
      // baseline and at a short viewport, on the live panel.
      const original = page.viewportSize() ?? { width: 1680, height: 1000 }
      for (const height of [1000, 700]) {
        await page.setViewportSize({ width: 900, height })
        const geometry = await panel.evaluate((root) => {
          const region = root.querySelector<HTMLElement>('[data-approval-scroll]')
          const card = region?.parentElement ?? null
          // Role/text, not the CSS-module class names: the built client hashes those.
          const buttons = [...root.querySelectorAll<HTMLElement>('button')]
          const rows = buttons.map(button => button.getBoundingClientRect())
          return {
            buttons: buttons.length,
            capped: region === null ? 0 : region.clientHeight,
            // A scrolling region proves the cap is genuinely engaged; without
            // it every assertion below would hold vacuously.
            scrolls: region === null ? false : region.scrollHeight > region.clientHeight,
            cardBottom: card === null ? Number.NaN : card.getBoundingClientRect().bottom,
            actionsTop: Math.min(...rows.map(rect => rect.top)),
            actionsBottom: Math.max(...rows.map(rect => rect.bottom)),
            viewport: window.innerHeight,
          }
        })
        expect(geometry.buttons).toBe(2)
        expect(geometry.scrolls).toBe(true)
        // One cap for the seat: the panel's text region stops where the
        // composer draft does (sub-pixel tolerance for the shared padding).
        expect(Math.abs(geometry.capped - composerCap)).toBeLessThan(1)
        // Both buttons stay inside the card AND inside the viewport — the
        // answerable state the cap exists to guarantee.
        expect(geometry.actionsTop).toBeGreaterThan(0)
        expect(geometry.actionsBottom).toBeLessThanOrEqual(geometry.viewport)
        expect(geometry.actionsBottom).toBeLessThanOrEqual(geometry.cardBottom)
      }
      await page.setViewportSize(original)
    }

    await panel.getByRole('button', { name: 'Allow once' }).click()

    const sessionId = await settled
    if (MODE === 'record') {
      await recordFixture(scaffold, sessionId, FIXTURE)
      return
    }
    // World state: the granted escalation is what let the command run, and the
    // panel leaves with the regular composer restored. Asserted on the world
    // and the DOM rather than through a transcript golden — the denied first
    // attempt renders the OS's own refusal ("Operation not permitted" on
    // macOS, "Read-only file system" on Linux), so the answered transcript is
    // not a platform-neutral golden surface.
    const shellCalls = sessionEvents.filter(
      (event): event is Extract<SessionEvent, { type: 'tool/call' }> =>
        event.type === 'tool/call' && event.data.name === SHELL_TOOL,
    )
    expect(shellCalls).toHaveLength(2)
    const deniedCall = shellCalls[0]
    const escalatedCall = shellCalls[1]
    if (deniedCall === undefined || escalatedCall === undefined) {
      throw new Error(`the replayed turn did not issue both ${SHELL_TOOL} attempts`)
    }
    const deniedArgs = callArgs(deniedCall)
    const escalatedArgs = callArgs(escalatedCall)
    expect(deniedArgs['command']).toBe(escalatedArgs['command'])
    expect(deniedArgs['sandbox_permissions']).toBeUndefined()
    expect(escalatedArgs['sandbox_permissions']).toBe('workspace-write')
    expect(sessionEvents.some(event => event.type === 'tool/result'
      && event.data.message.source.callId === deniedCall.data.callId
      && JSON.stringify(event.data).includes('[sandbox: file access denied under read-only mode]'))).toBe(true)
    expect(sessionEvents.filter(event => event.type === 'approval/asked')).toHaveLength(1)
    const decisions = sessionEvents.filter(event => event.type === 'approval/decided')
    expect(decisions).toHaveLength(1)
    expect(decisions[0]?.data.outcome).toBe('allowed-once')
    const payload = writtenPayload(escalatedArgs['command'])
    expect(payload.split(' ')).toHaveLength(220)
    expect(payload.slice(0, 64)).toBe(TOKENS.slice(0, 64))
    const written = await readFile(join(scaffold.workspaceCwd, 'workspace', 'notes.txt'), 'utf8')
    expect(written.split(/\r?\n/u)).toEqual([payload, ''])
    await expect.poll(() => page.getByText('DONE', { exact: true }).count(), { timeout: 20_000 }).toBeGreaterThanOrEqual(1)
    expect(await page.locator('[data-approval-key]').count()).toBe(0)
    await expect.poll(() => page.locator('textarea').first().isEnabled(), { timeout: 10_000 }).toBe(true)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 300_000)

  it.skipIf(MODE === 'record')('keeps the fixture inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['session.jsonl', 'ui.expected.md'])
  })
})
