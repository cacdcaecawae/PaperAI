import { methods, type ClientConnection, type InitializeResponse } from '@agentclientprotocol/sdk'
import { describe, expect, it, vi } from 'vitest'
import { manageAcp } from '../src/management.ts'

const signal = new AbortController().signal
const initialized: InitializeResponse = { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { list: {}, delete: {} }, providers: {}, auth: { logout: {} } }, authMethods: [{ id: 'login', name: 'Login' }] }
function endpoint() {
  const request = vi.fn<(method: string, params: unknown, options: unknown) => Promise<unknown>>()
  return { request, agent: { request } as unknown as ClientConnection['agent'] }
}

describe('ACP management operations', () => {
  it('refuses undeclared capabilities without sending an RPC', async () => {
    const { request, agent } = endpoint()
    for (const action of [{ kind: 'logout' }, { kind: 'history' }, { kind: 'providers' }, { kind: 'delete', sessionId: 's' }, { kind: 'authenticate', methodId: 'unknown' }] as const) {
      await expect(manageAcp(agent, { protocolVersion: 1 }, action, signal)).rejects.toThrow('未声明')
    }
    expect(request).not.toHaveBeenCalled()
  })

  it('projects paginated history without leaking extension fields', async () => {
    const { request, agent } = endpoint()
    request.mockResolvedValue({ sessions: [{ sessionId: 'external', cwd: '/work', title: 'Paper', _meta: { token: 'secret' } }], nextCursor: 'next' })
    expect(await manageAcp(agent, initialized, { kind: 'history', cwd: '/work', cursor: 'page' }, signal)).toEqual({ sessions: [{ sessionId: 'external', cwd: '/work', title: 'Paper', updatedAt: null, additionalDirectories: [] }], nextCursor: 'next' })
    expect(request).toHaveBeenCalledWith(methods.agent.session.list, { cwd: '/work', cursor: 'page' }, { cancellationSignal: signal })
  })

  it('keeps provider headers private and prevents disabling required providers', async () => {
    const { request, agent } = endpoint()
    request.mockResolvedValue({ providers: [{ providerId: 'primary', required: true, supported: ['openai'], current: { apiType: 'openai', baseUrl: 'https://api.example', headers: { Authorization: 'secret' } } }] })
    expect(JSON.stringify(await manageAcp(agent, initialized, { kind: 'providers' }, signal))).not.toContain('secret')
    await expect(manageAcp(agent, initialized, { kind: 'disable-provider', providerId: 'primary' }, signal)).rejects.toThrow('不能禁用')
    await expect(manageAcp(agent, initialized, { kind: 'set-provider', providerId: 'primary', apiType: 'unsupported', baseUrl: 'https://api.example', headers: {} }, signal)).rejects.toThrow('不支持')
    await expect(manageAcp(agent, initialized, { kind: 'set-provider', providerId: 'primary', apiType: 'openai', baseUrl: 'https://user:password@api.example', headers: {} }, signal)).rejects.toThrow('HTTP(S)')
    expect(request.mock.calls.every(([method]) => method === methods.agent.providers.list)).toBe(true)
  })

  it('forwards explicit authentication, logout and deletion to the initialized account', async () => {
    const { request, agent } = endpoint()
    request.mockResolvedValue({})
    await manageAcp(agent, initialized, { kind: 'authenticate', methodId: 'login' }, signal)
    await manageAcp(agent, initialized, { kind: 'logout' }, signal)
    await manageAcp(agent, initialized, { kind: 'delete', sessionId: 'selected' }, signal)
    expect(request.mock.calls.map(([method, params]) => [method, params])).toEqual([[methods.agent.authenticate, { methodId: 'login' }], [methods.agent.logout, {}], [methods.agent.session.delete, { sessionId: 'selected' }]])
  })
})
