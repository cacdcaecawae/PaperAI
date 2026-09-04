/**
 * Keyless built-artifact guard (the `dsh-workflow-worker-thread` built-worker
 * shape): plain `node` runs `lib/worker.cjs` and the bundle reaches its
 * real koffi requires. POSIX hosts prove the load path end to end through
 * the deterministic ole32 rejection. Windows checks the real dialog's
 * window ownership and cancellation. Skips until a build produces the artifact.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { Win32DialogWorkerMessage } from '../src/win32-dialog-worker.ts'
import { loadWindowProbe } from './window-probe.ts'

const builtWorker = fileURLToPath(new URL('../lib/worker.cjs', import.meta.url))

describe.skipIf(!existsSync(builtWorker))('built dialog worker (lib/worker.cjs)', () => {
  it.skipIf(process.platform === 'win32')('loads under plain node and reports the native-surface failure', async () => {
    const message = await new Promise<Win32DialogWorkerMessage>((resolve, reject) => {
      const child = spawn(process.execPath, [builtWorker], {
        env: { ...process.env, DSH_DIALOG_TITLE: 'Built-artifact guard' },
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      })
      child.on('message', resolve)
      child.on('error', reject)
      child.on('exit', (code) => {
        reject(new Error(`worker exited (${code}) before reporting`))
      })
    })
    expect(message.kind).toBe('error')
    expect((message as { kind: 'error'; message: string }).message).toMatch(/ole32|koffi/i)
  }, 30_000)

  it.skipIf(process.platform !== 'win32')('keeps the dialog off the taskbar and exits after cancellation', async () => {
    const probe = await loadWindowProbe()
    const title = 'Built-artifact guard'
    const child = spawn(process.execPath, [builtWorker], {
      env: { ...process.env, DSH_DIALOG_TITLE: title },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      windowsHide: true,
    })
    const messages: Win32DialogWorkerMessage[] = []
    child.on('message', (message: Win32DialogWorkerMessage) => { messages.push(message) })
    try {
      let dialog: ReturnType<typeof probe.dialogs>[number] | undefined
      await expect.poll(() => {
        if (child.pid === undefined) throw new Error('Dialog child has not spawned')
        const dialogs = probe.dialogs(new Set([child.pid]), title)
        dialog = dialogs[0]
        return dialogs.length
      }, { timeout: 10_000 }).toBe(1)
      expect(probe.presentation(dialog!)).toEqual({ visible: true, hiddenOwner: true, taskbarEligible: false })
      probe.cancel(dialog!)
      await expect.poll(() => child.exitCode, { timeout: 5000 }).toBe(0)
      expect(messages.find(message => message.kind !== 'showing')).toEqual({ kind: 'done', path: null })
      expect(probe.remaining(dialog!)).toEqual({ dialog: false, owner: false })
    } finally {
      if (child.exitCode === null) child.kill()
    }
  }, 30_000)
})
