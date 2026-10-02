// Web e2e scenario: full-session stats over paged history. A deterministic
// 28-turn log (56 surface messages — more than one 50-message history page)
// seeded cold through the REAL persistence API must render whole-log turn/step
// counts from the sessionStats projection on first open, and loading the
// older page must NOT change them. This pins the bug the projection fixed:
// the pre-projection window fold recounted per loaded page, so 加载更早 grew
// the counter. Zero model calls; the seed is generated, not recorded, because
// no line of it is model output.
import { fileURLToPath } from 'node:url'
import type { Browser, Page, WebSocketRoute } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/stats-paged-history', import.meta.url))
const UI_EXPECTED = fileURLToPath(new URL('./snapshots/stats-paged-history/ui.expected.md', import.meta.url))
const MODE = webSnapshotMode()
const SEED_ID = 'stats-paged-history-web-e2e'

/** Turn count: 2 surface messages per turn, so 28 turns overflow one 50-message page. */
const TURNS = 28
const FULL_COUNTS = `${TURNS} turns · ${TURNS} steps`

/**
 * Generate the seed: TURNS closed single-step turns of one short user prompt
 * and one short assistant reply each. Times are fixed so the fixture is
 * byte-deterministic; message ids are synthetic uuids (aria normalizes them).
 * @param turns - closed turns to generate.
 * @returns session.jsonl text for {@link seedSession}.
 */
