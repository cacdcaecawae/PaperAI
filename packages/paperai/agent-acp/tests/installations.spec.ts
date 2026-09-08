import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { afterEach, expect, it, vi } from 'vitest'
import { ACP_TEMPLATES, resolveProviders } from '../src/providers.ts'
import { installAdapter, managedInstallation, uninstallAdapter } from '../src/installations.ts'

const resources: Array<{ ctx: Context; root: string }> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const { ctx, root } of resources.splice(0)) {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

it('publishes a validated managed generation, preserves it on cancellation, and uninstalls only that generation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'paperai-acp-install-'))
  const ctx = new Context()
  resources.push({ ctx, root })
  await ctx.plugin(LocalSubprocessRuntime)
  const shim = join(root, process.platform === 'win32' ? 'npm.cmd' : 'npm')
  const npm = process.platform === 'win32' ? join(root, 'node_modules', 'npm', 'bin', 'npm-cli.js') : shim
  await mkdir(join(root, 'node_modules', 'npm', 'bin'), { recursive: true })
  await writeFile(
    npm,
    `
const fs = require('node:fs'); const path = require('node:path');
const target = process.argv[process.argv.indexOf('--prefix') + 1];
if (process.env.INSTALL_TEST_WAIT === '1') { process.stdout.write('install waiting'); setInterval(() => {}, 1000); }
else { const pkg = path.join(target, 'node_modules', '@agentclientprotocol', 'codex-acp'); fs.mkdirSync(pkg, { recursive: true }); fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({version:'test-1',bin:{'codex-acp':'index.js'}})); fs.writeFileSync(path.join(pkg,'index.js'),'process.exit(0)'); }
`,
  )
  vi.spyOn(ctx.subprocess, 'resolveExecutable').mockResolvedValue(shim)
  const provider = resolveProviders({})[0]!
  const template = ACP_TEMPLATES[0]!
  const limits = { outputBytes: 64, graceMs: 50 }
  await installAdapter(ctx, root, provider, template, limits, new AbortController().signal, () => {})
  const installed = managedInstallation(root, provider, false)!
  expect(installed.version).toBe('test-1')
  expect(installed.provider.command).toBe(process.execPath)
  expect(managedInstallation(root, provider, true)).toBeUndefined()
  const active = await readFile(join(root, 'codex', 'active.json'), 'utf8')
  const waiting = Promise.withResolvers<undefined>()
  const abort = new AbortController()
  const pending = installAdapter(
    ctx,
    root,
    { ...provider, env: { INSTALL_TEST_WAIT: '1' } },
    template,
    limits,
    abort.signal,
    (text) => {
      if (text.includes('install waiting')) waiting.resolve(undefined)
    },
  )
  const rejected = expect(pending).rejects.toThrow('cancel install')
  await waiting.promise
  abort.abort(new Error('cancel install'))
  await rejected
  expect(await readFile(join(root, 'codex', 'active.json'), 'utf8')).toBe(active)
  expect((await readdir(join(root, 'codex'))).filter(name => name.startsWith('install-'))).toHaveLength(1)
  await uninstallAdapter(root, provider)
  expect(managedInstallation(root, provider, false)).toBeUndefined()
  await writeFile(
    join(root, 'codex', 'active.json'),
    JSON.stringify({ packageName: provider.packageName, binName: provider.binName, directory: '../../outside' }),
  )
  expect(() => managedInstallation(root, provider, false)).toThrow('escapes')
}, 15_000)
