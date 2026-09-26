/** The shipped PaperAI UI reads shared DSH Workspaces without adopting their directories. */
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { describe, expect, it } from 'vitest'
import type {} from '@paperai/workbench-service'
import { compareOrRefreshGolden, launchWebScaffold, webSnapshotMode } from './scaffold.ts'
import { ZH_BROWSER_LOCALE } from './support.ts'

const PAPERAI_OVERLAY = fileURLToPath(new URL('../../../packages/bundle/paperai-web/cordis.patch.yml', import.meta.url))
const PAPERAI_PRESETS = fileURLToPath(new URL('../../../packages/bundle/paperai-web/config/agent-presets', import.meta.url))
const FAKE_ACP_AGENT = fileURLToPath(new URL('../../../packages/paperai/agent-acp/tests/fixtures/fake-acp-agent.mjs', import.meta.url))
const EXPECTED = fileURLToPath(new URL('./snapshots/paperai-initialization/ui.expected.md', import.meta.url))

describe('web e2e: explicit PaperAI project initialization', () => {
  it('preserves unrelated and removed Workspace directories until an explicit template choice', async () => {
    const scaffold = await launchWebScaffold({
      extraOverlayPath: PAPERAI_OVERLAY,
      agentPresets: { default: 'codex', roots: [{ path: PAPERAI_PRESETS, trust: 'system', ids: ['codex', 'claude'] }] },
      paperAiAcp: { providers: { codex: { command: process.execPath, args: [FAKE_ACP_AGENT], env: { FAKE_ACP_LABEL: 'codex' } } } },
    })
    let browser: Browser | undefined
    let page: Page | undefined
    try {
      const codeRoot = join(scaffold.workspaceCwd, 'code-repository')
      const removedRoot = join(scaffold.workspaceCwd, 'moved-project')
      await mkdir(codeRoot)
      await mkdir(removedRoot)
      await writeFile(join(codeRoot, 'AGENTS.md'), '# Coding instructions\n')
      await writeFile(join(codeRoot, 'CLAUDE.md'), '# Claude instructions\n')
      const workspace = await scaffold.ctx.workspaceRegistry.create(codeRoot, 'Code repository')
      const removed = await scaffold.ctx.workspaceRegistry.create(removedRoot, 'Moved project')
      await rm(removedRoot, { recursive: true })
      browser = await chromium.launch()
      page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: ZH_BROWSER_LOCALE })
      await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
      await page.getByRole('treeitem', { name: /Code repository/ }).click()
      await page.getByRole('button', { name: '在“Code repository”中新建会话', exact: true }).click()
      const start = page.locator('[data-paperai-start="project"]')
      await start.getByRole('button', { name: '尚未选择本项目的模板', exact: true }).waitFor({ timeout: 30_000 })
      const before = await start.ariaSnapshot()
      expect(await readdir(codeRoot)).toEqual(['AGENTS.md', 'CLAUDE.md'])
      expect(await readFile(join(codeRoot, 'AGENTS.md'), 'utf8')).toBe('# Coding instructions\n')
      expect(await readFile(join(codeRoot, 'CLAUDE.md'), 'utf8')).toBe('# Claude instructions\n')
      expect(scaffold.ctx.paperRepository.listProjects()).toEqual([])
      await expect(scaffold.ctx.paperaiWorkbench.overview({ workspaceId: removed.id })).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(scaffold.ctx.paperaiWorkbench.setProjectTemplate({ workspaceId: removed.id, packId: null })).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(readdir(removedRoot)).rejects.toMatchObject({ code: 'ENOENT' })

      await start.getByRole('button', { name: '尚未选择本项目的模板', exact: true }).click()
      await page.getByRole('button', { name: '不用模板，自由写', exact: true }).click()
      await start.getByRole('button', { name: '本项目不使用模板，自由写作', exact: true }).waitFor()
      await compareOrRefreshGolden(EXPECTED, `Before explicit initialization:\n${before}\n\nAfter template choice:\n${await start.ariaSnapshot()}`, webSnapshotMode())
      expect(scaffold.ctx.paperRepository.listProjects()).toMatchObject([{ workspaceId: workspace.id, rootPath: codeRoot }])
      expect(await readdir(codeRoot)).toEqual(expect.arrayContaining(['.git', 'documents', 'PAPERAI.md']))
      const charter = await readFile(join(codeRoot, 'AGENTS.md'), 'utf8')
      expect(charter).toContain('# Coding instructions')
      expect(charter).toContain('PaperAI')
      await writeFile(join(codeRoot, 'AGENTS.md'), '# User edited instructions\n')
      await scaffold.ctx.paperaiWorkbench.overview({ workspaceId: workspace.id })
      await scaffold.ctx.paperaiWorkbench.setProjectTemplate({ workspaceId: workspace.id, packId: null })
      expect(await readFile(join(codeRoot, 'AGENTS.md'), 'utf8')).toBe('# User edited instructions\n')
    } catch (error) {
      if (page !== undefined) console.info(await page.locator('body').ariaSnapshot())
      throw error
    } finally {
      await browser?.close()
      await scaffold.close()
    }
  }, 120_000)
})
