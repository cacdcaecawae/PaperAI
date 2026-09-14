// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { createSnapshotStore, SlotRegistry, type SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { IApiClient } from '@deepseek-ai/dsh-api-remotes/client'
import { SettingsDescribeMirror } from '@deepseek-ai/dsh-client-ui-settings/src/client/settings-mirror.ts'
import * as modelsPlugin from '@deepseek-ai/dsh-client-ui-model-selection/client'
import { expect, it, vi } from 'vitest'
import * as plugin from '../src/client/index.ts'
import * as host from '../src/index.ts'
import * as invariant from '../src/invariant.ts'
import type { AcpSettingsInjected } from '../src/client/SettingsSection.tsx'
import type { AcpSessionInjected } from '../src/client/SessionControls.tsx'

it('binds shared settings and per-session controls to their existing scopes and removes listeners on disposal', async () => {
  const ctx = new Context()
  const sessionId = 'acp-plugin' as SessionId
  const sessionScope = ctx.plugin(() => {})
  await ctx.plugin(host).await()
  const companion = ctx.plugin(invariant)
  await companion.await()
  await companion.dispose()
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('locale', new LocaleRuntime(ctx))
  const slots = ctx.get('slots') as SlotRegistry
  slots.register({ name: 'root', children: {
    'settings.section': { kind: 'list', scope: 'root' },
    'conversation.session.header.actions': { kind: 'list', scope: 'session' },
  } } as never, () => null)
  const namespace = { ns: 'paperai-acp-agents', schema: {}, value: {}, revision: 1, applies: 'live', secrets: [] }
  let currentModel = 'initial-model'
  let modelsFailure = false
  const models = vi.fn(async () => modelsFailure
    ? { result: { ok: false, error: { code: 'internal', message: 'offline', details: {} } } }
    : { result: { ok: true, value: {
      current: { provider: 'codex', model: currentModel, reasoningEffort: 'medium' },
      routable: true, groups: [], failures: [],
    } } })
  const api = { sessions: { models }, settings: {
    describe: vi.fn().mockResolvedValue({ result: { ok: true, value: {
      namespaces: [namespace], writable: true, hasDocument: true,
    } } }),
    mutate: vi.fn().mockResolvedValue({ result: { ok: true, value: namespace } }),
  } } as unknown as Pick<IApiClient, 'settings'>
  const mirror = new SettingsDescribeMirror(api)
  ctx.provide('settingsScope', { describe: () => mirror } as never)
  const entry = { id: 'codex', name: 'Codex', enabled: true, connected: true, template: 'codex', source: 'remote', args: [] }
  const remote = {
    acpCatalog: vi.fn().mockResolvedValue({ ok: true, value: [entry] }),
    probeAgent: vi.fn().mockResolvedValue({ ok: true }), acpCancel: vi.fn().mockResolvedValue({ ok: true }),
    acpManage: vi.fn().mockResolvedValue({ ok: true, value: {} }), acpInstall: vi.fn().mockResolvedValue({ ok: true }),
    acpLinkedSession: vi.fn().mockResolvedValue({ ok: true, value: null }),
    acpImportHistory: vi.fn().mockResolvedValue({ ok: true, value: sessionId }),
    acpSession: vi.fn().mockResolvedValue({ ok: true, value: { provider: 'codex', connected: true } }),
    acpSelectOption: vi.fn().mockResolvedValue({ ok: true }),
  }
  const listeners = new Map<string, Set<(id: SessionId) => void>>()
  ctx.provide('remote', { $on: (event: string, listener: (id: SessionId) => void) => {
    const group = listeners.get(event) ?? new Set()
    group.add(listener)
    listeners.set(event, group)
    return () => { group.delete(listener); if (group.size === 0) listeners.delete(event) }
  } } as never)
  const emit = (event: string): void => { for (const listener of listeners.get(event) ?? []) listener(sessionId) }
  ctx.provide('remote.paperaiWorkbench', remote as never)
  const hostDescription = createSnapshotStore<unknown>({})
  ctx.provide('connection', { api, hostDescription } as never)
  const create = vi.fn().mockResolvedValue(sessionId)
  const open = vi.fn()
  const list = createSnapshotStore<{ current: SessionId | undefined; byId: Record<string, { cwd: string }> }>({
    current: sessionId, byId: { [sessionId]: { cwd: '/local' } },
  })
  ctx.provide('sessions', { create, open, list,
    scope: (id: SessionId) => id === sessionId ? sessionScope.ctx : undefined,
    subagentAddress: () => undefined,
  } as never)
  ctx.provide('commandUi', { register: () => () => {} } as never)
  const modelsFiber = ctx.plugin(modelsPlugin)
  await modelsFiber.await()
  const modelListeners = new Map(Array.from(listeners, ([event, group]) => [event, new Set(group)]))
  try {
    const fiber = ctx.plugin(plugin)
    await fiber.await()
    const settings = (slots.entries('settings.section')[0]!.inject as unknown as () => AcpSettingsInjected)()
    await settings.load()
    settings.edit('codex')
    settings.updateDraft({ name: 'Research' })
    await settings.save()
    settings.edit('codex')
    settings.cancelEdit()
    await settings.probe('codex')
    await settings.cancel('codex')
    await settings.setDefault('claude')
    await settings.manage('codex', { kind: 'providers' })
    await settings.install('codex', 'install')
    const history = { sessionId: 'external', cwd: '/remote', title: null, updatedAt: null, additionalDirectories: [] }
    expect(await settings.importHistory('codex', history)).toBe(true)
    expect(create).toHaveBeenCalledWith({ cwd: '/local', agentPreset: 'codex' })
    expect(open).toHaveBeenCalledWith(sessionId)
    list.update((value) => { value.current = undefined })
    expect(await settings.importHistory('codex', history)).toBe(false)
    const injectSession = slots.entries('conversation.session.header.actions')[0]!.inject as unknown as
      (id: SessionId) => AcpSessionInjected
    expect(() => injectSession('unknown' as SessionId)).toThrow('require an open session')
    const session = injectSession(sessionId)
    expect(injectSession(sessionId).hooks.acpSession).toBe(session.hooks.acpSession)
    const directory = ctx.modelDirectories.directoryFor(sessionId)
    await directory.load()
    expect(directory.store.getSnapshot().current?.model).toBe('initial-model')
    remote.acpSelectOption.mockImplementation(async ({ value }: { value: string }) => {
      currentModel = value
      return { ok: true }
    })
    await session.load()
    await session.select('model', 'a')
    expect(directory.store.getSnapshot().current).toMatchObject({ model: 'a', reasoningEffort: 'medium' })
    modelsFailure = true
    await session.select('model', 'b')
    expect(directory.store.getSnapshot()).toMatchObject({ current: { model: 'a' }, error: 'load' })
    modelsFailure = false
    await session.select('model', 'a')
    await session.favorite('codex', 'a')
    expect(remote.acpSelectOption).toHaveBeenCalledWith({ sessionId, option: 'model', value: 'a' })
    remote.acpSession.mockClear()
    emit('paperai/acp-changed')
    emit('agent-preset/selected')
    await vi.waitFor(() =>{  expect(remote.acpSession).toHaveBeenCalledTimes(2) })
    hostDescription.set(undefined)
    expect(session.hooks.acpSession.getSnapshot().details?.connected).toBe(false)
    expect(settings.hooks.acp.getSnapshot().entries[0]?.connected).toBe(false)
    await ctx.parallel('connection/reset')
    await vi.waitFor(() =>{  expect(session.hooks.acpSession.getSnapshot().details?.connected).toBe(true) })
    await sessionScope.dispose()
    remote.acpSession.mockClear()
    models.mockClear()
    await session.load()
    await session.select('model', 'disposed')
    expect(remote.acpSession).not.toHaveBeenCalled()
    expect(models).not.toHaveBeenCalled()
    await fiber.dispose()
    expect(slots.entries('settings.section')).toHaveLength(0)
    expect(slots.entries('conversation.session.header.actions')).toHaveLength(0)
    expect(listeners).toEqual(modelListeners)
    await modelsFiber.dispose()
    remote.acpCatalog.mockClear()
    await settings.load()
    expect(remote.acpCatalog).not.toHaveBeenCalled()
  } finally { await ctx.fiber.dispose() }
})
