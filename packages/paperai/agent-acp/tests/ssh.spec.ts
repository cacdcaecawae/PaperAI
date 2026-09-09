import { PassThrough } from 'node:stream'
import type { SubprocessHandle, SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'
import { describe, expect, it } from 'vitest'
import { forwardedPort, sshLaunch } from '../src/ssh.ts'

describe('ACP OpenSSH transport', () => {
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
