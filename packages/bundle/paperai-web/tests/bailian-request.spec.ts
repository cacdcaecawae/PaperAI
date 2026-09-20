/**
 * What the declared 阿里云百炼 route actually puts on the wire.
 *
 * The schema test next door proves the row parses and resolves; neither
 * catches a capacity copied from another endpoint, because a wrong number is
 * a perfectly valid number. Bailian rejects `max_tokens` above 32768 while
 * thinking is on, and refuses the thinking switch entirely on its
 * thinking-only models, so the only honest assertion is the request body
 * itself: mount the shipped row against a local server, stream one turn, and
 * read what came out.
 */

import { createServer, type IncomingMessage, type Server } from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as yaml from 'js-yaml'
import { Context } from '@deepseek-ai/cordis'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime, { BlockAssembler, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'

/** Bailian's per-model ceiling on `max_tokens` while thinking is on. */
const THINKING_MAX_TOKENS_GATE = 32768

/** A complete, minimal chat-completions stream in pi-ai's expected shape. */
const EVENTS = [
  '{"choices":[{"delta":{"role":"assistant","content":""},"index":0,"finish_reason":null}]}',
  '{"choices":[{"delta":{"content":"ok"},"index":0,"finish_reason":null}]}',
  '{"choices":[{"delta":{},"index":0,"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}',
  '[DONE]',
]

const servers: Server[] = []

/** Local stand-in for the endpoint: records each request body, replays one stream. */
async function captureServer(): Promise<{ url: string; requests: Record<string, unknown>[] }> {
  const requests: Record<string, unknown>[] = []
  const server = createServer((request: IncomingMessage, response) => {
    let body = ''
    request.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
    request.on('end', () => {
      if (body.length > 0) requests.push(JSON.parse(body) as Record<string, unknown>)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const event of EVENTS) response.write(`data: ${event}\n\n`)
      response.end()
    })
  })
  servers.push(server)
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return { url: `http://127.0.0.1:${address.port}`, requests }
}

/** The shipped row, with only its endpoint redirected at the local server. */
function shippedRoute(baseURL: string): Record<string, unknown> {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const rows = yaml.load(
    readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8'),
    { schema: entryListSchema },
  ) as Array<{ id?: string; config?: { providers?: Record<string, Record<string, unknown>> } }>
  const bailian = rows.find(row => row.id === 'llm-pi-ai')?.config?.providers?.bailian
  if (bailian === undefined) throw new Error('the llm-pi-ai row declares no bailian provider')
  return { ...bailian, baseURL }
}

/** Every model the shipped row declares, with the levels it offers. */
function declaredModels(): Array<{ id: string; maxTokens: number; offers: string[] }> {
  const route = shippedRoute('http://unused') as { models?: Array<{ id: string; maxTokens: number; reasoningEfforts?: Record<string, unknown> }> }
  return (route.models ?? []).map(model => ({
    id: model.id,
    maxTokens: model.maxTokens,
    offers: Object.keys(model.reasoningEfforts ?? {}),
  }))
}

/**
 * Stream one turn. `effort` omitted reproduces the composer's own default
 * call: ModelSelect sends no reasoningEffort while the model menu sits on the
 * provider default, which is the path a declared level list never reaches.
 */
async function streamOnce(ctx: Context, model: string, effort?: string): Promise<void> {
  const assembler = new BlockAssembler()
  for await (const chunk of ctx.llm.stream({
    provider: 'bailian',
    model,
    ...effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(effort) },
    messages: [],
  })) assembler.push(chunk)
}

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(servers.splice(0).map(server => new Promise(done => server.close(done))))
})

beforeEach(() => {
  vi.stubEnv('DASHSCOPE_API_KEY', 'test-key')
})

describe('the Bailian route on the wire', () => {
  it('never asks for more output than Bailian accepts while thinking is on', async () => {
    const server = await captureServer()
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, { providers: { bailian: shippedRoute(server.url) } })

    const models = declaredModels()
    expect(models).toHaveLength(11)
    // Every model at its thinking level, which is where the cap binds.
    for (const model of models) await streamOnce(ctx, model.id, 'high')

    expect(server.requests).toHaveLength(models.length)
    server.requests.forEach((request, index) => {
      const model = models[index]
      expect(request).toMatchObject({ model: model?.id, max_tokens: model?.maxTokens })
      // The gate binds Alibaba's own Qwen, GLM and Kimi deployments; DeepSeek
      // and MiniMax are outside it and legitimately ask for more.
      if (model !== undefined && !/^(deepseek|MiniMax)/.test(model.id)) {
        expect(request.max_tokens).toBeLessThanOrEqual(THINKING_MAX_TOKENS_GATE)
      }
    })
  }, 30_000)

  it('switches thinking with enable_thinking, and never sends the anthropic-style object', async () => {
    const server = await captureServer()
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, { providers: { bailian: shippedRoute(server.url) } })

    // A mixed-mode model, both ways round. Bailian's only switch is the
    // boolean; the object shape belongs to a different vendor surface.
    await streamOnce(ctx, 'deepseek-v4-pro', 'high')
    expect(server.requests[0]).toMatchObject({ enable_thinking: true })
    expect(server.requests[0]).not.toHaveProperty('thinking')

    await streamOnce(ctx, 'deepseek-v4-pro', 'off')
    expect(server.requests[1]).toMatchObject({ enable_thinking: false })
    expect(server.requests[1]).not.toHaveProperty('thinking')
  }, 30_000)

  it('keeps thinking on for the thinking-only models when the caller names no level', async () => {
    const server = await captureServer()
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, { providers: { bailian: shippedRoute(server.url) } })

    // Declaring no `off` level keeps it out of the menu; it does not decide
    // what a request with no level sends. pi-ai's qwen format writes
    // enable_thinking from the effort's presence, so an absent effort asks a
    // thinking-only model to stop thinking, which Bailian cannot do.
    for (const model of ['kimi-k2.7-code', 'MiniMax-M2.5']) await streamOnce(ctx, model)

    expect(server.requests.map(request => request.enable_thinking)).toEqual([true, true])

    // The same route default carries the mixed models, and an explicit off
    // still reaches the ones that allow it.
    await streamOnce(ctx, 'kimi-k2.6')
    expect(server.requests[2]).toMatchObject({ enable_thinking: true })
    await streamOnce(ctx, 'kimi-k2.6', 'off')
    expect(server.requests[3]).toMatchObject({ enable_thinking: false })
  }, 30_000)

  it('offers no off level on the two models Bailian cannot stop thinking', () => {
    const thinkingOnly = declaredModels().filter(model => !model.offers.includes('off'))

    expect(thinkingOnly.map(model => model.id)).toEqual(['kimi-k2.7-code', 'MiniMax-M2.5'])
    for (const model of thinkingOnly) expect(model.offers).toEqual(['high'])
  })
})
