// PaperAI Workspace navigation snapshot: a real project enters a compact
// second-level view that composes project resources with its Session list.
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
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { ZH_BROWSER_LOCALE, saveFailureShot } from './support.ts'

const PAPERAI_OVERLAY = fileURLToPath(new URL(
  '../../../packages/bundle/paperai-web/cordis.patch.yml',
  import.meta.url,
))
const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/paperai-workspace-navigation', import.meta.url))
const LIST_EXPECTED = join(SNAPSHOT_DIR, 'list.expected.md')
const DETAIL_EXPECTED = join(SNAPSHOT_DIR, 'detail.expected.md')
const EMPTY_EXPECTED = join(SNAPSHOT_DIR, 'empty.expected.md')
const MODE = webSnapshotMode()

/** Small valid OOXML document sent through the assembled PaperAI import path. */
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
      + '<w:p><w:r><w:t>Workspace navigation fixture</w:t></w:r></w:p>'
      + '<w:sectPr/></w:body></w:document>',
    ),
  })).toString('base64')
}

/** Capture the complete Workspace identity and detail hierarchy with portable paths. */
async function captureWorkspaceDetail(page: Page, workspaceCwd: string): Promise<string> {
  return [
    await page.getByRole('button', { name: '返回工作区列表' }).ariaSnapshot(),
    await captureStableAria(page, '[class*="detailIdentity"]', workspaceCwd),
    await captureStableAria(page, '[role="region"][aria-label="工作区详情"]', workspaceCwd),
  ].join('\n').replace(/\{\{cwd\}\}[\\/]/g, '{{cwd}}/')
}

describe('web e2e: PaperAI Workspace detail navigation', { concurrent: false }, () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ extraOverlayPath: PAPERAI_OVERLAY })
    const projectRoot = join(scaffold.workspaceCwd, 'paper-project')
    await mkdir(projectRoot, { recursive: true })
    const workspace = await scaffold.ctx.workspaceRegistry.create(projectRoot, 'Paper project')
    await scaffold.ctx.paperaiWorkbench.list({ workspaceId: workspace.id })
    const emptyProjectRoot = join(scaffold.workspaceCwd, 'empty-project')
    await mkdir(emptyProjectRoot, { recursive: true })
    const emptyWorkspace = await scaffold.ctx.workspaceRegistry.create(emptyProjectRoot, 'Empty project')
    await scaffold.ctx.paperaiWorkbench.list({ workspaceId: emptyWorkspace.id })
    const imported = await scaffold.ctx.paperaiWorkbench.importDocument({
      workspaceId: workspace.id,
      sessionId: SessionId('paperai-workspace-navigation-import'),
      fileName: 'workspace-brief.docx',
      contentBase64: fixtureDocxBase64(),
      role: 'proposal',
      name: 'Workspace brief',
    })
    if (imported.status !== 'imported') {
      throw new Error(`PaperAI browser fixture import unavailable: ${imported.capability}: ${imported.detail}`)
    }

    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('enters by keyboard, composes resources with sessions, and returns to the list', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-paperai-workspace-navigation'))
    const list = page.getByRole('tree', { name: '工作区' })
    await list.waitFor({ timeout: 15_000 })
    await compareOrRefreshGolden(LIST_EXPECTED, await list.ariaSnapshot(), MODE)
    const workspace = page.getByRole('treeitem', { name: /Paper project/ })
    await workspace.waitFor({ timeout: 15_000 })
    await workspace.press('Enter')

    const back = page.getByRole('button', { name: '返回工作区列表' })
    await back.waitFor({ timeout: 15_000 })
    await expect.poll(() => back.evaluate(element => document.activeElement === element)).toBe(true)
    const identity = page.getByRole('heading', { name: 'Paper project', level: 2 }).locator('xpath=..')
    await identity.waitFor({ timeout: 15_000 })
    const detail = page.getByRole('region', { name: '工作区详情' })
    await detail.waitFor({ timeout: 15_000 })
    await page.getByRole('button', { name: '打开 Workspace brief.docx' }).waitFor({ timeout: 15_000 })
    await page.getByRole('heading', { name: '项目内容', level: 3 }).waitFor({ timeout: 15_000 })
    await page.getByRole('heading', { name: '会话', level: 3 }).waitFor({ timeout: 15_000 })
    await page.getByRole('button', { name: '在“Paper project”中新建会话' }).waitFor({ timeout: 15_000 })
    await compareOrRefreshGolden(DETAIL_EXPECTED, await captureWorkspaceDetail(page, scaffold.workspaceCwd), MODE)

    await back.click()
    await workspace.waitFor({ timeout: 15_000 })
    await expect.poll(() => workspace.evaluate(element => document.activeElement === element)).toBe(true)
    expect(await page.getByRole('region', { name: '工作区详情' }).count()).toBe(0)
    expect(await page.getByRole('button', { name: '打开 Workspace brief.docx' }).count()).toBe(0)
  }, 60_000)

  it('gives empty project content an immediate next action', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-paperai-workspace-empty'))
    await page.getByRole('treeitem', { name: 'Empty project' }).click()
    await page.getByRole('heading', { name: 'Empty project', level: 2 }).waitFor({ timeout: 15_000 })
    await page.getByText('暂无项目内容').waitFor({ timeout: 15_000 })
    await page.getByRole('button', { name: '在“Empty project”中新建会话' }).waitFor({ timeout: 15_000 })
    await page.getByRole('treeitem', { name: '新会话' }).waitFor({ timeout: 15_000 })
    // The template catalog is its own asynchronous request; the start flow is
    // complete only once the built-in template rows have replaced the loading line.
    await page.getByRole('button', { name: '从模板新建：硕士学位论文开题报告' }).waitFor({ timeout: 15_000 })
    await compareOrRefreshGolden(EMPTY_EXPECTED, await captureWorkspaceDetail(page, scaffold.workspaceCwd), MODE)
    await page.getByRole('button', { name: '返回工作区列表' }).click()
  }, 60_000)

  it('keeps its snapshot inventory closed', async () => {
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, [
      'detail.expected.md',
      'empty.expected.md',
      'list.expected.md',
    ])
  })
})
