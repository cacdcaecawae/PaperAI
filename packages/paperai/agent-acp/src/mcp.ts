/** ACP MCP transport negotiation over the existing authenticated PaperAI endpoint. */

import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import type { InitializeResponse, McpServer } from '@agentclientprotocol/sdk'

const require = createRequire(import.meta.url)

/**
 * Use HTTP when advertised and otherwise forward the same endpoint through standard MCP stdio.
 * @param servers - session-owned descriptors, including their revocable credentials.
 * @param capabilities - capabilities from this exact ACP initialization.
 * @returns descriptors accepted by the provider's declared transport support.
 */
export function negotiateMcp(servers: readonly McpServer[], capabilities: InitializeResponse['agentCapabilities']): McpServer[] {
  return servers.map((server) => {
    if (!('type' in server)) return server
    if (server.type === 'sse') {
      if (capabilities?.mcpCapabilities?.sse !== true) throw new Error('ACP provider does not support this SSE MCP server')
      return server
    }
    if (capabilities?.mcpCapabilities?.http === true) return server
    const stdio = pathToFileURL(require.resolve('@modelcontextprotocol/sdk/server/stdio.js')).href
    const http = pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js')).href
    const script = `
import { StdioServerTransport } from ${JSON.stringify(stdio)};
import { StreamableHTTPClientTransport } from ${JSON.stringify(http)};
const descriptor = JSON.parse(process.env.PAPERAI_ACP_MCP);
delete process.env.PAPERAI_ACP_MCP;
const local = new StdioServerTransport();
const remote = new StreamableHTTPClientTransport(new URL(descriptor.url), { requestInit: { headers: Object.fromEntries(descriptor.headers.map(({ name, value }) => [name, value])) } });
let closing;
const close = () => closing ??= Promise.resolve().then(() => Promise.allSettled([local.close(), remote.close()]));
const failed = () => { process.stderr.write('PaperAI MCP transport failed\\n'); process.exitCode = 1; void close(); };
local.onmessage = message => { void remote.send(message).catch(failed); };
remote.onmessage = message => { void local.send(message).catch(failed); };
local.onclose = remote.onclose = () => { void close(); };
local.onerror = remote.onerror = failed;
process.stdin.once('end', () => { void close(); });
process.once('SIGTERM', () => { void close(); });
try { await remote.start(); await local.start(); } catch { failed(); }
`
    return { name: server.name, command: process.execPath, args: ['--input-type=module', '--eval', script], env: [{ name: 'PAPERAI_ACP_MCP', value: JSON.stringify(server) }] }
  })
}
