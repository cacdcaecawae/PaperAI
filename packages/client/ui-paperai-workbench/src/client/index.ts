/** DSH-native PaperAI plugin: sidebar documents, project start page, template library, and document view. */

import type { ClientContext, SessionId, WorkspaceId } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { Config as LayoutConfig } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-models/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import paperAIWorkbenchRemote from '@paperai/workbench-service/remote'
import { PaperAIWorkbenchController } from './controller.ts'
import { resolvePreviewBudget, type Config } from '../config.ts'
import { selectionSource, wordSelectionReference } from './selection-context.ts'
import { DiagnosticsController } from './diagnostics-controller.ts'
import { AgentDiagnostics } from './AgentDiagnostics.tsx'
import { WordSelectionMessage } from './WordSelectionMessage.tsx'

export type { Config } from '../config.ts'
import { DocumentWorkbench } from './DocumentWorkbench.tsx'
import { en, zh, type PaperAIWorkbenchKey } from './locales.ts'
import type {
  PaperAIDocumentWorkbenchInjected, PaperAILibraryInjected, PaperAIStartPageInjected,
  PaperAIWorkspaceContentInjected,
} from './slots.ts'
import { StartPage } from './StartPage.tsx'
import { TemplatesSection } from './TemplateLibrary.tsx'
import { WorkspaceContent } from './WorkspaceContent.tsx'
import type { PaperAIActionResult, PaperAIWorkbenchRemote } from './types.ts'

