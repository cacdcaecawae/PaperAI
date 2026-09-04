// PaperAI project navigation snapshot: the sidebar lists a project's tracked
// documents beside its DSH sessions, the start page carries the project's
// template set, an undecided project is asked for its set once, and the
// settings page manages the template library.
import { Buffer } from 'node:buffer'
import { mkdir, readFile } from 'node:fs/promises'
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
const START_NO_PROJECT_EXPECTED = join(SNAPSHOT_DIR, 'start-no-project.expected.md')
const START_EXPECTED = join(SNAPSHOT_DIR, 'start.expected.md')
const TEMPLATE_DIALOG_EXPECTED = join(SNAPSHOT_DIR, 'template-dialog.expected.md')
const TEMPLATES_EXPECTED = join(SNAPSHOT_DIR, 'templates.expected.md')
const TEMPLATE_MISSING_EXPECTED = join(SNAPSHOT_DIR, 'template-missing.expected.md')
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

/** Capture the complete project identity and detail hierarchy with portable paths. */
async function captureProjectDetail(page: Page, workspaceCwd: string): Promise<string> {
  return [
    await page.getByRole('button', { name: '返回项目列表' }).ariaSnapshot(),
    await captureStableAria(page, '[class*="detailIdentity"]', workspaceCwd),
    await captureStableAria(page, '[role="region"][aria-label="项目详情"]', workspaceCwd),
  ].join('\n').replace(/\{\{cwd\}\}[\\/]/g, '{{cwd}}/')
}

