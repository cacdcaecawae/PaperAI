# Agent Note: 拉取请求 CI 的可移植恢复边界

Status: implemented

[English](2026-07-23-portable-required-pull-request-ci.md) | 中文

## 问题

分配到组织自有运行器标签的拉取请求必需作业，在 GitHub 无法为这些池分配运行器时会持续排队。工作流本身有效，GitHub 标准托管作业仍能通过，但 `all checks passed` 始终无法启动，原本健康的拉取请求因此无法满足分支保护要求。

账单状态正常、运行器定义处于 `Ready` 状态以及较高的自动扩缩容上限，都不能证明指定的运行器池可以接收作业。必需的正确性检查需要预先明确一条可移植恢复路径，即使日常低延迟路径依赖仓库外部的运行器预配也不例外。

## 决策

[CI](../../../../.github/workflows/ci.yml) 只处理 pull request。在 `deepseek-harness/deepseek-harness` 中，它在仅限本仓库使用的企业级 16 核运行器池上运行必需的主 Node 24 作业，而稳定的 `all checks passed` 聚合流程运行在标准托管 Linux 上。必需的 Windows 作业在标准托管 Linux 上通过 Wine 运行 Windows Node，覆盖阻断性检查范围；一个独立原生作业使用企业 Windows 池，但不参与聚合流程（[双 Windows 决策](2026-08-08-native-windows-pull-request-ci.zh.md)）。标准托管作业保留 Node 22.19、Node 26、Python SDK 单元测试套件与[发布形态的 Linux x64 Python 运行时验证](../testing/2026-08-12-required-python-runtime-pull-request-ci.zh.md)，`ci-master.yml` 中的串行参考流程仍是完整且未分片的跨平台定义。同步下游仓库则按[下游自动化所有权决策](2026-09-01-paperai-downstream-automation-ownership.zh.md)，在分配前为主作业选择 `ubuntu-24.04` 与 `windows-2025`。

三项 Linux 主作业、Node 兼容性、Python SDK 单元测试套件、Python 运行时验证和 `windows node 24 / wine blocking` 继续作为 `all checks passed` 的依赖项；`windows node 24 / native complete` 被刻意排除。上游仓库的企业运行器发生故障时，采用由仓库变量控制的[故障切换手册](2026-07-26-ci-failover-runbook.zh.md)。下游仓库不会选择这些企业或自托管标签。

当前主拓扑及其测量结果以[大型运行器决策](2026-07-22-evidence-based-larger-hosted-runners.zh.md)为准。[跨平台串行参考流程](2026-07-21-serial-cross-platform-ci-reference.zh.md)继续作为独立的完整性检查，现由 `master` 上公司自有 `vm-backup`/`dsh-win-ci` 自托管热备通道提供；仅存的托管串行参考是禁用的 `serial-macos`。手动大型运行器套件则保留规格比较，同时不扩大普通必需矩阵。

## 曾考虑的替代方案

**将 Linux 主作业和聚合流程保留在标准容量上。** 此方案消除了剩余的企业级运行器分配依赖，但标准运行器上的完整作业反馈明显更慢，仍会遇到共享容量排队。当前拆分既保留可移植兼容性和串行证据，又将企业级运行器容量用于 Linux 主关键路径。

**根据标称核心数选择企业规格。** 基准测试表明扩展效果不呈单调变化，设置耗时也存在波动，因此必需运行器池改由完整作业的精确测量结果选定。

**在容量不可用时跳过检查或降低其级别。** 这种方式通过丢弃证据而非执行仓库的必需约定来使状态变绿。

**在每台主机上使用同一工作线程策略。** 外层门禁并发与内层工具工作线程在 Linux、Windows 和标准运行器上的争用方式不同；按主机实测的上限可以避免新增核心反而拖慢执行。

## 后果

普通上游 DSH 拉取请求会将企业级运行器容量用于 Linux 关键路径，而 Wine 作业让必需的 Windows 判定继续使用标准 Linux 容量。下游拉取请求为相同的可移植作业清单使用标准托管容量。独立原生作业不会延迟或改变聚合流程。一次针对确切分支头的实际运行会区分分支保护采用的命令与单独的诊断约定；排队延迟与每个作业从 `startedAt` 到 `completedAt` 的执行区间分开报告。

上游企业运行器分配能力下降时，标准兼容性作业与必需的 Wine 作业仍能提供有用证据；故障切换变量只能在新触发的运行证明热备池可接收工作后恢复主路径。下游仓库已经使用完整的标准托管路径，不依赖这套恢复机制。
