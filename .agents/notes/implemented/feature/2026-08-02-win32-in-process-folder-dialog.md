# Agent Note: Win32 folder picker moves to koffi in a child process

Status: implemented

English | [中文](2026-08-02-win32-in-process-folder-dialog.zh.md)

## Problem

The Windows directory picker's primary tier was a spawned PowerShell script around WinForms `FolderBrowserDialog`: the modern dialog only where PowerShell 7 happens to be installed, a regression where PowerShell 6 resolves but has no WinForms (exit 1 is not `ENOENT`, so the 5.1 fallback never ran), a `SetProcessDPIAware` ceiling of system DPI, and a picker whose behavior depended on which shells a machine ships rather than on Windows itself.

## Decision

`packages/host/directory-picker-native` opens `IFileOpenDialog` (`FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_NOCHANGEDIR`) through koffi in a spawned child process. The modal `Show` runs on the child's main thread, keeping the Host event loop available for RPC. This is the only Windows native tier; COM failures surface directly ([PowerShell chain removal](../simplification/2026-08-04-drop-windows-powershell-picker-fallback.md)).

The dialog receives a hidden top-level tool window as its owner. This follows the [Windows taskbar ownership rules](https://learn.microsoft.com/en-us/windows/win32/shell/taskbar#managing-taskbar-buttons) and suppresses a separate Node.js taskbar button. The Web Host has no browser window handle; the unrelated foreground application cannot establish ownership of a picker request. The child destroys its hidden owner when `Show` returns or throws. Abort posts `WM_CLOSE` only to visible windows on the reported native thread (`EnumThreadWindows` and `IsWindowVisible`), leaving owner destruction until the modal call unwinds. The driver retries an abort that races window creation and kills the child if the close budget expires.

The child thread attempts per-monitor-v2, per-monitor, then system-aware DPI awareness through `SetThreadDpiAwarenessContext`, checking each return value before creating windows. DPI remains best-effort: a host accepting none of these contexts still receives the modern dialog.

## Alternatives considered

- **A prebuilt native helper (`native/` family like `@deepseek-ai/node-addon-landlock-run`).** Rejected: another npm package family, MSVC provisioning, and a Windows build/release lane — all to ship ~150 lines of C the repository cannot currently exercise on CI (no real-Windows lane); koffi delivers the same COM surface with zero new supply chain.
- **An N-API in-process addon.** Rejected for the same CI/toolchain reasons plus owned C++ for STA threading and message pumping that a child process + koffi express in TypeScript.
- **Keep PowerShell primary and probe versions.** Rejected: the picker stays hostage to shell packaging (6 vs 7, Store aliases, profiles), and 5.1's legacy dialog remains the floor wherever pwsh is absent; the fallback-trigger widening alone was accepted into the fallback tier instead.
- **Blocking the main thread for the modal call.** Rejected outright: the web host must keep serving RPC while the dialog is open.

## Consequences

- Every Windows machine gets the modern dialog with the best DPI awareness it supports (per-monitor-v2 on 1703+), PowerShell installed or not.
- Source and built-worker tests inspect real window ownership, taskbar eligibility, cancellation, and cleanup on Windows. The keyless Web snapshot exercises the shipped chooser through `host.pickDirectory` and records its native presentation and cancellation response. Rendering and interactive selection remain desktop checks.
- The COM vtable slots and GUIDs used are frozen Windows ABI (Vista); a koffi signature mistake risks a native access violation, contained to the dialog child process — the host Node process survives and the failure surfaces as-is (no fallback tier; see the [chain removal](../simplification/2026-08-04-drop-windows-powershell-picker-fallback.md)). The mocked-koffi ABI pins and the real win32 smoke exist to catch such mistakes before shipping.
- The packaged-binary arm — the packaged executable spawning itself as the dialog entry — is not exercised by any automated test: the source plane and the built `lib/worker.cjs` under plain node are covered, and the packaged spawn remains deferred to the Windows CI roadmap.
