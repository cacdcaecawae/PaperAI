import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { afterEach, describe, expect, it } from 'vitest'
import { AcpTerminals } from '../src/terminals.ts'

const resources: Array<{ ctx: Context; root: string; terminals: AcpTerminals }> = []
afterEach(async () => { for (const resource of resources.splice(0)) {
  await resource.terminals.close()
  await resource.ctx.fiber.dispose()
  await rm(resource.root, { recursive: true, force: true })
} })

async function setup(mode: 'read-only' | 'danger-full-access' = 'danger-full-access') {
  const root = await mkdtemp(join(tmpdir(), 'acp-terminal-test-'))
  const ctx = new Context()
  await ctx.plugin(LocalSubprocessRuntime)
  const terminals = new AcpTerminals(ctx, root, () => ({ mode, workspaceRoot: root }), { maxTerminals: 1, outputBytes: 8, graceMs: 100 })
  resources.push({ ctx, root, terminals })
  return terminals
}

describe('ACP terminal ownership', () => {
  it('retains bounded output through completion and invalidates a released id', async () => {
    const terminals = await setup()
    const signal = new AbortController().signal
    const id = await terminals.create({ sessionId: 's', command: process.execPath, args: ['-e', 'process.stdout.write("123456789ABC")'] }, signal)
    expect(await terminals.wait(id, signal)).toMatchObject({ exitCode: 0 })
    expect(terminals.output(id)).toMatchObject({ output: '56789ABC', truncated: true, exitStatus: { exitCode: 0 } })
    expect(terminals.output(id).output).toBe('56789ABC')
    await terminals.release(id)
    expect(() => terminals.output(id)).toThrow('released')
    expect(terminals.displayOutput(id)).toBe('56789ABC')
    const second = await terminals.create({ sessionId: 's', command: process.execPath, args: ['-e', 'process.stdout.write("second")'] }, signal)
    await terminals.wait(second, signal)
    await terminals.release(second)
    expect(terminals.displayOutput(id)).toContain('no longer available')
    expect(terminals.displayOutput(second)).toBe('second')
    expect(terminals.displayOutput('unknown')).toContain('no longer available')
  })

  it('limits concurrent terminals, cancels a wait independently, and tears down a running process', async () => {
    const terminals = await setup()
    const signal = new AbortController().signal
    const request = { sessionId: 's', command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] }
    const id = await terminals.create(request, signal)
    await expect(terminals.create(request, signal)).rejects.toThrow('limit')
    const abort = new AbortController()
    const wait = terminals.wait(id, abort.signal)
    abort.abort(new Error('stop waiting'))
    await expect(wait).rejects.toThrow('stop waiting')
    expect(terminals.output(id).exitStatus).toBeUndefined()
    await terminals.kill(id)
    await terminals.wait(id, signal)
    expect(terminals.output(id).exitStatus).toBeDefined()
    await terminals.close()
    await expect(terminals.create(request, signal)).rejects.toThrow('closed')
  })

  it('refuses a confined launch when no DSH sandbox provider is available', async () => {
    const terminals = await setup('read-only')
    await expect(terminals.create({ sessionId: 's', command: process.execPath }, new AbortController().signal)).rejects.toThrow('sandbox provider')
  })

  it('joins concurrent release and close without leaving a process alive', async () => {
    const terminals = await setup()
    const id = await terminals.create({ sessionId: 's', command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] }, new AbortController().signal)
    const release = terminals.release(id)
    const closed = terminals.close()
    expect(terminals.close()).toBe(closed)
    await Promise.all([release, closed])
    expect(() => terminals.output(id)).toThrow('released')
  })
})