describe('web e2e: PaperAI project navigation', { concurrent: false }, () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let builtInSetName: string
  let builtInPackId: string

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ extraOverlayPath: PAPERAI_OVERLAY })
    const library = await scaffold.ctx.paperaiWorkbench.listTemplateLibrary()
    const builtIn = library.sets.find(set => set.kind === 'built-in')
    if (builtIn === undefined) throw new Error('PaperAI browser fixture has no built-in template set')
    builtInSetName = builtIn.name
    builtInPackId = builtIn.packId

    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 180_000)

  // Seed after the no-project view: startup otherwise resumes the most recent
  // project and correctly opens its unanswered template dialog.
  async function seedProjects(): Promise<void> {
    // A decided project with one freely imported document.
    const projectRoot = join(scaffold.workspaceCwd, 'paper-project')
    await mkdir(projectRoot, { recursive: true })
    const workspace = await scaffold.ctx.workspaceRegistry.create(projectRoot, 'Paper project')
    await scaffold.ctx.paperaiWorkbench.overview({ workspaceId: workspace.id })
    await scaffold.ctx.paperaiWorkbench.setProjectTemplate({ workspaceId: workspace.id, packId: builtInPackId })
    const imported = await scaffold.ctx.paperaiWorkbench.importDocument({
      workspaceId: workspace.id,
      sessionId: SessionId('paperai-workspace-navigation-import'),
      fileName: 'workspace-brief.docx',
      contentBase64: fixtureDocxBase64(),
      name: 'Workspace brief',
    })
    if (imported.status !== 'imported') {
      throw new Error(`PaperAI browser fixture import unavailable: ${imported.capability}: ${imported.detail}`)
    }

    // A project that has never decided its template set.
    const emptyProjectRoot = join(scaffold.workspaceCwd, 'empty-project')
    await mkdir(emptyProjectRoot, { recursive: true })
    const emptyWorkspace = await scaffold.ctx.workspaceRegistry.create(emptyProjectRoot, 'Empty project')
    await scaffold.ctx.paperaiWorkbench.overview({ workspaceId: emptyWorkspace.id })

  }

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('opens on a start page that offers a new project, then enters a project by keyboard', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-paperai-workspace-navigation'))
    await page.getByRole('button', { name: '新建或打开项目' }).waitFor({ timeout: 15_000 })
    await compareOrRefreshGolden(
      START_NO_PROJECT_EXPECTED,
      await captureStableAria(page, '[data-paperai-start="no-project"]', scaffold.workspaceCwd),
      MODE,
    )
    await seedProjects()
    const list = page.getByRole('tree', { name: '项目' })
    await list.waitFor({ timeout: 15_000 })
    await page.getByRole('treeitem', { name: 'Empty project' }).waitFor({ timeout: 15_000 })
    await compareOrRefreshGolden(LIST_EXPECTED, await list.ariaSnapshot(), MODE)
    const workspace = page.getByRole('treeitem', { name: /Paper project/ })
    await workspace.waitFor({ timeout: 15_000 })
    await workspace.press('Enter')

    const back = page.getByRole('button', { name: '返回项目列表' })
    await back.waitFor({ timeout: 15_000 })
    await expect.poll(() => back.evaluate(element => document.activeElement === element)).toBe(true)
    const identity = page.getByRole('heading', { name: 'Paper project', level: 2 }).locator('xpath=..')
    await identity.waitFor({ timeout: 15_000 })
    const detail = page.getByRole('region', { name: '项目详情' })
    await detail.waitFor({ timeout: 15_000 })
    // Only tracked documents and DSH sessions: no template rows, no new-document buttons.
    await page.getByRole('button', { name: '打开 Workspace brief.docx' }).waitFor({ timeout: 15_000 })
    await page.getByRole('heading', { name: '文档', level: 3 }).waitFor({ timeout: 15_000 })
    await page.getByRole('heading', { name: '会话', level: 3 }).waitFor({ timeout: 15_000 })
    await page.getByRole('button', { name: '在“Paper project”中新建会话' }).waitFor({ timeout: 15_000 })
    expect(await detail.getByText('模板').count()).toBe(0)
    await compareOrRefreshGolden(DETAIL_EXPECTED, await captureProjectDetail(page, scaffold.workspaceCwd), MODE)

    // The start page names the project's template set and one action per format.
    await page.getByRole('button', { name: '在“Paper project”中新建会话' }).click()
    await page.getByText(`本项目模板：${builtInSetName}`).waitFor({ timeout: 15_000 })
    await page.getByRole('button', { name: '从本项目模板新建开题报告' }).waitFor({ timeout: 15_000 })
    await page.getByRole('button', { name: '导入 Word 初稿并套用学位论文格式' }).waitFor({ timeout: 15_000 })
    await page.getByRole('button', { name: '导入 Word，自由写' }).waitFor({ timeout: 15_000 })
    expect(await page.getByRole('dialog').count()).toBe(0)
    await compareOrRefreshGolden(
      START_EXPECTED,
      await captureStableAria(page, '[data-paperai-start="project"]', scaffold.workspaceCwd),
      MODE,
    )

    await back.click()
    await workspace.waitFor({ timeout: 15_000 })
    await expect.poll(() => workspace.evaluate(element => document.activeElement === element)).toBe(true)
    expect(await page.getByRole('region', { name: '项目详情' }).count()).toBe(0)
    expect(await page.getByRole('button', { name: '打开 Workspace brief.docx' }).count()).toBe(0)
  }, 60_000)

  it('asks an undecided project for its template set once and remembers the answer', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-paperai-workspace-empty'))
    await page.getByRole('treeitem', { name: 'Empty project' }).click()
    await page.getByRole('heading', { name: 'Empty project', level: 2 }).waitFor({ timeout: 15_000 })
    await page.getByText('还没有文档。在中间的起始页新建或导入。').waitFor({ timeout: 15_000 })
    await page.getByRole('button', { name: '在“Empty project”中新建会话' }).waitFor({ timeout: 15_000 })
    await page.getByRole('button', { name: '在“Empty project”中新建会话' }).click()

    const dialog = page.getByRole('dialog', { name: '本项目用哪套模板？' })
    await dialog.waitFor({ timeout: 15_000 })
    const use = dialog.getByRole('button', { name: '用于本项目' }).first()
    await use.waitFor({ timeout: 15_000 })
    await compareOrRefreshGolden(TEMPLATE_DIALOG_EXPECTED, await dialog.ariaSnapshot(), MODE)
    await use.click()
    await expect.poll(() => dialog.count(), { timeout: 15_000 }).toBe(0)
    await page.getByText(`本项目模板：${builtInSetName}`).waitFor({ timeout: 15_000 })
    await page.getByRole('button', { name: '从本项目模板新建开题报告' }).waitFor({ timeout: 15_000 })
    await compareOrRefreshGolden(EMPTY_EXPECTED, await captureProjectDetail(page, scaffold.workspaceCwd), MODE)

    // The answer is durable: revisiting the project asks nothing.
    await page.getByRole('button', { name: '返回项目列表' }).click()
    await page.getByRole('treeitem', { name: 'Empty project' }).click()
    await page.getByRole('heading', { name: 'Empty project', level: 2 }).waitFor({ timeout: 15_000 })
    await page.getByText(`本项目模板：${builtInSetName}`).waitFor({ timeout: 15_000 })
    expect(await page.getByRole('dialog').count()).toBe(0)
    await page.getByRole('button', { name: '返回项目列表' }).click()
  }, 60_000)

  it('uploads a custom format, selects its template for the project, and reports deletion after reload', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-paperai-templates-settings'))
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const settings = page.getByRole('dialog', { name: '设置' })
    await settings.waitFor({ timeout: 15_000 })
    await settings.getByRole('button', { name: '模板', exact: true }).click()
    await settings.getByRole('heading', { name: '模板', level: 2 }).waitFor({ timeout: 15_000 })
    await settings.getByText(builtInSetName).waitFor({ timeout: 15_000 })
    await settings.getByRole('button', { name: '添加自定义模板' }).waitFor({ timeout: 15_000 })
    await compareOrRefreshGolden(
      TEMPLATES_EXPECTED,
      await captureStableAria(page, '[data-paperai-library="settings"]', scaffold.workspaceCwd),
      MODE,
    )

    await settings.getByRole('button', { name: '添加自定义模板' }).click()
    await settings.getByRole('textbox', { name: '模板名称' }).fill('E2E 学院版')
    await settings.getByRole('button', { name: '创建' }).click()
    await settings.getByText('E2E 学院版').waitFor({ timeout: 15_000 })
    await settings.getByText('还没有格式，添加一份 Word 文件即可使用。').waitFor({ timeout: 15_000 })
    const customSet = settings.getByRole('listitem').filter({ hasText: 'E2E 学院版' })
    await customSet.getByRole('button', { name: '添加格式' }).click()
    await customSet.locator('input[type="file"]').setInputFiles({
      name: '学院开题.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer: Buffer.from(fixtureDocxBase64(), 'base64'),
    })
    await customSet.getByRole('button', { name: '移除：开题报告' }).waitFor({ timeout: 15_000 })
    await page.keyboard.press('Escape')
    await expect.poll(() => settings.count(), { timeout: 5_000 }).toBe(0)

    await page.getByRole('button', { name: '更换…' }).click()
    const templateDialog = page.getByRole('dialog', { name: '本项目用哪套模板？' })
    await templateDialog.getByRole('listitem').filter({ hasText: 'E2E 学院版' })
      .getByRole('button', { name: '用于本项目' }).click()
    await expect.poll(() => templateDialog.count(), { timeout: 15_000 }).toBe(0)
    await page.getByText('本项目模板：E2E 学院版').waitFor({ timeout: 15_000 })

    await page.getByRole('button', { name: '设置', exact: true }).click()
    await settings.getByRole('button', { name: '模板', exact: true }).click()
    await settings.getByRole('button', { name: '删除：E2E 学院版' }).click()
    await settings.getByRole('button', { name: '取消' }).click()
    await settings.getByText('E2E 学院版').waitFor({ timeout: 15_000 })
    expect(await settings.getByRole('button', { name: '确认删除' }).count()).toBe(0)
    await settings.getByRole('button', { name: '删除：E2E 学院版' }).click()
    await settings.getByRole('button', { name: '确认删除' }).click()
    await expect.poll(() => settings.getByText('E2E 学院版').count(), { timeout: 15_000 }).toBe(0)
    await page.keyboard.press('Escape')
    await expect.poll(() => page.getByRole('dialog', { name: '设置' }).count(), { timeout: 5_000 }).toBe(0)
    await page.reload({ waitUntil: 'load' })
    await page.getByText('本项目的模板已不在模板库中').waitFor({ timeout: 15_000 })
    expect(await page.getByRole('dialog').count()).toBe(0)
    await compareOrRefreshGolden(
      TEMPLATE_MISSING_EXPECTED,
      await captureStableAria(page, '[data-paperai-start="project"]', scaffold.workspaceCwd),
      MODE,
    )
  }, 60_000)

  it('keeps its snapshot inventory closed', async () => {
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, [
      'detail.expected.md',
      'empty.expected.md',
      'list.expected.md',
      'start-no-project.expected.md',
      'start.expected.md',
      'template-dialog.expected.md',
      'template-missing.expected.md',
      'templates.expected.md',
    ])
  })
})