export type {
  PaperAIDocumentWorkbenchInjected, PaperAIDocumentWorkbenchProps, PaperAILibraryInjected,
  PaperAIStartMarkOwnerProps, PaperAIStartPageInjected, PaperAIStartPageProps,
  PaperAITemplatesSectionProps, PaperAIWorkspaceContentInjected, PaperAIWorkspaceContentProps,
} from './slots.ts'
export type * from './types.ts'
export type { PaperAIWorkbenchKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** PaperAI documents, start page, template library, and document-view copy. */
    'paperai.workbench': PaperAIWorkbenchKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'paperai.workbench'
/** Additive details-view id selected through `ctx.conversationDetails`. */
export const PAPERAI_DETAILS_VIEW_ID = 'paperai'
/** Settings section id of the template library page. */
export const PAPERAI_TEMPLATES_SECTION_ID = 'paperai-templates'

/** PaperAI's wide document-view profile over the unchanged DSH defaults. */
export const PAPERAI_LAYOUT_CONFIG: Readonly<LayoutConfig> = Object.freeze({
  centerMin: 360,
  detailsMin: 480,
  detailsDefault: 760,
  detailsMax: 1280,
  detailsVisibility: 'current-session',
  detailsNarrowMode: 'focus',
  detailsPosition: 'start',
})

/** Required DSH services, including the generated Remote contribution mount. */
export const inject = [
  'slots', 'locale', 'sessions', 'workspaces', 'conversationDetails', 'layout',
  'modelsOnboarding', 'remote',
  'conversation', 'inputTriggers',
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

/** Register the generated Remote and the four PaperAI entries. */
export async function apply(ctx: ClientContext, config: Config = {}): Promise<() => Promise<void>> {
  const previewBudget = resolvePreviewBudget(config)
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
  const controller = new PaperAIWorkbenchController(remote, previewBudget)
  const diagnostics = new DiagnosticsController(remote)

  try {
    ctx.effect(() => ctx.inputTriggers.registerSource(selectionSource()), 'paperai-ui-workbench: Word selection codec')
    ctx.slots.inject('conversation.message.userText', () => ctx.slots.register({
      name: 'conversation.message.userText', locale: NS,
      select: ({ text }) => text.includes('[Word selection]\n') ? text : null,
    }, WordSelectionMessage))
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
    ctx.slots.inject('conversation.hero.agentPreset.status', () => ctx.slots.register({
      name: 'conversation.hero.agentPreset.status', locale: NS,
      inject: () => ({
        hooks: { diagnostics: diagnostics.store },
        loadAgents: () => diagnostics.loadAgents(),
        probe: (provider: 'codex' | 'claude', force: boolean) => diagnostics.probe(provider, force),
      }),
    }, AgentDiagnostics))
    const t = ctx.locale.bind(NS)
    // A DSH Workspace is the shell-level account, while a PaperAI project is
    // the product-level account that also owns the standard folders,
    // PAPERAI.md, and Git repository.  Initialize every observed Workspace as
    // soon as it enters the DSH ledger so the directory picker really means
    // "create/open a PaperAI project".
    const initializeWorkspaces = (): void => {
      for (const workspace of ctx.workspaces.list.getSnapshot().items) {
        void controller.ensureProject(workspace.workspaceId)
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

    const documentSession = async (workspaceId: WorkspaceId): Promise<SessionId> => {
      const current = ctx.sessions.list.getSnapshot().current
      const workspace = ctx.workspaces.list.getSnapshot().items.find(item => item.workspaceId === workspaceId)
      return current !== undefined && workspace?.sessionIds.includes(current) === true
        ? current
        : await ctx.workspaces.connectWorkspace(workspaceId)
    }

    // Import and template start share one gesture: connect the Workspace,
    // show its Session, open the document view, then establish the document.
    const startDocument = async (
      workspaceId: WorkspaceId,
      establish: (sessionId: SessionId) => Promise<PaperAIActionResult>,
    ): Promise<PaperAIActionResult> => {
      try {
        const sessionId = await documentSession(workspaceId)
        ctx.sessions.open(sessionId)
        ctx.conversationDetails.open(PAPERAI_DETAILS_VIEW_ID, sessionId)
        const result = await establish(sessionId)
        await settleDetailsSelection(ctx, sessionId)
        return result
      } catch (error: unknown) {
        controller.failWorkspace(workspaceId, error)
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }

    const libraryInjected: PaperAILibraryInjected = {
      hooks: { library: controller.libraryStore() },
      loadLibrary: force => controller.loadLibrary(force),
      createTemplateSet: input => controller.createTemplateSet(input),
      deleteTemplateSet: packId => controller.deleteTemplateSet(packId),
      addTemplateFormat: input => controller.addTemplateFormat(input),
      removeTemplateFormat: (packId, documentType) => controller.removeTemplateFormat(packId, documentType),
    }

    const workspaceInjected: PaperAIWorkspaceContentInjected = {
      hooks: { projects: controller.projectDirectoryStore(), diagnostics: diagnostics.store },
      inspectProject: async (workspaceId, plan) => {
        await diagnostics.inspect(workspaceId, plan)
        if (plan !== undefined) controller.refreshLoaded()
      },
      ensureProject: workspaceId => controller.ensureProject(workspaceId),
      refreshProject: workspaceId => controller.loadProject(workspaceId),
      openDocument: async (workspaceId, resourceId) => {
        try {
          const sessionId = await documentSession(workspaceId)
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
    }

    const startPageInjected: PaperAIStartPageInjected = {
      ...libraryInjected,
      hooks: { library: controller.libraryStore(), projects: controller.projectDirectoryStore() },
      ensureProject: workspaceId => controller.ensureProject(workspaceId),
      setProjectTemplate: (workspaceId, packId) => controller.setProjectTemplate(workspaceId, packId),
      createFromTemplate: (workspaceId, input) => startDocument(
        workspaceId,
        sessionId => controller.createFromTemplate(workspaceId, sessionId, input),
      ),
      importDocument: (workspaceId, input) => startDocument(
        workspaceId,
        sessionId => controller.importDocument(workspaceId, sessionId, input),
      ),
    }

    ctx.slots.inject('sidebar.workspaces.content', () => ctx.slots.register({
      name: 'sidebar.workspaces.content',
      id: PAPERAI_DETAILS_VIEW_ID,
      order: 10,
      locale: NS,
      inject: () => workspaceInjected,
    }, WorkspaceContent))

    ctx.slots.inject('conversation.hero.content', () => ctx.slots.register({
      name: 'conversation.hero.content',
      locale: NS,
      children: { 'paperai.start.mark': { kind: 'single', scope: 'root' } },
      inject: () => startPageInjected,
    }, StartPage))

    ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section',
      id: PAPERAI_TEMPLATES_SECTION_ID,
      order: 12,
      label: () => t('library.title'),
      locale: NS,
      inject: () => libraryInjected,
    }, TemplatesSection))

    ctx.slots.inject('conversation.details.view', () => ctx.slots.register({
      name: 'conversation.details.view',
      id: PAPERAI_DETAILS_VIEW_ID,
      order: 10,
      locale: NS,
      inject: (sessionId: SessionId): PaperAIDocumentWorkbenchInjected => ({
        ...libraryInjected,
        hooks: {
          library: controller.libraryStore(),
          workbench: controller.workbenchStore(sessionId),
          projects: controller.projectDirectoryStore(),
        },
        retryOpen: () => controller.retryOpen(sessionId),
        setScroll: (scrollTop) => { controller.setScroll(sessionId, scrollTop) },
        quoteSelection: (document, excerpt) => {
          const scope = ctx.sessions.scope(sessionId)
          if (scope === undefined) return
          const input = ctx.conversation.input.for(scope)
          const state = input.state.getSnapshot()
          const accepted = input.insertReference(wordSelectionReference(document, excerpt), {
            start: state.draft.length, end: state.draft.length, draftRev: state.draftRev,
          })
          if (!accepted) input.notify('error', ctx.locale.bind(NS)('selection.busy'))
          if (accepted) ctx.layout.revealConversation()
        },
        showPanel: (panel) => { controller.showPanel(sessionId, panel) },
        selectBlock: nodeId => controller.selectBlock(sessionId, nodeId),
        updateDraft: (value) => { controller.updateDraft(sessionId, value) },
        cancelEdit: () => { controller.cancelEdit(sessionId) },
        commitEdit: () => controller.commitEdit(sessionId),
        validate: () => controller.validate(sessionId),
        suggestType: () => controller.suggestType(sessionId),
        applyTemplate: documentType => controller.applyTemplate(sessionId, documentType),
        detachTemplate: () => controller.detachTemplate(sessionId),
        setProjectTemplate: (workspaceId, packId) => controller.setProjectTemplate(workspaceId, packId),
        showDiff: commitId => controller.showDiff(sessionId, commitId),
        restore: commitId => controller.restore(sessionId, commitId),
        exportDocument: mode => controller.exportDocument(sessionId, mode),
        reloadExternal: () => controller.reloadExternal(sessionId),
        setDetailsFocus: (active) => { ctx.layout.setDetailsFocus(active) },
      }),
    }, DocumentWorkbench))
  } catch (error) {
    diagnostics.dispose()
    controller.dispose()
    await disposeRemote()
    throw error
  }

  return async () => {
    diagnostics.dispose()
    controller.dispose()
    await disposeRemote()
  }
}
