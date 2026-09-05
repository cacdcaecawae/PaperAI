import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { createSnapshotStore, SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import paperAIWorkbenchRemote from '@paperai/workbench-service/remote'
import { DocumentWorkbench } from '../src/client/DocumentWorkbench.tsx'
import { AgentDiagnostics, type AgentDiagnosticsInjected } from '../src/client/AgentDiagnostics.tsx'
import { WordSelectionMessage } from '../src/client/WordSelectionMessage.tsx'
import {
  apply, inject, NS, PAPERAI_DETAILS_VIEW_ID, PAPERAI_LAYOUT_CONFIG, PAPERAI_TEMPLATES_SECTION_ID,
} from '../src/client/index.ts'
import type {
  PaperAIDocumentWorkbenchInjected, PaperAILibraryInjected, PaperAIStartPageInjected,
  PaperAIWorkspaceContentInjected,
} from '../src/client/slots.ts'
import { StartPage } from '../src/client/StartPage.tsx'
import { TemplatesSection } from '../src/client/TemplateLibrary.tsx'
import { WorkspaceContent } from '../src/client/WorkspaceContent.tsx'
import {
  COMMIT_0, COMMIT_2, CUSTOM_PACK_ID, DOCUMENT_ID, documentOpenResult, documentSnapshot, HIT_PACK_ID, NODE_HEADING,
  RESOURCE_ID, REVISION_2, SESSION_ID, successfulRemote, WORKSPACE_ID,
} from './fixtures.client.ts'

vi.mock('@paperai/workbench-service/remote', () => ({
  default: Object.freeze({ package: '@paperai/workbench-service', descriptors: [] }),
}))

const SLOTS = [
  'sidebar.workspaces.content', 'conversation.hero.content', 'settings.section', 'conversation.details.view',
  'conversation.hero.agentPreset.status', 'conversation.message.userText',
] as const

async function bench(mountError?: Error) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('zh')
  ctx.provide('locale', locale)
  const connectWorkspace = vi.fn(async () => SESSION_ID)
  const workspaceList = createSnapshotStore({
    items: [] as Array<{ workspaceId: typeof WORKSPACE_ID; sessionIds: Array<typeof SESSION_ID> }>,
  })
  const sessionList = createSnapshotStore<{ current: typeof SESSION_ID | undefined }>({ current: undefined })
  const openSession = vi.fn()
  const openDetails = vi.fn()
  const closeDetails = vi.fn()
  const disposeLayoutProfile = vi.fn()
  const configureLayout = vi.fn(() => disposeLayoutProfile)
  const setDetailsFocus = vi.fn()
  const revealConversation = vi.fn()
  const scope = vi.fn<() => Context | undefined>(() => ctx)
  const input = {
    state: createSnapshotStore({ draft: 'Please check ', draftRev: 4 }),
    insertReference: vi.fn(() => true), notify: vi.fn(),
  }
  const disposeOnboardingProfile = vi.fn()
  const configureOnboarding = vi.fn(() => disposeOnboardingProfile)
  ctx.provide('workspaces', { connectWorkspace, list: workspaceList } as never)
  ctx.provide('sessions', { open: openSession, list: sessionList, scope } as never)
  ctx.provide('conversation', { input: { for: () => input } } as never)
  ctx.provide('inputTriggers', { registerSource: vi.fn(() => () => {}) } as never)
  ctx.provide('conversationDetails', { open: openDetails, close: closeDetails })
  ctx.provide('layout', { configure: configureLayout, setDetailsFocus, revealConversation } as never)
  ctx.provide('modelsOnboarding', { configure: configureOnboarding } as never)
  const remote = successfulRemote()
  const remoteListeners = new Map<string, Set<(payload: unknown) => void>>()
  const onRemote = vi.fn((event: string, listener: (payload: unknown) => void) => {
    let listeners = remoteListeners.get(event)
    if (listeners === undefined) {
      listeners = new Set()
      remoteListeners.set(event, listeners)
    }
    const eventListeners = listeners
    eventListeners.add(listener)
    return () => { eventListeners.delete(listener) }
  })
  const emitRemote = (event: string, payload: unknown): void => {
    for (const listener of remoteListeners.get(event) ?? []) listener(payload)
  }
  let mounted = false
  let disposeNamespace: () => Promise<void> = async () => {}
  const disposeRemote = vi.fn(async () => {
    mounted = false
    await disposeNamespace()
    disposeNamespace = async () => {}
  })
  const mountRemote = vi.fn(async () => {
    if (mountError !== undefined) throw mountError
    disposeNamespace = ctx.reflect.provide('remote.paperaiWorkbench', remote)
    mounted = true
    return disposeRemote
  })
  const remoteService = {
    $mount: mountRemote,
    $on: onRemote,
    get paperaiWorkbench() {
      if (!mounted) throw new Error('paperAIWorkbench descriptor is not mounted')
      return remote
    },
  }
  ctx.provide('remote', remoteService as never)
  return {
    ctx,
    slots: ctx.get('slots') as SlotRegistry,
    locale,
    connectWorkspace,
    workspaceList,
    sessionList,
    openSession,
    openDetails,
    configureLayout,
    disposeLayoutProfile,
    setDetailsFocus,
    revealConversation,
    scope,
    input,
    configureOnboarding,
    disposeOnboardingProfile,
    remote,
    mountRemote,
    disposeRemote,
    onRemote,
    emitRemote,
  }
}

