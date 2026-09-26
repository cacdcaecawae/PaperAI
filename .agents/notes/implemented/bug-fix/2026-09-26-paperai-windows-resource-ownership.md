# Agent Note: PaperAI Windows resource ownership

Status: implemented

English | [中文](2026-09-26-paperai-windows-resource-ownership.zh.md)

## Problem

Word automation is launched by DCOM rather than as a PowerShell child. Killing the converter process tree cannot guarantee that Word releases imported files. A missing drive root can also return `ENOENT` indefinitely to recursive project-directory creation, blocking the shared project-operation queue.

## Decision

Both packaged legacy converters bind their automation instance to a Windows job with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. A blank document supplies Word's window handle before the supplied file is opened. The converter holds the only job handle; disposal closes it and waits for Word to exit, while forced PowerShell termination closes it through the operating system. Quit runs independently of document Close. Nonempty password arguments prevent hidden password prompts.

The two providers retain independently packaged PowerShell assets, with an equality assertion preventing lifecycle behavior from diverging. Project-directory recursion stops at a root that reports `ENOENT`, preserving the original error and allowing later queued operations to run.

## Alternatives considered

**Process-tree termination alone.** Word's DCOM parentage leaves it outside the converter tree, and forced termination does not run PowerShell `finally` blocks.

**Killing every Word process.** Other instances may contain the user's unsaved work. The converter owns only the process identified by its own document window.

**Retrying a missing filesystem root.** Recursion cannot create the drive or network share and has no progress condition.

## Consequences

Windows-native tests use unrelated, file-locking processes to verify cancellation, timeout, and Close-failure cleanup without requiring Office. They also verify that another process remains alive. Word startup and blank-document creation precede job assignment; the job protects source-file conversion once its Word window exists. The root-failure regression checks both the original error and successful subsequent project creation.
