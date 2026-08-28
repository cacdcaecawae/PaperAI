import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { createSnapshotStore, SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import paperAIWorkbenchRemote from '@paperai/workbench-service/remote'
import { DocumentWorkbench } from '../src/client/DocumentWorkbench.tsx'
import {
  apply, inject, NS, PAPERAI_DETAILS_VIEW_ID, PAPERAI_LAYOUT_CONFIG,
} from '../src/client/index.ts'
import type {
  PaperAIDocumentWorkbenchInjected, PaperAIWorkspaceContentInjected,
} from '../src/client/slots.ts'
import { WorkspaceContent } from '../src/client/WorkspaceContent.tsx'
import {
  COMMIT_0, COMMIT_2, DOCUMENT_ID, documentOpenResult, HIT_PACK_ID,
  HIT_PROPOSAL_MEMBER_ID, HIT_TEMPLATE_ID, NODE_HEADING, RESOURCE_ID, REVISION_2,
  SESSION_ID, successfulRemote, WORKSPACE_ID,
} from './fixtures.client.ts'

vi.mock('@paperai/workbench-service/remote', () => ({
  default: Object.freeze({ package: '@paperai/workbench-service', descriptors: [] }),
}))

async function bench(mountError?: Error) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('zh')
  ctx.provide('locale', locale)
  const connectWorkspace = vi.fn(async () => SESSION_ID)
  const workspaceList = createSnapshotStore({
    items: [] as Array<{ workspaceId: typeof WORKSPACE_ID }>,
  })
  const openSession = vi.fn()
  const openDetails = vi.fn()
  const closeDetails = vi.fn()
  const disposeLayoutProfile = vi.fn()
  const configureLayout = vi.fn(() => disposeLayoutProfile)
  const disposeOnboardingProfile = vi.fn()
  const configureOnboarding = vi.fn(() => disposeOnboardingProfile)
  ctx.provide('workspaces', { connectWorkspace, list: workspaceList } as never)
  ctx.provide('sessions', { open: openSession } as never)
  ctx.provide('conversationDetails', { open: openDetails, close: closeDetails })
  ctx.provide('layout', { configure: configureLayout } as never)
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
    openSession,
    openDetails,
    configureLayout,
    disposeLayoutProfile,
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
      'conversation.details.view': { kind: 'list', scope: 'session' },
    },
  } as never, () => null)
}