function buildSeed(turns: number): string {
  const lines = [JSON.stringify({
    type: 'session', version: 0, id: '{{sessionId}}', createdAt: 1784974100000, cwd: '{{cwd}}/workspace',
  })]
  let seq = 0
  let time = 1784974100000
  const at = (event: Record<string, unknown>): void => {
    lines.push(JSON.stringify({ ...event, seq: seq++, time: time++ }))
  }
  for (let turn = 1; turn <= turns; turn++) {
    at({ type: 'turn/start', data: { turn } })
    at({
      type: 'user/message',
      data: { content: [{ type: 'text', text: `m${turn}` }], source: { kind: 'user' } },
      surfaceOp: 'append',
    })
    at({ type: 'step/start', data: { turn, step: 1 } })
    at({
      type: 'assistant/message',
      data: {
        turn,
        step: 1,
        message: {
          id: `00000000-0000-4000-8000-${String(turn).padStart(12, '0')}`,
          role: 'assistant',
          content: [{ type: 'text', text: `r${turn}` }],
          source: { kind: 'model', provider: 'snapshot', model: 'snapshot-replier' },
        },
      },
      sourceEventSeqs: [],
      surfaceOp: 'append',
    })
    at({ type: 'step/end', data: { turn, step: 1 } })
    at({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
  }
  return `${lines.join('\n')}\n`
}

describe('web e2e: whole-session stats survive history paging', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let mux: WebSocketRoute | undefined
  let dropNextSessionEvent = false
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    if (MODE === 'record') throw new Error('stats-paged-history is a keyless assembled snapshot')
    scaffold = await launchWebScaffold({})
    await seedSession(scaffold, buildSeed(TURNS), SEED_ID)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    await page.routeWebSocket('**/api/events.mux', (socket) => {
      mux = socket
      const server = socket.connectToServer()
      server.onMessage((message) => {
        const envelope = JSON.parse(typeof message === 'string' ? message : message.toString('utf8')) as {
          payload?: { type?: string; sessionId?: string }
        }
        if (dropNextSessionEvent && envelope.payload?.type === 'session/event' && envelope.payload.sessionId === SEED_ID) {
          dropNextSessionEvent = false
          return
        }
        socket.send(message)
      })
    })
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('renders full-session counts on the partial tail page and keeps them across load-older', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-stats-paged'))
    const groupRow = page.locator('[role="treeitem"]').first()
    await groupRow.waitFor({ timeout: 15_000 })
    await groupRow.click()
    const sessionRow = page.locator('[role="treeitem"]').nth(1)
    await sessionRow.waitFor({ timeout: 10_000 })
    await sessionRow.click()
    // Settled barrier: the newest recorded reply renders from the tail page.
    await expect.poll(() => page.getByText(`r${TURNS}`, { exact: true }).count(), { timeout: 15_000 }).toBe(1)
    // The tail page is partial (56 messages > one 50-message page): the first
    // turns are NOT loaded, yet the strip already reports the whole log —
    // the sessionStats projection, not the window fold.
    expect(await page.getByText('m1', { exact: true }).count()).toBe(0)
    await expect.poll(() => page.getByText(FULL_COUNTS, { exact: false }).count(), { timeout: 10_000 }).toBe(1)
    const strip = page.getByText(FULL_COUNTS, { exact: false }).locator('..')
    const stripBeforePaging = await strip.textContent()

    // Hold one real history response across reconnect; recovered paging must
    // be usable before that stale response returns.
    let held = false
    let tailRequests = 0
    const release = Promise.withResolvers<undefined>()
    const returned = Promise.withResolvers<undefined>()
    await page.route('**/api/session.history', async (route) => {
      const request = route.request().postDataJSON() as { payload?: { beforeSeq?: number } }
      if (request.payload?.beforeSeq === undefined) tailRequests++
      if (!held && request.payload?.beforeSeq !== undefined) {
        held = true
        const response = await route.fetch()
        await release.promise
        await route.fulfill({ response })
        returned.resolve(undefined)
      } else await route.continue()
    })
    try {
      await page.getByRole('button', { name: 'Load earlier' }).click()
      await expect.poll(() => held).toBe(true)
      if (mux === undefined) throw new Error('history session has no mux connection')
      await mux.close({ code: 1012, reason: 'history reconnect regression' })
      await expect.poll(() => tailRequests, { timeout: 15_000 }).toBeGreaterThan(0)
      await expect.poll(
        () => page.getByRole('button', { name: 'Load earlier' }).evaluate((button: HTMLButtonElement) =>
          !button.disabled && !button.closest('[data-chat-flow]')?.textContent?.includes('Loading history…')),
        { timeout: 15_000 },
      ).toBe(true)

      await page.getByRole('button', { name: 'Load earlier' }).click()
      await expect.poll(() => page.getByText('m1', { exact: true }).count(), { timeout: 10_000 }).toBe(1)
      release.resolve(undefined)
      await returned.promise
    } finally {
      release.resolve(undefined)
      await page.unroute('**/api/session.history')
    }
    // Prepending the older page must not move counts, wall times, or token groups.
    expect(await strip.textContent()).toBe(stripBeforePaging)
    // With the whole log loaded, the window mounts one turn-tail footer per
    // settled turn — the loaded-window probe the scroll/perf lanes count now
    // that the strip is whole-log-scoped.
    expect(await page.locator('[data-chat-flow-key^="9:turn-tail"]').count()).toBe(TURNS)
  }, 60_000)

  it('matches the paged-stats aria golden', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-stats-paged-aria'))
    const snapshot = (await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd))
      .split(SEED_ID).join('{{seededId}}')
    await compareOrRefreshGolden(UI_EXPECTED, snapshot, MODE)
  })

  it('renders live messages after reconnect without waiting for an obsolete gap repair', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-history-gap-reconnect'))
    const agent = scaffold.ctx.agents.get(SessionId(SEED_ID))
    if (agent === undefined) throw new Error('seeded history session did not attach an agent')
    const append = (text: string): void => {
      agent.session.append('user/message', createUserMessage({
        content: [{ type: 'text', text }], source: { kind: 'user' },
      }), { surfaceOp: 'append' })
    }
    let held = false
    const release = Promise.withResolvers<undefined>()
    const returned = Promise.withResolvers<undefined>()
    await page.route('**/api/session.history', async (route) => {
      const request = route.request().postDataJSON() as { payload?: { beforeSeq?: number } }
      if (!held && request.payload?.beforeSeq === undefined) {
        held = true
        const response = await route.fetch()
        await release.promise
        await route.fulfill({ response })
        returned.resolve(undefined)
      } else await route.continue()
    })
    try {
      dropNextSessionEvent = true
      append('History gap omitted message')
      append('History gap repair trigger')
      await expect.poll(() => held).toBe(true)
      if (mux === undefined) throw new Error('history session has no mux connection')
      await mux.close({ code: 1012, reason: 'gap repair reconnect regression' })
      await page.getByText('History gap repair trigger', { exact: true }).waitFor({ timeout: 15_000 })
      await expect.poll(() => page.getByText('Loading history…', { exact: true }).count()).toBe(0)
      append('Live message after reconnect')
      await page.getByText('Live message after reconnect', { exact: true }).waitFor({ timeout: 10_000 })
      release.resolve(undefined)
      await returned.promise
      append('Live message after response release')
      await page.getByText('Live message after response release', { exact: true }).waitFor({ timeout: 10_000 })
      const transcript = await page.locator('[data-chat-flow]').getByText(
        /^(History gap omitted message|History gap repair trigger|Live message after reconnect|Live message after response release)$/,
      ).allTextContents()
      expect(transcript).toMatchInlineSnapshot(`
        [
          "History gap omitted message",
          "History gap repair trigger",
          "Live message after reconnect",
          "Live message after response release",
        ]
      `)
    } finally {
      release.resolve(undefined)
      await page.unroute('**/api/session.history')
    }
  }, 60_000)

  it('issued zero model calls and recovered from exactly the two intentional disconnects', async () => {
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([
      '[web-runtime] connection lost, retry #1',
      '[web-runtime] connection lost, retry #1',
    ])
    await assertFixtureInventory(SNAPSHOT_DIR, ['ui.expected.md'])
  })
})
