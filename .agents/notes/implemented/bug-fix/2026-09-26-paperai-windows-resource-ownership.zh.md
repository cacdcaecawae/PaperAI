# Agent Note: PaperAI Windows 资源归属

Status: implemented

[English](2026-09-26-paperai-windows-resource-ownership.md) | 中文

## Problem

Word 自动化实例由 DCOM 启动，并非 PowerShell 的子进程。终止转换器进程树不能保证 Word 释放导入文件。缺失的驱动器根目录也可能让递归创建项目目录不断返回 `ENOENT`，阻塞共享的项目操作队列。

## Decision

两个随包分发的旧版转换器都将自动化实例绑定到带 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 的 Windows 作业对象。转换器在打开传入文件前，通过空白文档取得 Word 窗口句柄。转换器持有唯一的作业句柄；资源释放时关闭它并等待 Word 退出，强制终止 PowerShell 时则由操作系统关闭。Quit 独立于文档 Close 执行。非空密码参数避免隐藏的密码提示框。

两个 Provider 保留各自随包分发的 PowerShell 资源，并通过相等断言防止生命周期行为分歧。项目目录递归在根目录返回 `ENOENT` 时停止，保留原始错误，并允许后续排队操作继续执行。

## Alternatives considered

**仅终止进程树。** Word 的 DCOM 父进程关系使其位于转换器进程树之外，强制终止也不会执行 PowerShell 的 `finally` 块。

**终止所有 Word 进程。** 其他实例可能包含用户尚未保存的内容。转换器仅拥有由自身文档窗口识别出的进程。

**重试缺失的文件系统根目录。** 递归无法创建驱动器或网络共享，也没有推进条件。

## Consequences

Windows 原生测试使用无父子关系且锁定文件的进程，在无需 Office 的情况下验证取消、超时和 Close 失败后的清理，并验证另一个进程仍然存活。Word 启动和空白文档创建先于作业绑定；作业在 Word 窗口存在后保护源文件转换。根目录失败回归同时检查原始错误和后续项目创建成功。
