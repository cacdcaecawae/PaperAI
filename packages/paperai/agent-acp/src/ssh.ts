/** OpenSSH transport for an explicitly configured POSIX host with Node.js and an installed ACP CLI. */

import type { McpServer } from '@agentclientprotocol/sdk'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'

/** Remote execution settings; credentials remain in OpenSSH's existing key/agent configuration. */
export interface AcpSshConfig {
  /** Trusted hostname or existing SSH config alias. */
  readonly host: string
  /** Absolute POSIX workspace path on the remote host. */
  readonly cwd: string
  /** Optional remote login name. */
  readonly user?: string
  /** Optional TCP port overriding SSH configuration. */
  readonly port?: number
  /** Local private-key path passed to OpenSSH. */
  readonly identityFile?: string
  /** Remote Node executable; omission uses node on PATH. */
  readonly node?: string
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

// The first stdin line carries launch data; subsequent bytes belong exclusively to ACP.
// A detached process group lets stdin EOF or SSH termination reclaim the remote descendants.
const bootstrap = `
const { spawn } = require('node:child_process');
let prefix = Buffer.alloc(0), child, stopping, graceMs;
const stop = () => {
  if (stopping) return;
  stopping = true;
  if (!child?.pid) return;
  try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code === 'ESRCH') return; throw error; }
  setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }, graceMs);
};
process.on('SIGTERM', stop); process.on('SIGHUP', stop); process.stdin.on('end', stop);
process.stdin.on('data', function first(chunk) {
  if (stopping) return;
  prefix = Buffer.concat([prefix, chunk]);
  const at = prefix.indexOf(10);
  if (at < 0) return;
  process.stdin.removeListener('data', first);
  const input = JSON.parse(prefix.subarray(0, at).toString('utf8'));
  graceMs = input.graceMs;
  child = spawn(input.command, input.args, { cwd: input.cwd, env: { ...process.env, ...input.env }, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
  child.stdin.on('error', stop);
  child.on('error', error => { process.stderr.write(error.message + '\\n'); process.exitCode = 1; process.stdin.destroy(); });
  child.on('exit', (code) => { stop(); process.exitCode = code ?? 1; process.stdin.destroy(); });
  if (prefix.length > at + 1) child.stdin.write(prefix.subarray(at + 1));
  prefix = undefined;
  process.stdin.pipe(child.stdin);
});
`

/**
 * Resolve an SSH command with strict host verification and loopback-only reverse MCP forwarding.
 * @param config - explicit remote host and execution directory.
 * @param servers - session-owned local HTTP descriptors.
 * @returns executable arguments and the forwarded local port when a PaperAI descriptor exists.
 */
export function sshLaunch(
  config: AcpSshConfig,
  servers: readonly McpServer[],
): { argv: readonly [string, ...string[]]; localPort?: number } {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.:[\]_-]*$/u.test(config.host) || !config.cwd.startsWith('/'))
    throw new Error('SSH requires a host name and an absolute POSIX working directory')
  if (config.user !== undefined && !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/u.test(config.user))
    throw new Error('Invalid SSH user name')
  if (servers.length > 1) throw new Error('SSH ACP currently supports one session-owned PaperAI MCP endpoint')
  const server = servers[0]
  let localPort: number | undefined
  if (server !== undefined) {
    if (!('type' in server) || server.type !== 'http') throw new Error('SSH requires the PaperAI HTTP MCP descriptor')
    const url = new URL(server.url)
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1')
      throw new Error('SSH MCP forwarding requires a local loopback endpoint')
    localPort = Number(url.port || 80)
  }
  return {
    argv: [
      'ssh',
      '-T',
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      'ExitOnForwardFailure=yes',
      '-o',
      'ControlMaster=no',
      '-S',
      'none',
      ...(config.port === undefined ? [] : ['-p', String(config.port)]),
      ...(config.user === undefined ? [] : ['-l', config.user]),
      ...(config.identityFile === undefined ? [] : ['-i', config.identityFile]),
      ...(localPort === undefined ? [] : ['-R', `127.0.0.1:0:127.0.0.1:${localPort}`]),
      config.host,
      `${quote(config.node ?? 'node')} -e ${quote(bootstrap)}`,
    ],
    ...(localPort === undefined ? {} : { localPort }),
  }
}

/**
 * Wait for OpenSSH's dynamic reverse-port announcement while the owning process remains alive.
 * @param child - SSH process with piped stderr.
 * @param localPort - local MCP port named by this forwarding request.
 * @param signal - startup cancellation and deadline.
 * @param stderr - bounded stderr retained by the runtime.
 * @returns allocated remote loopback port.
 */
export async function forwardedPort(
  child: SubprocessHandle,
  localPort: number,
  signal: AbortSignal,
  stderr: () => string,
): Promise<number> {
  signal.throwIfAborted()
  const port = Promise.withResolvers<number>()
  const read = (): void => {
    const match = new RegExp(
      `Allocated port (\\d+) for remote forward to 127\\.0\\.0\\.1:${localPort}(?:\\s|$)`,
      'u',
    ).exec(stderr())
    if (match !== null) port.resolve(Number(match[1]))
  }
  const abort = (): void => {
    port.reject(signal.reason)
  }
  signal.addEventListener('abort', abort, { once: true })
  child.stderr?.on('data', read)
  void child.done.then(
    () => {
      port.reject(new Error(`SSH forwarding failed: ${stderr()}`))
    },
    (error: unknown) => {
      port.reject(error)
    },
  )
  try {
    read()
    return await port.promise
  } finally {
    signal.removeEventListener('abort', abort)
    child.stderr?.off('data', read)
  }
}
