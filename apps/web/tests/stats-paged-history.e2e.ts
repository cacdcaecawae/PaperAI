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
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  acknowledgeReloadConnectionLoss, assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { conversationContextKey, newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/stats-paged-history', import.meta.url))
const UI_EXPECTED = fileURLToPath(new URL('./snapshots/stats-paged-history/ui.expected.md', import.meta.url))
const MODE = webSnapshotMode()
const SEED_ID = 'stats-paged-history-web-e2e'
const AWAY_ID = 'history-gap-navigation-web-e2e'
const AWAY_TITLE = 'History gap navigation target'

/** Turn count: 2 surface messages per turn, so 28 turns overflow one 50-message page. */
const TURNS = 28
const FULL_COUNTS = `${TURNS} turns · ${TURNS} steps`

/**
 * Generate the seed: TURNS closed single-step turns of one short user prompt
 * and one short assistant reply each. Times are fixed so the fixture is
 * byte-deterministic; message ids are synthetic uuids (aria normalizes them).
 * @param turns - closed turns to generate.
 * @param title - optional durable title for the navigation companion.
 * @returns session.jsonl text for {@link seedSession}.
 */
function buildSeed(turns: number, title?: string): string {
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
    const userSeq = seq
    at({
      type: 'user/message',
      data: { content: [{ type: 'text', text: `m${turn}` }], source: { kind: 'user' } },
      surfaceOp: 'append',
    })
    if (turn === 1 && title !== undefined) {
      at({ type: 'session/title', data: { title, messageSeqs: [userSeq], source: { kind: 'fallback' } } })
    }
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
  let companion: Awaited<ReturnType<WebScaffold['ctx']['agents']['resume']>> | undefined
  let browser: Browser
  let page: Page
  let mux: WebSocketRoute | undefined
  let dropNextSessionEvent = false
  let muxConnections = 0
  let forwardedSessionEvents = 0
  let projectionsAfterTurn: number | undefined
  let heldProjections: Parameters<WebSocketRoute['send']>[0][] = []
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    if (MODE === 'record') throw new Error('stats-paged-history is a keyless assembled snapshot')
    scaffold = await launchWebScaffold({})
    await seedSession(scaffold, buildSeed(TURNS), SEED_ID)
    await seedSession(scaffold, buildSeed(1, AWAY_TITLE), AWAY_ID)
    // Cold list rows have fallback titles; only the navigation companion is
    // resumed so its durable title identifies it without warming the main seed.
    companion = await scaffold.ctx.agents.resume({ resumeSessionId: SessionId(AWAY_ID) })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    await page.routeWebSocket('**/api/events.mux', (socket) => {
      mux = socket
      muxConnections++
      const server = socket.connectToServer()
      server.onMessage((message) => {
        const envelope = JSON.parse(typeof message === 'string' ? message : message.toString('utf8')) as {
          payload?: { type?: string; sessionId?: string; event?: { type: string; data: { turn?: number } } }
        }
        if (socket === mux && dropNextSessionEvent
          && envelope.payload?.type === 'session/event' && envelope.payload.sessionId === SEED_ID) {
          dropNextSessionEvent = false
          return
        }
        const frame = envelope.payload
        if (socket === mux && frame?.sessionId === SEED_ID) {
          if (frame.type === 'session/projection' && projectionsAfterTurn !== undefined) {
            heldProjections.push(message)
            return
          }
          if (frame.type === 'session/event') forwardedSessionEvents++
        }
        socket.send(message)
        if (socket === mux && frame?.sessionId === SEED_ID
          && frame.type === 'session/event' && frame.event?.type === 'turn/end'
          && frame.event.data.turn === projectionsAfterTurn) {
          // Keep the real projection values, but publish them after turn/end:
          // the changed stats strip then acknowledges that earlier mux frame.
          projectionsAfterTurn = undefined
          for (const projection of heldProjections) socket.send(projection)
          heldProjections = []
        }
      })
    })
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    try { await companion?.dispose() } finally { await scaffold?.close() }
  })

  it('renders full-session counts on the partial tail page and keeps them across load-older', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-stats-paged'))
    const groupRow = page.locator('[role="treeitem"]').first()
    await groupRow.waitFor({ timeout: 15_000 })
    await groupRow.click()
    const sessionRow = page.locator('[role="treeitem"][aria-selected]').filter({ hasNotText: AWAY_TITLE })
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
      await mux.close({ code: 1000, reason: 'history reconnect regression' })
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

  it.each(['table', 'timeline'] as const)(
    'releases mounted Trajectory %s paging on reconnect before the old response returns',
    async (consumer) => {
      onTestFailed(() => saveFailureShot(page, `web-e2e-trajectory-${consumer}-paging`))
      // A new browser Session opens the partial tail again; the real persisted
      // seed and the Loader-owned web composition are shared with the stats case.
      const warningStart = tripwire.warnings.length
      await page.reload({ waitUntil: 'load' })
      const group = page.locator('[role="treeitem"]').first()
      await group.waitFor({ timeout: 15_000 })
      if (await group.getAttribute('aria-expanded') !== 'true') await group.click()
      await page.locator('[role="treeitem"][aria-selected]').filter({ hasNotText: AWAY_TITLE }).click()
      await page.getByRole('tab', { name: 'Trajectory', exact: true }).click()
      const table = page.locator('[data-trajectory-scroll]')
      const timeline = page.getByRole('region', { name: 'Trajectory timeline' })
      await table.waitFor({ timeout: 15_000 })
      const mountedTable = await table.elementHandle()
      const mountedTimeline = await timeline.elementHandle()
      if (mountedTable === null || mountedTimeline === null) throw new Error('Trajectory did not mount')
      const control = consumer === 'table'
        ? table.locator('[data-history-load] button')
        : timeline.locator('[data-earlier-history]')
      const isBusy = () => control.evaluate((button: HTMLButtonElement) =>
        button.disabled || button.getAttribute('aria-disabled') === 'true')
      const transcript: { phase: string; present: number; busy: boolean | null }[] = []
      const capture = async (phase: string): Promise<void> => {
        const present = await control.count()
        transcript.push({ phase, present, busy: present === 0 ? null : await isBusy() })
      }
      await expect.poll(() => isBusy(), { timeout: 15_000 }).toBe(false)
      acknowledgeReloadConnectionLoss(tripwire, warningStart)
      await capture('ready')
      let olderRequests = 0
      let tailRequests = 0
      let staleReturned = false
      let freshReturned = false
      const staleRelease = Promise.withResolvers<undefined>()
      const freshRelease = Promise.withResolvers<undefined>()
      const staleFulfilled = Promise.withResolvers<undefined>()
      const freshFulfilled = Promise.withResolvers<undefined>()
      const routeErrors: unknown[] = []
      await page.route('**/api/session.history', async (route) => {
        const request = route.request().postDataJSON() as {
          payload?: { sessionId?: string; beforeSeq?: number }
        }
        if (request.payload?.sessionId !== SEED_ID) { await route.continue(); return }
        if (request.payload.beforeSeq === undefined) {
          tailRequests++
          await route.continue()
          return
        }
        const ordinal = ++olderRequests
        if (ordinal > 2) { await route.continue(); return }
        try {
          const response = await route.fetch()
          await (ordinal === 1 ? staleRelease.promise : freshRelease.promise)
          await route.fulfill({ response })
          if (ordinal === 1) staleReturned = true
          else freshReturned = true
        } catch (error) {
          routeErrors.push(error)
        } finally {
          if (ordinal === 1) staleFulfilled.resolve(undefined)
          else freshFulfilled.resolve(undefined)
        }
      })
      try {
        // Avoid Playwright scrolling Table's first row into view: that scroll
        // is itself a paging gesture and would disable the intended click.
        await control.dispatchEvent('click')
        await expect.poll(() => olderRequests).toBe(1)
        await expect.poll(() => isBusy()).toBe(true)
        await capture('old request pending')
        if (mux === undefined) throw new Error('Trajectory session has no mux connection')
        const tailResponse = page.waitForResponse((response) => {
          if (!response.url().endsWith('/api/session.history')) return false
          const request = response.request().postDataJSON() as {
            payload?: { sessionId?: string; beforeSeq?: number }
          }
          return request.payload?.sessionId === SEED_ID && request.payload.beforeSeq === undefined
        })
        await mux.close({ code: 1000, reason: `trajectory ${consumer} paging reconnect` })
        await expect.poll(() => tailRequests, { timeout: 15_000 }).toBeGreaterThan(0)
        await (await tailResponse).finished()
        await expect.poll(
          () => table.getByText('Loading trajectory…', { exact: true }).count(),
          { timeout: 15_000 },
        ).toBe(0)
        await expect.poll(() => isBusy(), { timeout: 15_000 }).toBe(false)
        expect(staleReturned).toBe(false)
        expect(await table.evaluate((node, mounted) => node === mounted, mountedTable)).toBe(true)
        expect(await timeline.evaluate((node, mounted) => node === mounted, mountedTimeline)).toBe(true)
        await capture('reconnected before old response')

        await control.dispatchEvent('click')
        await expect.poll(() => olderRequests).toBe(2)
        await expect.poll(() => isBusy()).toBe(true)
        expect(staleReturned).toBe(false)
        expect(freshReturned).toBe(false)
        await capture('fresh request pending')
        freshRelease.resolve(undefined)
        await freshFulfilled.promise
        expect(routeErrors).toEqual([])
        await expect.poll(() => control.count(), { timeout: 10_000 }).toBe(0)
        await expect.poll(() => table.getByText('m1', { exact: true }).count()).toBe(1)
        expect(staleReturned).toBe(false)
        expect(freshReturned).toBe(true)
        expect(olderRequests).toBe(2)
        await capture('fresh page exhausted history before old response')
        expect(transcript).toMatchInlineSnapshot(`
          [
            {
              "busy": false,
              "phase": "ready",
              "present": 1,
            },
            {
              "busy": true,
              "phase": "old request pending",
              "present": 1,
            },
            {
              "busy": false,
              "phase": "reconnected before old response",
              "present": 1,
            },
            {
              "busy": true,
              "phase": "fresh request pending",
              "present": 1,
            },
            {
              "busy": null,
              "phase": "fresh page exhausted history before old response",
              "present": 0,
            },
          ]
        `)
      } finally {
        staleRelease.resolve(undefined)
        freshRelease.resolve(undefined)
        await page.unroute('**/api/session.history')
        const pending = []
        if (olderRequests >= 1) pending.push(staleFulfilled.promise)
        if (olderRequests >= 2) pending.push(freshFulfilled.promise)
        await Promise.all(pending)
        await mountedTable.dispose()
        await mountedTimeline.dispose()
        await page.getByRole('tab', { name: 'Chat', exact: true }).click()
      }
      expect(routeErrors).toEqual([])
    },
    60_000,
  )

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
      await expect.poll(() => dropNextSessionEvent, { timeout: 10_000 }).toBe(false)
      append('History gap repair trigger')
      await expect.poll(() => held, { timeout: 10_000 }).toBe(true)
      if (mux === undefined) throw new Error('history session has no mux connection')
      await mux.close({ code: 1000, reason: 'gap repair reconnect regression' })
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

  it('recovers a completed turn on navigation after a history transport failure without reconnecting', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-history-gap-transport-reopen'))
    const agent = scaffold.ctx.agents.get(SessionId(SEED_ID))
    if (agent === undefined) throw new Error('seeded history session did not attach an agent')
    const turn = TURNS + 1
    const question = 'Question after failed history repair'
    const answer = 'Final answer after failed history repair'
    const originalRow = page.locator('[role="treeitem"][aria-selected]').filter({ hasNotText: AWAY_TITLE })
    const awayRow = page.locator('[role="treeitem"][aria-selected]').filter({ hasText: AWAY_TITLE })
    const connectionsBefore = muxConnections
    const socketBefore = mux
    const warningStart = tripwire.warnings.length
    let held = false
    let tailRequests = 0
    let failedRpcId: string | undefined
    const release = Promise.withResolvers<undefined>()
    const returned = Promise.withResolvers<undefined>()
    await page.route('**/api/session.history', async (route) => {
      const request = route.request().postDataJSON() as {
        rpcId: string; payload?: { sessionId?: string; beforeSeq?: number }
      }
      if (request.payload?.sessionId !== SEED_ID || request.payload.beforeSeq !== undefined) {
        await route.continue()
        return
      }
      tailRequests++
      if (held) {
        await route.continue()
        return
      }
      held = true
      failedRpcId = request.rpcId
      await release.promise
      try {
        // The real fetch carrier throws on non-2xx; only this unary fails.
        await route.fulfill({ status: 503, body: 'Intentional history transport failure' })
        returned.resolve(undefined)
      } catch (error) {
        returned.reject(error)
      }
    })
    try {
      projectionsAfterTurn = turn
      dropNextSessionEvent = true
      agent.session.append('turn/start', { turn })
      await expect.poll(() => dropNextSessionEvent, { timeout: 10_000 }).toBe(false)
      agent.session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: question }], source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      await expect.poll(() => held, { timeout: 10_000 }).toBe(true)
      agent.session.append('step/start', { turn, step: 1 })
      agent.session.append('assistant/message', {
        turn, step: 1,
        message: createAssistantMessage({
          content: [{ type: 'text', text: answer }],
          source: { provider: 'snapshot', model: 'snapshot-replier' },
        }),
      }, { surfaceOp: 'append' })
      agent.session.append('step/end', { turn, step: 1 })
      agent.session.append('turn/end', { turn, reason: { kind: 'completed' } })
      // Projection frames are released only after the final durable frame.
      // Its rendered count is a browser-consumption barrier while history is held.
      await expect.poll(
        () => page.getByText(`${turn} turns · ${turn} steps`, { exact: false }).count(),
        { timeout: 10_000 },
      ).toBe(1)
      expect(projectionsAfterTurn).toBeUndefined()
      expect(tailRequests).toBe(1)
      expect(await page.getByText(answer, { exact: true }).count()).toBe(0)
      expect(await page.getByText(`r${TURNS}`, { exact: true }).count()).toBe(1)
      const eventsBeforeFailure = forwardedSessionEvents
      const failedResponse = page.waitForResponse(response => {
        if (new URL(response.url()).pathname !== '/api/session.history') return false
        return (response.request().postDataJSON() as { rpcId: string }).rpcId === failedRpcId
      })
      release.resolve(undefined)
      const response = await failedResponse
      expect(response.status()).toBe(503)
      await response.finished()
      await returned.promise
      // This console line is emitted inside the real repair's catch; its
      // finally releases request ownership before the next browser task.
      await expect.poll(() => tripwire.warnings.slice(warningStart), { timeout: 10_000 }).toEqual([
        expect.stringMatching(/^\[web-runtime\] gap repair failed:/),
      ])
      expect(await page.getByText(answer, { exact: true }).count()).toBe(0)
      expect(tailRequests).toBe(1)

      // Selecting an actual different Session moves the runtime's watched
      // stage; the empty New Session view alone intentionally retains it.
      await awayRow.click()
      await expect.poll(() => awayRow.getAttribute('aria-selected')).toBe('true')
      await expect.poll(() => page.getByText(`r${TURNS}`, { exact: true }).count()).toBe(0)
      await page.locator('[data-chat-flow]').getByText('r1', { exact: true }).waitFor({ timeout: 10_000 })
      await originalRow.click()
      await page.getByText(answer, { exact: true }).waitFor({ timeout: 15_000 })
      await expect.poll(() => tailRequests).toBe(2)
      const footer = page.locator(`[data-chat-flow-key="${conversationContextKey('turn-tail', String(turn))}"]`)
      await expect.poll(() => footer.count()).toBe(1)
      const transcript = await page.locator('[data-chat-flow]').getByText(
        new RegExp(`^(r${TURNS}|${question}|${answer})$`),
      ).allTextContents()
      expect(transcript).toMatchInlineSnapshot(`
        [
          "r28",
          "Question after failed history repair",
          "Final answer after failed history repair",
        ]
      `)

      await awayRow.click()
      await expect.poll(() => awayRow.getAttribute('aria-selected')).toBe('true')
      await originalRow.click()
      await page.getByText(answer, { exact: true }).waitFor({ timeout: 10_000 })
      expect(tailRequests).toBe(2)
      expect(await page.getByText(question, { exact: true }).count()).toBe(1)
      expect(await page.getByText(answer, { exact: true }).count()).toBe(1)
      expect(await footer.count()).toBe(1)
      expect(forwardedSessionEvents).toBe(eventsBeforeFailure)
      expect(muxConnections).toBe(connectionsBefore)
      expect(mux).toBe(socketBefore)
      expect(tripwire.warnings.slice(warningStart)).toEqual([
        expect.stringMatching(/^\[web-runtime\] gap repair failed:/),
      ])
    } finally {
      release.resolve(undefined)
      try {
        // This test owns the page's only HTTP route. Remove it and drain
        // even a handler that started after the last assertion failed.
        await page.unrouteAll({ behavior: 'wait' })
        if (held) await returned.promise
      } finally {
        dropNextSessionEvent = false
        projectionsAfterTurn = undefined
        for (const projection of heldProjections) mux?.send(projection)
        heldProjections = []
      }
    }
  }, 60_000)

  it('issued zero model calls and recovered from exactly the four intentional disconnects', async () => {
    // Initial mux, two full reloads, and four intentional reconnects.
    expect(muxConnections).toBe(7)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([
      '[web-runtime] connection lost, retry #1',
      '[web-runtime] connection lost, retry #1',
      '[web-runtime] connection lost, retry #1',
      '[web-runtime] connection lost, retry #1',
      expect.stringMatching(/^\[web-runtime\] gap repair failed:/),
    ])
    await assertFixtureInventory(SNAPSHOT_DIR, ['ui.expected.md'])
  })
})
