// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import type { ModelSelection, SessionId, SessionModels } from '@deepseek-ai/dsh-api-remotes/client'
import { ModelDirectoryResolver } from '../src/client/service.ts'
import { ModelSelect } from '../src/client/ModelSelect.tsx'
import { en, zh } from '../src/client/locales.ts'

const sessionId = 'driver-change' as SessionId
const contexts: Context[] = []
const previous: SessionModels = {
  current: { provider: 'codex', model: 'old-model', reasoningEffort: 'high' },
  routable: true,
  failures: [],
  switches: [{ id: 'fast', name: 'Old fast mode', enabled: true }],
  groups: [{ id: 'codex', name: 'Codex', models: [{
    id: 'old-model', name: 'Old Codex model',
    reasoning: { defaultEffort: 'high', efforts: [{ id: 'high', name: 'Old high effort' }] },
  }] }],
}
const fresh: SessionModels = {
  current: { provider: 'claude', model: 'alpha' }, routable: true, failures: [], switches: [],
  groups: [{ id: 'claude', name: 'Claude', models: [
    { id: 'alpha', name: 'Claude Alpha' }, { id: 'beta', name: 'Claude Beta' },
  ] }],
}
const failure = { result: { ok: false as const, error: { code: 'internal', message: 'provider diagnostic', details: {} } } }
const modelsReply = (value: SessionModels) => ({ result: { ok: true as const, value } })
const selectionReply = (selected: ModelSelection) => ({ result: { ok: true as const, value: { selected } } })
type ModelsReply = ReturnType<typeof modelsReply> | typeof failure
type SelectionReply = ReturnType<typeof selectionReply> | typeof failure

async function bench() {
  const ctx = new Context()
  contexts.push(ctx)
  const models = vi.fn<() => Promise<ModelsReply>>().mockResolvedValue(modelsReply(previous))
  const selectModel = vi.fn<(request: ModelSelection) => Promise<SelectionReply>>()
    .mockImplementation(async request => selectionReply(request))
  ctx.provide('connection', { api: { sessions: { models, selectModel } } } as never)
  ctx.provide('sessions', { scope: () => ctx, subagentAddress: () => undefined } as never)
  new TestRemote(ctx)
  await ctx.plugin(ModelDirectoryResolver, { blockReason: () => 'Unavailable' }).await()
  const directory = ctx.modelDirectories.directoryFor(sessionId)
  await directory.load()
  const locale = new LocaleRuntime(ctx)
  locale.register('common', { en: commonEn, zh: commonZh })
  locale.register('model', { en, zh })
  locale.setLocale('zh')
  const changeAgent = () => { ctx.remote.$dispatch('agent-preset/selected', [sessionId, 'claude']) }
  const open = async () => {
    render(<ModelSelect
      locked={false} available directory={directory.store} t={locale.bind('model')}
      load={() => { void directory.load().catch(() => undefined) }}
      select={selection => directory.select(selection).then(() => true, () => false)}
    />)
    await waitFor(() => { expect(directory.store.getSnapshot().status).toBe('ready') })
    fireEvent.click(screen.getByRole('button', { name: /选择模型/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /^模型/ }))
    await waitFor(() => { expect(directory.store.getSnapshot().status).toBe('ready') })
  }
  return { models, selectModel, directory, changeAgent, open }
}

afterEach(async () => {
  cleanup()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

it.each(['success', 'failure'] as const)('removes the old Agent choices while loading and ignores its late %s response', async (outcome) => {
  const b = await bench()
  await b.open()
  expect(screen.getByRole('menuitemradio', { name: 'Old Codex model' })).toBeTruthy()
  const obsolete = Promise.withResolvers<ModelsReply>()
  const current = Promise.withResolvers<ModelsReply>()
  b.models.mockReturnValueOnce(obsolete.promise).mockReturnValueOnce(current.promise)
  let oldLoad: Promise<unknown>
  act(() => { oldLoad = b.directory.load().catch(() => undefined) })
  act(b.changeAgent)
  expect(b.directory.store.getSnapshot()).toMatchObject({
    current: null, groups: [], failures: [], switches: [], routable: null, status: 'loading', error: null,
  })
  expect(screen.queryByRole('menuitemradio')).toBeNull()
  expect(document.body.textContent).not.toMatch(/Old Codex|Old high|Old fast/)
  await act(async () => {
    obsolete.resolve(outcome === 'success' ? modelsReply(previous) : failure)
    await oldLoad
  })
  expect(screen.queryByRole('menuitemradio')).toBeNull()
  expect(b.directory.store.getSnapshot()).toMatchObject({ status: 'loading', current: null, error: null })
  await act(async () => { current.resolve(modelsReply(fresh)) })
  expect(screen.getByRole('menuitemradio', { name: 'Claude Beta' })).toBeTruthy()
  fireEvent.click(screen.getByRole('menuitemradio', { name: 'Claude Beta' }))
  await waitFor(() => {
    expect(b.selectModel).toHaveBeenCalledWith({ sessionId, provider: 'claude', model: 'beta' })
    expect(screen.queryByRole('menu')).toBeNull()
  })
})

it('keeps a failed Agent refresh empty and retries from the open model menu', async () => {
  const b = await bench()
  await b.open()
  b.models.mockResolvedValueOnce(failure)
  act(b.changeAgent)
  expect((await screen.findByRole('alert')).textContent).toContain('暂时无法加载模型列表，请重试。')
  expect(screen.queryByRole('menuitemradio')).toBeNull()
  expect(document.body.textContent).not.toMatch(/Old Codex|provider diagnostic/)
  b.models.mockResolvedValueOnce(modelsReply(fresh))
  fireEvent.click(screen.getByRole('button', { name: '重试' }))
  expect(await screen.findByRole('menuitemradio', { name: 'Claude Beta' })).toBeTruthy()
  expect(screen.queryByRole('alert')).toBeNull()
})

it.each(['success', 'failure'] as const)('keeps the new Agent directory when an old model selection settles with %s', async (outcome) => {
  const b = await bench()
  const oldSelection = { provider: 'codex', model: 'another-old-model' }
  const pending = Promise.withResolvers<SelectionReply>()
  b.selectModel.mockReturnValueOnce(pending.promise)
  const selecting = b.directory.select(oldSelection).catch(() => undefined)
  b.models.mockResolvedValueOnce(modelsReply(fresh))
  b.changeAgent()
  await waitFor(() => { expect(b.directory.store.getSnapshot().current).toEqual(fresh.current) })
  pending.resolve(outcome === 'success' ? selectionReply(oldSelection) : failure)
  await selecting
  expect(b.directory.store.getSnapshot()).toMatchObject({ ...fresh, status: 'ready', error: null })
})
