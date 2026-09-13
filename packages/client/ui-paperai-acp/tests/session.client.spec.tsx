// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { AcpSessionDetails } from '@paperai/agent-acp/diagnostic-types'
import { AcpSessionController } from '../src/client/session-controller.ts'
import { AcpSessionControls, type AcpSessionProps } from '../src/client/SessionControls.tsx'
import { t, english } from './translations.client.ts'

afterEach(cleanup)
const id = 'acp-controls' as SessionId
const details: AcpSessionDetails = {
  provider: 'codex', name: 'Codex', connected: true, externalSessionId: 'external', capabilities: {},
  options: [
    { id: 'model', name: '模型', category: 'model', description: null, value: 'a', editable: true,
      choices: [{ value: 'a', name: 'Alpha' }, { value: 'b', name: 'Beta' }] },
    { id: 'fast', name: '快速模式', category: null, description: '快速回答', value: false, choices: [], editable: true },
    { id: 'effort', name: '推理强度', category: null, description: null, value: 'unknown', editable: true,
      choices: [{ value: 'high', name: 'High' }] },
    { id: 'mode', name: '权限模式', category: null, description: null, value: 'plan', choices: [], editable: false },
  ],
  state: { commands: [{ name: 'help', description: '帮助', hint: null }], title: null, updatedAt: null,
    usage: { used: 20, size: 100, cost: { amount: 0.01, currency: 'USD' } }, stopReason: 'end_turn',
    plans: [{ id: 'p1', text: '先检查论文', entries: [
      { content: '读取', status: 'completed' }, { content: '修改', status: 'in_progress' }, { content: '导出', status: 'pending' },
    ] }], compactions: [{ id: 'c1', status: 'completed', summary: 'Summary', error: null }],
  },
}

it('keeps the latest session observation and invalidates an in-flight refresh on disconnect', async () => {
  const remote = { acpSession: vi.fn().mockResolvedValue({ ok: true, value: details }), acpSelectOption: vi.fn() }
  const controller = new AcpSessionController(remote, id)
  await controller.load()
  expect(controller.store.getSnapshot().details?.connected).toBe(true)
  const pending = Promise.withResolvers<unknown>()
  remote.acpSession.mockReturnValueOnce(pending.promise)
  const loading = controller.load()
  controller.disconnected()
  pending.resolve({ ok: true, value: details })
  await loading
  expect(controller.store.getSnapshot().details?.connected).toBe(false)
  remote.acpSession.mockResolvedValueOnce({ ok: false, error: { message: 'Unavailable' } })
  await controller.load()
  expect(controller.store.getSnapshot().error).toContain('Unavailable')
  controller.dispose()
  remote.acpSession.mockClear()
  await controller.load()
  await controller.select('model', 'b')
  expect(remote.acpSession).not.toHaveBeenCalled()
  expect(remote.acpSelectOption).not.toHaveBeenCalled()
})

it('serializes option changes and retains provider rejection after refreshing the settled selection', async () => {
  const pending = Promise.withResolvers<unknown>()
  const remote = { acpSession: vi.fn().mockResolvedValue({ ok: true, value: details }),
    acpSelectOption: vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue({ ok: true }) }
  const controller = new AcpSessionController(remote, id)
  const first = controller.select('model', 'bad')
  await controller.select('model', 'b')
  expect(remote.acpSelectOption).toHaveBeenCalledTimes(1)
  pending.resolve({ ok: false, error: { message: 'Model rejected' } })
  await first
  expect(controller.store.getSnapshot()).toMatchObject({ busy: false, error: 'Error: Model rejected', details })
  await controller.select('fast', true)
  expect(controller.store.getSnapshot().error).toBeNull()
  remote.acpSession.mockRejectedValueOnce(new Error('Disconnected'))
  await controller.load()
  expect(controller.store.getSnapshot().error).toContain('Disconnected')
  await controller.load()
  expect(controller.store.getSnapshot().error).toBeNull()
  controller.dispose()
})

it('clears the old Agent choices immediately and ignores its pending option rejection after a switch', async () => {
  const pending = Promise.withResolvers<unknown>()
  const fresh = Promise.withResolvers<unknown>()
  const remote = { acpSession: vi.fn().mockResolvedValue({ ok: true, value: details }),
    acpSelectOption: vi.fn().mockReturnValue(pending.promise) }
  const controller = new AcpSessionController(remote, id)
  await controller.load()
  const selecting = controller.select('model', 'bad')
  remote.acpSession.mockReturnValueOnce(fresh.promise)
  controller.reset()
  expect(controller.store.getSnapshot()).toMatchObject({ details: null, busy: false, loading: true, error: null })
  pending.resolve({ ok: false, error: { message: 'Old Agent rejected' } })
  await selecting
  fresh.resolve({ ok: true, value: { ...details, provider: 'claude', name: 'Claude' } })
  await vi.waitFor(() =>{  expect(controller.store.getSnapshot().details?.provider).toBe('claude') })
  expect(controller.store.getSnapshot().error).toBeNull()
  controller.dispose()
})

