// PaperAI browser snapshots: the shipped product composition exposes its safe
// permission default and preserves both sides of a same-node external conflict.
import { Buffer } from 'node:buffer'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspect } from 'node:util'
import type { Browser, Locator, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
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
const PAPERAI_PRESETS = fileURLToPath(new URL(
  '../../../packages/bundle/paperai-web/config/agent-presets',
  import.meta.url,
))
const FAKE_ACP_AGENT = fileURLToPath(new URL(
  '../../../packages/paperai/agent-acp/tests/fixtures/fake-acp-agent.mjs',
  import.meta.url,
))
const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/paperai-workbench', import.meta.url))
const AGENT_PRESETS_EXPECTED = join(SNAPSHOT_DIR, 'agent-presets.expected.md')
const DEFAULT_PERMISSION_EXPECTED = join(SNAPSHOT_DIR, 'permission-default.expected.md')
const READ_ONLY_PERMISSION_EXPECTED = join(SNAPSHOT_DIR, 'permission-read-only.expected.md')
const PERMISSION_FAILURE_EXPECTED = join(SNAPSHOT_DIR, 'permission-failure.expected.md')
const MODEL_FAILURE_EXPECTED = join(SNAPSHOT_DIR, 'model-failure.expected.md')
const MODEL_MENU_EXPECTED = join(SNAPSHOT_DIR, 'model-menu.expected.md')
const CANCEL_BEFORE_PROMPT_EXPECTED = join(SNAPSHOT_DIR, 'cancel-before-prompt.expected.md')
const CANCEL_FINAL_TOOL_EXPECTED = join(SNAPSHOT_DIR, 'cancel-final-tool.expected.md')
const EXTERNAL_UPDATE_EXPECTED = join(SNAPSHOT_DIR, 'external-update.expected.md')
const BLOCK_EDITOR_EXPECTED = join(SNAPSHOT_DIR, 'block-editor.expected.md')
const MODE = webSnapshotMode()

interface AcpLogEntry {
  readonly event: string
  readonly modeId?: string
  readonly title?: string
}

/** Include engine validation evidence when setup fails before browser assertions. */
function reportDocumentSetupFailure(error: unknown): never {
  console.error(`PaperAI browser document setup failed: ${inspect(error, { depth: null })}`)
  throw error
}

async function readAcpLog(path: string): Promise<AcpLogEntry[]> {
  try {
    const content = await readFile(path, 'utf8')
    return content.trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as AcpLogEntry)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

/** Small valid OOXML document sent through the real browser import path. */
function fixtureDocxBase64(withFigureAndTable = false, paragraphs = ['Initial browser paragraph', 'Second paragraph']): string {
  return Buffer.from(zipSync({
    '[Content_Types].xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8"?>'
      + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + (withFigureAndTable ? '<Default Extension="png" ContentType="image/png"/>' : '')
      + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
      + (withFigureAndTable
        ? '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>'
          + '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>'
        : '')
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
      + paragraphs.map(text => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`).join('')
      + (withFigureAndTable
        ? '<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="3000"/></w:tblGrid>'
          + '<w:tr><w:tc><w:tcPr/><w:p><w:r><w:t>Repeated passage</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
          + '<w:p><w:r><w:t>Repeated passage</w:t></w:r></w:p>'
          + '<w:p><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">'
          + '<wp:extent cx="914400" cy="914400"/><wp:docPr id="1" name="Research figure" descr="Research figure"/>'
          + '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
          + '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">'
          + '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">'
          + '<pic:nvPicPr><pic:cNvPr id="1" name="figure.png"/><pic:cNvPicPr/></pic:nvPicPr>'
          + '<pic:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="rIdFigure"/>'
          + '<a:stretch><a:fillRect/></a:stretch></pic:blipFill>'
          + '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm>'
          + '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>'
          + '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>'
        : '')
      + (withFigureAndTable
        ? '<w:sectPr xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
          + '<w:headerReference w:type="default" r:id="rIdHeader"/><w:footerReference w:type="default" r:id="rIdFooter"/></w:sectPr>'
        : '<w:sectPr/>')
      + '</w:body></w:document>',
    ),
    ...(withFigureAndTable ? {
      'word/_rels/document.xml.rels': strToU8(
        '<?xml version="1.0" encoding="UTF-8"?>'
        + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + '<Relationship Id="rIdFigure" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/figure.png"/>'
        + '<Relationship Id="rIdHeader" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>'
        + '<Relationship Id="rIdFooter" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>'
        + '</Relationships>',
      ),
      'word/header1.xml': strToU8('<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        + '<w:p><w:r><w:t>Initial browser paragraph</w:t></w:r></w:p></w:hdr>'),
      'word/footer1.xml': strToU8('<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        + '<w:p><w:r><w:t>Second paragraph</w:t></w:r></w:p></w:ftr>'),
      'word/media/figure.png': Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNQyVgDAAHsATleaPIZAAAAAElFTkSuQmCC', 'base64'),
    } : {}),
  })).toString('base64')
}

describe('web e2e: PaperAI permissions and document conflicts', { concurrent: false }, () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  const selectBlockText = async (block: Locator): Promise<void> => {
    await block.click()
    await block.evaluate((element) => {
      const range = document.createRange()
      range.selectNodeContents(element)
      const selection = window.getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      element.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', bubbles: true }))
    })
  }
  /** Replace one paragraph's selected text through the browser's native input event. */
  const retype = async (block: Locator, text: string): Promise<void> => {
    await selectBlockText(block)
    await page.keyboard.insertText(text)
  }
  const pending = () => page.locator('[data-paperai-pending]')
  const agentColumn = () => page.locator('[class*="centerCol"]')
  const expectAgentHidden = async (): Promise<void> => {
    await expect.poll(() => agentColumn().evaluate(element => element.hasAttribute('inert')
      && element.getAttribute('aria-hidden') === 'true' && element.getBoundingClientRect().width < 1)).toBe(true)
  }
  const expectAgentVisible = async (): Promise<void> => {
    await expect.poll(() => agentColumn().evaluate(element => !element.hasAttribute('inert')
      && element.getBoundingClientRect().width >= 280)).toBe(true)
  }
  const sidebarDocument = (fileName: string) => page.getByRole('region', { name: '文档' })
    .getByRole('button', { name: `打开 ${fileName}`, exact: true })
  let tripwire: ReturnType<typeof watchConsole>
  let workspaceId: Parameters<WebScaffold['ctx']['paperaiWorkbench']['overview']>[0]['workspaceId']
  let resourceId: Awaited<ReturnType<WebScaffold['ctx']['paperaiWorkbench']['overview']>>['documents'][number]['id']
  let originalPermissionMode: string | undefined
  let acpFixtureRoot: string | undefined
  let acpLogPath: string
  let rejectModePath: string
  let rejectModelPath: string
  let startupGatePath: string
  const sessionEvents: SessionEvent[] = []

  beforeAll(async () => {
    originalPermissionMode = process.env.DSH_PERMISSION_MODE
    Reflect.deleteProperty(process.env, 'DSH_PERMISSION_MODE')
    acpFixtureRoot = await mkdtemp(join(tmpdir(), 'dsh-paperai-acp-browser-'))
    acpLogPath = join(acpFixtureRoot, 'events.jsonl')
    rejectModePath = join(acpFixtureRoot, 'reject-set-mode')
    rejectModelPath = join(acpFixtureRoot, 'reject-set-config')
    startupGatePath = join(acpFixtureRoot, 'startup-gate')
    const harnessHome = join(acpFixtureRoot, 'home')
    await mkdir(harnessHome)
    await writeFile(join(harnessHome, 'settings.yaml'), JSON.stringify({
      'paperai-acp-agents': { codex: { apiKey: 'browser-old-codex' }, claude: { apiKey: 'browser-old-claude' } },
    }))
    scaffold = await launchWebScaffold({
      harnessHome,
      extraOverlayPath: PAPERAI_OVERLAY,
      agentPresets: {
        default: 'codex',
        roots: [
          { path: PAPERAI_PRESETS, trust: 'system', ids: ['codex', 'claude'] },
        ],
      },
      paperAiAcp: {
        providers: {
          codex: {
            command: process.execPath,
            args: [FAKE_ACP_AGENT],
            env: {
              FAKE_ACP_LABEL: 'codex',
              FAKE_ACP_LOG: acpLogPath,
              FAKE_ACP_REJECT_SET_MODE: 'read-only',
              FAKE_ACP_REJECT_SET_MODE_FILE: rejectModePath,
              FAKE_ACP_REJECT_SET_CONFIG_FILE: rejectModelPath,
              FAKE_ACP_CANCEL_FINAL_TOOL: '1',
              FAKE_ACP_TOOL_IMAGE: '1',
            },
          },
          claude: {
            command: process.execPath,
            args: [FAKE_ACP_AGENT],
            env: {
              FAKE_ACP_LABEL: 'claude',
              FAKE_ACP_STARTUP_GATE_FILE: startupGatePath,
              FAKE_ACP_MODEL: 'fake-beta',
              FAKE_ACP_LOG: acpLogPath,
              FAKE_ACP_TITLE_ECHO: '1',
            },
          },
        },
      },
    })
    scaffold.ctx.on('session/event', (_session, event: SessionEvent) => { sessionEvents.push(event) })
    const projectRoot = join(scaffold.workspaceCwd, 'paper-project')
    await mkdir(projectRoot, { recursive: true })
    const workspace = await scaffold.ctx.workspaceRegistry.create(projectRoot, 'Paper project')
    workspaceId = workspace.id
    await scaffold.ctx.paperaiWorkbench.overview({ workspaceId })
    await scaffold.ctx.paperaiWorkbench.setProjectTemplate({ workspaceId, packId: null })
    const imported = await scaffold.ctx.paperaiWorkbench.importDocument({
      workspaceId,
      sessionId: SessionId('paperai-browser-import'),
      fileName: 'proposal.docx',
      contentBase64: fixtureDocxBase64(),
      name: 'Browser conflict proposal',
    }).catch(reportDocumentSetupFailure)
    if (imported.status !== 'imported') {
      throw new Error(`PaperAI browser fixture import unavailable: ${imported.capability}: ${imported.detail}`)
    }
    const overview = await scaffold.ctx.paperaiWorkbench.overview({ workspaceId })
    const documentRow = overview.documents[0]
    if (documentRow === undefined) throw new Error('PaperAI browser fixture has no tracked document')
    resourceId = documentRow.id

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
    const initialNode = initial.document.nodes.find(node => node.editable)
    if (initialNode === undefined) throw new Error('PaperAI browser fixture has no node to normalize')
    await scaffold.ctx.paperaiWorkbench.commit({
      sessionId: normalizationSessionId,
      documentId: initial.document.documentId,
      baseRevision: initial.document.revision,
      baseCommitId: initial.document.headCommitId,
      mutations: [{
        type: 'replace-text',
        nodeId: initialNode.nodeId,
        baseText: initialNode.text,
        nextText: 'Initial browser paragraph — normalized',
      }],
    }).catch(reportDocumentSetupFailure)

    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await page.getByRole('treeitem', { name: /Paper project/ }).click()
    await page.getByRole('treeitem', { name: '新会话', exact: true }).click()
    const open = sidebarDocument('Browser conflict proposal.docx')
    await open.waitFor({ timeout: 15_000 })
    await open.click()
    await page.getByRole('document', { name: '文档预览' }).filter({ visible: true }).waitFor({ timeout: 30_000 })
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    if (acpFixtureRoot !== undefined) await rm(acpFixtureRoot, { recursive: true, force: true })
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
    await expect.poll(() => scaffold.ctx.settings.describe().find(entry => entry.ns === 'paperai-acp-agents')?.user)
      .toEqual({ providers: { codex: { apiKey: 'browser-old-codex' }, claude: { apiKey: 'browser-old-claude' } } })
    await expectAgentHidden()
    await page.getByRole('toolbar', { name: '文档编辑工具栏', exact: true }).waitFor()
    await page.getByRole('button', { name: '显示 Agent 协作', exact: true }).click()
    await expectAgentVisible()
    const trigger = page.getByRole('button', { name: 'Codex' }).first()
    await trigger.waitFor({ timeout: 10_000 })
    await trigger.click()
    const menu = page.getByRole('menu')
    await menu.waitFor({ timeout: 10_000 })
    expect(await menu.getByRole('menuitem').allTextContents()).toHaveLength(2)
    await compareOrRefreshGolden(AGENT_PRESETS_EXPECTED, await menu.ariaSnapshot(), MODE)
    await page.keyboard.press('Escape')
  }, 60_000)

  it('keeps drafting during initialization and honors the latest Agent pick', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-paperai-pending-agent'))
    await writeFile(startupGatePath, 'hold startup', 'utf8')
    try {
      await page.getByRole('button', { name: 'Codex', exact: true }).first().click()
      await page.getByRole('menuitem', { name: /^Claude/ }).click()
      const pending = page.locator('button[aria-busy="true"]').filter({ hasText: 'Claude' })
      await pending.waitFor({ timeout: 15_000 })
      const input = page.locator('textarea:enabled').last()
      await input.fill('连接期间继续写作')
      expect(await page.getByRole('button', { name: '发送消息', exact: true }).isEnabled()).toBe(false)
      await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'agent-connecting.expected.md'), await pending.ariaSnapshot(), MODE)
      await pending.click()
      await page.getByRole('menuitem', { name: /^Codex/ }).click()
      expect(await page.getByRole('button', { name: 'Codex', exact: true }).first().isEnabled()).toBe(true)
      expect(await input.inputValue()).toBe('连接期间继续写作')
    } finally {
      await rm(startupGatePath, { force: true })
    }
    await page.getByRole('button', { name: 'Codex', exact: true }).first().waitFor({ timeout: 20_000 })
    await expect.poll(() => page.getByRole('button', { name: 'Codex', exact: true }).first().getAttribute('aria-busy')).not.toBe('true')
    const input = page.locator('textarea:enabled').last()
    expect(await input.inputValue()).toBe('连接期间继续写作')
    await input.fill('')
  }, 60_000)

  it('shows channel diagnostics separately from session usage', async () => {
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const settings = page.getByRole('dialog', { name: '设置', exact: true })
    await settings.getByRole('button', { name: 'Agent', exact: true }).click()
    const directory = settings.getByRole('region', { name: 'Agent', exact: true })
    const codex = directory.getByRole('article').filter({ has: page.getByRole('button', { name: /^Codex/ }) })
    const claude = directory.getByRole('article').filter({ has: page.getByRole('button', { name: /^Claude/ }) })
    await codex.getByText('正在使用', { exact: true }).waitFor()
    await claude.getByText('未使用', { exact: true }).waitFor()
    expect(await directory.getByRole('article').count()).toBe(2)
    expect(await directory.getByRole('combobox', { name: '默认 Agent' }).locator('option').allTextContents()).toEqual(['Codex', 'Claude'])
    expect(await codex.locator('svg[aria-hidden="true"]').count()).toBe(1)
    expect(await claude.locator('svg[aria-hidden="true"]').count()).toBe(1)
    const detectAll = directory.getByRole('button', { name: '一键检测', exact: true })
    await detectAll.click()
    await expect.poll(() => detectAll.isEnabled()).toBe(true)
    await codex.getByText('检测通过', { exact: true }).waitFor()
    await claude.getByText('检测通过', { exact: true }).waitFor()
    expect(await claude.getByText('未使用', { exact: true }).isVisible()).toBe(true)
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'acp-connection-status.expected.md'), [
      await detectAll.ariaSnapshot(),
      await codex.getByText('检测通过', { exact: true }).ariaSnapshot(),
      await codex.getByText('正在使用', { exact: true }).ariaSnapshot(),
      await claude.getByText('检测通过', { exact: true }).ariaSnapshot(),
      await claude.getByText('未使用', { exact: true }).ariaSnapshot(),
      await directory.getByRole('combobox', { name: '默认 Agent' }).ariaSnapshot(),
    ].join('\n'), MODE)
    await page.keyboard.press('Escape')
    await settings.waitFor({ state: 'hidden' })
  }, 60_000)

  it('keeps model selection usable across Claude and Codex round trips', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-paperai-provider-round-trip'))
    const model = page.locator('button[aria-label^="选择模型"]').first()
    let current = 'Codex'
    for (const [index, [provider, wanted]] of ([
      ['Claude', 'Fake Alpha'],
      ['Codex', 'Fake Beta'],
      ['Claude', 'Fake Alpha'],
      ['Codex', 'Fake Alpha'],
    ] as const).entries()) {
      const ready = Promise.withResolvers<undefined>()
      const release = Promise.withResolvers<undefined>()
      await page.route('**/api/session.models', async (route) => {
        const response = await route.fetch()
        ready.resolve(undefined)
        await release.promise
        await route.fulfill({ response })
      })
      try {
        await page.getByRole('button', { name: current, exact: true }).first().click()
        await page.getByRole('menuitem', { name: new RegExp(`^${provider}`) }).click()
        const providerChip = page.getByRole('button', { name: provider, exact: true }).first()
        await providerChip.waitFor({ timeout: 15_000 })
        await expect.poll(() => providerChip.getAttribute('aria-busy'), { timeout: 15_000 }).not.toBe('true')
        await expect.poll(() => providerChip.isEnabled(), { timeout: 15_000 }).toBe(true)
        await ready.promise
        await model.click()
        await page.getByRole('menuitem', { name: /^模型/ }).click()
        const menu = page.getByRole('menu', { name: '模型与推理等级' })
        expect(await menu.getAttribute('aria-busy')).toBe('true')
        expect(await menu.getByRole('menuitemradio').count()).toBe(0)
        expect(await model.getAttribute('aria-label')).toBe('选择模型')
        if (index === 0) await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'model-agent-loading.expected.md'), await menu.ariaSnapshot(), MODE)
        release.resolve(undefined)
        await menu.getByText(provider, { exact: true }).waitFor({ timeout: 15_000 })
        await page.getByRole('menuitemradio', { name: new RegExp(wanted) }).click()
        await expect.poll(() => model.getAttribute('aria-label'), { timeout: 10_000 }).toContain(wanted)
        await expect.poll(() => page.getByRole('menu').count(), { timeout: 10_000 }).toBe(0)
        current = provider
      } finally {
        release.resolve(undefined)
        await page.unrouteAll({ behavior: 'wait' })
      }
    }
    await model.click()
    await compareOrRefreshGolden(MODEL_MENU_EXPECTED, await page.getByRole('menu', { name: '模型与推理等级' }).ariaSnapshot(), MODE)
    await model.click()
  }, 90_000)

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
    await expect.poll(() => access.isEnabled(), { timeout: 10_000 }).toBe(true)
  }, 60_000)

  it('announces a rejected permission switch without exposing an internal error', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-paperai-permission-failure'))
    const access = page.locator('button[aria-label^="访问模式"]').first()
    const logBefore = (await readAcpLog(acpLogPath)).length
    try {
      await writeFile(rejectModePath, 'reject read-only', 'utf8')
      await access.click()
      await page.getByRole('menuitem', { name: 'Read Only' }).click()
      const alert = page.getByRole('alert')
      await alert.waitFor({ timeout: 10_000 })
      expect(await alert.textContent()).toContain('无法切换访问模式，请重试。')
      expect(await alert.textContent()).not.toContain('provider internal failure')
      expect(await access.getAttribute('aria-label')).toBe('访问模式，当前：Workspace Write')
      await compareOrRefreshGolden(PERMISSION_FAILURE_EXPECTED, await alert.ariaSnapshot(), MODE)
      const attempted = (await readAcpLog(acpLogPath)).slice(logBefore)
      expect(attempted).toContainEqual(expect.objectContaining({ event: 'set-mode-start', modeId: 'read-only' }))
      expect(attempted).not.toContainEqual(expect.objectContaining({ event: 'set-mode', modeId: 'read-only' }))
      expect(await page.locator('body').innerText()).not.toContain('scripted ACP set-mode rejection')
      expect(await page.locator('body').innerText()).not.toContain('Internal error')
    } finally {
      await rm(rejectModePath, { force: true })
    }
    await expect.poll(() => access.isEnabled(), { timeout: 10_000 }).toBe(true)
  }, 60_000)

  it('keeps the provider final tool result visible when a running turn is cancelled', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-paperai-cancel-final-tool'))
    const composer = page.locator('textarea:enabled').last()
    await expect.poll(() => composer.inputValue(), { timeout: 10_000 }).toBe('')
    await composer.fill('请编辑论文引言，然后等待我停止。')
    const send = page.getByRole('button', { name: '发送消息', exact: true })
    await expect.poll(() => send.isEnabled(), { timeout: 10_000 }).toBe(true)
    const eventStart = sessionEvents.length
    const settled = scaffold.whenTurnSettled(60_000)
    await send.click()
    await expect.poll(() => composer.inputValue(), { timeout: 15_000 }).toBe('')
    await expect.poll(async () => (
      (await readAcpLog(acpLogPath)).some(entry => entry.event === 'cancel-tool-start')
    ), { timeout: 15_000 }).toBe(true)
    await expect.poll(() => {
      const turnEvents = sessionEvents.slice(eventStart).map(event => event.type)
      return turnEvents.includes('user/message') && turnEvents.includes('turn/start')
    }, { timeout: 15_000 }).toBe(true)
    await page.getByRole('button', { name: '停止生成' }).click()
    await settled
    await expect.poll(async () => (
      (await readAcpLog(acpLogPath)).some(entry => entry.event === 'cancel-tool-finished')
    ), { timeout: 10_000 }).toBe(true)
    const finalTool = page.locator('[data-tool="paperai_acp_tool"]')
    await finalTool.waitFor({ timeout: 15_000 })
    await finalTool.locator('[data-disclosure-row]').click()
    await finalTool.getByText('{"changedParagraphs":1}', { exact: true }).waitFor({ timeout: 10_000 })
    const toolRow = page.locator('[data-chat-call-id="cancel-edit"]')
    const image = toolRow.getByRole('img', { name: '图片', exact: true })
    await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth), { timeout: 10_000 }).toBe(1)
    const snapshot = await captureStableAria(page, '[data-chat-call-id="cancel-edit"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(CANCEL_FINAL_TOOL_EXPECTED, snapshot, MODE)
  }, 60_000)

  it('does not start provider work when cancellation wins before prompt dispatch', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-paperai-cancel-before-prompt'))
    const text = '这条消息在发送给提供方之前取消。'
    const composer = page.locator('textarea:enabled').last()
    await composer.fill(text)
    const send = page.getByRole('button', { name: '发送消息', exact: true })
    await expect.poll(() => send.isEnabled(), { timeout: 10_000 }).toBe(true)
    const logStart = (await readAcpLog(acpLogPath)).length
    const eventStart = sessionEvents.length
    let armed = true
    let cancelTurn: (() => void) | undefined
    scaffold.ctx.on('session/event', (session, event) => {
      if (!armed || event.type !== 'request/context') return
      const agent = scaffold.ctx.agents.get(session.id)
      if (agent === undefined || agent.options.provider !== 'codex') return
      armed = false
      cancelTurn = () => { agent.cancel({ kind: 'user' }) }
      queueMicrotask(() => { cancelTurn?.() })
    })
    const settled = scaffold.whenTurnSettled(60_000)
    await send.click()
    await expect.poll(() => composer.inputValue(), { timeout: 15_000 }).toBe('')
    await expect.poll(async () => {
      const attempted = (await readAcpLog(acpLogPath)).slice(logStart)
      return attempted.some(entry => entry.event === 'prompt')
        || sessionEvents.slice(eventStart).some(event => event.type === 'turn/end')
    }, { timeout: 15_000 }).toBe(true)
    expect(armed).toBe(false)
    expect(cancelTurn).toBeTypeOf('function')
    const prematurePrompt = (await readAcpLog(acpLogPath))
      .slice(logStart)
      .some(entry => entry.event === 'prompt')
    if (prematurePrompt) {
      await expect.poll(async () => {
        const attempted = (await readAcpLog(acpLogPath)).slice(logStart)
        return attempted.some(entry => entry.event === 'cancel-tool-start')
          || sessionEvents.slice(eventStart).some(event => event.type === 'turn/end')
      }, { timeout: 15_000 }).toBe(true)
      cancelTurn?.()
    }
    await settled

    const attempted = (await readAcpLog(acpLogPath)).slice(logStart)
    expect(attempted).not.toContainEqual(expect.objectContaining({ event: 'prompt' }))
    await expect.poll(() => composer.isEnabled(), { timeout: 10_000 }).toBe(true)
    const userRowSelector = `div[data-time-hover-root]:has-text("${text}")`
    await page.locator(userRowSelector).first().waitFor({ timeout: 10_000 })
    const snapshot = await captureStableAria(page, userRowSelector, scaffold.workspaceCwd)
    await compareOrRefreshGolden(CANCEL_BEFORE_PROMPT_EXPECTED, snapshot, MODE)
  }, 60_000)

  it('selects the provider reasoning effort and fast mode from the model menu', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-paperai-model-effort'))
    const model = page.locator('button[aria-label^="选择模型"]').first()
    await model.waitFor({ timeout: 10_000 })
    expect(await model.getAttribute('aria-label')).toBe('选择模型，当前 Fake Alpha，推理等级 Medium')
    const logBefore = (await readAcpLog(acpLogPath)).length

    await model.click()
    const menu = page.getByRole('menu', { name: '模型与推理等级' })
    await menu.waitFor({ timeout: 10_000 })
    await compareOrRefreshGolden(MODEL_MENU_EXPECTED, await menu.ariaSnapshot(), MODE)
    await page.getByRole('menuitem', { name: /^推理等级/ }).click()
    await page.getByRole('menuitemradio', { name: /High/ }).click()
    await expect.poll(() => model.getAttribute('aria-label'), { timeout: 10_000 })
      .toBe('选择模型，当前 Fake Alpha，推理等级 High')

    await model.click()
    const fast = page.getByRole('menuitemcheckbox', { name: /Fast mode/ })
    await fast.waitFor({ timeout: 10_000 })
    expect(await fast.getAttribute('aria-checked')).toBe('false')
    await fast.click()
    await expect.poll(() => fast.getAttribute('aria-checked'), { timeout: 10_000 }).toBe('true')
    await expect.poll(() => model.textContent(), { timeout: 10_000 }).toContain('Fast mode')
    // The menu stays open after a flip so the row reads back in place; the
    // trigger toggles it closed (a mouse click keeps keyboard focus in the
    // composer, so Escape is the keyboard path, covered by the unit tests).
    await model.click()
    await expect.poll(() => page.getByRole('menu').count(), { timeout: 10_000 }).toBe(0)

    const applied = (await readAcpLog(acpLogPath)).slice(logBefore)
      .filter(entry => entry.event === 'set-config-option')
    expect(applied).toEqual([
      expect.objectContaining({ configId: 'effort', value: 'high' }),
      expect.objectContaining({ configId: 'fast', value: true }),
    ])
  }, 60_000)

  it('localizes a rejected provider model switch without exposing its diagnostic', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-paperai-model-failure'))
    const model = page.locator('button[aria-label^="选择模型"]').first()
    await model.waitFor({ timeout: 10_000 })
    try {
      await writeFile(rejectModelPath, 'reject model switch', 'utf8')
      await model.click()
      await page.getByRole('menuitem', { name: /^模型/ }).click()
      await page.getByRole('menuitemradio', { name: /Fake Beta/ }).click()
      const alert = page.getByRole('alert').filter({ hasText: '未能切换模型，请重试。' })
      await alert.waitFor({ timeout: 10_000 })
      expect(await model.getAttribute('aria-label')).toContain('Fake Alpha')
      await compareOrRefreshGolden(MODEL_FAILURE_EXPECTED, await alert.ariaSnapshot(), MODE)
      expect(await page.locator('body').innerText()).not.toContain('scripted ACP set-config rejection')
      expect(await page.locator('body').innerText()).not.toContain('Internal error')
    } finally {
      await rm(rejectModelPath, { force: true })
      await page.keyboard.press('Escape')
    }
  }, 60_000)

  it('keeps block drafts across external versions and prevents overwriting a changed block', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-paperai-conflict'))
    await sidebarDocument('Browser conflict proposal.docx').click()
    await expect.poll(() => page.locator('[data-phase="active"]').count()).toBeGreaterThan(0)
    const preview = page.getByRole('document', { name: '文档预览' }).filter({ visible: true })
    await retype(preview.locator('[data-paperai-block]', { hasText: 'Initial browser paragraph — normalized' }).first(), '浏览器中的本地草稿')
    const changed = preview.locator('[data-paperai-changed]')
    await expect.poll(() => pending().getByRole('button', { name: '保存', exact: true }).isEnabled()).toBe(true)
    await sidebarDocument('Browser conflict proposal.docx').click()
    expect(await changed.textContent()).toBe('浏览器中的本地草稿')

    const externalSessionId = SessionId('paperai-browser-external-writer')
    const before = await scaffold.ctx.paperaiWorkbench.open({ workspaceId, sessionId: externalSessionId, resourceId })
    const target = before.document.nodes.find(node => node.editable && node.text === 'Initial browser paragraph — normalized')
    const other = before.document.nodes.find(node => node.editable && node.text === 'Second paragraph')
    if (target === undefined || other === undefined) throw new Error('PaperAI browser fixture lost its paragraphs')

    // A version on another block: the banner offers the refresh and the draft survives it.
    await scaffold.ctx.paperaiWorkbench.commit({
      sessionId: externalSessionId,
      documentId: before.document.documentId,
      baseRevision: before.document.revision,
      baseCommitId: before.document.headCommitId,
      mutations: [{
        type: 'replace-text',
        nodeId: other.nodeId,
        baseText: other.text,
        nextText: 'Second paragraph — unrelated external update',
      }],
    })
    const banner = page.getByRole('status').filter({ hasText: '发现文档新版本' })
    await banner.waitFor({ timeout: 10_000 })
    await compareOrRefreshGolden(EXTERNAL_UPDATE_EXPECTED, await banner.ariaSnapshot(), MODE)
    await banner.getByRole('button', { name: '刷新' }).click()
    await expect.poll(() => banner.count(), { timeout: 30_000 }).toBe(0)
    await preview.getByText('Second paragraph — unrelated external update').waitFor({ timeout: 10_000 })
    expect(await changed.textContent()).toBe('浏览器中的本地草稿')
    const snapshot = await captureStableAria(page, '[data-paperai-pending]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(BLOCK_EDITOR_EXPECTED, snapshot, MODE)

    // A version on the edited block retains the draft but prevents an automatic overwrite.
    const latest = await scaffold.ctx.paperaiWorkbench.open({ workspaceId, sessionId: externalSessionId, resourceId })
    await scaffold.ctx.paperaiWorkbench.commit({
      sessionId: externalSessionId,
      documentId: latest.document.documentId,
      baseRevision: latest.document.revision,
      baseCommitId: latest.document.headCommitId,
      mutations: [{
        type: 'replace-text',
        nodeId: target.nodeId,
        baseText: target.text,
        nextText: 'Initial browser paragraph — 外部会话写入的最新文本',
      }],
    })
    await banner.waitFor({ timeout: 10_000 })
    await banner.getByRole('button', { name: '刷新' }).click()
    await expect.poll(() => banner.count(), { timeout: 30_000 }).toBe(0)
    await page.getByRole('alert').filter({ hasText: '草稿已保留' }).waitFor({ timeout: 30_000 })
    expect(await changed.textContent()).toBe('浏览器中的本地草稿')
    expect(await changed.getAttribute('data-paperai-conflicted')).not.toBeNull()
    expect(await pending().getByRole('button', { name: '保存', exact: true }).isEnabled()).toBe(false)
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'block-conflict.expected.md'),
      await captureStableAria(page, '[data-paperai-pending]', scaffold.workspaceCwd), MODE)
    await pending().getByRole('button', { name: '放弃修改', exact: true }).click()
    await expect.poll(() => pending().count()).toBe(0)
    await preview.getByText('Initial browser paragraph — 外部会话写入的最新文本').waitFor({ timeout: 10_000 })
    expect(await page.locator('body').innerText()).not.toContain('local draft dropped')

    // Retyping the refreshed block saves one version on top of the external one; the mark leaves with the save.
    await retype(preview.locator('[data-paperai-block]', { hasText: '外部会话写入的最新文本' }).first(), '浏览器合并后的最终文本')
    const savedBlock = preview.locator('[data-paperai-block]:not([data-paperai-changed])', { hasText: '浏览器合并后的最终文本' })
    expect(await savedBlock.count()).toBe(0)
    await pending().getByRole('button', { name: '保存', exact: true }).click()
    await savedBlock.waitFor({ timeout: 30_000 })
    await expect.poll(() => pending().count(), { timeout: 10_000 }).toBe(0)
    const committed = await scaffold.ctx.paperaiWorkbench.open({ workspaceId, sessionId: externalSessionId, resourceId })
    expect(committed.document.nodes.find(node => node.nodeId === target.nodeId)?.text).toBe('浏览器合并后的最终文本')
  }, 120_000)

  it('retains a Word preview, scroll position, and draft while navigating documents', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-paperai-preview-retention'))
    const imported = await scaffold.ctx.paperaiWorkbench.importDocument({
      workspaceId, sessionId: SessionId('paperai-cache-import'), fileName: 'second.docx',
      contentBase64: fixtureDocxBase64(), name: 'Second proposal',
    })
    expect(imported.status).toBe('imported')
    const preview = page.getByRole('document', { name: '文档预览' }).filter({ visible: true })
    await page.getByRole('combobox', { name: '缩放', exact: true }).selectOption('100')
    const original = await preview.elementHandle()
    if (original === null) throw new Error('document preview missing')
    await retype(preview.locator('[data-paperai-block]', { hasText: '浏览器合并后的最终文本' }), '切换文档保留的草稿')
    await preview.evaluate((element) => { element.scrollTop = 120 })
    await expect.poll(() => preview.evaluate(element => element.scrollTop)).toBe(120)
    await sidebarDocument('Second proposal.docx').click()
    await preview.getByText('Initial browser paragraph', { exact: true }).waitFor({ timeout: 20_000 })
    expect(await original.evaluate(element => element.isConnected)).toBe(true)
    await sidebarDocument('Browser conflict proposal.docx').click()
    await expect.poll(() => preview.locator('[data-paperai-changed]').textContent()).toBe('切换文档保留的草稿')
    await expect.poll(() => preview.evaluate(element => element.scrollTop)).toBe(120)
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'retained-draft.expected.md'),
      await captureStableAria(page, '[data-paperai-pending]', scaffold.workspaceCwd), MODE)
    await pending().getByRole('button', { name: '放弃修改', exact: true }).click()
    await page.getByRole('combobox', { name: '缩放', exact: true }).selectOption('fit')
    await original.dispose()
  }, 90_000)

  it('quotes exact Word text into a logged message, keeps source metadata out of the session title, and reveals the Agent at narrow widths', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-paperai-selection'))
    await page.getByRole('button', { name: '在“Paper project”中新建会话', exact: true }).click()
    await page.getByRole('button', { name: 'Codex', exact: true }).first().click()
    await page.getByRole('menuitem', { name: /^Claude/ }).click()
    await page.getByRole('button', { name: 'Claude', exact: true }).first().waitFor({ timeout: 20_000 })
    await expect.poll(() => page.getByRole('button', { name: 'Claude', exact: true }).first().getAttribute('aria-busy')).not.toBe('true')
    await sidebarDocument('Browser conflict proposal.docx').click()
    const preview = page.getByRole('document', { name: '文档预览' }).filter({ visible: true })
    await preview.waitFor({ timeout: 15_000 })
    expect(await page.locator('[data-paperai-start="project"]').count()).toBe(0)
    const frame = page.locator('[data-details-position="start"]')
    expect(await frame.count()).toBe(1)
    await page.setViewportSize({ width: 760, height: 900 })
    const block = preview.locator('[data-paperai-block]', { hasText: '浏览器合并后的最终文本' }).first()
    await block.evaluate((element) => {
      const range = document.createRange()
      range.selectNodeContents(element)
      const selection = window.getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      element.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', bubbles: true }))
    })
    const selection = page.getByRole('toolbar', { name: '文档编辑工具栏', exact: true })
      .getByRole('button', { name: '交给 Agent', exact: true })
    await expect.poll(() => selection.isEnabled(), { timeout: 10_000 }).toBe(true)
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'word-selection.expected.md'), await selection.ariaSnapshot(), MODE)
    await selection.click()
    const composer = page.locator('textarea:enabled').last()
    await expect.poll(() => composer.isVisible()).toBe(true)
    expect(await composer.inputValue()).toContain('浏览器合并后的最终文本')
    const eventStart = sessionEvents.length
    const settled = scaffold.whenTurnSettled(60_000)
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    await settled
    const message = sessionEvents.slice(eventStart).find(event => event.type === 'user/message')
    expect(JSON.stringify(message?.data)).toContain('[Word selection]')
    expect(JSON.stringify(message?.data)).toContain('浏览器合并后的最终文本')
    expect(JSON.stringify(message?.data)).toContain('version')
    await page.setViewportSize({ width: 1680, height: 1000 })
    await expect.poll(async () => (await preview.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(480)
    await expect.poll(async () => (await page.locator('[class*=sidebarCol]').boundingBox())?.width ?? 0).toBe(280)
    await expect.poll(async () => (await page.locator('[class*=detailsCol]').boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(480)
    const quotedMessage = page.locator('[data-word-selection-message]').last()
    await quotedMessage.waitFor()
    const titleEcho = (await readAcpLog(acpLogPath)).filter(entry => entry.event === 'title-echo').at(-1)?.title
    expect(titleEcho).toContain('[Word selection]')
    expect(titleEcho).toContain('"document"')
    const sessions = page.getByRole('tree', { name: '项目会话', exact: true })
    const sessionTitle = sessions.getByText('Browser conflict proposal', { exact: true })
    await sessionTitle.waitFor({ timeout: 10_000 })
    expect(await sessions.innerText()).not.toContain('[Word selection]')
    expect(await sessions.innerText()).not.toContain('"revision"')
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'word-selection-session-title.expected.md'), await sessionTitle.ariaSnapshot(), MODE)
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'word-selection-message.expected.md'), await quotedMessage.ariaSnapshot(), MODE)
    await page.screenshot({ path: join(process.cwd(), '.artifacts', 'paperai-agentero-workbench.png') })
  }, 90_000)

  it('scans without writing and restores missing working bytes only after reviewing a recovery plan', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-paperai-doctor'))
    const projection = await scaffold.ctx.paperaiWorkbench.open({ workspaceId, sessionId: SessionId('doctor-read'), resourceId })
    const path = join(scaffold.workspaceCwd, 'paper-project', projection.document.path)
    const bytes = await readFile(path)
    const head = projection.document.headCommitId
    // The document engine keeps the file resident for a moment after reading it; an outside delete waits that out.
    await expect.poll(() => rm(path).then(() => true, (error: unknown) => (
      typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT'
    )), { timeout: 15_000 }).toBe(true)
    await page.getByRole('button', { name: '项目体检', exact: true }).click()
    const report = page.getByRole('region', { name: '项目体检', exact: true })
    await report.getByText('工作文件丢失', { exact: true }).waitFor({ timeout: 20_000 })
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'project-doctor.expected.md'),
      await captureStableAria(page, '[aria-label="项目体检"]', scaffold.workspaceCwd), MODE)
    await report.getByRole('button', { name: /^查看恢复方案/ }).click()
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
    await report.getByRole('button', { name: '恢复缺失文件', exact: true }).click()
    await report.getByText('文档文件与版本快照完整。', { exact: true }).waitFor({ timeout: 20_000 })
    expect(await readFile(path)).toEqual(bytes)
    const restored = await scaffold.ctx.paperaiWorkbench.open({ workspaceId, sessionId: SessionId('doctor-read'), resourceId })
    expect(restored.document.headCommitId).toBe(head)
    await page.getByRole('button', { name: '项目体检', exact: true }).click()
  }, 90_000)

  it('preserves a newly typed draft when a real Word import response arrives', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-paperai-import-draft'))
    await page.getByRole('button', { name: '关闭文档', exact: true }).click()
    await page.getByRole('button', { name: '在“Paper project”中新建会话', exact: true }).click()
    await page.locator('[data-paperai-start="project"]').waitFor({ timeout: 20_000 })
    await sidebarDocument('Browser conflict proposal.docx').click()
    const preview = page.getByRole('document', { name: '文档预览', exact: true }).filter({ visible: true })
    await preview.locator('[data-paperai-block]').first().waitFor({ timeout: 20_000 })
    await page.getByRole('button', { name: '关闭文档', exact: true }).click()
    await page.locator('[data-paperai-start="project"]').waitFor({ timeout: 20_000 })
    const ready = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const pattern = '**/api/paperaiWorkbench/importDocument'
    await page.route(pattern, async (route) => {
      const response = await route.fetch()
      ready.resolve(undefined)
      await release.promise
      await route.fulfill({ response })
    })
    try {
      const choosing = page.waitForEvent('filechooser')
      await page.getByRole('button', { name: '新建或导入文档' }).click()
      await page.getByRole('menuitem', { name: '导入 Word，自由写', exact: true }).click()
      await (await choosing).setFiles({
        name: 'Review figures.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        buffer: Buffer.from(fixtureDocxBase64(true), 'base64'),
      })
      await ready.promise
      await retype(preview.locator('[data-paperai-block][contenteditable="true"]').first(), '导入期间新写的草稿')
      release.resolve(undefined)
      await sidebarDocument('Review figures.docx').waitFor({ timeout: 20_000 })
      expect(await preview.locator('[data-paperai-changed]').textContent()).toBe('导入期间新写的草稿')
      await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'import-draft.expected.md'),
        await captureStableAria(page, '[data-paperai-pending]', scaffold.workspaceCwd), MODE)
      await pending().getByRole('button', { name: '放弃修改', exact: true }).click()
    } finally {
      release.resolve(undefined)
      await page.unrouteAll({ behavior: 'wait' })
    }
  }, 120_000)

  it('loads embedded figures and edits body text without retargeting a matching table cell', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-paperai-table-figure'))
    await sidebarDocument('Review figures.docx').click()
    const preview = page.getByRole('document', { name: '文档预览', exact: true }).filter({ visible: true })
    const figure = preview.locator('img')
    await figure.waitFor({ timeout: 20_000 })
    expect(await figure.count()).toBe(1)
    await expect.poll(() => figure.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(1)
    const overview = await scaffold.ctx.paperaiWorkbench.overview({ workspaceId })
    const row = overview.documents.find(document => document.fileName === 'Review figures.docx')!
    const before = await scaffold.ctx.paperaiWorkbench.open({ workspaceId, sessionId: SessionId('review-read'), resourceId: row.id })
    const cell = before.document.nodes.find(node => node.kind === 'table-cell' && node.text === 'Repeated passage' && node.editable)
    const cellBlock = preview.locator('td').getByText('Repeated passage', { exact: true })
    expect(await cellBlock.evaluate(element => (element as HTMLElement).isContentEditable)).toBe(cell !== undefined)
    const body = preview.locator('p[data-paperai-block]:not(table p)', { hasText: /^Repeated passage$/u })
    expect(await body.count()).toBe(1)
    await retype(body, 'Only the body paragraph changed')
    await pending().getByRole('button', { name: '保存', exact: true }).click()
    await preview.locator('[data-paperai-block]:not([data-paperai-changed])', { hasText: 'Only the body paragraph changed' })
      .waitFor({ timeout: 30_000 })
    await expect.poll(() => pending().count()).toBe(0)
    expect(await preview.locator('td').innerText()).toBe('Repeated passage')
    await expect.poll(() => figure.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(1)
    const after = await scaffold.ctx.paperaiWorkbench.open({ workspaceId, sessionId: SessionId('review-read'), resourceId: row.id })
    expect(after.document.nodes.filter(node => node.kind === 'table-cell').map(node => node.text))
      .toEqual(before.document.nodes.filter(node => node.kind === 'table-cell').map(node => node.text))
    expect(after.document.nodes.find(node => node.kind === 'paragraph' && node.text === 'Only the body paragraph changed')).toBeDefined()
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'table-figure.expected.md'), await preview.ariaSnapshot(), MODE)
  }, 90_000)

  it('keeps headers and footers read-only when body paragraphs have the same text', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-paperai-header-footer'))
    const preview = page.getByRole('document', { name: '文档预览', exact: true }).filter({ visible: true })
    for (const band of ['doc-header', 'doc-footer']) {
      expect(await preview.locator(`.${band} p`).evaluate(element => (element as HTMLElement).isContentEditable)).toBe(false)
    }
    const body = preview.locator('.page-body p[data-path="/body/p[1]"]')
    expect(await body.textContent()).toBe(await preview.locator('.doc-header p').textContent())
    await retype(body, 'Body edited; header unchanged')
    await pending().getByRole('button', { name: '保存', exact: true }).click()
    await preview.locator('[data-paperai-block]:not([data-paperai-changed])', { hasText: 'Body edited; header unchanged' })
      .waitFor({ timeout: 30_000 })
    await expect.poll(() => pending().count()).toBe(0)
    expect(await preview.locator('.doc-header p').textContent()).toBe('Initial browser paragraph')
    expect(await preview.locator('.doc-footer p').textContent()).toBe('Second paragraph')
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'header-footer.expected.md'), await preview.ariaSnapshot(), MODE)
  }, 90_000)

  it('carries bold and a font size from the page into the saved document', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-paperai-formatting'))
    const preview = page.getByRole('document', { name: '文档预览', exact: true }).filter({ visible: true })
    const body = preview.locator('.page-body p[data-path="/body/p[1]"]')
    await selectBlockText(body)
    const toolbar = page.getByRole('toolbar', { name: '文档编辑工具栏', exact: true })
    await toolbar.getByRole('button', { name: '加粗', exact: true }).click()
    await toolbar.getByRole('combobox', { name: '字号（磅）', exact: true }).selectOption('16pt')
    await pending().getByRole('button', { name: '保存', exact: true }).click()
    await expect.poll(() => pending().count(), { timeout: 30_000 }).toBe(0)
    // The Host re-renders the preview from the DOCX, so its spans are the run properties Word now stores.
    await expect.poll(() => body.locator('span').first().getAttribute('style'), { timeout: 30_000 })
      .toMatch(/font-weight:\s*bold/u)
    expect(await body.locator('span').first().getAttribute('style')).toMatch(/font-size:\s*16pt/u)
    expect(await body.textContent()).toBe('Body edited; header unchanged')
  }, 90_000)

  it('separates recorded formatting operations from text comparison and confirms a restore before writing', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-paperai-versions'))
    const overview = await scaffold.ctx.paperaiWorkbench.overview({ workspaceId })
    const row = overview.documents.find(document => document.fileName === 'Review figures.docx')!
    const read = () => scaffold.ctx.paperaiWorkbench.open({ workspaceId, sessionId: SessionId('versions-read'), resourceId: row.id })
    const before = await read()
    await page.locator('[data-paperai-toolbar] button[data-kind="versions"]').click()
    const versions = page.getByRole('complementary', { name: '版本', exact: true })
    await versions.locator('ol > li button').first().click()
    const formatting = versions.getByText('此版本记录了 1 项格式操作；具体格式差异暂不展示。', { exact: true })
    await formatting.waitFor({ timeout: 20_000 })
    expect(await page.getByRole('document', { name: '文档预览' }).filter({ visible: true }).locator('[data-paperai-change]').count()).toBe(0)
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'formatting-comparison.expected.md'), await formatting.ariaSnapshot(), MODE)
    await versions.locator('ol > li button').nth(1).click()
    await versions.getByRole('button', { name: '恢复到此版本', exact: true }).click()
    const confirm = versions.getByRole('button', { name: '确认恢复并创建新版本', exact: true })
    await confirm.waitFor()
    expect((await read()).document.headCommitId).toBe(before.document.headCommitId)
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'restore-confirmation.expected.md'), [
      await confirm.ariaSnapshot(),
      await versions.getByRole('button', { name: '保留当前版本', exact: true }).ariaSnapshot(),
    ].join('\n'), MODE)
    await versions.getByRole('button', { name: '保留当前版本', exact: true }).click()
    expect(await confirm.count()).toBe(0)
    expect((await read()).document.headCommitId).toBe(before.document.headCommitId)
    await versions.getByRole('button', { name: '恢复到此版本', exact: true }).click()
    await confirm.click()
    await expect.poll(async () => (await read()).document.versions.length, { timeout: 30_000 }).toBe(before.document.versions.length + 1)
    const after = await read()
    expect(after.document.headCommitId).not.toBe(before.document.headCommitId)
    expect(after.document.nodes.map(node => node.text)).toEqual(before.document.nodes.map(node => node.text))
    await versions.getByRole('button', { name: '关闭面板', exact: true }).click()
    const body = page.getByRole('document', { name: '文档预览' }).filter({ visible: true }).locator('.page-body p').first()
    expect(await body.innerText()).toBe('Body edited; header unchanged')
    expect(`${await body.getAttribute('style') ?? ''} ${await body.innerHTML()}`).not.toMatch(/font-size:\s*16pt/u)
  }, 120_000)

  it('saves Enter, multiline paste, soft breaks, multi-block formatting and paragraph layout through OfficeCLI', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-paperai-paragraph-editing'))
    const imported = await scaffold.ctx.paperaiWorkbench.importDocument({
      workspaceId, sessionId: SessionId('paragraph-edit-import'), fileName: 'Paragraph editing.docx',
      contentBase64: fixtureDocxBase64(), name: 'Paragraph editing',
    })
    expect(imported.status).toBe('imported')
    await sidebarDocument('Paragraph editing.docx').click()
    const preview = page.getByRole('document', { name: '文档预览', exact: true }).filter({ visible: true })
    const blocks = preview.locator('[data-paperai-block][contenteditable="true"]').filter({ visible: true })
    const toolbar = page.getByRole('toolbar', { name: '文档编辑工具栏', exact: true })
    await expect.poll(() => blocks.first().textContent(), { timeout: 20_000 }).toBe('Initial browser paragraph')
    await retype(blocks.first(), '第一段')
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    await page.keyboard.insertText('新增段落')
    expect(await blocks.first().locator('[data-paperai-paragraph]').count()).toBe(2)
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    await page.evaluate(text => navigator.clipboard.writeText(text), '\n多行粘贴')
    await page.keyboard.press('Control+V')
    await expect.poll(() => blocks.first().locator('[data-paperai-paragraph]').count()).toBe(3)
    await toolbar.getByRole('button', { name: '撤销草稿修改', exact: true }).click()
    expect(await blocks.first().locator('[data-paperai-paragraph]').count()).toBe(2)
    await toolbar.getByRole('button', { name: '重做草稿修改', exact: true }).click()
    expect(await blocks.first().locator('[data-paperai-paragraph]').count()).toBe(3)
    await page.keyboard.press('Shift+Enter')
    await page.keyboard.insertText('软换行')
    await retype(blocks.nth(1), '尾段已修改')
    const beforeCrossBlockDelete = await blocks.allTextContents()
    await blocks.first().click()
    await page.keyboard.press('Control+A')
    expect(await page.evaluate(() => window.getSelection()?.toString())).toContain('尾段已修改')
    await page.keyboard.press('Backspace')
    expect(await blocks.allTextContents()).toEqual(beforeCrossBlockDelete)
    await blocks.first().evaluate((first) => {
      const last = first.parentElement!.querySelectorAll('[data-paperai-block][contenteditable="true"]')[1]!
      const range = document.createRange()
      range.setStart(first, 0)
      range.setEnd(last, last.childNodes.length)
      const selection = window.getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      first.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', bubbles: true }))
    })
    await toolbar.getByRole('button', { name: '加粗', exact: true }).click()
    await toolbar.getByRole('combobox', { name: '字体', exact: true }).selectOption('Arial')
    await toolbar.getByRole('combobox', { name: '字号（磅）', exact: true }).selectOption('14pt')
    await toolbar.getByRole('button', { name: '段落', exact: true }).click()
    await toolbar.getByLabel('段落对齐', { exact: true }).selectOption('center')
    await toolbar.getByLabel('左缩进（磅）', { exact: true }).fill('24')
    await toolbar.getByLabel('行距', { exact: true }).selectOption('1.5x')
    expect(await preview.locator('[data-paperai-changed]').count()).toBe(2)
    expect(await page.locator('[data-paperai-toolbar] button[data-kind="export"]').isEnabled()).toBe(false)
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'paragraph-draft.expected.md'),
      await captureStableAria(page, '[data-paperai-pending]', scaffold.workspaceCwd), MODE)
    await toolbar.getByRole('button', { name: '保存', exact: true }).click()
    await expect.poll(() => pending().count(), { timeout: 30_000 }).toBe(0)
    await page.getByRole('button', { name: '关闭文档', exact: true }).click()
    await sidebarDocument('Paragraph editing.docx').click()
    await expect.poll(() => blocks.count(), { timeout: 20_000 }).toBe(4)
    const overview = await scaffold.ctx.paperaiWorkbench.overview({ workspaceId })
    const row = overview.documents.find(document => document.fileName === 'Paragraph editing.docx')!
    const saved = await scaffold.ctx.paperaiWorkbench.open({ workspaceId, sessionId: SessionId('paragraph-edit-read'), resourceId: row.id })
    expect(saved.document.nodes.filter(node => node.editable).map(node => node.text))
      .toEqual(['第一段', '新增段落', '多行粘贴\v软换行', '尾段已修改'])
    const wordXml = unzipSync(await readFile(row.workingPath!))['word/document.xml']!
    const paragraphLayouts = await page.evaluate((xml) => {
      const namespace = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
      const document = new DOMParser().parseFromString(xml, 'application/xml')
      const body = document.getElementsByTagNameNS(namespace, 'body')[0]!
      return [...body.getElementsByTagNameNS(namespace, 'p')].map((paragraph) => {
        const properties = paragraph.getElementsByTagNameNS(namespace, 'pPr')[0]
        const value = (name: string, attribute: string): string | null | undefined =>
          properties?.getElementsByTagNameNS(namespace, name)[0]?.getAttributeNS(namespace, attribute)
        return { align: value('jc', 'val'), indent: value('ind', 'left'), spacing: value('spacing', 'line'), rule: value('spacing', 'lineRule') }
      })
    }, strFromU8(wordXml))
    expect(paragraphLayouts).toEqual(Array.from({ length: 4 }, () => ({ align: 'center', indent: '480', spacing: '360', rule: 'auto' })))
    for (const block of await blocks.all()) {
      expect(await block.evaluate(element => getComputedStyle(element).textAlign)).toBe('center')
      const readings = await block.evaluate((element) => {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
        const values = []
        for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
          if (node.nodeValue === '') continue
          const style = getComputedStyle(node.parentElement!)
          values.push({ font: style.fontFamily, size: parseFloat(style.fontSize), weight: style.fontWeight })
        }
        return values
      })
      expect(readings.length).toBeGreaterThan(0)
      for (const reading of readings) {
        expect(reading.font).toContain('Arial')
        expect(reading.size).toBeCloseTo(14 * 96 / 72, 2)
        expect(reading.weight).toBe('700')
      }
    }
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'paragraph-saved.expected.md'), await preview.ariaSnapshot(), MODE)
  }, 180_000)

  it('preserves Word fonts during typing and bold changes and carries the native Enter insertion style', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-paperai-format-intent'))
    const entries = unzipSync(Buffer.from(fixtureDocxBase64(), 'base64'))
    const font = '<w:rFonts w:hAnsi="宋体" w:hint="eastAsia"/>'
    const run = (text: string, bold = false): string => `<w:r><w:rPr>${font}${bold ? '<w:b/>' : ''}</w:rPr><w:t>${text}</w:t></w:r>`
    entries['[Content_Types].xml'] = strToU8(strFromU8(entries['[Content_Types].xml']!).replace('</Types>',
      '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>'))
    entries['word/_rels/document.xml.rels'] = strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
      + '</Relationships>')
    entries['word/styles.xml'] = strToU8('<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
      + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr>'
      + '<w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="宋体" w:cs="Times New Roman"/>'
      + '</w:rPr></w:style></w:styles>')
    entries['word/document.xml'] = strToU8('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
      + `<w:p>${run('层次')}${run('代号')}${run('及说明')}</w:p><w:p>${run('Bold only control')}</w:p>`
      + `<w:p>${run('Bold insertion seed', true)}</w:p><w:sectPr/></w:body></w:document>`)
    const imported = await scaffold.ctx.paperaiWorkbench.importDocument({
      workspaceId, sessionId: SessionId('format-intent-import'), fileName: 'Formatting preservation.docx',
      contentBase64: Buffer.from(zipSync(entries)).toString('base64'), name: 'Formatting preservation',
    })
    expect(imported.status).toBe('imported')
    await sidebarDocument('Formatting preservation.docx').click()
    const preview = page.getByRole('document', { name: '文档预览', exact: true }).filter({ visible: true })
    const blocks = preview.locator('[data-paperai-block][contenteditable="true"]').filter({ visible: true })
    const toolbar = page.getByRole('toolbar', { name: '文档编辑工具栏', exact: true })
    await expect.poll(() => blocks.first().textContent(), { timeout: 20_000 }).toBe('层次代号及说明')
    expect(await blocks.first().locator('span').first().evaluate(element => getComputedStyle(element).fontFamily)).toContain('Times New Roman')
    await blocks.first().locator('span').last().click()
    await page.keyboard.press('End')
    await page.keyboard.insertText('（验收）')
    await selectBlockText(blocks.nth(1))
    await toolbar.getByRole('button', { name: '加粗', exact: true }).click()
    const seedFont = await blocks.nth(2).locator('span').last().evaluate(element => getComputedStyle(element).fontFamily)
    await blocks.nth(2).locator('span').last().click()
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    await page.keyboard.insertText('Native Enter inherits formatting')
    const inserted = blocks.nth(2).locator('[data-paperai-paragraph]').nth(1)
    expect(await inserted.textContent()).toBe('Native Enter inherits formatting')
    const insertionReading = await inserted.evaluate((element) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
      const readings = []
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        if (node.nodeValue === '') continue
        const style = getComputedStyle(node.parentElement!)
        readings.push({ font: style.fontFamily, bold: style.fontWeight === '700' })
      }
      return readings
    })
    expect(insertionReading.length).toBeGreaterThan(0)
    expect(seedFont).toContain('Times New Roman')
    for (const reading of insertionReading) expect(reading).toEqual({ font: seedFont, bold: true })
    await toolbar.getByRole('button', { name: '保存', exact: true }).click()
    await expect.poll(() => pending().count(), { timeout: 30_000 }).toBe(0)
    const row = (await scaffold.ctx.paperaiWorkbench.overview({ workspaceId })).documents.find(item => item.fileName === 'Formatting preservation.docx')!
    const xml = strFromU8(unzipSync(await readFile(row.workingPath!))['word/document.xml']!)
    const paragraphs = await page.evaluate((xml) => {
      const ns = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
      const document = new DOMParser().parseFromString(xml, 'application/xml')
      return [...document.getElementsByTagNameNS(ns, 'p')].map(paragraph => [...paragraph.getElementsByTagNameNS(ns, 'r')].map((run) => {
        const props = run.getElementsByTagNameNS(ns, 'rPr')[0]!
        const font = props.getElementsByTagNameNS(ns, 'rFonts')[0]!
        const bold = props.getElementsByTagNameNS(ns, 'b')[0]
        return {
          text: [...run.getElementsByTagNameNS(ns, 't')].map(text => text.textContent).join(''),
          font: Object.fromEntries([...font.attributes].map(attribute => [attribute.localName, attribute.value])),
          size: props.getElementsByTagNameNS(ns, 'sz')[0]?.getAttributeNS(ns, 'val') ?? null,
          bold: bold !== undefined && !['0', 'false'].includes(bold.getAttributeNS(ns, 'val') ?? ''),
        }
      }))
    }, xml)
    expect(paragraphs.map(paragraph => paragraph.map(run => run.text).join(''))).toEqual([
      '层次代号及说明（验收）', 'Bold only control', 'Bold insertion seed', 'Native Enter inherits formatting',
    ])
    for (const [index, paragraph] of paragraphs.entries()) {
      for (const run of paragraph) expect(run).toMatchObject({ font: { hAnsi: '宋体', hint: 'eastAsia' }, size: null, bold: index > 0 })
      for (const run of paragraph) expect(Object.keys(run.font).sort()).toEqual(['hAnsi', 'hint'])
    }
    await page.getByRole('button', { name: '关闭文档', exact: true }).click()
    await sidebarDocument('Formatting preservation.docx').click()
    await expect.poll(() => blocks.count(), { timeout: 20_000 }).toBe(4)
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'format-intent.expected.md'), [
      await preview.ariaSnapshot(), 'Word run properties:', JSON.stringify(paragraphs, null, 2),
    ].join('\n'), MODE)
  }, 90_000)

  it('offers the document paragraph styles and saves Normal over an existing template style', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-paperai-paragraph-styles'))
    const entries = unzipSync(Buffer.from(fixtureDocxBase64(false, ['Template body paragraph']), 'base64'))
    entries['[Content_Types].xml'] = strToU8(strFromU8(entries['[Content_Types].xml']!).replace('</Types>',
      '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>'))
    entries['word/_rels/document.xml.rels'] = strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
      + '</Relationships>')
    entries['word/styles.xml'] = strToU8('<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
      + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>'
      + '<w:style w:type="paragraph" w:styleId="SchoolBody"><w:name w:val="学院正文"/><w:basedOn w:val="Normal"/></w:style>'
      + '</w:styles>')
    entries['word/document.xml'] = strToU8(strFromU8(entries['word/document.xml']!).replace('<w:p>',
      '<w:p><w:pPr><w:pStyle w:val="SchoolBody"/></w:pPr>'))
    const imported = await scaffold.ctx.paperaiWorkbench.importDocument({
      workspaceId, sessionId: SessionId('style-menu-import'), fileName: 'Template styles.docx',
      contentBase64: Buffer.from(zipSync(entries)).toString('base64'), name: 'Template styles',
    })
    expect(imported.status).toBe('imported')
    const row = (await scaffold.ctx.paperaiWorkbench.overview({ workspaceId })).documents.find(item => item.fileName === 'Template styles.docx')!
    const beforeXml = strFromU8(unzipSync(await readFile(row.workingPath!))['word/document.xml']!)
    expect(beforeXml).toContain('w:pStyle w:val="SchoolBody"')
    await sidebarDocument('Template styles.docx').click()
    const preview = page.getByRole('document', { name: '文档预览', exact: true }).filter({ visible: true })
    const paragraph = preview.locator('[data-paperai-block][contenteditable="true"]').first()
    const toolbar = page.getByRole('toolbar', { name: '文档编辑工具栏', exact: true })
    await expect.poll(() => paragraph.textContent(), { timeout: 20_000 }).toBe('Template body paragraph')
    await selectBlockText(paragraph)
    await toolbar.getByRole('button', { name: '段落', exact: true }).click()
    const styles = toolbar.getByRole('combobox', { name: '段落样式', exact: true })
    expect(await styles.locator('option').allTextContents()).toEqual(['应用样式', 'Normal', '学院正文'])
    expect(await styles.locator('option[value="Heading1"]').count()).toBe(0)
    expect(await styles.locator('option[value="SchoolBody"]').textContent()).toBe('学院正文')
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'paragraph-styles.expected.md'), await styles.ariaSnapshot(), MODE)
    await styles.selectOption('Normal')
    expect(await styles.inputValue()).toBe('Normal')
    await toolbar.getByRole('button', { name: '保存', exact: true }).click()
    await expect.poll(() => pending().count(), { timeout: 30_000 }).toBe(0)
    await page.getByRole('button', { name: '关闭文档', exact: true }).click()
    await sidebarDocument('Template styles.docx').click()
    await expect.poll(() => paragraph.textContent(), { timeout: 20_000 }).toBe('Template body paragraph')
    const saved = await scaffold.ctx.paperaiWorkbench.open({ workspaceId, sessionId: SessionId('style-menu-read'), resourceId: row.id })
    expect(saved.document.paragraphStyles).toEqual([{ id: 'Normal', name: 'Normal' }, { id: 'SchoolBody', name: '学院正文' }])
    const afterXml = strFromU8(unzipSync(await readFile(row.workingPath!))['word/document.xml']!)
    expect(afterXml).toContain('w:pStyle w:val="Normal"')
    expect(afterXml).not.toContain('w:pStyle w:val="SchoolBody"')
  }, 90_000)

  it('keeps writing controls reachable across desktop viewports, themes, locales and document zoom', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-paperai-writing-viewports'))
    const fileName = '毕业论文_公开合成长文档_方法结果与讨论_Methods_Results_Discussion_Appendix_Review_Draft_2026.docx'
    const endMarker = 'Long document end marker 080'
    const paragraphs = Array.from({ length: 80 }, (_, index) =>
      `${index === 79 ? endMarker : `Public synthetic paragraph ${String(index + 1).padStart(3, '0')}`} ${'公开合成正文，用于验证长文档的阅读、查找与视口布局。'.repeat(8)}`)
    const imported = await scaffold.ctx.paperaiWorkbench.importDocument({
      workspaceId, sessionId: SessionId('long-document-import'), fileName,
      contentBase64: fixtureDocxBase64(false, paragraphs), name: fileName.slice(0, -5),
    })
    expect(imported.status).toBe('imported')
    const row = (await scaffold.ctx.paperaiWorkbench.overview({ workspaceId })).documents.find(document => document.fileName === fileName)!
    const readback = await scaffold.ctx.paperaiWorkbench.open({ workspaceId, sessionId: SessionId('long-document-read'), resourceId: row.id })
    expect(readback.document.nodes.filter(node => node.editable).map(node => node.text)).toEqual(paragraphs)
    await sidebarDocument(fileName).click()
    const longPreview = page.getByRole('document', { name: '文档预览', exact: true }).filter({ visible: true })
    await expect.poll(() => longPreview.locator('[data-paperai-block][contenteditable="true"]').count()).toBe(80)
    expect(await longPreview.evaluate(element => element.scrollHeight / element.clientHeight)).toBeGreaterThan(3)
    expect(await sidebarDocument(fileName).getAttribute('title')).toBe(row.workingPath)
    await page.getByRole('button', { name: '查找文档', exact: true }).click()
    await page.getByRole('textbox', { name: '查找正文', exact: true }).fill(endMarker)
    await page.getByRole('button', { name: '下一个匹配', exact: true }).click()
    await expect.poll(() => longPreview.evaluate(element => element.scrollTop)).toBeGreaterThan(1_000)
    const last = longPreview.locator('[data-paperai-block]', { hasText: endMarker })
    await expect.poll(async () => {
      const outer = (await longPreview.boundingBox())!; const target = (await last.boundingBox())!
      return target.y >= outer.y && target.y < outer.y + outer.height
    }).toBe(true)
    await page.getByRole('button', { name: '查找文档', exact: true }).click()
    const readingPosition = await longPreview.evaluate(element => element.scrollTop)
    await page.locator('[data-paperai-toolbar] button[data-kind="versions"]').click()
    await page.getByRole('complementary', { name: '版本', exact: true }).getByRole('button', { name: '关闭面板', exact: true }).click()
    expect(await longPreview.evaluate(element => element.scrollTop)).toBe(readingPosition)
    const focus = page.getByRole('button', { name: '专注写作', exact: true })
    if (await focus.isVisible()) await focus.click()
    const artifactRoot = join(process.cwd(), '.playwright-mcp', 'paperai-writing-viewports')
    await mkdir(artifactRoot, { recursive: true })
    const evidence: unknown[] = []
    for (const [width, height, locale, scheme] of [
      [1366, 768, 'zh', 'light'], [1366, 768, 'zh', 'dark'],
      [1440, 900, 'en', 'light'], [1440, 900, 'en', 'dark'],
      [1920, 1080, 'zh', 'light'], [1920, 1080, 'en', 'dark'],
    ] as const) {
      await page.setViewportSize({ width, height })
      await page.emulateMedia({ colorScheme: scheme })
      await scaffold.ctx.settings.mutate(settingsNamespace('locale'), [{ op: 'set', path: ['preference'], value: locale }])
      await expect.poll(() => page.evaluate(() => document.documentElement.lang)).toBe(locale === 'zh' ? 'zh-CN' : 'en')
      await expect.poll(() => page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'))).toBe(scheme === 'dark')
      await expectAgentHidden()
      const toolbar = page.getByRole('toolbar', { name: locale === 'zh' ? '文档编辑工具栏' : 'Document editing toolbar', exact: true })
      const preview = page.getByRole('document', { name: locale === 'zh' ? '文档预览' : 'Document preview', exact: true }).filter({ visible: true })
      const status = page.locator('footer').filter({ has: page.getByRole('combobox', { name: locale === 'zh' ? '缩放' : 'Zoom', exact: true }) })
      const zoom = status.getByRole('combobox')
      await zoom.selectOption('fit')
      const geometry = async (): Promise<{ toolbar: unknown; preview: unknown; status: unknown }> => {
        await expect.poll(async () => {
          const boxes = await Promise.all([toolbar.boundingBox(), preview.boundingBox(), status.boundingBox()])
          return boxes.every(box => box !== null && box.x >= 0 && box.y >= 0
            && box.x + box.width <= width + 1 && box.y + box.height <= height + 1)
        }).toBe(true)
        const boxes = { toolbar: await toolbar.boundingBox(), preview: await preview.boundingBox(), status: await status.boundingBox() }
        for (const box of Object.values(boxes)) {
          expect(box).not.toBeNull()
          expect(box!.x).toBeGreaterThanOrEqual(0)
          expect(box!.y).toBeGreaterThanOrEqual(0)
          expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1)
          expect(box!.y + box!.height).toBeLessThanOrEqual(height + 1)
        }
        expect(boxes.preview!.width).toBeGreaterThanOrEqual(480)
        expect(boxes.preview!.height).toBeGreaterThanOrEqual(280)
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        return boxes
      }
      const fit = await geometry()
      await zoom.selectOption('100')
      const normal = await preview.locator('.page').first().boundingBox()
      await zoom.selectOption('125')
      await expect.poll(async () => ((await preview.locator('.page').first().boundingBox())?.width ?? 0) / normal!.width).toBeCloseTo(1.25, 2)
      await geometry()
      expect(await preview.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
      await page.screenshot({ path: join(artifactRoot, `${width}x${height}-${locale}-${scheme}-document-125.png`) })
      await zoom.selectOption('fit')
      await compareOrRefreshGolden(join(SNAPSHOT_DIR, `writing-controls.${locale}.expected.md`), [
        await toolbar.ariaSnapshot(), await status.ariaSnapshot(),
      ].join('\n'), MODE)
      const collaborate = page.getByRole('button', { name: locale === 'zh' ? '显示 Agent 协作' : 'Show Agent collaboration', exact: true })
      await collaborate.click()
      await expectAgentVisible()
      await page.screenshot({ path: join(artifactRoot, `${width}x${height}-${locale}-${scheme}-agent.png`) })
      await page.getByRole('button', { name: locale === 'zh' ? '专注写作' : 'Focus writing', exact: true }).click()
      await expectAgentHidden()
      await page.screenshot({ path: join(artifactRoot, `${width}x${height}-${locale}-${scheme}.png`) })
      evidence.push({ width, height, locale, scheme, documentZoom: '125% verified against 100%', fit })
    }
    await writeFile(join(artifactRoot, 'geometry.json'), `${JSON.stringify(evidence, null, 2)}\n`)
    await scaffold.ctx.settings.mutate(settingsNamespace('locale'), [{ op: 'set', path: ['preference'], value: 'zh' }])
    await page.emulateMedia({ colorScheme: 'light' })
    await page.setViewportSize({ width: 1680, height: 1000 })
    await page.getByRole('button', { name: '显示 Agent 协作', exact: true }).click()
  }, 180_000)

  it('exports the saved writing document to the displayed project path', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-paperai-draft-export'))
    await sidebarDocument('Paragraph editing.docx').click()
    await page.getByRole('document', { name: '文档预览', exact: true }).filter({ visible: true }).getByText('第一段', { exact: true }).waitFor()
    await page.locator('[data-paperai-toolbar] button[data-kind="export"]').click()
    await page.getByRole('menuitem', { name: '导出草稿', exact: true }).click()
    const receipt = page.getByRole('status').filter({ hasText: '草稿已导出' })
    await receipt.waitFor({ timeout: 30_000 })
    const outputPath = await receipt.locator('span').textContent()
    expect(outputPath).toBe(join(scaffold.workspaceCwd, 'paper-project', 'exports', 'drafts', 'Paragraph editing-草稿.docx'))
    expect((await readFile(outputPath!)).byteLength).toBeGreaterThan(0)
    const exported = await scaffold.ctx.documentEngine.readTextNodes(outputPath!)
    expect(exported.map(node => node.text)).toEqual(['第一段', '新增段落', '多行粘贴\v软换行', '尾段已修改'])
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'draft-export.expected.md'),
      await receipt.locator('strong').ariaSnapshot(), MODE)
  }, 90_000)

  it('starts from migrated credentials with optional defaults and renders throttled tool progress', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-paperai-acp-defaults'))
    const projectRoot = join(scaffold.workspaceCwd, 'acp-defaults')
    await mkdir(projectRoot)
    const streamGate = join(projectRoot, 'stream-gate')
    await writeFile(streamGate, 'hold')
    await scaffold.ctx.workspaceRegistry.create(projectRoot, 'ACP defaults')
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const settings = page.getByRole('dialog', { name: '设置', exact: true })
    await settings.getByRole('button', { name: 'Agent', exact: true }).click()
    const claude = settings.getByRole('article').filter({ has: page.getByRole('button', { name: /^Claude/ }) })
    await claude.getByRole('button', { name: '配置', exact: true }).click()
    const editor = page.getByRole('dialog', { name: '配置 ACP 渠道', exact: true })
    await editor.getByText('模型与权限', { exact: true }).click()
    await editor.getByLabel('默认模型', { exact: true }).fill('custom-browser-model')
    await editor.getByRole('textbox', { name: '默认思考强度', exact: true }).fill('retired-effort')
    await editor.getByRole('textbox', { name: '默认会话选项 · JSON 对象', exact: true }).fill('{"removed-option":true}')
    await editor.getByText('高级设置', { exact: true }).click()
    await editor.getByRole('textbox', { name: '环境变量 · JSON 对象', exact: true }).fill(JSON.stringify({
      FAKE_ACP_STREAM_TOOL: 'completed', FAKE_ACP_STREAM_UPDATES: '4', FAKE_ACP_STREAM_GATE_FILE: streamGate, FAKE_ACP_STREAM_FORMAT: 'terminal-delta',
    }))
    await editor.getByRole('button', { name: '保存配置', exact: true }).click()
    await editor.waitFor({ state: 'hidden' })
    await settings.getByRole('combobox', { name: '默认 Agent' }).selectOption('claude')
    await expect.poll(() => scaffold.ctx.settings.describe().find(entry => entry.ns === 'agent-presets')?.value)
      .toMatchObject({ default: 'claude' })
    await page.keyboard.press('Escape')
    await settings.waitFor({ state: 'hidden' })
    await page.getByRole('button', { name: '返回项目列表', exact: true }).click()
    await page.getByRole('treeitem', { name: /ACP defaults/ }).click()
    await page.getByRole('button', { name: '在“ACP defaults”中新建会话', exact: true }).click()
    await page.getByRole('button', { name: '尚未选择本项目的模板', exact: true }).click()
    await page.getByRole('button', { name: '不用模板，自由写', exact: true }).click()
    await page.getByRole('dialog', { name: '本项目用哪套模板？', exact: true }).waitFor({ state: 'hidden' })
    await page.getByRole('button', { name: 'Claude', exact: true }).first().waitFor()
    const model = page.locator('button[aria-label^="选择模型"]').first()
    await expect.poll(() => model.getAttribute('aria-label'), { timeout: 20_000 }).toContain('custom-browser-model')
    const eventStart = sessionEvents.length
    const settled = scaffold.whenTurnSettled(60_000)
    await page.locator('textarea:enabled').last().fill('显示工具运行中的输出。')
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    const tool = page.locator('[data-chat-call-id="streaming-tool"]')
    try {
      await tool.waitFor({ timeout: 15_000 })
      await tool.locator('[data-disclosure-row]').click()
      await expect.poll(() => tool.innerText(), { timeout: 10_000 }).toContain(`003 ${'x'.repeat(250)}`)
      expect(sessionEvents.slice(eventStart).some(event => event.type === 'turn/end')).toBe(false)
      await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'acp-running-output.expected.md'),
        await captureStableAria(page, '[data-chat-call-id="streaming-tool"]', scaffold.workspaceCwd), MODE)
    } finally {
      await rm(streamGate)
      await settled
    }
    await expect.poll(() => tool.innerText()).toContain('已完成')
    expect(sessionEvents.slice(eventStart).filter(event => event.type === 'tool/progress')).toHaveLength(3)
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'acp-migrated-defaults.expected.md'), [
      await model.ariaSnapshot(),
      await captureStableAria(page, '[data-chat-call-id="streaming-tool"]', scaffold.workspaceCwd),
    ].join('\n'), MODE)
  }, 90_000)

  it('keeps its snapshot inventory closed', async () => {
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, [
      'agent-presets.expected.md',
      'model-agent-loading.expected.md',
      'agent-connecting.expected.md',
      'acp-connection-status.expected.md',
      'acp-migrated-defaults.expected.md',
      'acp-running-output.expected.md',
      'block-conflict.expected.md',
      'block-editor.expected.md',
      'cancel-before-prompt.expected.md',
      'cancel-final-tool.expected.md',
      'draft-export.expected.md',
      'external-update.expected.md',
      'formatting-comparison.expected.md',
      'format-intent.expected.md',
      'header-footer.expected.md',
      'import-draft.expected.md',
      'model-failure.expected.md',
      'model-menu.expected.md',
      'permission-default.expected.md',
      'permission-failure.expected.md',
      'permission-read-only.expected.md',
      'paragraph-draft.expected.md',
      'paragraph-saved.expected.md',
      'paragraph-styles.expected.md',
      'project-doctor.expected.md',
      'retained-draft.expected.md',
      'restore-confirmation.expected.md',
      'table-figure.expected.md',
      'word-selection.expected.md',
      'word-selection-message.expected.md',
      'word-selection-session-title.expected.md',
      'writing-controls.en.expected.md',
      'writing-controls.zh.expected.md',
    ])
  })
})
