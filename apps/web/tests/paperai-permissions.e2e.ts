// PaperAI browser snapshots: the shipped product composition exposes its safe
// permission default and preserves both sides of a same-node external conflict.
import { Buffer } from 'node:buffer'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspect } from 'node:util'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
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
    scaffold = await launchWebScaffold({
      extraOverlayPath: PAPERAI_OVERLAY,
      agentPresets: {
        default: 'codex',
        roots: [
          { path: PAPERAI_PRESETS, trust: 'system' },
        ],
      },
      paperAiAcp: {
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
    }).catch(reportDocumentSetupFailure)

    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await page.getByRole('treeitem', { name: /Paper project/ }).click()
    await page.getByRole('treeitem', { name: '新会话', exact: true }).click()
    const open = page.getByRole('button', { name: '打开 Browser conflict proposal.docx' })
    await open.waitFor({ timeout: 15_000 })
    await open.click()
    await page.getByRole('document', { name: '文档预览' }).waitFor({ timeout: 30_000 })
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
    const trigger = page.getByRole('button', { name: 'Codex' }).first()
    await trigger.waitFor({ timeout: 10_000 })
    await trigger.click()
    const menu = page.getByRole('menu')
    await menu.waitFor({ timeout: 10_000 })
    expect(await menu.getByRole('menuitem').allTextContents()).toHaveLength(3)
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
      expect(await page.locator('button[aria-busy="true"]').filter({ hasText: 'Codex' }).isEnabled()).toBe(true)
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

  it('inspects cached Agent metadata and explicitly probes without submitting a prompt', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-paperai-agent-diagnostics'))
    const before = await readAcpLog(acpLogPath)
    const model = page.locator('button[aria-label^="选择模型"]').first()
    const selected = await model.getAttribute('aria-label')
    await page.getByRole('button', { name: 'Agent 状态', exact: true }).click()
    const details = page.getByRole('region', { name: 'Agent 状态', exact: true })
    await details.getByText('历史模型预览 · 连接完成后再选择', { exact: true }).waitFor()
    expect(await details.innerText()).toContain('Fake Alpha')
    await details.getByRole('button', { name: '检测 / 重试', exact: true }).click()
    await expect.poll(async () => (await readAcpLog(acpLogPath)).filter(entry => entry.event === 'initialize').length)
      .toBeGreaterThan(before.filter(entry => entry.event === 'initialize').length)
    await details.getByRole('button', { name: '检测 / 重试', exact: true }).waitFor()
    expect(await model.getAttribute('aria-label')).toBe(selected)
    expect((await readAcpLog(acpLogPath)).slice(before.length).filter(entry => entry.event === 'prompt')).toEqual([])
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'agent-diagnostics.expected.md'),
      await details.getByText('历史模型预览 · 连接完成后再选择', { exact: true }).ariaSnapshot(), MODE)
    await page.getByRole('button', { name: 'Agent 状态', exact: true }).click()
  }, 60_000)

  it('keeps model selection usable across Claude and Codex round trips', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-paperai-provider-round-trip'))
    const model = page.locator('button[aria-label^="选择模型"]').first()
    let current = 'Codex'
    for (const [provider, wanted] of [
      ['Claude', 'Fake Alpha'],
      ['Codex', 'Fake Beta'],
      ['Claude', 'Fake Alpha'],
      ['Codex', 'Fake Alpha'],
    ] as const) {
      await page.getByRole('button', { name: current, exact: true }).first().click()
      await page.getByRole('menuitem', { name: new RegExp(`^${provider}`) }).click()
      const providerChip = page.getByRole('button', { name: provider, exact: true }).first()
      await providerChip.waitFor({ timeout: 15_000 })
      await expect.poll(() => providerChip.getAttribute('aria-busy'), { timeout: 15_000 }).not.toBe('true')
      await expect.poll(() => providerChip.isEnabled(), { timeout: 15_000 }).toBe(true)
      await expect.poll(() => model.isEnabled(), { timeout: 10_000 }).toBe(true)
      await model.click()
      await page.getByRole('menuitem', { name: /^模型/ }).click()
      await page.getByRole('menuitemradio', { name: new RegExp(wanted) }).click()
      await expect.poll(() => model.getAttribute('aria-label'), { timeout: 10_000 }).toContain(wanted)
      await expect.poll(() => page.getByRole('menu').count(), { timeout: 10_000 }).toBe(0)
      current = provider
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
    const finalTool = page.locator('[data-tool="paperai.edit"]')
    await finalTool.waitFor({ timeout: 15_000 })
    await finalTool.locator('[data-disclosure-row]').click()
    await finalTool.getByText('changedParagraphs', { exact: false }).waitFor({ timeout: 10_000 })
    const snapshot = await captureStableAria(page, '[data-tool="paperai.edit"]', scaffold.workspaceCwd)
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
    await page.getByRole('button', { name: '打开 Browser conflict proposal.docx' }).click()
    await expect.poll(() => page.locator('[data-phase="active"]').count()).toBeGreaterThan(0)
    const preview = page.getByRole('document', { name: '文档预览' })
    await preview.locator('[data-paperai-block]', { hasText: 'Initial browser paragraph — normalized' }).first().click()
    const editor = page.getByRole('textbox', { name: '编辑段落' })
    await editor.waitFor({ timeout: 10_000 })
    await editor.fill('浏览器中的本地草稿')
    await expect.poll(() => page.locator('[data-paperai-block-editor]').getByRole('button', { name: '保存', exact: true }).isEnabled()).toBe(true)
    await page.getByRole('button', { name: '打开 Browser conflict proposal.docx' }).click()
    expect(await editor.inputValue()).toBe('浏览器中的本地草稿')

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
    expect(await editor.inputValue()).toBe('浏览器中的本地草稿')
    const snapshot = await captureStableAria(page, '[data-paperai-block-editor]', scaffold.workspaceCwd)
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
    await page.getByRole('alert').filter({ hasText: '草稿已保留' }).waitFor({ timeout: 30_000 })
    expect(await editor.inputValue()).toBe('浏览器中的本地草稿')
    expect(await page.getByRole('button', { name: '保存', exact: true }).isEnabled()).toBe(false)
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'block-conflict.expected.md'),
      await captureStableAria(page, '[data-paperai-block-editor]', scaffold.workspaceCwd), MODE)
    await page.getByRole('button', { name: '取消', exact: true }).click()
    await expect.poll(() => editor.count()).toBe(0)
    await preview.getByText('Initial browser paragraph — 外部会话写入的最新文本').waitFor({ timeout: 10_000 })
    expect(await page.locator('body').innerText()).not.toContain('local draft dropped')

    // Editing the refreshed block saves one version on top of the external one.
    await preview.locator('[data-paperai-block]', { hasText: '外部会话写入的最新文本' }).first().click()
    await editor.waitFor({ timeout: 10_000 })
    await editor.fill('浏览器合并后的最终文本')
    await page.locator('[data-paperai-block-editor]').getByRole('button', { name: '保存' }).click()
    await preview.getByText('浏览器合并后的最终文本').waitFor({ timeout: 30_000 })
    await expect.poll(() => editor.count(), { timeout: 10_000 }).toBe(0)
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
    const preview = page.getByRole('document', { name: '文档预览' })
    const original = await preview.elementHandle()
    if (original === null) throw new Error('document preview missing')
    await preview.locator('[data-paperai-block]', { hasText: '浏览器合并后的最终文本' }).click()
    const editor = page.getByRole('textbox', { name: '编辑段落' })
    await editor.fill('切换文档保留的草稿')
    await preview.evaluate((element) => { element.scrollTop = 120 })
    await expect.poll(() => preview.evaluate(element => element.scrollTop)).toBe(120)
    await page.getByRole('button', { name: '打开 Second proposal.docx', exact: true }).click()
    await preview.getByText('Initial browser paragraph', { exact: true }).waitFor({ timeout: 20_000 })
    expect(await original.evaluate(element => element.isConnected)).toBe(true)
    await page.getByRole('button', { name: '打开 Browser conflict proposal.docx', exact: true }).click()
    await expect.poll(() => editor.inputValue()).toBe('切换文档保留的草稿')
    await expect.poll(() => preview.evaluate(element => element.scrollTop)).toBe(120)
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'retained-draft.expected.md'),
      await captureStableAria(page, '[data-paperai-block-editor]', scaffold.workspaceCwd), MODE)
    await page.getByRole('button', { name: '取消', exact: true }).click()
    await original.dispose()
  }, 90_000)

  it('quotes exact Word text into a logged message and reveals the Agent at narrow widths', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-paperai-selection'))
    await page.getByRole('button', { name: '在“Paper project”中新建会话', exact: true }).click()
    await page.getByRole('button', { name: 'Codex', exact: true }).first().click()
    await page.getByRole('menuitem', { name: /^Claude/ }).click()
    await page.getByRole('button', { name: 'Claude', exact: true }).first().waitFor({ timeout: 20_000 })
    await expect.poll(() => page.getByRole('button', { name: 'Claude', exact: true }).first().getAttribute('aria-busy')).not.toBe('true')
    await page.getByRole('button', { name: '打开 Browser conflict proposal.docx', exact: true }).click()
    const preview = page.getByRole('document', { name: '文档预览' })
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
    const selection = page.getByRole('region', { name: '选中的文字' })
    await selection.waitFor({ timeout: 10_000 })
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'word-selection.expected.md'), await selection.ariaSnapshot(), MODE)
    await selection.getByRole('button', { name: '交给 Agent' }).click()
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
    await expect.poll(async () => (await page.locator('[class*=detailsCol]').boundingBox())?.width ?? 0).toBe(760)
    const quotedMessage = page.locator('[data-word-selection-message]').last()
    await quotedMessage.waitFor()
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'word-selection-message.expected.md'), await quotedMessage.ariaSnapshot(), MODE)
    await page.screenshot({ path: join(process.cwd(), '.artifacts', 'paperai-agentero-workbench.png') })
  }, 90_000)

  it('scans without writing and restores missing working bytes only after reviewing a recovery plan', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-paperai-doctor'))
    const projection = await scaffold.ctx.paperaiWorkbench.open({ workspaceId, sessionId: SessionId('doctor-read'), resourceId })
    const path = join(scaffold.workspaceCwd, 'paper-project', projection.document.path)
    const bytes = await readFile(path)
    const head = projection.document.headCommitId
    await rm(path)
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

  it('keeps its snapshot inventory closed', async () => {
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, [
      'agent-presets.expected.md',
      'agent-connecting.expected.md',
      'agent-diagnostics.expected.md',
      'block-conflict.expected.md',
      'block-editor.expected.md',
      'cancel-before-prompt.expected.md',
      'cancel-final-tool.expected.md',
      'external-update.expected.md',
      'model-failure.expected.md',
      'model-menu.expected.md',
      'permission-default.expected.md',
      'permission-failure.expected.md',
      'permission-read-only.expected.md',
      'project-doctor.expected.md',
      'retained-draft.expected.md',
      'word-selection.expected.md',
      'word-selection-message.expected.md',
    ])
  })
})
