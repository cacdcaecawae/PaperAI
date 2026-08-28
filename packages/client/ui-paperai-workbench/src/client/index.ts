/** DSH-native PaperAI Workspace tree and document details workbench plugin. */

import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { Config as LayoutConfig } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-models/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import paperAIWorkbenchRemote from '@paperai/workbench-service/remote'
import { PaperAIWorkbenchController } from './controller.ts'
import { DocumentWorkbench } from './DocumentWorkbench.tsx'
import { en, zh, type PaperAIWorkbenchKey } from './locales.ts'
import type {
  PaperAIDocumentWorkbenchInjected, PaperAIWorkspaceContentInjected,
} from './slots.ts'
import { WorkspaceContent } from './WorkspaceContent.tsx'
import type { PaperAIWorkbenchRemote } from './types.ts'

export type {
  PaperAIDocumentWorkbenchInjected, PaperAIDocumentWorkbenchProps,
  PaperAIWorkspaceContentInjected, PaperAIWorkspaceContentProps,
} from './slots.ts'
export type * from './types.ts'
export type { PaperAIWorkbenchKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** PaperAI project resources and document-workbench copy. */
    'paperai.workbench': PaperAIWorkbenchKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'paperai.workbench'
/** Additive details-view id selected through `ctx.conversationDetails`. */
export const PAPERAI_DETAILS_VIEW_ID = 'paperai'

/** PaperAI's wide document-workbench profile over the unchanged DSH defaults. */
export const PAPERAI_LAYOUT_CONFIG: Readonly<LayoutConfig> = Object.freeze({
  centerMin: 560,
  detailsMin: 420,
  detailsDefault: 600,
  detailsMax: 960,
  detailsVisibility: 'current-session',
  detailsNarrowMode: 'focus',
})

/** Required DSH services, including the generated Remote contribution mount. */
export const inject = [
  'slots', 'locale', 'sessions', 'workspaces', 'conversationDetails', 'layout',
  'modelsOnboarding', 'remote',
]

/**
 * Reopen the product details view after React has committed a possible
 * Session switch.  AppFrame intentionally closes the previous Session's
 * panel in a layout effect; yielding one task prevents that cleanup from
 * winning over the explicit document-open gesture.
 */
async function settleDetailsSelection(ctx: ClientContext, sessionId: SessionId): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, 0))
  ctx.conversationDetails.open(PAPERAI_DETAILS_VIEW_ID, sessionId)
}

