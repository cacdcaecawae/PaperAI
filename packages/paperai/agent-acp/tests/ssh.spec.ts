import { PassThrough } from 'node:stream'
import { createServer, type ServerResponse } from 'node:http'
import type { SubprocessHandle, SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'
import { describe, expect, it } from 'vitest'
import { forwardedPort, isolateSshMcp, sshLaunch } from '../src/ssh.ts'

describe('ACP OpenSSH transport', () => {
  it('requires one loopback HTTP descriptor with its own bearer credential', async () => {
    const empty = await isolateSshMcp([])
    expect(empty.servers).toEqual([])
    await empty.close()
    const descriptor = { name: 'paperai', type: 'http' as const, url: 'http://127.0.0.1:3210/mcp', headers: [] }
    await expect(isolateSshMcp([descriptor, descriptor])).rejects.toThrow('one PaperAI')
    await expect(isolateSshMcp([descriptor])).rejects.toThrow('bearer credential')
    await expect(isolateSshMcp([{ ...descriptor, url: 'http://remote:3210/mcp' }])).rejects.toThrow('loopback')
    await expect(isolateSshMcp([{ ...descriptor, url: 'http://user@127.0.0.1:3210/mcp' }])).rejects.toThrow('loopback')
  })

  it('forwards only authenticated MCP requests and closes the isolated listener', async () => {
    const received: string[] = []
    const host = createServer((request, response) => {
      received.push(request.url ?? '')
      request.pipe(response)
    })
    await new Promise<void>(resolve => host.listen(0, '127.0.0.1', resolve))
    const address = host.address()
    if (address === null || typeof address === 'string') throw new Error('expected TCP host')
    const url = `http://127.0.0.1:${address.port}/api/paperai/mcp`
    const isolated = await isolateSshMcp([{
      name: 'paperai', type: 'http', url,
      headers: [{ name: 'Authorization', value: 'Bearer session-token' }],
    }])
    const descriptor = isolated.servers[0]
    if (descriptor === undefined || !('url' in descriptor)) throw new Error('expected HTTP descriptor')
    const target = descriptor.url
    try {
      expect(new URL(target).port).not.toBe(String(address.port))
      const headers = { Authorization: 'Bearer session-token' }
      for (const path of ['/', '/api', '/api/paperai/mcp/../settings', '/api/paperai/mcp?path=/api']) {
        expect((await fetch(new URL(path, target), { headers })).status).toBe(404)
      }
      expect((await fetch(target)).status).toBe(401)
      expect((await fetch(target, { headers: { Authorization: 'Bearer other-session' } })).status).toBe(401)
      expect(received).toEqual([])
      const response = await fetch(target, { method: 'POST', headers, body: 'MCP request' })
      expect(response.status).toBe(200)
      expect(await response.text()).toBe('MCP request')
      expect(received).toEqual(['/api/paperai/mcp'])
      await isolated.close()
      await isolated.close()
      await expect(fetch(target)).rejects.toThrow()
    } finally {
      await isolated.close()
      await new Promise<void>((resolve) => {
        host.close(() => { resolve() })
        host.closeAllConnections()
      })
    }
  })

  it('terminates interrupted MCP streams and reports an unavailable upstream', async () => {
    const streaming = Promise.withResolvers<ServerResponse>()
    const host = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('data: partial\n\n')
      streaming.resolve(response)
    })
    await new Promise<void>(resolve => host.listen(0, '127.0.0.1', resolve))
    const address = host.address()
    if (address === null || typeof address === 'string') throw new Error('expected TCP host')
    const isolated = await isolateSshMcp([{
      name: 'paperai', type: 'http', url: `http://127.0.0.1:${address.port}/mcp`,
      headers: [{ name: 'Authorization', value: 'Bearer session-token' }],
    }])
    const descriptor = isolated.servers[0]
    if (descriptor === undefined || !('url' in descriptor)) throw new Error('expected HTTP descriptor')
    try {
      const headers = { Authorization: 'Bearer session-token' }
      const response = await fetch(descriptor.url, { headers })
      const body = expect(response.text()).rejects.toThrow()
      const upstream = await streaming.promise
      upstream.destroy()
      await body
      await new Promise<void>(resolve => host.close(() => { resolve() }))
      expect((await fetch(descriptor.url, { headers })).status).toBe(502)
    } finally {
      await isolated.close()
      await new Promise<void>((resolve) => {
        host.close(() => { resolve() })
        host.closeAllConnections()
      })
    }
  })

  it('uses strict host verification, isolated dynamic forwarding and no credentials in argv', () => {
    const launch = sshLaunch({ host: 'research', user: 'me', cwd: '/home/me/paper', node: "/opt/node's/bin/node" }, [{ name: 'paperai', type: 'http', url: 'http://127.0.0.1:3210/mcp', headers: [{ name: 'Authorization', value: 'secret' }] }])
    expect(launch.localPort).toBe(3210)
    expect(launch.argv).toEqual(expect.arrayContaining(['StrictHostKeyChecking=yes', 'BatchMode=yes', 'ControlMaster=no', '127.0.0.1:0:127.0.0.1:3210']))
    expect(launch.argv.at(-1)).toContain("'/opt/node'\\''s/bin/node'")
    expect(launch.argv.join(' ')).not.toContain('secret')
    expect(() => sshLaunch({ host: '-bad', cwd: '/repo' }, [])).toThrow('host name')
    expect(() => sshLaunch({ host: 'host', cwd: 'relative' }, [])).toThrow('absolute')
    expect(() => sshLaunch({ host: 'host', cwd: '/repo' }, [{ name: 'mcp', type: 'http', url: 'http://elsewhere:3210/mcp', headers: [] }])).toThrow('loopback')
  })

  it('observes a fragmented allocation and removes listeners after completion or cancellation', async () => {
    const stderr = new PassThrough()
    let retained = ''
    stderr.on('data', (chunk) => { retained += String(chunk) })
    const done = Promise.withResolvers<SubprocessOutcome>()
    const child = { stderr, done: done.promise } as unknown as SubprocessHandle
    const abort = new AbortController()
    const waiting = forwardedPort(child, 3210, abort.signal, () => retained)
    stderr.write('Allocated port 4321 for remote for')
    stderr.write('ward to 127.0.0.1:3210\r\n')
    expect(await waiting).toBe(4321)
    expect(stderr.listenerCount('data')).toBe(1)
    const second = forwardedPort(child, 9999, abort.signal, () => retained)
    abort.abort(new Error('cancelled'))
    await expect(second).rejects.toThrow('cancelled')
    expect(stderr.listenerCount('data')).toBe(1)
    done.resolve({ exitCode: 0, signal: null })
    const exited = forwardedPort(child, 9999, new AbortController().signal, () => retained)
    await expect(exited).rejects.toThrow('forwarding failed')
  })
})