describe('PaperAI workbench browser plugin', () => {
  it('requires the generated Remote mount instead of a guessed namespace', () => {
    expect(inject).toEqual([
      'slots', 'locale', 'sessions', 'workspaces', 'conversationDetails', 'layout',
      'modelsOnboarding', 'remote',
    ])
    expect(inject).not.toContain('remote.paperaiWorkbench')
  })

  it('follows late declaration, declarer reload, and plugin disposal lifetimes', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(b.slots.entries('sidebar.workspaces.content')).toHaveLength(0)
    expect(b.slots.entries('conversation.details.view')).toHaveLength(0)

    const stop = declare(b.slots)
    await vi.waitFor(() => {
      expect(b.slots.entries('sidebar.workspaces.content')[0]?.component).toBe(WorkspaceContent)
      expect(b.slots.entries('conversation.details.view')[0]?.component).toBe(DocumentWorkbench)
    })
    expect(b.slots.entries('sidebar.workspaces.content')[0]?.options).toMatchObject({
      id: PAPERAI_DETAILS_VIEW_ID, order: 10,
    })
    expect(b.slots.entries('conversation.details.view')[0]?.locale).toBe(NS)
    expect(b.locale.bind(NS)('tab.preview')).toBe('预览')

    stop()
    expect(b.slots.entries('sidebar.workspaces.content')).toHaveLength(0)
    expect(b.slots.entries('conversation.details.view')).toHaveLength(0)
    declare(b.slots)
    await vi.waitFor(() => {
      expect(b.slots.entries('conversation.details.view')).toHaveLength(1)
    })

    const workspace = (b.slots.entries('sidebar.workspaces.content')[0]!.inject as unknown as
      () => PaperAIWorkspaceContentInjected)()
    await fiber.dispose()
    expect(b.configureLayout).toHaveBeenCalledWith(PAPERAI_LAYOUT_CONFIG)
    expect(b.disposeLayoutProfile).toHaveBeenCalledOnce()
    expect(b.configureOnboarding).toHaveBeenCalledWith({
      welcomeNotice: false,
      deepSeekCredential: false,
    })
    expect(b.disposeOnboardingProfile).toHaveBeenCalledOnce()
    expect(b.mountRemote).toHaveBeenCalledWith(paperAIWorkbenchRemote)
    expect(b.disposeRemote).toHaveBeenCalledOnce()
    expect(b.slots.entries('sidebar.workspaces.content')).toHaveLength(0)
    expect(() => workspace.ensureResources(WORKSPACE_ID)).toThrow('controller disposed')
    await b.ctx.fiber.dispose()
  })

  it('initializes a PaperAI project as soon as a DSH Workspace enters the ledger', async () => {
    const b = await bench()
    declare(b.slots)
    const list = vi.spyOn(b.remote, 'list')
    await b.ctx.plugin({ inject: [...inject], apply }).await()

    b.workspaceList.set({ items: [{ workspaceId: WORKSPACE_ID }] })

    await vi.waitFor(() => { expect(list).toHaveBeenCalledOnce() })
    expect(list).toHaveBeenCalledWith({ workspaceId: WORKSPACE_ID }, expect.any(AbortSignal))
    await b.ctx.fiber.dispose()
  })

  it('connects a blank Workspace Session before opening the PaperAI details view', async () => {
    const b = await bench()
    declare(b.slots)
    const open = vi.spyOn(b.remote, 'open')
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const workspace = (b.slots.entries('sidebar.workspaces.content')[0]!.inject as unknown as
      () => PaperAIWorkspaceContentInjected)()

    await workspace.openResource(WORKSPACE_ID, RESOURCE_ID)
    expect(b.connectWorkspace).toHaveBeenCalledWith(WORKSPACE_ID)
    expect(b.openSession).toHaveBeenCalledWith(SESSION_ID)
    expect(b.openDetails).toHaveBeenCalledWith(PAPERAI_DETAILS_VIEW_ID, SESSION_ID)
    expect(b.openDetails).toHaveBeenCalledTimes(2)
    expect(open).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      resourceId: RESOURCE_ID,
    }, expect.any(AbortSignal))

    const details = (b.slots.entries('conversation.details.view')[0]!.inject as unknown as
      (sessionId: typeof SESSION_ID) => PaperAIDocumentWorkbenchInjected)(SESSION_ID)
    expect(details.hooks.workbench.getSnapshot()).toMatchObject({ phase: 'ready' })
    expect(typeof details.selectNode).toBe('function')
    expect(typeof details.updateDraft).toBe('function')
    expect(typeof details.discardDraft).toBe('function')
    expect(typeof details.commitSelected).toBe('function')
    expect(typeof details.loadTemplates).toBe('function')
    expect(typeof details.installTemplate).toBe('function')
    expect(typeof details.uploadTemplate).toBe('function')
    expect(typeof details.confirmTemplate).toBe('function')
    expect(typeof details.associateTemplate).toBe('function')
    expect(typeof details.exportDocument).toBe('function')
    expect(typeof details.reloadExternal).toBe('function')
    expect(typeof details.dismissExternal).toBe('function')
    expect('save' in details).toBe(false)

    details.selectTab('preview')
    await expect(details.retryOpen()).resolves.toBeUndefined()
    await expect(details.selectNode(NODE_HEADING)).resolves.toEqual({ ok: true })
    details.updateDraft('Local draft')
    details.discardDraft()
    await expect(details.commitSelected()).resolves.toEqual({
      ok: false, error: 'selected node has no changes',
    })
    await expect(details.validate()).resolves.toEqual({ ok: true })
    await expect(details.loadTemplates()).resolves.toEqual({ ok: true })
    await expect(details.installTemplate(HIT_PACK_ID, HIT_PROPOSAL_MEMBER_ID))
      .resolves.toEqual({ ok: true })
    await expect(details.uploadTemplate({
      fileName: 'custom.docx', contentBase64: 'UEsDBAoAAAAA',
      name: 'Custom', usage: 'format-reference',
    })).resolves.toEqual({ ok: true })
    await expect(details.confirmTemplate(HIT_TEMPLATE_ID)).resolves.toEqual({ ok: true })
    await expect(details.associateTemplate(HIT_TEMPLATE_ID)).resolves.toEqual({ ok: true })
    await expect(details.exportDocument('draft-export')).resolves.toEqual({ ok: true })
    await expect(details.reloadExternal()).resolves.toEqual({
      ok: false, error: 'no external document update',
    })
    details.dismissExternal()
    await expect(details.restore(COMMIT_0)).resolves.toEqual({ ok: true })
    await b.ctx.fiber.dispose()
  })

  it('forwards durable document-head events into a clean open workbench', async () => {
    const b = await bench()
    declare(b.slots)
    b.remote.open = vi.fn<typeof b.remote.open>()
      .mockResolvedValueOnce({ ok: true, value: documentOpenResult() })
      .mockResolvedValueOnce({ ok: true, value: documentOpenResult(REVISION_2) })
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const workspace = (b.slots.entries('sidebar.workspaces.content')[0]!.inject as unknown as
      () => PaperAIWorkspaceContentInjected)()
    await workspace.openResource(WORKSPACE_ID, RESOURCE_ID)
    expect(b.onRemote).toHaveBeenCalledWith('paperai/document-changed', expect.any(Function))
    b.emitRemote('paperai/document-changed', {
      documentId: DOCUMENT_ID,
      headCommitId: COMMIT_2,
      updatedAt: '2026-08-28T12:00:00.000Z',
    })
    const details = (b.slots.entries('conversation.details.view')[0]!.inject as unknown as
      (sessionId: typeof SESSION_ID) => PaperAIDocumentWorkbenchInjected)(SESSION_ID)
    await vi.waitFor(() => {
      expect(details.hooks.workbench.getSnapshot()).toMatchObject({
        externalUpdate: null,
        document: { revision: REVISION_2, headCommitId: COMMIT_2 },
      })
    })
    await b.ctx.fiber.dispose()
  })

  it('connects the Workspace before importing a browser-selected Word source', async () => {
    const b = await bench()
    declare(b.slots)
    const importDocument = vi.spyOn(b.remote, 'importDocument')
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const workspace = (b.slots.entries('sidebar.workspaces.content')[0]!.inject as unknown as
      () => PaperAIWorkspaceContentInjected)()

    await expect(workspace.importDocument(WORKSPACE_ID, {
      fileName: 'proposal.docx',
      contentBase64: 'UEsDBAoAAAAA',
      role: 'proposal',
    })).resolves.toEqual({ ok: true })
    expect(b.connectWorkspace).toHaveBeenCalledWith(WORKSPACE_ID)
    expect(b.openSession).toHaveBeenCalledWith(SESSION_ID)
    expect(b.openDetails).toHaveBeenCalledWith(PAPERAI_DETAILS_VIEW_ID, SESSION_ID)
    expect(b.openDetails).toHaveBeenCalledTimes(2)
    expect(importDocument).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      fileName: 'proposal.docx',
      contentBase64: 'UEsDBAoAAAAA',
      role: 'proposal',
    }, expect.any(AbortSignal))
    await b.ctx.fiber.dispose()
  })

  it('projects Workspace callback failures and refreshes loaded state after reconnect', async () => {
    const b = await bench()
    declare(b.slots)
    const list = vi.spyOn(b.remote, 'list')
    const open = vi.spyOn(b.remote, 'open')
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const workspace = (b.slots.entries('sidebar.workspaces.content')[0]!.inject as unknown as
      () => PaperAIWorkspaceContentInjected)()

    expect(workspace.hooks.resources.getSnapshot().workspaces[WORKSPACE_ID]).toBeUndefined()
    await workspace.ensureResources(WORKSPACE_ID)
    await workspace.ensureResources(WORKSPACE_ID)
    await workspace.refreshResources(WORKSPACE_ID)
    expect(list).toHaveBeenCalledTimes(2)
    await workspace.openResource(WORKSPACE_ID, RESOURCE_ID)
    b.ctx.emit('connection/reset')
    await vi.waitFor(() => {
      expect(list).toHaveBeenCalledTimes(3)
      expect(open).toHaveBeenCalledTimes(2)
    })

    b.connectWorkspace.mockRejectedValueOnce(new Error('Workspace connect failed'))
    await workspace.openResource(WORKSPACE_ID, RESOURCE_ID)
    expect(workspace.hooks.resources.getSnapshot().workspaces[WORKSPACE_ID]).toMatchObject({
      phase: 'error', error: 'Workspace connect failed',
    })
    b.connectWorkspace.mockRejectedValueOnce('Workspace unavailable')
    await expect(workspace.importDocument(WORKSPACE_ID, {
      fileName: 'proposal.docx', contentBase64: 'UEsDBAoAAAAA', role: 'proposal',
    })).resolves.toEqual({ ok: false, error: 'Workspace unavailable' })
    b.connectWorkspace.mockRejectedValueOnce(new Error('Import connect failed'))
    await expect(workspace.importDocument(WORKSPACE_ID, {
      fileName: 'proposal.docx', contentBase64: 'UEsDBAoAAAAA', role: 'proposal',
    })).resolves.toEqual({ ok: false, error: 'Import connect failed' })
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
    expect(b.slots.entries('sidebar.workspaces.content')).toHaveLength(0)
    expect(b.slots.entries('conversation.details.view')).toHaveLength(0)
    await b.ctx.fiber.dispose()
  })
})