/** Register the generated Remote, flat Workspace content, and document details entries. */
export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(paperAIWorkbenchRemote)
  // `$mount()` publishes the generated namespace as the dynamic Cordis
  // service `remote.paperaiWorkbench`. This plugin cannot list that service in
  // its static inject set because the namespace does not exist until this very
  // mount completes. Resolve the now-live service explicitly instead of using
  // the guarded `ctx.remote.paperaiWorkbench` property from a scope that only
  // injected the parent `remote` service.
  const remote = ctx.get('remote.paperaiWorkbench') as PaperAIWorkbenchRemote | undefined
  if (remote === undefined) {
    await disposeRemote()
    throw new Error('PaperAI Workbench Remote namespace did not start')
  }
  const controller = new PaperAIWorkbenchController(remote)

  try {
    ctx.effect(
      () => ctx.layout.configure(PAPERAI_LAYOUT_CONFIG),
      'paperai-ui-workbench: document layout profile',
    )
    ctx.effect(
      () => ctx.modelsOnboarding.configure({
        welcomeNotice: false,
        deepSeekCredential: false,
      }),
      'paperai-ui-workbench: local Agent onboarding profile',
    )
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'paperai-ui-workbench: dictionaries')
    // A DSH Workspace is the shell-level account, while a PaperAI project is
    // the product-level account that also owns the standard folders,
    // PAPERAI.md, and Git repository.  Initialize every observed Workspace as
    // soon as it enters the DSH ledger so the directory picker really means
    // "create/open a PaperAI project"; the expanded resource tree remains a
    // pure view and no longer controls whether initialization happens.
    const initializeWorkspaces = (): void => {
      for (const workspace of ctx.workspaces.list.getSnapshot().items) {
        void controller.ensureResources(workspace.workspaceId)
      }
    }
    ctx.effect(
      () => ctx.workspaces.list.subscribe(initializeWorkspaces),
      'paperai-ui-workbench: eager project initialization',
    )
    initializeWorkspaces()
    ctx.on('connection/reset', () => { controller.refreshLoaded() })
    ctx.effect(
      () => ctx.remote.$on('paperai/document-changed', (change) => {
        controller.handleDocumentChanged(change)
      }),
      'paperai-ui-workbench: durable document heads',
    )

    const workspaceInjected: PaperAIWorkspaceContentInjected = {
      hooks: { resources: controller.resourceDirectoryStore() },
      ensureResources: workspaceId => controller.ensureResources(workspaceId),
      refreshResources: workspaceId => controller.loadResources(workspaceId),
      openResource: async (workspaceId, resourceId) => {
        try {
          const sessionId = await ctx.workspaces.connectWorkspace(workspaceId)
          ctx.sessions.open(sessionId)
          await settleDetailsSelection(ctx, sessionId)
          await controller.openDocument(workspaceId, sessionId, resourceId)
          // A Session switch and a details-open gesture may land in the same
          // render turn.  The generic frame closes the previous Session's
          // details in its layout effect; reopen after the document request so
          // that cleanup cannot accidentally hide the newly selected
          // PaperAI view.
          await settleDetailsSelection(ctx, sessionId)
        } catch (error: unknown) {
          controller.failWorkspace(workspaceId, error)
        }
      },
      importDocument: async (workspaceId, input) => {
        try {
          const sessionId = await ctx.workspaces.connectWorkspace(workspaceId)
          ctx.sessions.open(sessionId)
          ctx.conversationDetails.open(PAPERAI_DETAILS_VIEW_ID, sessionId)
          const result = await controller.importDocument(workspaceId, sessionId, input)
          await settleDetailsSelection(ctx, sessionId)
          return result
        } catch (error: unknown) {
          controller.failWorkspace(workspaceId, error)
          return { ok: false, error: error instanceof Error ? error.message : String(error) }
        }
      },
    }

    ctx.slots.inject('sidebar.workspaces.content', () => ctx.slots.register({
      name: 'sidebar.workspaces.content',
      id: PAPERAI_DETAILS_VIEW_ID,
      order: 10,
      locale: NS,
      inject: () => workspaceInjected,
    }, WorkspaceContent))

    ctx.slots.inject('conversation.details.view', () => ctx.slots.register({
      name: 'conversation.details.view',
      id: PAPERAI_DETAILS_VIEW_ID,
      order: 10,
      locale: NS,
      inject: (sessionId: SessionId): PaperAIDocumentWorkbenchInjected => ({
        hooks: { workbench: controller.workbenchStore(sessionId) },
        selectTab: (tab) => { controller.selectTab(sessionId, tab) },
        retryOpen: () => controller.retryOpen(sessionId),
        selectNode: nodeId => controller.selectNode(sessionId, nodeId),
        updateDraft: (value) => { controller.updateDraft(sessionId, value) },
        discardDraft: () => { controller.discardDraft(sessionId) },
        commitSelected: () => controller.commitSelected(sessionId),
        validate: () => controller.validate(sessionId),
        loadTemplates: () => controller.loadTemplates(sessionId),
        installTemplate: (packId, memberId) => controller.installTemplate(sessionId, packId, memberId),
        uploadTemplate: input => controller.uploadTemplate(sessionId, input),
        confirmTemplate: templateId => controller.confirmTemplate(sessionId, templateId),
        associateTemplate: templateId => controller.associateTemplate(sessionId, templateId),
        exportDocument: mode => controller.exportDocument(sessionId, mode),
        reloadExternal: () => controller.reloadExternal(sessionId),
        dismissExternal: () => { controller.dismissExternal(sessionId) },
        restore: commitId => controller.restore(sessionId, commitId),
      }),
    }, DocumentWorkbench))
  } catch (error) {
    controller.dispose()
    await disposeRemote()
    throw error
  }

  return async () => {
    controller.dispose()
    await disposeRemote()
  }
}