it('prompts for a template after picking a fresh project and creates one document in its public directory', async () => {
  const scaffold = await launchWebScaffold({ extraOverlayPath: PAPERAI_OVERLAY })
  let browser: Browser | undefined
  let page: Page | undefined
  try {
    const projectRoot = join(scaffold.workspaceCwd, 'new-paper-project')
    await mkdir(projectRoot)
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    const tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.getByRole('button', { name: '新建或打开项目' }).click()
    const picker = page.getByRole('dialog', { name: '选择工作区目录' })
    await picker.getByRole('button', { name: '编辑路径' }).click()
    const pathInput = picker.getByRole('textbox', { name: '编辑路径' })
    await pathInput.fill(projectRoot)
    await pathInput.press('Enter')
    await picker.getByRole('button', { name: '打开', exact: true }).click()
    await picker.waitFor({ state: 'hidden', timeout: 15_000 })

    const dialog = page.getByRole('dialog', { name: '本项目用哪套模板？' })
    await dialog.waitFor({ timeout: 15_000 })
    await dialog.getByRole('button', { name: '用于本项目' }).first().waitFor({ timeout: 15_000 })
    await compareOrRefreshGolden(TEMPLATE_DIALOG_EXPECTED, await dialog.ariaSnapshot(), MODE)
    await dialog.getByRole('button', { name: '用于本项目' }).first().click()
    await dialog.waitFor({ state: 'hidden', timeout: 15_000 })
    await page.getByRole('button', { name: '从本项目模板新建开题报告' }).click()
    const displayedPath = 'documents/working/硕士学位论文开题报告.docx'
    await page.getByText(displayedPath, { exact: true }).waitFor({ timeout: 30_000 })
    await page.getByRole('treeitem', { name: 'new-paper-project' }).click()
    await page.getByRole('button', { name: '打开 硕士学位论文开题报告.docx' }).waitFor({ timeout: 15_000 })

    const workspace = await scaffold.ctx.workspaceRegistry.resolveByPath(projectRoot)
    if (workspace === undefined) throw new Error('Selected project was not registered')
    const overview = await scaffold.ctx.paperaiWorkbench.overview({ workspaceId: workspace.id })
    expect(overview.templateDecided).toBe(true)
    expect(overview.documents.map(document => document.documentType)).toEqual(['proposal'])
    const bytes = await readFile(join(projectRoot, 'documents', 'working', '硕士学位论文开题报告.docx'))
    expect(bytes.byteLength).toBeGreaterThan(0)
    expect(await page.getByRole('list', { name: '文档' }).getByRole('listitem').count()).toBe(1)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  } catch (error) {
    if (page !== undefined) await saveFailureShot(page, 'web-e2e-paperai-new-project')
    throw error
  } finally {
    await browser?.close()
    await scaffold.close()
  }
}, 120_000)
