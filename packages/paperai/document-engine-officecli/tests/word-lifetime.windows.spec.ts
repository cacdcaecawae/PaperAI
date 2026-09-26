/** Native Windows job ownership with an out-of-tree, file-locking Word surrogate. */
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LEGACY_DOC_CONVERTER_ASSET } from '../src/legacy-doc.ts'

const surrogate = fileURLToPath(new URL('./fixtures/word-process.ps1', import.meta.url))
const wrapper = fileURLToPath(new URL('./fixtures/word-converter-wrapper.ps1', import.meta.url))
const converters = [
  ['document', LEGACY_DOC_CONVERTER_ASSET],
  ['template', fileURLToPath(new URL('../../template-service/assets/convert-legacy-doc.ps1', import.meta.url))],
] as const

describe.skipIf(process.platform !== 'win32')('Word converter process ownership', () => {
  let ctx: Context
  let root: string
  let dispose: () => Promise<void>
  const handles: SubprocessHandle[] = []

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'paperai-word-lifetime-'))
    ctx = new Context()
    const fiber = await ctx.plugin(LocalSubprocessRuntime)
    dispose = async () => { await fiber.dispose() }
  })

  afterEach(async () => {
    for (const handle of handles.splice(0)) handle.terminate()
    await dispose()
    await rm(root, { recursive: true, force: true })
  })

  function run(args: string[], signal?: AbortSignal): SubprocessHandle {
    const handle = ctx.subprocess.spawn({
      argv: ['powershell.exe', '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ...args],
      cwd: root,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 8192 } },
      graceMs: 500,
      signal: signal ?? AbortSignal.timeout(30_000),
      env: {},
    })
    handles.push(handle)
    return handle
  }

  async function word(name: string): Promise<{ handle: SubprocessHandle; window: string; file: string }> {
    const file = join(root, name)
    const handle = run([surrogate, file])
    await expect.poll(() => handle.collected.stdout?.readFrom(0).text.trim(), { timeout: 10_000 }).toMatch(/^\d+$/u)
    return { handle, window: handle.collected.stdout!.readFrom(0).text.trim(), file }
  }

  for (const [name, converter] of converters) {
    it.each(['cancel', 'timeout'] as const)(`${name} converter releases only its Word process on %s`, async (mode) => {
      const owned = await word('owned.doc')
      const unrelated = await word('unrelated.doc')
      const controller = new AbortController()
      const signal = mode === 'timeout' ? AbortSignal.timeout(5_000) : controller.signal
      const conversion = run([wrapper, converter, owned.window, root, 'hang'], signal)
      await expect.poll(async () => access(join(root, 'opened')).then(() => true, () => false), { timeout: 4_000 }).toBe(true)
      if (mode === 'cancel') controller.abort()
      await conversion.done
      expect(signal.aborted).toBe(true)
      expect(await owned.handle.waitForExit(AbortSignal.timeout(5_000)), conversion.collected.stderr?.readFrom(0).text).toBe(true)
      await rm(owned.file)
      expect(await unrelated.handle.waitForExit(AbortSignal.timeout(10))).toBe(false)
    }, 25_000)

    it(`${name} converter attempts Quit and releases its process when Close fails`, async () => {
      const owned = await word('close-failure.doc')
      const conversion = run([wrapper, converter, owned.window, root, 'close-failure'])
      const result = await conversion.done
      expect(result.exitCode).not.toBe(0)
      expect(await readFile(join(root, 'quit'), 'utf8')).toBe('called')
      expect(await owned.handle.waitForExit(AbortSignal.timeout(5_000))).toBe(true)
      await rm(owned.file)
    }, 20_000)
  }
})
