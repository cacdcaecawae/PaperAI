/** The real PaperAI ACP transport and built browser preserve a failed MCP tool's identity and inspectable error. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@paperai/workbench-service'
import {
  assertFixtureInventory, compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { saveFailureShot, ZH_BROWSER_LOCALE } from './support.ts'

const OVERLAY = fileURLToPath(new URL('../../../packages/bundle/paperai-web/cordis.patch.yml', import.meta.url))
const PRESETS = fileURLToPath(new URL('../../../packages/bundle/paperai-web/config/agent-presets', import.meta.url))
const FAKE_ACP = fileURLToPath(new URL('../../../packages/paperai/agent-acp/tests/fixtures/fake-acp-agent.mjs', import.meta.url))
const SNAPSHOTS = fileURLToPath(new URL('./snapshots/paperai-acp-tool-failure', import.meta.url))

describe('web e2e: failed ACP generic tool presentation', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let harnessHome: string
  let tripwire: ReturnType<typeof watchConsole>
  const events: SessionEvent[] = []

  beforeAll(async () => {
    harnessHome = await mkdtemp(join(tmpdir(), 'paperai-failed-tool-'))
    await writeFile(join(harnessHome, 'settings.yaml'), JSON.stringify({
      'paperai-acp-agents': { providers: { codex: { apiKey: 'public-synthetic-key' } } },
    }))
    scaffold = await launchWebScaffold({
      harnessHome, extraOverlayPath: OVERLAY,
      agentPresets: { default: 'codex', roots: [{ path: PRESETS, trust: 'system', ids: ['codex'] }] },
      paperAiAcp: { providers: { codex: { command: process.execPath, args: [FAKE_ACP], env: { FAKE_ACP_LABEL: 'codex', FAKE_ACP_FAILED_MCP_TOOL: '1' } } } },
    })
    scaffold.ctx.on('session/event', (_session, event: SessionEvent) => { events.push(event) })
    const project = join(scaffold.workspaceCwd, 'tool-review')
    await mkdir(project)
    const workspace = await scaffold.ctx.workspaceRegistry.create(project, 'Tool review')
    await scaffold.ctx.paperaiWorkbench.overview({ workspaceId: workspace.id })
    await scaffold.ctx.paperaiWorkbench.setProjectTemplate({ workspaceId: workspace.id, packId: null })
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.getByRole('treeitem', { name: /Tool review/ }).click()
    await page.getByRole('button', { name: '在“Tool review”中新建会话', exact: true }).click()
    await page.locator('textarea:enabled:not([readonly])').last().waitFor({ timeout: 20_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    if (harnessHome !== undefined) await rm(harnessHome, { recursive: true, force: true })
  })

  it('keeps the failed tool title collapsed and the complete MCP error expanded', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-paperai-failed-tool'))
    const settled = scaffold.whenTurnSettled(60_000)
    await page.locator('textarea:enabled:not([readonly])').last().fill('Inspect the failed document edit.')
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    await settled
    const card = page.locator('[data-chat-call-id="failed-mcp-edit"] [data-tool="paperai_acp_tool"]')
    await expect.poll(() => card.getAttribute('data-state'), { timeout: 15_000 }).toBe('error')
    const row = card.locator('[data-disclosure-row]')
    expect(await row.getAttribute('aria-expanded')).toBe('false')
    expect(await row.textContent()).toContain('paperai: paperai_commit_document')
    expect(await row.textContent()).not.toContain('revision_conflict')
    expect(await row.textContent()).not.toContain('"content"')
    expect(events.some(event => event.type === 'tool/result' && JSON.stringify(event.data).includes('revision_conflict'))).toBe(true)
    const mode = webSnapshotMode()
    await compareOrRefreshGolden(join(SNAPSHOTS, 'collapsed.expected.md'), await card.ariaSnapshot(), mode)
    await row.click()
    await expect.poll(() => card.innerText()).toContain('revision_conflict')
    expect(await card.innerText()).toContain('Read the current revision before retrying.')
    expect(await card.innerText()).toContain('public-synthetic-document')
    expect(await card.getAttribute('data-state')).toBe('error')
    expect(await row.textContent()).toContain('paperai: paperai_commit_document')
    await compareOrRefreshGolden(join(SNAPSHOTS, 'expanded.expected.md'), await card.ariaSnapshot(), mode)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOTS, ['collapsed.expected.md', 'expanded.expected.md'])
  }, 90_000)
})
