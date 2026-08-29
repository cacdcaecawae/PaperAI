// PaperAI browser snapshots: the shipped product composition exposes its safe
// permission default and preserves both sides of a same-node external conflict.
import { Buffer } from 'node:buffer'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@paperai/workbench-service'
import {
  assertFixtureInventory, compareOrRefreshGolden, captureStableAria,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { ZH_BROWSER_LOCALE, saveFailureShot } from './support.ts'

const PAPERAI_OVERLAY = fileURLToPath(new URL(
  '../../../packages/bundle/paperai-web/cordis.patch.yml',
  import.meta.url,
))
const SHIPPED_PRESETS = fileURLToPath(new URL('../../cli/config/agent-presets', import.meta.url))
const PAPERAI_PRESETS = fileURLToPath(new URL(
  '../../../packages/bundle/paperai-web/config/agent-presets',
  import.meta.url,
))
const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/paperai-workbench', import.meta.url))
const AGENT_PRESETS_EXPECTED = join(SNAPSHOT_DIR, 'agent-presets.expected.md')
const DEFAULT_PERMISSION_EXPECTED = join(SNAPSHOT_DIR, 'permission-default.expected.md')
const READ_ONLY_PERMISSION_EXPECTED = join(SNAPSHOT_DIR, 'permission-read-only.expected.md')
const PERMISSION_FAILURE_EXPECTED = join(SNAPSHOT_DIR, 'permission-failure.expected.md')
const CONFLICT_EXPECTED = join(SNAPSHOT_DIR, 'external-conflict.expected.md')
const MODE = webSnapshotMode()

/** Small valid OOXML document sent through the real browser import path. */
function fixtureDocxBase64(): string {
  return Buffer.from(zipSync({
    '[Content_Types].xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8"?>'
      + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
      + '</Types>',
    ),
    '_rels/.rels': strToU8(
      '<?xml version="1.0" encoding="UTF-8"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
      + '</Relationships>',
    ),
    'word/document.xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
      + '<w:p><w:r><w:t>Initial browser paragraph</w:t></w:r></w:p>'
      + '<w:p><w:r><w:t>Second paragraph</w:t></w:r></w:p>'
      + '<w:sectPr/></w:body></w:document>',
    ),
  })).toString('base64')
}