function declare(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: {
      'sidebar.workspaces.content': { kind: 'list', scope: 'root' },
      'conversation.hero.content': { kind: 'single', scope: 'root' },
      'settings.section': { kind: 'list', scope: 'root' },
      'conversation.details.view': { kind: 'list', scope: 'session' },
      'conversation.hero.agentPreset.status': { kind: 'single', scope: 'root' },
      'conversation.message.userText': { kind: 'chain', scope: 'session' },
    },
  } as never, () => null)
}

function injected(slots: SlotRegistry, name: typeof SLOTS[number]): unknown {
  const entry = slots.entries(name)[0]
  if (entry === undefined) throw new Error(`no ${name} entry`)
  return (entry.inject as unknown as (...args: unknown[]) => unknown)(SESSION_ID)
}

describe('PaperAI workbench browser plugin', () => {
  it('requires the generated Remote mount instead of a guessed namespace', () => {
    expect(inject).toEqual([
      'slots', 'locale', 'sessions', 'workspaces', 'conversationDetails', 'layout',
      'modelsOnboarding', 'remote', 'conversation', 'inputTriggers',
    ])
    expect(inject).not.toContain('remote.paperaiWorkbench')
  })

  it('registers the workbench and Agent entries after declaration and removes them with the plugin', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    for (const name of SLOTS) expect(b.slots.entries(name)).toHaveLength(0)

    const stop = declare(b.slots)
    await vi.waitFor(() => {
      expect(b.slots.entries('sidebar.workspaces.content')[0]?.component).toBe(WorkspaceContent)
      expect(b.slots.entries('conversation.hero.content')[0]?.component).toBe(StartPage)
      expect(b.slots.entries('settings.section')[0]?.component).toBe(TemplatesSection)
      expect(b.slots.entries('conversation.details.view')[0]?.component).toBe(DocumentWorkbench)
      expect(b.slots.entries('conversation.hero.agentPreset.status')[0]?.component).toBe(AgentDiagnostics)
      expect(b.slots.entries('conversation.message.userText')[0]?.component).toBe(WordSelectionMessage)
    })
    expect(b.slots.entries('sidebar.workspaces.content')[0]?.options).toMatchObject({ id: PAPERAI_DETAILS_VIEW_ID, order: 10 })
    expect(b.slots.entries('settings.section')[0]?.options).toMatchObject({ id: PAPERAI_TEMPLATES_SECTION_ID, order: 12 })
    const label = b.slots.entries('settings.section')[0]?.options.label
    expect(typeof label === 'function' ? label() : label).toBe('模板')
    // The start page declares the mark seat the brand plugin fills.
    expect(b.slots.spec('paperai.start.mark')).toEqual({ kind: 'single', scope: 'root' })
    expect(b.slots.entries('conversation.details.view')[0]?.locale).toBe(NS)
    expect(b.locale.bind(NS)('documents.title')).toBe('文档')

    stop()
    for (const name of SLOTS) expect(b.slots.entries(name)).toHaveLength(0)
    declare(b.slots)
    await vi.waitFor(() => { expect(b.slots.entries('conversation.details.view')).toHaveLength(1) })

    const workspace = injected(b.slots, 'sidebar.workspaces.content') as PaperAIWorkspaceContentInjected
    await fiber.dispose()
    expect(b.configureLayout).toHaveBeenCalledWith(PAPERAI_LAYOUT_CONFIG)
    expect(b.disposeLayoutProfile).toHaveBeenCalledOnce()
    expect(b.configureOnboarding).toHaveBeenCalledWith({ welcomeNotice: false, deepSeekCredential: false })
    expect(b.disposeOnboardingProfile).toHaveBeenCalledOnce()
    expect(b.mountRemote).toHaveBeenCalledWith(paperAIWorkbenchRemote)
    expect(b.disposeRemote).toHaveBeenCalledOnce()
    for (const name of SLOTS) expect(b.slots.entries(name)).toHaveLength(0)
    expect(() => workspace.ensureProject(WORKSPACE_ID)).toThrow('controller disposed')
    await b.ctx.fiber.dispose()
  })

  it('appends a frozen Word reference only to a live Session at the current draft revision', async () => {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const details = injected(b.slots, 'conversation.details.view') as PaperAIDocumentWorkbenchInjected
    const document = documentSnapshot()
    const excerpt = { nodeIds: [NODE_HEADING], text: 'Introduction' }
    b.scope.mockReturnValueOnce(undefined)
    details.quoteSelection(document, excerpt)
    expect(b.input.insertReference).not.toHaveBeenCalled()
    details.quoteSelection(document, excerpt)
    expect(b.input.insertReference).toHaveBeenCalledWith(expect.objectContaining({
      source: 'paperai-selection', clipboardText: expect.stringContaining('"text":"Introduction"') as unknown,
    }), { start: 13, end: 13, draftRev: 4 })
    expect(b.revealConversation).toHaveBeenCalledOnce()
    b.input.insertReference.mockReturnValueOnce(false)
    details.quoteSelection(document, excerpt)
    expect(b.input.notify).toHaveBeenCalledWith('error', b.locale.bind(NS)('selection.busy'))
    expect(b.revealConversation).toHaveBeenCalledOnce()
    const select = b.slots.entries('conversation.message.userText')[0]!.select!
    expect(select({ text: 'ordinary prompt' } as never)).toBeNull()
    const quoted = '[Word selection]\nquoted payload'
    expect(select({ text: quoted } as never)).toBe(quoted)
    await b.ctx.fiber.dispose()
  })

  it('keeps provider discovery and reviewed recovery behind their own explicit actions', async () => {
    const b = await bench()
    declare(b.slots)
    const discover = vi.spyOn(b.remote, 'agentDiagnostics')
    const probe = vi.spyOn(b.remote, 'probeAgent')
    const inspect = vi.spyOn(b.remote, 'inspectProject')
    const recover = vi.spyOn(b.remote, 'recoverWorking')
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const status = injected(b.slots, 'conversation.hero.agentPreset.status') as AgentDiagnosticsInjected
    const workspace = injected(b.slots, 'sidebar.workspaces.content') as PaperAIWorkspaceContentInjected
    expect(discover).not.toHaveBeenCalled()
    expect(inspect).not.toHaveBeenCalled()
    await status.loadAgents()
    expect(discover).toHaveBeenCalledOnce()
    expect(probe).not.toHaveBeenCalled()
    await status.probe('claude', true)
    expect(probe).toHaveBeenCalledWith({ provider: 'claude', force: true })
    expect(discover).toHaveBeenCalledTimes(2)
    expect(status.hooks.diagnostics.getSnapshot().probing).toEqual([])
    await workspace.inspectProject(WORKSPACE_ID)
    expect(inspect).toHaveBeenCalledWith({ workspaceId: WORKSPACE_ID })
    expect(recover).not.toHaveBeenCalled()
    const plan = { documentId: DOCUMENT_ID, headCommitId: COMMIT_2, workingPath: 'working/paper.docx', sha256: 'a'.repeat(64) }
    await workspace.inspectProject(WORKSPACE_ID, plan)
    expect(recover).toHaveBeenCalledWith({ workspaceId: WORKSPACE_ID, plan })
    await b.ctx.fiber.dispose()
  })

  it('initializes a PaperAI project as soon as a DSH Workspace enters the ledger', async () => {
    const b = await bench()
    declare(b.slots)
    const overview = vi.spyOn(b.remote, 'overview')
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    b.workspaceList.set({ items: [{ workspaceId: WORKSPACE_ID, sessionIds: [] }] })
    await vi.waitFor(() => { expect(overview).toHaveBeenCalledOnce() })
    expect(overview).toHaveBeenCalledWith({ workspaceId: WORKSPACE_ID }, expect.any(AbortSignal))
    await b.ctx.fiber.dispose()
  })

  it('keeps document navigation in the selected project session', async () => {
    const b = await bench()
    b.workspaceList.set({ items: [{ workspaceId: WORKSPACE_ID, sessionIds: [SESSION_ID] }] })
    b.sessionList.set({ current: SESSION_ID })
    declare(b.slots)
    const open = vi.spyOn(b.remote, 'open')
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const workspace = injected(b.slots, 'sidebar.workspaces.content') as PaperAIWorkspaceContentInjected
    await workspace.openDocument(WORKSPACE_ID, RESOURCE_ID)
    await workspace.openDocument(WORKSPACE_ID, RESOURCE_ID)
    expect(b.connectWorkspace).not.toHaveBeenCalled()
    expect(open).toHaveBeenCalledOnce()
    expect(b.openSession).toHaveBeenLastCalledWith(SESSION_ID)
    await b.ctx.fiber.dispose()
  })

  it('connects a blank Workspace Session before opening the PaperAI document view', async () => {
    const b = await bench()
    declare(b.slots)
    const open = vi.spyOn(b.remote, 'open')
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const workspace = injected(b.slots, 'sidebar.workspaces.content') as PaperAIWorkspaceContentInjected

    await workspace.openDocument(WORKSPACE_ID, RESOURCE_ID)
    expect(b.connectWorkspace).toHaveBeenCalledWith(WORKSPACE_ID)
    expect(b.openSession).toHaveBeenCalledWith(SESSION_ID)
    expect(b.openDetails).toHaveBeenCalledWith(PAPERAI_DETAILS_VIEW_ID, SESSION_ID)
    expect(b.openDetails).toHaveBeenCalledTimes(2)
    expect(open).toHaveBeenCalledWith(
      { workspaceId: WORKSPACE_ID, sessionId: SESSION_ID, resourceId: RESOURCE_ID },
      expect.any(AbortSignal),
    )

    const details = injected(b.slots, 'conversation.details.view') as PaperAIDocumentWorkbenchInjected
    expect(details.hooks.workbench.getSnapshot()).toMatchObject({ phase: 'ready' })
    expect(details.hooks.projects.getSnapshot().workspaces[WORKSPACE_ID]).toMatchObject({ selected: RESOURCE_ID })
    details.showPanel('versions')
    expect(details.hooks.workbench.getSnapshot().panel).toBe('versions')
    expect(details.selectBlock(NODE_HEADING)).toEqual({ ok: true })
    details.updateDraft('Local draft')
    details.cancelEdit()
    await expect(details.commitEdit()).resolves.toEqual({ ok: false, error: 'no block is being edited' })
    await expect(details.validate()).resolves.toEqual({ ok: true })
    await expect(details.suggestType()).resolves.toEqual({ ok: true })
    await expect(details.applyTemplate('midterm')).resolves.toEqual({ ok: true })
    await expect(details.detachTemplate()).resolves.toEqual({ ok: true })
    await expect(details.setProjectTemplate(WORKSPACE_ID, CUSTOM_PACK_ID)).resolves.toEqual({ ok: true })
    await expect(details.showDiff(COMMIT_0)).resolves.toEqual({ ok: true })
    await expect(details.exportDocument('draft-export')).resolves.toEqual({ ok: true })
    await expect(details.reloadExternal()).resolves.toEqual({ ok: false, error: 'no external document update' })
    await expect(details.restore(COMMIT_0)).resolves.toEqual({ ok: true })
    await expect(details.retryOpen()).resolves.toBeUndefined()
    details.setDetailsFocus(true)
    expect(b.setDetailsFocus).toHaveBeenCalledWith(true)
    await expect(details.loadLibrary()).resolves.toBeUndefined()
    expect(details.hooks.library.getSnapshot().phase).toBe('ready')
    await b.ctx.fiber.dispose()
  })

  it('forwards durable document-head events into a clean open workbench', async () => {
    const b = await bench()
    declare(b.slots)
    b.remote.open = vi.fn<typeof b.remote.open>()
      .mockResolvedValueOnce({ ok: true, value: documentOpenResult() })
      .mockResolvedValueOnce({ ok: true, value: documentOpenResult(REVISION_2) })
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const workspace = injected(b.slots, 'sidebar.workspaces.content') as PaperAIWorkspaceContentInjected
    await workspace.openDocument(WORKSPACE_ID, RESOURCE_ID)
    expect(b.onRemote).toHaveBeenCalledWith('paperai/document-changed', expect.any(Function))
    b.emitRemote('paperai/document-changed', {
      documentId: DOCUMENT_ID, headCommitId: COMMIT_2, updatedAt: '2026-08-28T12:00:00.000Z',
    })
    const details = injected(b.slots, 'conversation.details.view') as PaperAIDocumentWorkbenchInjected
    await vi.waitFor(() => {
      expect(details.hooks.workbench.getSnapshot()).toMatchObject({
        externalUpdate: null, document: { revision: REVISION_2, headCommitId: COMMIT_2 },
      })
    })
    await b.ctx.fiber.dispose()
  })

  it('connects the Workspace before starting or importing a document from the start page', async () => {
    const b = await bench()
    declare(b.slots)
    const createFromTemplate = vi.spyOn(b.remote, 'createFromTemplate')
    const importDocument = vi.spyOn(b.remote, 'importDocument')
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const start = injected(b.slots, 'conversation.hero.content') as PaperAIStartPageInjected

    await expect(start.createFromTemplate(WORKSPACE_ID, { documentType: 'proposal' })).resolves.toEqual({ ok: true })
    expect(b.connectWorkspace).toHaveBeenCalledWith(WORKSPACE_ID)
    expect(b.openSession).toHaveBeenCalledWith(SESSION_ID)
    expect(b.openDetails).toHaveBeenCalledWith(PAPERAI_DETAILS_VIEW_ID, SESSION_ID)
    expect(createFromTemplate).toHaveBeenCalledWith(
      { workspaceId: WORKSPACE_ID, sessionId: SESSION_ID, documentType: 'proposal' },
      expect.any(AbortSignal),
    )
    await expect(start.importDocument(WORKSPACE_ID, { fileName: '初稿.docx', contentBase64: 'd29yZA==' })).resolves.toEqual({ ok: true })
    expect(importDocument).toHaveBeenCalledWith(
      { workspaceId: WORKSPACE_ID, sessionId: SESSION_ID, fileName: '初稿.docx', contentBase64: 'd29yZA==' },
      expect.any(AbortSignal),
    )
    await expect(start.setProjectTemplate(WORKSPACE_ID, HIT_PACK_ID)).resolves.toEqual({ ok: true })
    await expect(start.ensureProject(WORKSPACE_ID)).resolves.toBeUndefined()

    b.connectWorkspace.mockRejectedValueOnce(new Error('Template connect failed'))
    await expect(start.createFromTemplate(WORKSPACE_ID, { documentType: 'proposal' }))
      .resolves.toEqual({ ok: false, error: 'Template connect failed' })
    expect(start.hooks.projects.getSnapshot().workspaces[WORKSPACE_ID]).toMatchObject({ error: 'Template connect failed' })
    b.connectWorkspace.mockRejectedValueOnce('Workspace unavailable')
    await expect(start.importDocument(WORKSPACE_ID, { fileName: 'x.docx', contentBase64: 'd29yZA==' }))
      .resolves.toEqual({ ok: false, error: 'Workspace unavailable' })
    await b.ctx.fiber.dispose()
  })

  it('shares one library source between the settings page, the start page, and the document view', async () => {
    const b = await bench()
    declare(b.slots)
    const createTemplateSet = vi.spyOn(b.remote, 'createTemplateSet')
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const section = injected(b.slots, 'settings.section') as PaperAILibraryInjected
    const start = injected(b.slots, 'conversation.hero.content') as PaperAIStartPageInjected
    const details = injected(b.slots, 'conversation.details.view') as PaperAIDocumentWorkbenchInjected
    expect(start.hooks.library).toBe(section.hooks.library)
    expect(details.hooks.library).toBe(section.hooks.library)
    await section.loadLibrary()
    await expect(section.createTemplateSet({ name: '新模板' })).resolves.toEqual({ ok: true })
    expect(createTemplateSet).toHaveBeenCalledWith({ name: '新模板' })
    await expect(section.addTemplateFormat({
      packId: CUSTOM_PACK_ID, documentType: 'midterm', usage: 'form-template', fileName: '中期.docx', contentBase64: 'd29yZA==',
    })).resolves.toEqual({ ok: true })
    await expect(section.removeTemplateFormat(CUSTOM_PACK_ID, 'midterm')).resolves.toEqual({ ok: true })
    await expect(section.deleteTemplateSet(CUSTOM_PACK_ID)).resolves.toEqual({ ok: true })
    await b.ctx.fiber.dispose()
  })

  it('projects Workspace callback failures and refreshes loaded state after reconnect', async () => {
    const b = await bench()
    declare(b.slots)
    const overview = vi.spyOn(b.remote, 'overview')
    const open = vi.spyOn(b.remote, 'open')
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const workspace = injected(b.slots, 'sidebar.workspaces.content') as PaperAIWorkspaceContentInjected

    expect(workspace.hooks.projects.getSnapshot().workspaces[WORKSPACE_ID]).toBeUndefined()
    await workspace.ensureProject(WORKSPACE_ID)
    await workspace.ensureProject(WORKSPACE_ID)
    await workspace.refreshProject(WORKSPACE_ID)
    expect(overview).toHaveBeenCalledTimes(2)
    await workspace.openDocument(WORKSPACE_ID, RESOURCE_ID)
    b.ctx.emit('connection/reset')
    await vi.waitFor(() => {
      expect(overview).toHaveBeenCalledTimes(3)
      expect(open).toHaveBeenCalledTimes(2)
    })

    b.connectWorkspace.mockRejectedValueOnce(new Error('Workspace connect failed'))
    await workspace.openDocument(WORKSPACE_ID, RESOURCE_ID)
    expect(workspace.hooks.projects.getSnapshot().workspaces[WORKSPACE_ID]).toMatchObject({
      phase: 'ready', error: 'Workspace connect failed',
    })
    await b.ctx.fiber.dispose()
  })

  it('disposes the mounted Remote when browser assembly fails after mounting', async () => {
    const b = await bench()
    vi.spyOn(b.locale, 'register').mockImplementation(() => { throw new Error('locale rejected') })
    await expect(apply(b.ctx as never)).rejects.toThrow('locale rejected')
    expect(b.disposeRemote).toHaveBeenCalledOnce()
    await b.ctx.fiber.dispose()
  })

  it('fails plugin activation when the generated descriptor cannot mount', async () => {
    const b = await bench(new Error('descriptor rejected'))
    declare(b.slots)
    await expect(apply(b.ctx as never)).rejects.toThrow('descriptor rejected')
    expect(b.mountRemote).toHaveBeenCalledWith(paperAIWorkbenchRemote)
    for (const name of SLOTS) expect(b.slots.entries(name)).toHaveLength(0)
    await b.ctx.fiber.dispose()
  })
})
