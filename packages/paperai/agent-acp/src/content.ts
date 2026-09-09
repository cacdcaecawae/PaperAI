/** ACP media admission through the existing durable attachment service. */

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock as AcpContentBlock } from '@agentclientprotocol/sdk'
import { admitEncodedImages } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Original provider content for media without a canonical DSH content block. */
    'paperai/acp/content': { provider: string; content: AcpContentBlock }
  }
}

/**
 * Preserve provider content and admit supported raster images before publishing their references.
 * @param ctx - attachment service owner.
 * @param session - destination log, including detached import staging.
 * @param provider - owning ACP channel.
 * @param content - SDK-validated content.
 * @returns canonical display blocks; unsupported media retains its original bytes in the log.
 */
export async function projectAcpContent(
  ctx: Context,
  session: Session,
  provider: string,
  content: AcpContentBlock,
): Promise<ContentBlock[]> {
  switch (content.type) {
    case 'text':
      return [{ type: 'text', text: content.text }]
    case 'resource_link':
      return [{ type: 'text', text: `${content.title ?? content.name}: ${content.uri}` }]
    case 'resource':
      if ('text' in content.resource)
        return [{ type: 'text', text: `${content.resource.uri}\n${content.resource.text}` }]
      session.append('paperai/acp/content', { provider, content })
      return [
        {
          type: 'text',
          text: `[二进制资源已保存到会话记录：${content.resource.uri} · ${content.resource.mimeType ?? 'binary'}]`,
        },
      ]
    case 'image': {
      const attachments = ctx.get('attachments')
      const mediaType = content.mimeType
      if (
        attachments !== undefined &&
        (mediaType === 'image/png' ||
          mediaType === 'image/jpeg' ||
          mediaType === 'image/webp' ||
          mediaType === 'image/gif')
      ) {
        const images = await admitEncodedImages(attachments, [{ mediaType, data: content.data }])
        return images.map(attachment => ({ type: 'image', attachment }))
      }
      session.append('paperai/acp/content', { provider, content })
      return [{ type: 'text', text: `[图片已保存到会话记录，当前部署无法预览：${mediaType}]` }]
    }
    case 'audio':
      session.append('paperai/acp/content', { provider, content })
      return [{ type: 'text', text: `[音频已保存到会话记录，当前视图无法播放：${content.mimeType}]` }]
  }
}
