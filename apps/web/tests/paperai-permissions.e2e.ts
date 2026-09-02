// PaperAI browser snapshots: the shipped product composition exposes its safe
// permission default and preserves both sides of a same-node external conflict.
import { Buffer } from 'node:buffer'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
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
const SHIPPED_PRESETS = fileURLToPath(new URL('../../cli/config/agent-presets', import.meta.url))
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
const CANCEL_BEFORE_PROMPT_EXPECTED = join(SNAPSHOT_DIR, 'cancel-before-prompt.expected.md')
const CANCEL_FINAL_TOOL_EXPECTED = join(SNAPSHOT_DIR, 'cancel-final-tool.expected.md')
const CONFLICT_EXPECTED = join(SNAPSHOT_DIR, 'external-conflict.expected.md')
const MODE = webSnapshotMode()

interface AcpLogEntry {
  readonly event: string
  readonly modeId?: string
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
  let workspaceId: Parameters<WebScaffold['ctx']['paperaiWorkbench']['list']>[0]['workspaceId']
  let resourceId: Awaited<ReturnType<WebScaffold['ctx']['paperaiWorkbench']['list']>>['resources'][number]['id']
  let originalPermissionMode: string | undefined
  let acpFixtureRoot: string | undefined
  let acpLogPath: string
  let rejectModePath: string
  let rejectModelPath: string
  const sessionEvents: SessionEvent[] = []

  beforeAll(async () => {
    originalPermissionMode = process.env.DSH_PERMISSION_MODE
    Reflect.deleteProperty(process.env, 'DSH_PERMISSION_MODE')
    acpFixtureRoot = await mkdtemp(join(tmpdir(), 'dsh-paperai-acp-browser-'))
    acpLogPath = join(acpFixtureRoot, 'events.jsonl')
    rejectModePath = join(acpFixtureRoot, 'reject-set-mode')
    rejectModelPath = join(acpFixtureRoot, 'reject-set-config')
    scaffold = await launchWebScaffold({
      extraOverlayPath: PAPERAI_OVERLAY,
      agentPresets: {
        default: 'codex',
        roots: [
          { path: SHIPPED_PRESETS, trust: 'system', ids: ['standard'] },
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
      },
    })
    scaffold.ctx.on('session/event', (_session, event: SessionEvent) => { sessionEvents.push(event) })
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
    await page.getByRole('treeitem', { name: '新会话', exact: true }).click()
    const open = page.getByRole('button', { name: '打开 Browser conflict proposal.docx' })
    await open.waitFor({ timeout: 15_000 })
    await open.click()
    await page.getByRole('tab', { name: '编辑' }).waitFor({ timeout: 30_000 })
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
    const conflictHeading = page.getByText('当前节点也有外部修改', { exact: true })
    await expect.poll(() => conflictHeading.evaluate(element => document.activeElement === element)).toBe(true)
    expect(await page.getByRole('textbox', { name: '本地草稿' }).inputValue()).toBe('浏览器中的本地草稿')
    expect(await page.getByRole('textbox', { name: '外部最新文本' }).inputValue())
      .toBe('Initial browser paragraph — 外部会话写入的最新文本')

    await editor.fill('浏览器合并中的草稿')
    const latest = await scaffold.ctx.paperaiWorkbench.open({
      workspaceId,
      sessionId: externalSessionId,
      resourceId,
    })
    const other = latest.document.nodes.find(node => node.editable && node.nodeId !== selected.nodeId)
    if (other === undefined) throw new Error('PaperAI browser fixture has no second editable node')
    const otherBuffer = await scaffold.ctx.paperaiWorkbench.readNode({
      sessionId: externalSessionId,
      documentId: latest.document.documentId,
      nodeId: other.nodeId,
      revision: latest.document.revision,
      headCommitId: latest.document.headCommitId,
    })
    await scaffold.ctx.paperaiWorkbench.commit({
      sessionId: externalSessionId,
      documentId: latest.document.documentId,
      baseRevision: latest.document.revision,
      baseCommitId: latest.document.headCommitId,
      mutations: [{
        type: 'replace-text',
        nodeId: other.nodeId,
        baseText: otherBuffer.text,
        nextText: `${otherBuffer.text} — unrelated external update`,
      }],
    })
    await review.waitFor({ timeout: 10_000 })
    await review.click()
    await expect.poll(() => editor.isEnabled(), { timeout: 30_000 }).toBe(true)
    expect(await page.getByRole('textbox', { name: '本地草稿' }).inputValue()).toBe('浏览器中的本地草稿')
    expect(await page.getByRole('textbox', { name: '外部最新文本' }).inputValue())
      .toBe('Initial browser paragraph — 外部会话写入的最新文本')
    expect(await editor.inputValue()).toBe('浏览器合并中的草稿')
    const snapshot = await captureStableAria(page, '[data-paperai-node-editor]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(CONFLICT_EXPECTED, snapshot, MODE)

    await editor.fill('浏览器合并后的最终文本')
    await page.getByRole('button', { name: '使用合并内容' }).click()
    await expect.poll(() => editor.evaluate(element => document.activeElement === element)).toBe(true)
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
      'cancel-before-prompt.expected.md',
      'cancel-final-tool.expected.md',
      'external-conflict.expected.md',
      'model-failure.expected.md',
      'permission-default.expected.md',
      'permission-failure.expected.md',
      'permission-read-only.expected.md',
    ])
  })
})
