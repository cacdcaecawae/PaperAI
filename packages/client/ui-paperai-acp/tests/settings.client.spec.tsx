// @vitest-environment jsdom
import { useSyncExternalStore } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { IApiClient, RpcId, SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import { SettingsDescribeMirror } from '@deepseek-ai/dsh-client-ui-settings/src/client/settings-mirror.ts'
import type { AcpCatalogEntry } from '@paperai/agent-acp/diagnostic-types'
import { AcpSettingsController, type AcpRemote } from '../src/client/controller.ts'
import { AcpSettingsSection, type AcpSettingsProps } from '../src/client/SettingsSection.tsx'

const controllers: AcpSettingsController[] = []
afterEach(() => {
  cleanup()
  for (const controller of controllers.splice(0)) controller.dispose()
})
const namespace: SettingsNamespaceView = {
  ns: 'paperai-acp-agents',
  schema: {},
  value: { providers: { codex: { name: 'Codex', model: 'default-model' } } },
  applies: 'live',
  secrets: [{ path: ['providers', 'codex', 'apiKey'], set: true }],
  revision: 1,
}
const entries: AcpCatalogEntry[] = ['codex', 'claude'].map(id => ({
  id,
  name: id === 'codex' ? 'Codex' : 'Claude',
  template: id,
  enabled: true,
  connected: id === 'codex',
  startup: null,
  host: 'local-host',
  command: `${id}-acp`,
  args: [],
  adapter: '/adapter',
  cli: '/cli',
  source: 'bundled',
  documentation: null,
  login: `${id} login`,
  installable: true,
  busy: null,
  output: null,
  diagnostic: {
    provider: id,
    executable: '/adapter',
    adapterVersion: '1',
    agentVersion: '2',
    status: 'ready',
    stage: 'handshake',
    models: [],
    checkedAt: 1,
    retryAt: null,
    elapsedMs: 5,
    error: null,
  },
}))

async function bench() {
  const describe = vi
    .fn()
    .mockResolvedValue({
      result: {
        ok: true,
        value: {
          namespaces: [namespace, { ...namespace, ns: 'agent-presets', value: { default: 'codex' } }],
          writable: true,
          hasDocument: true,
        },
      },
    })
  const mutate = vi
    .fn<IApiClient['settings']['mutate']>()
    .mockResolvedValue({ rpcId: 'settings-test' as RpcId, result: { ok: true, value: { ...namespace, revision: 2 } } })
  const api = { settings: { describe, mutate } } as unknown as Pick<IApiClient, 'settings'>
  const mirror = new SettingsDescribeMirror(api)
  const remote = {
    acpCatalog: vi.fn().mockResolvedValue({ ok: true, value: entries }),
    probeAgent: vi.fn().mockResolvedValue({ ok: true, value: entries[0]!.diagnostic }),
    acpCancel: vi.fn().mockResolvedValue({ ok: true }),
    acpManage: vi.fn(),
    acpInstall: vi.fn(),
    acpLinkedSession: vi.fn(),
    acpImportHistory: vi.fn(),
  } satisfies AcpRemote
  const navigation = { create: vi.fn().mockResolvedValue('created'), open: vi.fn(), localDirectory: (): string | undefined => '/local' }
  const controller = new AcpSettingsController(remote, api, mirror, navigation)
  controllers.push(controller)
  await controller.load()
  return { controller, remote, mutate, describe, navigation, mirror }
}

function settingsProps(b: Awaited<ReturnType<typeof bench>>): AcpSettingsProps {
  return {
    useAcp: selector =>
      selector(
        useSyncExternalStore(
          listener => b.controller.store.subscribe(listener),
          () => b.controller.store.getSnapshot(),
        ),
      ),
    load: () => b.controller.load(),
    probe: id => b.controller.probe(id),
    cancel: id => b.controller.cancel(id),
    edit: (id) => {
      b.controller.edit(id)
    },
    updateDraft: (patch) => {
      b.controller.updateDraft(patch)
    },
    cancelEdit: () => {
      b.controller.cancelEdit()
    },
    save: () => b.controller.save(),
    setDefault: id => b.controller.setDefault(id),
    manage: (id, action) => b.controller.manage(id, action),
    install: (id, action) => b.controller.install(id, action),
    importHistory: (id, history) => b.controller.importHistory(id, history),
    close: vi.fn(),
    renderSlot: () => null,
  } as AcpSettingsProps
}

it('shows probe results and session usage independently for Codex and Claude', async () => {
  const b = await bench()
  render(<AcpSettingsSection {...settingsProps(b)} />)
  const codex = screen.getByText('Codex', { selector: 'strong' }).closest('article')!
  const claude = screen.getByText('Claude', { selector: 'strong' }).closest('article')!
  expect(within(codex).getByText('检测通过')).toBeTruthy()
  expect(within(codex).getByText('正在使用')).toBeTruthy()
  expect(within(claude).getByText('检测通过')).toBeTruthy()
  expect(within(claude).getByText('未使用')).toBeTruthy()
  expect(screen.queryByText('未连接')).toBeNull()
  expect(screen.queryByText('DSH')).toBeNull()
  expect(screen.getAllByRole('article')).toHaveLength(2)
  fireEvent.click(within(claude).getByRole('button', { name: '检测' }))
  expect(b.remote.probeAgent).toHaveBeenCalledWith({ provider: 'claude', force: true })
  expect(b.describe).toHaveBeenCalledOnce()
})

it.each([
  { status: 'discovered', adapter: '/adapter', expected: '待检测' },
  { status: 'error', adapter: '/adapter', expected: '检测失败' },
  { status: 'error', adapter: null, expected: '未安装' },
] as const)('shows $expected without treating a diagnostic as session usage', async ({ status, adapter, expected }) => {
  const b = await bench()
  b.remote.acpCatalog.mockResolvedValue({ ok: true, value: entries.map(entry => ({
    ...entry, adapter, connected: false, diagnostic: { ...entry.diagnostic, status },
  })) })
  await b.controller.load()
  render(<AcpSettingsSection {...settingsProps(b)} />)
  for (const row of screen.getAllByRole('article')) {
    expect(within(row).getByText(expected)).toBeTruthy()
    expect(within(row).getByText('未使用')).toBeTruthy()
  }
})

it('shows both channels in use and marks usage unknown when the Host observation is lost', async () => {
  const b = await bench()
  b.remote.acpCatalog.mockResolvedValue({ ok: true, value: entries.map(entry => ({ ...entry, connected: true })) })
  await b.controller.load()
  render(<AcpSettingsSection {...settingsProps(b)} />)
  for (const row of screen.getAllByRole('article')) expect(within(row).getByText('正在使用')).toBeTruthy()
  await act(async () => { b.controller.disconnected() })
  for (const row of screen.getAllByRole('article')) {
    expect(within(row).getByText('使用情况未知')).toBeTruthy()
    expect(within(row).getByText('检测通过')).toBeTruthy()
  }
  await act(async () => { await b.controller.load() })
  for (const row of screen.getAllByRole('article')) expect(within(row).getByText('正在使用')).toBeTruthy()
  b.remote.acpCatalog.mockRejectedValueOnce(new Error('Host unavailable'))
  await act(async () => { await b.controller.load() })
  expect(b.controller.store.getSnapshot().usageKnown).toBe(false)
  expect(screen.getAllByText('使用情况未知')).toHaveLength(2)
})

it('preserves unseen credentials, keeps channel identity fixed and validates default disable before writing', async () => {
  const b = await bench()
  b.controller.edit('codex')
  expect(b.controller.store.getSnapshot().draft).toMatchObject({ apiKey: '', env: '', model: 'default-model' })
  b.controller.updateDraft({ id: 'custom', template: 'claude', name: 'My Codex' })
  await b.controller.save()
  const ops = b.mutate.mock.calls[0]![0].ops as Array<{ path: string[] }>
  expect(ops.every(op => op.path[1] === 'codex')).toBe(true)
  expect(ops.some(op => op.path.includes('apiKey') || op.path.includes('env'))).toBe(false)
  b.mutate.mockClear()
  b.controller.edit('codex')
  b.controller.updateDraft({ enabled: false })
  await b.controller.save()
  expect(b.mutate).not.toHaveBeenCalled()
  expect(b.controller.store.getSnapshot().draftError).toContain('更换默认')
})

it('clears connection claims immediately and discards a stale catalog response', async () => {
  const b = await bench()
  const pending = Promise.withResolvers<{ ok: true; value: AcpCatalogEntry[] }>()
  b.remote.acpCatalog.mockReturnValueOnce(pending.promise)
  const loading = b.controller.load()
  await Promise.resolve()
  b.controller.disconnected()
  pending.resolve({ ok: true, value: entries })
  await loading
  expect(b.controller.store.getSnapshot().entries.every(entry => !entry.connected)).toBe(true)
})

it('opens an existing import without creating another conversation and keeps the current draft on failed import', async () => {
  const b = await bench()
  const history = { sessionId: 'external', cwd: '/paper', title: null, updatedAt: null, additionalDirectories: [] }
  b.remote.acpLinkedSession
    .mockResolvedValueOnce({ ok: true, value: 'known' })
    .mockResolvedValueOnce({ ok: true, value: null })
  expect(await b.controller.importHistory('codex', history)).toBe(true)
  expect(b.navigation.open).toHaveBeenCalledWith('known')
  expect(b.navigation.create).not.toHaveBeenCalled()
  b.navigation.open.mockClear()
  b.remote.acpImportHistory.mockResolvedValueOnce({ ok: false, error: { message: 'Import failed' } })
  expect(await b.controller.importHistory('codex', history)).toBe(false)
  expect(b.navigation.create).toHaveBeenCalledWith({ cwd: '/paper', agentPreset: 'codex' })
  expect(b.navigation.open).not.toHaveBeenCalled()
  expect(b.controller.store.getSnapshot().error).toBe('Error: Import failed')
})

it('edits connection fields and preferences, validating JSON before persisting and clearing secrets explicitly', async () => {
  const b = await bench()
  render(<AcpSettingsSection {...settingsProps(b)} />)
  await act(async () =>{  b.controller.edit('claude') })
  const fields = {
    '显示名称': 'Research Claude', '可执行命令': 'claude-acp', '启动参数 · JSON 数组': '["--stdio"]',
    'SSH 配置 · JSON 对象': '{"host":"research","cwd":"/paper"}', 'API Key': 'test-key',
    'Base URL': 'https://api.example.test', '网络代理': 'http://localhost:7890', '默认模型': 'sonnet',
    '环境变量 · JSON 对象': '{"RESEARCH":"true"}', '默认思考强度': 'high',
    '默认会话选项 · JSON 对象': '{"fast":true}', '原生权限模式映射 · JSON 对象': '{"read-only":"plan"}',
    '回复语言': '简体中文', '个人指令': '保留引文',
  }
  for (const [label, value] of Object.entries(fields))
    fireEvent.change(screen.getByLabelText(label), { target: { value } })
  fireEvent.click(screen.getByLabelText('启用渠道'))
  fireEvent.change(screen.getByLabelText('启动参数 · JSON 数组'), { target: { value: '[1]' } })
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '保存配置' })))
  expect(screen.getByRole('alert').textContent).toContain('JSON 字符串数组')
  expect(b.mutate).not.toHaveBeenCalled()
  fireEvent.change(screen.getByLabelText('启动参数 · JSON 数组'), { target: { value: '["--stdio"]' } })
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '保存配置' })))
  expect(b.mutate.mock.calls[0]?.[0].ops).toEqual(expect.arrayContaining([
    { op: 'set', path: ['providers', 'claude', 'apiKey'], value: 'test-key' },
    { op: 'set', path: ['providers', 'claude', 'env'], value: { RESEARCH: 'true' } },
    { op: 'set', path: ['providers', 'claude', 'ssh'], value: { host: 'research', cwd: '/paper' } },
    { op: 'set', path: ['providers', 'claude', 'personalPrompt'], value: '保留引文' },
  ]))
  await act(async () =>{  b.controller.edit('codex') })
  fireEvent.click(screen.getByLabelText('清除已保存的 API Key'))
  fireEvent.click(screen.getByLabelText('清除环境变量覆盖'))
  expect(screen.getByLabelText('API Key')).toHaveProperty('disabled', true)
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '保存配置' })))
  expect(b.mutate.mock.lastCall?.[0].ops).toEqual(expect.arrayContaining([
    { op: 'unset', path: ['providers', 'codex', 'apiKey'] },
    { op: 'unset', path: ['providers', 'codex', 'env'] },
  ]))
  await act(async () =>{  b.controller.edit('codex') })
  fireEvent.click(screen.getByRole('button', { name: '取消编辑' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  await act(async () =>{  b.controller.edit('codex') })
  fireEvent.click(screen.getByRole('button', { name: '取消' }))
  expect(b.controller.store.getSnapshot().draft).toBeNull()
})

it('paginates history within one directory and refreshes routing after changes', async () => {
  const b = await bench()
  const first = { sessionId: 'one', cwd: '/paper', title: 'First', updatedAt: null, additionalDirectories: [] }
  b.remote.acpManage.mockResolvedValueOnce({ ok: true, value: { sessions: [first], nextCursor: 'p2' } })
  await b.controller.manage('codex', { kind: 'history', cwd: '/paper' })
  b.remote.acpManage.mockResolvedValueOnce({ ok: true, value: {
    sessions: [{ ...first, title: 'Updated' }, { ...first, sessionId: 'two' }], nextCursor: null,
  } })
  await b.controller.manage('codex', { kind: 'history', cwd: '/paper', cursor: 'p2' })
  expect(b.controller.store.getSnapshot().management.codex?.sessions).toHaveLength(2)
  expect(b.controller.store.getSnapshot().management.codex?.sessions?.[0]?.title).toBe('Updated')
  await b.controller.manage('codex', { kind: 'history', cwd: '/other', cursor: 'p2' })
  expect(b.remote.acpManage).toHaveBeenCalledTimes(2)
  expect(b.controller.store.getSnapshot().error).toContain('工作目录已改变')
  b.remote.acpManage.mockResolvedValue({ ok: true, value: {} })
  await b.controller.manage('codex', { kind: 'delete', sessionId: 'one' })
  expect(b.controller.store.getSnapshot().management.codex?.sessions?.map(s => s.sessionId)).toEqual(['two'])
  await b.controller.manage('codex', { kind: 'disable-provider', providerId: 'optional' })
  expect(b.remote.acpManage.mock.lastCall).toEqual([{ provider: 'codex', action: { kind: 'providers' } }])
  b.remote.acpManage.mockResolvedValueOnce({ ok: true, value: {} })
    .mockResolvedValueOnce({ ok: false, error: { message: 'Refresh failed' } })
  await b.controller.manage('codex', { kind: 'disable-provider', providerId: 'optional' })
  expect(b.controller.store.getSnapshot().error).toContain('Refresh failed')
})

it('serializes favorites against the acknowledged settings revision and recovers after rejected writes', async () => {
  const b = await bench()
  b.mutate.mockImplementation(async (request) => {
    const favoriteOp = request.ops[0]!
    const models = favoriteOp.op === 'set' ? favoriteOp.value : []
    return { rpcId: 'settings-test' as RpcId, result: { ok: true, value: {
      ...namespace, revision: (request.expectedRevision ?? 0) + 1,
      value: { providers: { codex: { favoriteModels: models } } },
    } } }
  })
  await Promise.all([b.controller.favorite('codex', 'a'), b.controller.favorite('codex', 'b')])
  expect(b.controller.store.getSnapshot().favorites.codex).toEqual(['a', 'b'])
  expect(b.mutate.mock.calls.map(call => call[0].expectedRevision)).toEqual([1, 2])
  await b.controller.favorite('codex', 'a')
  expect(b.controller.store.getSnapshot().favorites.codex).toEqual(['b'])
  b.mutate.mockRejectedValueOnce(new Error('Settings unavailable'))
  await b.controller.favorite('codex', 'c')
  expect(b.controller.store.getSnapshot().error).toContain('Settings unavailable')
  b.mutate.mockRejectedValueOnce(new Error('Default rejected'))
  await b.controller.setDefault('claude')
  expect(b.controller.store.getSnapshot().error).toContain('Default rejected')
})

it('polls an installation until cancellation settles and retains operation and connection errors', async () => {
  const b = await bench()
  vi.useFakeTimers()
  try {
    const pending = Promise.withResolvers<unknown>()
    b.remote.acpInstall.mockReturnValueOnce(pending.promise)
    const installing = b.controller.install('codex', 'install')
    await b.controller.install('codex', 'uninstall')
    await b.controller.probe('codex')
    expect(b.remote.acpInstall).toHaveBeenCalledTimes(1)
    expect(b.remote.probeAgent).not.toHaveBeenCalled()
    const before = b.remote.acpCatalog.mock.calls.length
    await vi.advanceTimersByTimeAsync(1100)
    expect(b.remote.acpCatalog.mock.calls.length).toBeGreaterThan(before)
    await b.controller.cancel('codex')
    pending.resolve({ ok: false, error: { message: 'Installation cancelled' } })
    await installing
    expect(b.controller.store.getSnapshot()).toMatchObject({ busy: [], error: 'Error: Installation cancelled' })
    b.remote.acpCancel.mockResolvedValueOnce({ ok: false, error: { message: 'Cancel failed' } })
    await b.controller.cancel('codex')
    expect(b.controller.store.getSnapshot().error).toContain('Cancel failed')
    b.remote.probeAgent.mockResolvedValueOnce({ ok: false, error: { message: 'Probe refused' } })
      .mockRejectedValueOnce(new Error('Probe disconnected'))
    await b.controller.probe()
    expect(b.controller.store.getSnapshot().error).toContain('Probe disconnected')
    b.remote.acpCatalog.mockResolvedValueOnce({ ok: false, error: { message: 'Host lost' } })
    await b.controller.load()
    expect(b.controller.store.getSnapshot().entries.every(entry => !entry.connected)).toBe(true)
    expect(b.controller.store.getSnapshot().error).toContain('Host lost')
  } finally { vi.useRealTimers() }
})

it('imports remote history into the current local project and refuses import without a local project', async () => {
  const b = await bench()
  b.remote.acpCatalog.mockResolvedValue({ ok: true, value: [{ ...entries[0]!, source: 'remote' }] })
  await b.controller.load()
  b.remote.acpLinkedSession.mockResolvedValue({ ok: true, value: null })
  b.remote.acpImportHistory.mockResolvedValue({ ok: true, value: 'created' })
  const history = { sessionId: 'external', cwd: '/remote', title: null, updatedAt: null, additionalDirectories: [] }
  expect(await b.controller.importHistory('codex', history)).toBe(true)
  expect(b.navigation.create).toHaveBeenCalledWith({ cwd: '/local', agentPreset: 'codex' })
  expect(b.remote.acpImportHistory).toHaveBeenCalledWith({
    sessionId: 'created', externalSessionId: 'external', cwd: '/remote',
  })
  b.navigation.localDirectory = () => undefined
  expect(await b.controller.importHistory('codex', history)).toBe(false)
  expect(b.controller.store.getSnapshot().error).toContain('打开一个本地论文项目')
  b.remote.acpLinkedSession.mockResolvedValueOnce({ ok: false, error: { message: 'Link lookup failed' } })
  expect(await b.controller.importHistory('codex', history)).toBe(false)
  expect(b.controller.store.getSnapshot().error).toContain('Link lookup failed')
})

it('confirms destructive channel actions and validates provider headers without hiding the connection status', async () => {
  const b = await bench()
  const history = { sessionId: 'external', cwd: '/paper', title: 'Research', updatedAt: null, additionalDirectories: [] }
  const provider = { id: 'custom', required: false, supported: ['openai', 'anthropic'],
    current: { apiType: 'openai', baseUrl: 'https://api.example.test', headers: {} } }
  b.remote.acpCatalog.mockResolvedValue({ ok: true, value: [{ ...entries[0]!, source: 'managed', output: 'Ready',
    documentation: 'https://example.test/agent', diagnostic: { ...entries[0]!.diagnostic,
      models: [{ id: 'a', name: 'Alpha' }], capabilities: { list: true, load: true, delete: true, providers: true, logout: true },
      authMethods: [{ id: 'login', name: '网页登录', type: 'agent', description: 'Open login' }],
    } }, entries[1]!] })
  await b.controller.load()
  b.remote.acpManage.mockResolvedValue({ ok: true, value: { sessions: [history], nextCursor: 'p2', providers: [provider] } })
  b.remote.acpInstall.mockResolvedValue({ ok: true })
  b.remote.acpLinkedSession.mockResolvedValue({ ok: true, value: 'known' })
  const props = settingsProps(b)
  render(<AcpSettingsSection {...props} />)
  const click = async (name: string) => act(async () => fireEvent.click(screen.getByRole('button', { name })))
  await act(async () => fireEvent.change(screen.getByLabelText(/默认 Agent/), { target: { value: 'claude' } }))
  await click('一键检测')
  await click('刷新安装状态')
  fireEvent.change(screen.getByLabelText('搜索 ACP 渠道'), { target: { value: 'missing' } })
  expect(screen.getByText('没有匹配的渠道')).toBeTruthy()
  fireEvent.change(screen.getByLabelText('搜索 ACP 渠道'), { target: { value: '' } })
  fireEvent.click(screen.getByText('Codex', { selector: 'strong' }).closest('button')!)
  await click('网页登录')
  expect(b.remote.acpManage).toHaveBeenCalledWith({ provider: 'codex', action: { kind: 'authenticate', methodId: 'login' } })
  await click('模型服务商')
  await click('设置')
  fireEvent.change(screen.getByLabelText('API 协议'), { target: { value: 'anthropic' } })
  fireEvent.change(screen.getByLabelText('API 地址'), { target: { value: 'https://routing.example.test' } })
  fireEvent.change(screen.getByLabelText('请求头 · JSON 对象'), { target: { value: '{"key":1}' } })
  await click('保存到渠道')
  expect(screen.getByRole('alert').textContent).toContain('JSON 字符串对象')
  fireEvent.change(screen.getByLabelText('请求头 · JSON 对象'), { target: { value: '{"key":"value"}' } })
  await click('保存到渠道')
  expect(b.remote.acpManage).toHaveBeenCalledWith({ provider: 'codex', action: {
    kind: 'set-provider', providerId: 'custom', apiType: 'anthropic', baseUrl: 'https://routing.example.test',
    headers: { key: 'value' },
  } })
  await click('设置')
  await click('取消设置')
  await click('禁用服务商')
  fireEvent.click(screen.getByText('渠道中的历史会话'))
  fireEvent.change(screen.getByLabelText('Codex 历史工作目录'), { target: { value: ' /paper ' } })
  await click('读取历史')
  await click('加载更多')
  await click('导入并打开')
  expect(props.close).toHaveBeenCalledOnce()
  for (const action of ['更新托管安装', '卸载托管安装', '退出渠道登录', '删除外部历史']) {
    b.remote.acpManage.mockClear()
    b.remote.acpInstall.mockClear()
    await click(action)
    expect(b.remote.acpManage).not.toHaveBeenCalled()
    expect(b.remote.acpInstall).not.toHaveBeenCalled()
    await click('取消操作')
    await click(action)
    await click('取消')
    await click(action)
    await click('确认')
    expect(b.remote.acpManage.mock.calls.length + b.remote.acpInstall.mock.calls.length).toBeGreaterThan(0)
  }
})