describe('web e2e: PaperAI permissions and document conflicts', { concurrent: false }, () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let workspaceId: Parameters<WebScaffold['ctx']['paperaiWorkbench']['list']>[0]['workspaceId']
  let resourceId: Awaited<ReturnType<WebScaffold['ctx']['paperaiWorkbench']['list']>>['resources'][number]['id']
  let originalPermissionMode: string | undefined

  beforeAll(async () => {
    originalPermissionMode = process.env.DSH_PERMISSION_MODE
    Reflect.deleteProperty(process.env, 'DSH_PERMISSION_MODE')
    scaffold = await launchWebScaffold({
      extraOverlayPath: PAPERAI_OVERLAY,
      agentPresets: {
        default: 'standard',
        roots: [
          { path: SHIPPED_PRESETS, trust: 'system', ids: ['standard'] },
          { path: PAPERAI_PRESETS, trust: 'system' },
        ],
      },
    })
    const projectRoot = join(scaffold.workspaceCwd, 'paper-project')
    await mkdir(projectRoot, { recursive: true })
    const workspace = await scaffold.ctx.workspaceRegistry.create(projectRoot, 'Paper project')
    workspaceId = workspace.id
    await scaffold.ctx.paperaiWorkbench.list({ workspaceId })
    const imported = await scaffold.ctx.paperaiWorkbench.importDocument({
      workspaceId,
      sessionId: SessionId('paperai-browser-import'),
      fileName: 'proposal.docx',
      contentBase64: fixtureDocxBase64(),
      role: 'proposal',
      name: 'Browser conflict proposal',
    })
    if (imported.status !== 'imported') {
      throw new Error(`PaperAI browser fixture import unavailable: ${imported.capability}: ${imported.detail}`)
    }
    const resources = await scaffold.ctx.paperaiWorkbench.list({ workspaceId })
    const documentResource = resources.resources.find(resource => resource.category === 'document')
    if (documentResource === undefined) throw new Error('PaperAI browser fixture has no document resource')
    resourceId = documentResource.id

    // The first OfficeCLI save normalizes the compact fixture into the same
    // representation used by later edits. Run that save through the shipped
    // workbench before opening the browser so subsequent commits retain the
    // selected semantic-node identity without repository-level test repairs.
    const normalizationSessionId = SessionId('paperai-browser-normalizer')
    const initial = await scaffold.ctx.paperaiWorkbench.open({
      workspaceId,
      sessionId: normalizationSessionId,
      resourceId,
    })
    if (initial.selectedNode === null) throw new Error('PaperAI browser fixture has no node to normalize')
    await scaffold.ctx.paperaiWorkbench.commit({
      sessionId: normalizationSessionId,
      documentId: initial.document.documentId,
      baseRevision: initial.document.revision,
      baseCommitId: initial.document.headCommitId,
      mutations: [{
        type: 'replace-text',
        nodeId: initial.selectedNode.nodeId,
        baseText: initial.selectedNode.text,
        nextText: 'Initial browser paragraph — normalized',
      }],
    })

    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await page.getByRole('treeitem', { name: /Paper project/ }).click()
    const open = page.getByRole('button', { name: '打开 Browser conflict proposal.docx' })
    await open.waitFor({ timeout: 15_000 })
    await open.click()
    await page.getByRole('tab', { name: '编辑' }).waitFor({ timeout: 30_000 })
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    if (originalPermissionMode === undefined) {
      Reflect.deleteProperty(process.env, 'DSH_PERMISSION_MODE')
    } else {
      process.env.DSH_PERMISSION_MODE = originalPermissionMode
    }
  })

  it('seeds a fresh session with the inherited confined-access preset', () => {
    const session = scaffold.ctx.sessions.create(SessionId('paperai-safe-default'))

    expect(session.events.map(event => [event.type, event.data])).toEqual([
      ['permission/preset', { preset: 'workspace-write' }],
      ['sandbox/mode', { mode: 'workspace-write' }],
      ['approval/policy', { policy: 'ask' }],
    ])
  })

  it('offers exactly the PaperAI product Agent presets', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-paperai-agent-presets'))
    const trigger = page.getByRole('button', { name: '标准模式' }).first()
    await trigger.waitFor({ timeout: 10_000 })
    await trigger.click()
    const menu = page.getByRole('menu')
    await menu.waitFor({ timeout: 10_000 })
    expect(await menu.getByRole('menuitem').allTextContents()).toHaveLength(3)
    await compareOrRefreshGolden(AGENT_PRESETS_EXPECTED, await menu.ariaSnapshot(), MODE)
    await page.keyboard.press('Escape')
  }, 60_000)

  it('snapshots the default permission and a real picker switch', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-paperai-permissions'))
    const access = page.locator('button[aria-label^="访问模式"]').first()
    await access.waitFor({ timeout: 10_000 })
    expect(await access.getAttribute('aria-label')).toBe('访问模式，当前：Workspace Write')
    await expect.poll(() => access.isEnabled(), { timeout: 10_000 }).toBe(true)
    await compareOrRefreshGolden(DEFAULT_PERMISSION_EXPECTED, await access.ariaSnapshot(), MODE)

    await access.click()
    await page.getByRole('menuitem', { name: 'Read Only' }).click()
    await expect.poll(() => access.getAttribute('aria-label'), { timeout: 10_000 })
      .toBe('访问模式，当前：Read Only')
    await expect.poll(() => access.isEnabled(), { timeout: 10_000 }).toBe(true)
    await compareOrRefreshGolden(READ_ONLY_PERMISSION_EXPECTED, await access.ariaSnapshot(), MODE)

    await access.click()
    await page.getByRole('menuitem', { name: 'Workspace Write' }).click()
    await expect.poll(() => access.getAttribute('aria-label'), { timeout: 10_000 })
      .toBe('访问模式，当前：Workspace Write')
  }, 60_000)

  it('announces a rejected permission switch without exposing an internal error', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-paperai-permission-failure'))
    await page.route('**/api/commands/execute', async (route) => {
      const request = route.request().postDataJSON() as {
        rpcId: string
        payload: { args: { line: string } }
      }
      expect(request.payload).toMatchObject({ args: { line: '/permission read-only' } })
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          type: 'server-response',
          rpcId: request.rpcId,
          result: {
            ok: false,
            error: { code: 'internal', message: 'provider internal failure', details: {} },
          },
        }),
      })
    }, { times: 1 })
    const access = page.locator('button[aria-label^="访问模式"]').first()
    await access.click()
    await page.getByRole('menuitem', { name: 'Read Only' }).click()
    const alert = page.getByRole('alert')
    await alert.waitFor({ timeout: 10_000 })
    expect(await alert.textContent()).toContain('无法切换访问模式，请重试。')
    expect(await alert.textContent()).not.toContain('provider internal failure')
    expect(await access.getAttribute('aria-label')).toBe('访问模式，当前：Workspace Write')
    await compareOrRefreshGolden(PERMISSION_FAILURE_EXPECTED, await alert.ariaSnapshot(), MODE)
  }, 60_000)

  it('compares and merges a same-node external change from the latest revision', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-paperai-conflict'))
    await page.getByRole('tab', { name: '编辑' }).click()
    const editor = page.locator('textarea[aria-label^="编辑节点："]')
    await editor.waitFor({ timeout: 10_000 })
    await editor.fill('浏览器中的本地草稿')

    const externalSessionId = SessionId('paperai-browser-external-writer')
    const before = await scaffold.ctx.paperaiWorkbench.open({ workspaceId, sessionId: externalSessionId, resourceId })
    const selected = before.selectedNode
    if (selected === null) throw new Error('PaperAI browser fixture has no editable selected node')
    const external = await scaffold.ctx.paperaiWorkbench.commit({
      sessionId: externalSessionId,
      documentId: before.document.documentId,
      baseRevision: before.document.revision,
      baseCommitId: before.document.headCommitId,
      mutations: [{
        type: 'replace-text',
        nodeId: selected.nodeId,
        baseText: selected.text,
        nextText: 'Initial browser paragraph — 外部会话写入的最新文本',
      }],
    })
    expect(external.selectedNode?.nodeId).toBe(selected.nodeId)

    const review = page.getByRole('button', { name: '查看并解决' })
    await review.waitFor({ timeout: 10_000 })
    await review.click()
    await page.getByRole('textbox', { name: '外部最新文本' }).waitFor({ timeout: 30_000 })
    expect(await page.getByRole('textbox', { name: '本地草稿' }).inputValue()).toBe('浏览器中的本地草稿')
    expect(await page.getByRole('textbox', { name: '外部最新文本' }).inputValue())
      .toBe('Initial browser paragraph — 外部会话写入的最新文本')
    const snapshot = await captureStableAria(page, '[data-paperai-node-editor]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(CONFLICT_EXPECTED, snapshot, MODE)

    await editor.fill('浏览器合并后的最终文本')
    await page.getByRole('button', { name: '使用合并内容' }).click()
    const commit = page.getByRole('button', { name: '提交并创建版本' })
    await commit.click()
    await page.getByRole('heading', { name: '浏览器合并后的最终文本' }).waitFor({ timeout: 30_000 })
    const committed = await scaffold.ctx.paperaiWorkbench.open({
      workspaceId,
      sessionId: externalSessionId,
      resourceId,
    })
    expect(committed.selectedNode?.text).toBe('浏览器合并后的最终文本')
  }, 120_000)

  it('keeps its snapshot inventory closed', async () => {
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, [
      'agent-presets.expected.md',
      'external-conflict.expected.md',
      'permission-default.expected.md',
      'permission-failure.expected.md',
      'permission-read-only.expected.md',
    ])
  })
})
