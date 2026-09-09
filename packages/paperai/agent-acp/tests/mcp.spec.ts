import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { expect, it } from 'vitest'
import { negotiateMcp } from '../src/mcp.ts'

it('forwards real MCP initialization and tools over stdio with the existing HTTP authorization', async () => {
  const server = new McpServer({ name: 'paperai-test', version: '1' })
  server.registerTool('paper_read', { description: 'Read a paper' }, async () => ({ content: [{ type: 'text', text: 'paper content' }] }))
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID })
  // The upstream Transport declaration omits explicit undefined on optional callbacks.
  await server.connect(transport as Parameters<typeof server.connect>[0])
  let authorized = 0
  const http = createServer((req, res) => {
    if (req.headers.authorization !== 'Bearer example-session-lease') { res.writeHead(401).end(); return }
    authorized += 1
    void transport.handleRequest(req, res).catch(() => { if (!res.writableEnded) res.writeHead(500).end() })
  })
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
  const address = http.address()
  if (address === null || typeof address === 'string') throw new Error('Missing TCP listener')
  const source = { name: 'paperai', type: 'http' as const, url: `http://127.0.0.1:${address.port}/mcp`, headers: [{ name: 'Authorization', value: 'Bearer example-session-lease' }] }
  expect(negotiateMcp([source], { mcpCapabilities: { http: true } })).toEqual([source])
  expect(() => negotiateMcp([{ ...source, type: 'sse' }], {})).toThrow('SSE')
  const [descriptor] = negotiateMcp([source], {})
  if (descriptor === undefined || !('command' in descriptor)) throw new Error('Missing stdio bridge')
  expect(descriptor.args.join(' ')).not.toContain('example-session-lease')
  const client = new Client({ name: 'acp-adapter', version: '1' })
  try {
    await client.connect(new StdioClientTransport({ command: descriptor.command, args: descriptor.args, env: Object.fromEntries(descriptor.env.map(entry => [entry.name, entry.value])), stderr: 'pipe' }))
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['paper_read'])
    expect(await client.callTool({ name: 'paper_read', arguments: {} })).toMatchObject({ content: [{ type: 'text', text: 'paper content' }] })
    expect(authorized).toBeGreaterThan(1)
  } finally {
    await client.close()
    await server.close()
    http.closeAllConnections()
    await new Promise<void>((resolve, reject) => http.close((error) => { if (error) reject(error); else resolve() }))
  }
}, 15_000)
