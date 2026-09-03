// PaperAI assembled roster: the product profile offers exactly its three
// engines, and the built-in `dsh` engine composes the writing persona, the
// native paperai_* document tools, and the complete standard capability set.
// Proven on the real bundle composition (base + web + PaperAI overlay), not on
// a package-level stub: a preset row that fails to resolve, or a document
// service the tool package waits for, surfaces here as a mount failure.
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { launchWebScaffold, type WebScaffold } from './scaffold.ts'

const PAPERAI_OVERLAY = fileURLToPath(new URL(
  '../../../packages/bundle/paperai-web/cordis.patch.yml',
  import.meta.url,
))
const PAPERAI_PRESETS = fileURLToPath(new URL(
  '../../../packages/bundle/paperai-web/config/agent-presets',
  import.meta.url,
))
const NATIVE_SHELL_TOOL = process.platform === 'win32' ? 'pwsh' : 'bash'
/** The MCP-parity document vocabulary every PaperAI engine shares. */
const DOCUMENT_TOOLS = [
  'paperai_check_gate', 'paperai_commit_document', 'paperai_get_template',
  'paperai_list_documents', 'paperai_list_projects', 'paperai_list_templates',
  'paperai_list_versions', 'paperai_prepare_export', 'paperai_read_document',
  'paperai_revert_document',
]

describe('web e2e: PaperAI assembled agent roster', { concurrent: false }, () => {
  let scaffold: WebScaffold
  let handle: AgentHandle

  beforeAll(async () => {
    scaffold = await launchWebScaffold({
      extraOverlayPath: PAPERAI_OVERLAY,
      agentPresets: {
        default: 'codex',
        roots: [{ path: PAPERAI_PRESETS, trust: 'system' }],
      },
    })
    handle = await scaffold.ctx.agents.create({
      sessionId: SessionId('paperai-dsh-preset'),
      setup: agentCtx => scaffold.ctx.agentPresets.mount(agentCtx, 'dsh').then(() => undefined),
    })
  }, 180_000)

  afterAll(async () => {
    await handle?.dispose()
    await scaffold?.close()
  })

  it('offers exactly the three PaperAI engines from the product root', async () => {
    const listed = await scaffold.ctx.agentPresets.list()
    expect(listed.map(preset => preset.id).sort()).toEqual(['claude', 'codex', 'dsh'])
    expect(listed.every(preset => preset.trust === 'system')).toBe(true)
    expect(scaffold.ctx.agentPresets.defaultId).toBe('codex')
  })

  it('composes the writing persona and document tools over the full standard engine', async () => {
    const assembly = await scaffold.ctx.systemPrompt.assemble({ scope: handle.agent })
    const persona = assembly.sections.find(section => section.name === 'deployment:persona')
    expect(persona?.text).toContain('PaperAI 的论文写作智能体')
    expect(persona?.text).toContain('paperai_*')

    const tools = scaffold.ctx.tools.schemas(handle.agent).map(schema => schema.name)
    expect(tools).toEqual(expect.arrayContaining(DOCUMENT_TOOLS))
    // The standard capability set rides along instead of being replaced.
    expect(tools).toEqual(expect.arrayContaining([
      NATIVE_SHELL_TOOL, 'read', 'edit', 'skill', 'subagent', 'todo_write', 'web_search', 'ask_user_question',
    ]))
    expect(tools).not.toContain('str_replace_editor')
    // Document tools belong to the preset layer: the host's global layer stays empty.
    expect(scaffold.ctx.tools.schemas().map(schema => schema.name)).toEqual([])
  })
})
