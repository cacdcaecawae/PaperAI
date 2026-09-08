/** Native window observations for picker subprocess and assembled Web tests. */

interface DialogWindow {
  handle: unknown
  owner: unknown
  threadId: number
  pid: number
}

/**
 * Load Win32 observations and cancellation scoped to the caller's process ids.
 * @returns the probe; callers must supply only test-owned process ids.
 */
export async function loadWindowProbe() {
  const koffi = (await import('koffi')).default
  const user32 = koffi.load('user32.dll')
  const enumWindows = user32.func('__stdcall', 'EnumWindows', 'int', ['void *', 'intptr'])
  const getWindowThreadProcessId = user32.func('__stdcall', 'GetWindowThreadProcessId', 'uint32', ['void *', 'void *'])
  const getWindowText = user32.func('__stdcall', 'GetWindowTextW', 'int', ['void *', 'void *', 'int'])
  const getWindow = user32.func('__stdcall', 'GetWindow', 'void *', ['void *', 'uint32'])
  const getWindowLong = user32.func('__stdcall', 'GetWindowLongW', 'int32', ['void *', 'int'])
  const isWindowVisible = user32.func('__stdcall', 'IsWindowVisible', 'int', ['void *'])
  const isWindow = user32.func('__stdcall', 'IsWindow', 'int', ['void *'])
  const postMessage = user32.func('__stdcall', 'PostMessageW', 'int', ['void *', 'uint32', 'uintptr', 'intptr'])
  const enumProc = koffi.proto('int __stdcall DshPickerTestWindowEnum(void *hwnd, intptr lparam)')

  return {
    dialogs(pids: ReadonlySet<number>, title: string): DialogWindow[] {
      const dialogs: DialogWindow[] = []
      const callback = koffi.register((handle: unknown) => {
        const pidBytes = Buffer.alloc(4)
        const threadId = getWindowThreadProcessId(handle, pidBytes) as number
        const pid = pidBytes.readUInt32LE()
        if (!pids.has(pid) || !isWindowVisible(handle)) return 1
        const titleBytes = Buffer.alloc(512)
        const length = getWindowText(handle, titleBytes, 256) as number
        if (titleBytes.toString('utf16le', 0, length * 2) === title) {
          dialogs.push({ handle, owner: getWindow(handle, 4), threadId, pid })
        }
        return 1
      }, koffi.pointer(enumProc))
      try {
        enumWindows(callback, 0)
      } finally {
        koffi.unregister(callback)
      }
      return dialogs
    },
    presentation(dialog: DialogWindow) {
      const style = getWindowLong(dialog.handle, -20) as number
      return {
        visible: Boolean(isWindowVisible(dialog.handle)),
        hiddenOwner: dialog.owner !== null && !isWindowVisible(dialog.owner),
        // WS_EX_APPWINDOW forces a taskbar button; otherwise only an unowned
        // non-tool window is eligible under the Shell's taskbar rules.
        taskbarEligible: Boolean(style & 0x40000) || (dialog.owner === null && !(style & 0x80)),
      }
    },
    remaining(dialog: DialogWindow) {
      return {
        dialog: Boolean(isWindow(dialog.handle)),
        owner: dialog.owner !== null && Boolean(isWindow(dialog.owner)),
      }
    },
    cancel(dialog: DialogWindow): void {
      if (!postMessage(dialog.handle, 0x10, 0, 0)) throw new Error('Could not cancel the test folder picker')
    },
  }
}
