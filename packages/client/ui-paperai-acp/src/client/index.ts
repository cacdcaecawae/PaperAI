/** ACP settings contributions over the shared PaperAI Remote and DSH settings mirror. */

import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import type { TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type {} from '@paperai/agent-acp/diagnostic-types'
import { AcpSettingsController } from './controller.ts'
import { AcpSettingsSection, type AcpSettingsInjected } from './SettingsSection.tsx'
import { AcpSessionController } from './session-controller.ts'
import { AcpSessionControls, type AcpSessionInjected } from './SessionControls.tsx'
import { zh, en, type AcpKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** PaperAI Agent connection settings and session controls. */
    'paperai.acp': AcpKey
  }
}

export type { AcpChannelMarkOwnerProps } from './brand-slot.ts'

/** Required runtime services; the workbench plugin owns the shared generated Remote mount. */
export const inject = ['slots', 'locale', 'sessions', 'settingsScope', 'connection', 'remote', 'remote.paperaiWorkbench', 'modelDirectories']

/**
 * Register ACP settings and dispose the controller with its contribution scope.
 * @param ctx - browser plugin context with the shared Host namespace mounted.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register('paperai.acp', { zh, en }), 'paperai-acp: dictionaries')
  const connection = ctx.get('connection') as ConnectionHandle
  const remote = ctx.get('remote.paperaiWorkbench') as TypertClientRemote['paperaiWorkbench']
  const controller = new AcpSettingsController(remote, connection.api, ctx.settingsScope.describe(), {
    create: options => ctx.sessions.create(options),
    open: (id) => {
      ctx.sessions.open(id)
    },
    localDirectory: () => {
      const snapshot = ctx.sessions.list.getSnapshot()
      return snapshot.current === undefined ? undefined : snapshot.byId[snapshot.current]?.cwd
    },
  }, ctx.locale.bind('paperai.acp'))
  const sessions = new Map<SessionId, AcpSessionController>()
  const sessionFor = (id: SessionId): AcpSessionController => {
    const existing = sessions.get(id)
    if (existing !== undefined) return existing
    const scope = ctx.sessions.scope(id)
    if (scope === undefined) throw new Error(`ACP controls require an open session: ${id}`)
    const session = new AcpSessionController(remote, id)
    sessions.set(id, session)
    scope.effect(
      () => () => {
        session.dispose()
        sessions.delete(id)
      },
      'paperai-acp: session controls',
    )
    return session
  }
  const injected: AcpSettingsInjected = {
    hooks: { acp: controller.store },
    load: () => controller.load(),
    probe: id => controller.probe(id),
    cancel: id => controller.cancel(id),
    edit: (id) => {
      controller.edit(id)
    },
    updateDraft: (patch) => {
      controller.updateDraft(patch)
    },
    cancelEdit: () => {
      controller.cancelEdit()
    },
    save: () => controller.save(),
    setDefault: id => controller.setDefault(id),
    manage: (id, action) => controller.manage(id, action),
    install: (id, action) => controller.install(id, action),
    importHistory: (id, history) => controller.importHistory(id, history),
  }
  ctx.effect(
    () => () => {
      controller.dispose()
      for (const session of sessions.values()) session.dispose()
      sessions.clear()
    },
    'paperai-acp: controllers',
  )
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'paperai-acp',
        locale: 'paperai.acp',
        order: -20,
        label: 'Agent',
        children: { 'paperai.acp.channel.mark': { kind: 'keyed', scope: 'root' } },
        inject: () => injected,
      },
      AcpSettingsSection,
    ),
  )
  ctx.slots.inject('conversation.session.header.actions', () =>
    ctx.slots.register(
      {
        name: 'conversation.session.header.actions',
        id: 'paperai-acp-options',
        locale: 'paperai.acp',
        order: 0,
        inject: (id): AcpSessionInjected => {
          const session = sessionFor(id)
          return {
            hooks: { acpSession: session.store, acpPreferences: controller.store },
            load: () => session.load(),
            select: async (option, value) => {
              await session.select(option, value)
              if (sessions.get(id) !== session) return
              await ctx.modelDirectories.directoryFor(id).load().catch(() => {
                // The shared model menu retains its last selection and owns refresh-error feedback.
              })
            },
            favorite: (provider, model) => controller.favorite(provider, model),
          }
        },
      },
      AcpSessionControls,
    ),
  )
  ctx.effect(
    () =>
      ctx.remote.$on('paperai/acp-changed', (id) => {
        void sessions.get(id)?.load(false)
        if (controller.store.getSnapshot().entries.length > 0) void controller.load(false)
      }),
    'paperai-acp: provider state',
  )
  ctx.effect(
    () =>
      ctx.remote.$on('agent-preset/selected', (id) => {
        sessions.get(id)?.reset()
      }),
    'paperai-acp: selected agent',
  )
  ctx.effect(
    () =>
      connection.hostDescription.subscribe(() => {
        if (connection.hostDescription.getSnapshot() === undefined) {
          controller.disconnected()
          for (const session of sessions.values()) session.disconnected()
        }
      }),
    'paperai-acp: Host connection loss',
  )
  ctx.on('connection/reset', () => {
    void controller.load(false)
    for (const session of sessions.values()) void session.load()
  })
}
