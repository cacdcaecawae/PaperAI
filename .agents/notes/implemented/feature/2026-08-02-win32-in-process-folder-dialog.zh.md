# Agent Note: Win32 文件夹选择器迁至 koffi 子进程

Status: implemented

[English](2026-08-02-win32-in-process-folder-dialog.md) | 中文

## 问题

Windows 目录选择器的主层此前是围绕 WinForms `FolderBrowserDialog` spawn 出的 PowerShell 脚本：只有恰好安装了 PowerShell 7 的机器才有现代对话框；一处回归——PowerShell 6 可解析却没有 WinForms（退出码 1 而非 `ENOENT`，5.1 回退永远不会触发）；`SetProcessDPIAware` 只有系统 DPI 的上限；选择器的行为取决于机器装了哪些 shell，而不是取决于 Windows 本身。

## 决策

`packages/host/directory-picker-native` 在 spawn 出的子进程内通过 koffi 打开 `IFileOpenDialog`（`FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_NOCHANGEDIR`）。模态 `Show` 在子进程主线程运行，宿主事件循环继续处理 RPC。这是 Windows 唯一的原生层级，COM 失败直接上报（见 [PowerShell 链删除](../simplification/2026-08-04-drop-windows-powershell-picker-fallback.zh.md)）。

对话框使用一个隐藏的顶层工具窗口作为所属窗口，遵循 [Windows 任务栏窗口归属规则](https://learn.microsoft.com/en-us/windows/win32/shell/taskbar#managing-taskbar-buttons)，避免出现独立的 Node.js 任务栏按钮。Web 宿主没有浏览器窗口句柄，其他前台应用也不能确定选择请求的窗口归属。`Show` 返回或抛出异常时，子进程销毁隐藏的所属窗口。中止时只向已上报原生线程中的可见窗口投递 `WM_CLOSE`（`EnumThreadWindows` 与 `IsWindowVisible`），等模态调用退出后再销毁所属窗口。若中止与窗口创建发生竞态，驱动层会重试；关闭等待预算耗尽后强制终止子进程。

子进程线程在创建窗口前通过 `SetThreadDpiAwarenessContext` 依次尝试 per-monitor-v2、per-monitor、system-aware DPI 感知，并检查每次返回值。DPI 为尽力启用的外观功能：宿主拒绝全部上下文时仍使用现代对话框。

## 考虑过的替代方案

- **预编译原生辅助程序（`native/` 家族，如 `@deepseek-ai/node-addon-landlock-run`）。** 否决：再增加一个 npm 包家族、MSVC 环境配置和 Windows 构建／发布通道——只为交付约 150 行仓库目前无法通过 CI 检验的 C 代码（现有 CI 没有真 Windows 通道）；koffi 以零新增供应链提供同一 COM 接口。
- **N-API 进程内插件。** 否决：同样的 CI／工具链原因，还需自行维护处理 STA 线程与消息泵的 C++ 代码，而子进程 + koffi 用 TypeScript 就能表达。
- **保留 PowerShell 为主层并探测版本。** 否决：选择器仍被 shell 打包形态挟持（6 与 7、Store 别名、profile），且没有 pwsh 的机器仍只能使用 5.1 的旧版对话框；只有拓宽回退触发条件这一项改动被纳入了回退层。
- **在主线程上阻塞模态调用。** 直接否决：对话框打开期间 web 宿主必须继续服务 RPC。

## 后果

- 每台 Windows 机器都得到带其所支持的最佳 DPI 感知（1703+ 为 per-monitor-v2）的现代对话框，无论是否安装 PowerShell。
- 源码与构建后子进程测试在 Windows 上检查真实窗口的归属、任务栏显示条件、取消和清理。无密钥 Web 快照通过 `host.pickDirectory` 调用发布的选择器，记录原生窗口状态和取消响应。渲染与交互式选择仍需桌面检查。
- 所用 COM vtable 槽位与 GUID 是冻结的 Windows ABI（Vista 起）；koffi 签名错误可能引发原生访问冲突，但被限制在对话框子进程内——宿主 Node 进程存活，失败原样上报（无回退层；见[链删除](../simplification/2026-08-04-drop-windows-powershell-picker-fallback.zh.md)）。mocked-koffi 的 ABI 固定测试与真实 win32 冒烟测试正是为了在交付前捕获这类错误。
- 打包二进制路径——打包后的可执行文件以对话框入口形式自我 spawn——不受任何自动化测试覆盖：源码侧与普通 node 下构建出的 `lib/worker.cjs` 已被覆盖，打包 spawn 推迟到 Windows CI 路线图。
