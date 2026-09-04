/** Keyless native-window transcript through the shipped Web tree and HTTP picker RPC. */

import type { ChildProcess } from 'node:child_process'
import { subscribe, unsubscribe } from 'node:diagnostics_channel'
import { basename } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadWindowProbe } from '../../../packages/host/directory-picker-native/tests/window-probe.ts'
import { launchWebScaffold, type WebScaffold } from './scaffold.ts'

describe.skipIf(process.platform !== 'win32')('Web native directory picker', () => {
  let scaffold: WebScaffold
  let probe: Awaited<ReturnType<typeof loadWindowProbe>>

  beforeAll(async () => {
    probe = await loadWindowProbe()
    scaffold = await launchWebScaffold({ directoryPicker: 'auto' })
  })

  afterAll(async () => {
    await scaffold?.close()
  })

  it('shows an owned native chooser and returns cancellation without leaving a window or process', async () => {
    const controller = new AbortController()
    const children = new Set<ChildProcess>()
    const observeChild = (message: unknown): void => {
      children.add((message as { process: ChildProcess }).process)
    }
    subscribe('child_process', observeChild)
    const request = fetch(`${scaffold.baseUrl}/api/host.pickDirectory`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'native-picker', method: 'host.pickDirectory', payload: {} }),
      signal: controller.signal,
    })
    // The HTTP request remains pending while the real native dialog is open.
    // Own its rejection immediately so cleanup can abort a failed scenario.
    const response = request.then(value => ({ value }), (error: unknown) => ({ error }))
    let dialog: ReturnType<typeof probe.dialogs>[number] | undefined
    let child: ChildProcess | undefined
    try {
      await expect.poll(() => {
        const pids = new Set([...children].flatMap(entry => entry.pid === undefined ? [] : [entry.pid]))
        const dialogs = probe.dialogs(pids, 'Select Workspace Directory')
        dialog = dialogs[0]
        child = [...children].find(entry => entry.pid === dialog?.pid)
        return dialogs.length
      }, { timeout: 15_000 }).toBe(1)
      const presentation = probe.presentation(dialog!)
      probe.cancel(dialog!)
      const result = await response
      if ('error' in result) throw result.error
      await expect.poll(() => child?.exitCode, { timeout: 5000 }).toBe(0)
      expect({
        presentation,
        builtWorker: child!.spawnargs.map(arg => basename(arg)).includes('worker.cjs'),
        status: result.value.status,
        response: await result.value.json() as unknown,
        remainingWindows: probe.remaining(dialog!),
      }).toMatchInlineSnapshot(`
        {
          "builtWorker": true,
          "presentation": {
            "hiddenOwner": true,
            "taskbarEligible": false,
            "visible": true,
          },
          "remainingWindows": {
            "dialog": false,
            "owner": false,
          },
          "response": {
            "result": {
              "ok": true,
              "value": {
                "path": null,
              },
            },
            "rpcId": "native-picker",
            "type": "server-response",
          },
          "status": 200,
        }
      `)
    } finally {
      unsubscribe('child_process', observeChild)
      controller.abort()
      await response
      if (child !== undefined) {
        try {
          await expect.poll(() => child?.exitCode, { timeout: 5000 }).toBe(0)
        } finally {
          if (child.exitCode === null) child.kill()
        }
      }
    }
  }, 30_000)
})
