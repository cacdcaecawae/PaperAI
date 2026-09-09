import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AttachmentLocal from '@deepseek-ai/dsh-attachment-local'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { expect, it } from 'vitest'
import { projectAcpContent } from '../src/content.ts'

it('stores provider images as durable attachments and preserves unsupported media bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'paperai-acp-media-'))
  const ctx = new Context()
  try {
    await ctx.plugin(AttachmentLocal, { dshHome: root })
    const session = Session.create(SessionId('acp-media'))
    const image = { type: 'image' as const, mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC' }
    const [block] = await projectAcpContent(ctx, session, 'codex', image)
    if (block?.type !== 'image') throw new Error('Image was not admitted')
    expect(block.attachment).toMatchObject({ width: 1, height: 1 })
    expect((await ctx.attachments.readImage(block.attachment)).data.length).toBeGreaterThan(0)
    await expect(projectAcpContent(ctx, session, 'codex', { ...image, data: 'invalid bytes' })).rejects.toThrow('base64')
    const audio = { type: 'audio' as const, mimeType: 'audio/wav', data: 'c291bmQ=' }
    expect(await projectAcpContent(ctx, session, 'claude', audio)).toEqual([{ type: 'text', text: '[音频已保存到会话记录，当前视图无法播放：audio/wav]' }])
    expect(session.events.find(event => event.type === 'paperai/acp/content')?.data).toEqual({ provider: 'claude', content: audio })
  } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
})

it('projects text and resources and keeps unrenderable images and binary resources in the session log', async () => {
  const ctx = new Context()
  const session = Session.create(SessionId('acp-resource'))
  expect(await projectAcpContent(ctx, session, 'codex', { type: 'text', text: 'Text' }))
    .toEqual([{ type: 'text', text: 'Text' }])
  for (const title of [undefined, 'Paper']) {
    expect(await projectAcpContent(ctx, session, 'codex', {
      type: 'resource_link', uri: 'file:///paper', name: 'paper.docx', ...(title === undefined ? {} : { title }),
    })).toEqual([{ type: 'text', text: `${title ?? 'paper.docx'}: file:///paper` }])
  }
  expect(await projectAcpContent(ctx, session, 'claude', {
    type: 'resource', resource: { uri: 'file:///notes', text: 'Research notes' },
  })).toEqual([{ type: 'text', text: 'file:///notes\nResearch notes' }])
  const binary = { type: 'resource' as const, resource: { uri: 'file:///data', blob: 'Ynl0ZXM=' } }
  const image = { type: 'image' as const, mimeType: 'image/svg+xml', data: 'PHN2Zy8+' }
  expect(await projectAcpContent(ctx, session, 'codex', binary)).toEqual([
    { type: 'text', text: '[二进制资源已保存到会话记录：file:///data · binary]' },
  ])
  expect(await projectAcpContent(ctx, session, 'codex', image)).toEqual([
    { type: 'text', text: '[图片已保存到会话记录，当前部署无法预览：image/svg+xml]' },
  ])
  expect(session.events.filter(event => event.type === 'paperai/acp/content').map(event => event.data.content))
    .toEqual([binary, image])
  await ctx.fiber.dispose()
})
