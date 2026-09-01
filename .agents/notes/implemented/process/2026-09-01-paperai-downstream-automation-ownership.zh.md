# Agent Note: PaperAI 自主管理产品自动化并继承 DSH 基线

Status: implemented

[English](2026-09-01-paperai-downstream-automation-ownership.md) | 中文

## 问题

PaperAI 在产品包所在仓库中保留了同步自 DeepSeek Harness 的工作流与依赖清单。部分继承工作流假设自己运行在 `deepseek-harness/deepseek-harness`：issue 自动化访问该仓库及其组织 Project，真实 API 测试依赖该仓库的 secret，npm 发布检查只打包 DSH 与 vendored-framework 发布族，主要 pull request job 还指向 DSH 拥有的大型或自托管 runner 标签。原样在 PaperAI 运行这些 job，会产生与 PaperAI 行为无关的基础设施失败或永久排队。常规 Dependabot 版本更新还会逐项把同步基线推进到 DSH 之前，并从陈旧分支重新生成大范围 lockfile 差异。

## 决策

可移植、无密钥的构建、测试、覆盖率、快照与平台 job 继续在 PaperAI 运行，其 runner 选择也按仓库身份区分：DSH 保留大型与故障转移资源池，PaperAI 及其他同步下游仓库使用 `ubuntu-24.04` 和 `windows-2025`。依赖 runner 的缓存、浏览器安装与并发分支采用相同的仓库守卫，因此下游即使存在与上游故障转移变量同名的配置，也不会选择上游专属行为。拥有上游专属外部状态的自动化按仓库身份选择：DSH issue 自动化以及 DSH 或 vendored-framework npm 发布 job 只在 `deepseek-harness/deepseek-harness` 运行。PaperAI 保留这些工作流源码，使上游同步仍可审查；跳过一个由上游拥有的 job 不算 PaperAI 产品失败。

托管真实 API 工作流沿用已有凭证策略：上游默认启用，下游仓库只有在配置 `DEEPSEEK_API_KEY_EXTERNAL` 后，才用 `DSH_REAL_API_E2E_ENABLED=true` 显式启用。

npm、Python 与 GitHub Actions 的常规 Dependabot 版本更新通过 `open-pull-requests-limit: 0` 关闭。PaperAI 通过有意识的 DSH 同步与明确的产品依赖工作获取这些基线。Dependabot 安全更新是独立通道，不受版本更新数量限制。

PaperAI 发布产品包之前需要自己的发布族。把 `@paperai/*` 包塞进 DSH 发布族不能替代这项设计：上游发布族拥有不同的 scope、成员规则、版本线与 registry 所有权。

## 曾考虑的替代方案

**让所有继承工作流运行，并复制全部上游凭证与组织配置。** PaperAI 不拥有上游 Project 或 npm 发布族；复制凭证会把同步来的实现细节变成产品前置条件。

**修改 DSH 发布族以包含 `@paperai/*`。** 这会混合两个包 scope 与发布所有者，还会让上游发布验证依赖下游产品包。

**独立合并常规 Dependabot 更新。** 看似很小的更新也可能越过 DSH 兼容策略，或夹带无关 lockfile 漂移。有意识的基线同步保留单一、经过审查的依赖状态；安全更新保留紧急例外路径。

**删除继承工作流。** 删除能减少表面噪声，却会让上游同步更难审计，并可能在工作流职责变化时静默丢失可移植检查。

## 后果

PaperAI pull request 会在仓库能够分配的 runner 上报告与产品相关的 CI，不再因缺少上游权限而失败或无限排队。仓库不再收到常规版本更新 PR，因此维护者必须同步 DSH，并安排明确的 PaperAI 依赖升级。安全公告仍可产生聚焦更新。DSH 与 vendored-framework 发布继续在其所有仓库中验证；在产品专属发布族完成设计和测试前，PaperAI 发布保持不可用。