it('offers an English retry after the first load fails without exposing stale provider choices', () => {
  const load = vi.fn()
  const state = { details: null, loading: false, busy: false, error: 'Host unavailable' }
  const props = { sessionId: id, load, t: english,
    useSessions: (fn: (value: unknown) => unknown) => fn({ byId: { [id]: { agentPreset: 'claude' } } }),
    useAcpSession: (fn: (value: unknown) => unknown) => fn(state),
    useAcpPreferences: (fn: (value: unknown) => unknown) => fn({ favorites: {}, writable: true, error: null }),
  } as unknown as AcpSessionProps
  const view = render(<AcpSessionControls {...props} />)
  expect(screen.getByRole('status').textContent).toContain('Could not load Agent options')
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(load).toHaveBeenCalledTimes(2)
  view.rerender(<AcpSessionControls {...props} useAcpSession={fn => fn({ ...state, details, loading: true })} />)
  expect(screen.getByRole('status').textContent).toContain('Loading Agent options')
  expect(screen.queryByRole('button', { name: /Codex/ })).toBeNull()
})

it('shows model search, favorites, native options, usage and plans while keeping permission changes locked', async () => {
  const load = vi.fn().mockResolvedValue(undefined)
  const select = vi.fn().mockResolvedValue(undefined)
  const favorite = vi.fn().mockResolvedValue(undefined)
  const state = { details, loading: false, busy: false, error: null as string | null }
  const preferences = { favorites: { codex: ['b'] }, writable: true, error: null as string | null }
  const props = { sessionId: id, load, select, favorite, t, useSessions: (fn: (value: unknown) => unknown) =>
    fn({ byId: { [id]: { agentPreset: 'codex' } } }), useAcpSession: (fn: (value: unknown) => unknown) => fn(state),
  useAcpPreferences: (fn: (value: unknown) => unknown) => fn(preferences) } as unknown as AcpSessionProps
  const view = render(<AcpSessionControls {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'Codex ACP 会话选项' }))
  expect(screen.getByLabelText(/权限模式/)).toHaveProperty('disabled', true)
  fireEvent.change(screen.getByLabelText('搜索 ACP 模型'), { target: { value: 'beta' } })
  expect(screen.queryByRole('button', { name: /Alpha/ })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: /^Beta/ }))
  expect(select).toHaveBeenCalledWith('model', 'b')
  fireEvent.click(screen.getByRole('button', { name: '取消收藏 Beta' }))
  expect(favorite).toHaveBeenCalledWith('codex', 'b')
  fireEvent.change(screen.getByLabelText('自定义模型 ID'), { target: { value: ' custom-model ' } })
  fireEvent.click(screen.getByRole('button', { name: '应用模型' }))
  expect(select).toHaveBeenCalledWith('model', 'custom-model')
  fireEvent.click(screen.getByLabelText(/快速模式/))
  expect(select).toHaveBeenCalledWith('fast', true)
  fireEvent.change(screen.getByLabelText('推理强度'), { target: { value: 'high' } })
  expect(select).toHaveBeenCalledWith('effort', 'high')
  expect(screen.getByText(/累计费用 0.01 USD/)).toBeTruthy()
  expect(screen.getByText('先检查论文')).toBeTruthy()
  expect(screen.getByText('/help · 帮助')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '刷新选项' }))
  state.details = { ...details, connected: false, externalSessionId: null,
    state: { ...details.state, usage: { used: 0, size: 100, cost: null },
      compactions: [{ id: 'failed', status: 'failed', summary: '', error: 'Compaction failed' }] } }
  state.error = 'Connection lost'
  preferences.error = 'Preferences unavailable'
  view.rerender(<AcpSessionControls {...props} />)
  expect(screen.getByText(/未连接 · ACP 选项/)).toBeTruthy()
  expect(screen.getByLabelText(/快速模式/)).toHaveProperty('disabled', true)
  expect(screen.getAllByRole('alert')).toHaveLength(3)
  fireEvent.click(screen.getByRole('button', { name: '关闭 ACP 会话选项' }))
  view.rerender(<AcpSessionControls {...props} useAcpSession={fn => fn({ ...state, details: null })} />)
  expect(screen.queryByRole('button', { name: 'Codex ACP 会话选项' })).toBeNull()
})
