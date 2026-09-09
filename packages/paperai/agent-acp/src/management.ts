/** Capability-gated ACP account, routing, and provider-history operations. */

import { methods, type ClientConnection, type InitializeResponse } from '@agentclientprotocol/sdk'
import type { AcpManagementRequest, AcpManagementResult } from './diagnostic-types.ts'

/**
 * Run one explicit user operation on an initialized management connection.
 * @param agent - SDK endpoint that owns request cancellation and validation.
 * @param initialized - capabilities advertised by this exact process.
 * @param request - requested account or history action.
 * @param signal - operation lifetime, including user cancellation.
 * @returns only declared non-secret response fields.
 */
export async function manageAcp(agent: ClientConnection['agent'], initialized: InitializeResponse, request: AcpManagementRequest, signal: AbortSignal): Promise<AcpManagementResult> {
  const options = { cancellationSignal: signal }
  const caps = initialized.agentCapabilities
  const requireCapability = (supported: boolean, name: string): void => {
    if (!supported) throw new Error(`此渠道未声明 ${name} 能力`)
  }
  switch (request.kind) {
    case 'authenticate': {
      const method = initialized.authMethods?.find(entry => entry.id === request.methodId)
      requireCapability(method !== undefined, '此认证方式')
      if (method !== undefined && 'type' in method) throw new Error('请使用渠道的原生终端登录命令完成此认证方式')
      await agent.request(methods.agent.authenticate, { methodId: request.methodId }, options)
      return {}
    }
    case 'logout':
      requireCapability(caps?.auth?.logout != null, '退出登录')
      await agent.request(methods.agent.logout, {}, options)
      return {}
    case 'history': {
      requireCapability(caps?.sessionCapabilities?.list != null, '会话列表')
      const result = await agent.request(methods.agent.session.list, {
        ...request.cwd === undefined ? {} : { cwd: request.cwd },
        ...request.cursor === undefined ? {} : { cursor: request.cursor },
      }, options)
      return {
        sessions: result.sessions.map(session => ({
          sessionId: session.sessionId, cwd: session.cwd, title: session.title ?? null,
          updatedAt: session.updatedAt ?? null, additionalDirectories: session.additionalDirectories ?? [],
        })),
        nextCursor: result.nextCursor ?? null,
      }
    }
    case 'delete':
      requireCapability(caps?.sessionCapabilities?.delete != null, '删除外部会话')
      await agent.request(methods.agent.session.delete, { sessionId: request.sessionId }, options)
      return {}
    case 'providers':
    case 'set-provider':
    case 'disable-provider': {
      requireCapability(caps?.providers != null, '模型服务商配置')
      const listing = await agent.request(methods.agent.providers.list, {}, options)
      if (request.kind !== 'providers') {
        const provider = listing.providers.find(entry => entry.providerId === request.providerId)
        if (provider === undefined) throw new Error('渠道未声明此模型服务商')
        if (request.kind === 'disable-provider') {
          if (provider.required) throw new Error('此模型服务商为必需项，不能禁用')
          await agent.request(methods.agent.providers.disable, { providerId: request.providerId }, options)
        } else {
          if (!provider.supported.includes(request.apiType)) throw new Error('此模型服务商不支持所选 API 协议')
          const url = new URL(request.baseUrl)
          if (!['http:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== '') throw new Error('API 地址须为不含用户名和密码的 HTTP(S) URL')
          await agent.request(methods.agent.providers.set, {
            providerId: request.providerId, apiType: request.apiType, baseUrl: request.baseUrl, headers: { ...request.headers },
          }, options)
        }
        return {}
      }
      return { providers: listing.providers.map(provider => ({
        id: provider.providerId, supported: provider.supported, required: provider.required,
        current: provider.current == null ? null : { apiType: provider.current.apiType, baseUrl: provider.current.baseUrl },
      })) }
    }
  }
}
