# Agent Note: PaperAI 自主管理产品自动化并继承 DSH 基线

Status: implemented

[English](2026-09-01-paperai-downstream-automation-ownership.md) | 中文

## 问题

PaperAI 在产品包所在仓库中保留了同步自 DeepSeek Harness 的工作流与依赖清单。部分继承工作流假设自己运行在 `deepseek-harness/deepseek-harness`：issue 自动化访问该仓库及其组织 Project，真实 API 测试依赖该仓库的 secret，npm 发布检查只打包 DSH 与 vendored-framework 发布族，主要 pull request job 还指向 DSH 拥有的大型或自托管 runner 标签。原样在 PaperAI 运行这些 job，会产生与 PaperAI 行为无关的基础设施失败或永久排队。常规 Dependabot 版本更新还会逐项把同步基线推进到 DSH 之前，并从陈旧分支重新生成大范围 lockfile 差异。

## 决策

Pull request CI 按仓库身份选择。DSH 保留完整发布矩阵、大型与故障转移 runner、逐文件 100% 覆盖率、Node 兼容矩阵、Python SDK 与 runtime 检查、Wine lane、完整原生 Windows 清单和全量快照清单。同步后的下游仓库只在标准托管 runner 上运行三个产品门禁：Linux 代码门禁负责静态检查、类型、lint、文档、聚焦产品测试，以及改动源码的逐文件覆盖率（语句、函数与行 85%，分支 65%）；Linux 组装 UI 门禁执行一次完整构建、发布产物检查、受影响的协议快照和 PaperAI 无密钥浏览器快照；聚焦的原生 Windows 门禁验证 ACP、OfficeCLI、导出、项目路径标识和持久 PowerShell 集成。快照 job 直接调用 Vitest 并显式指定配置与文件路径，命令转发不会把聚焦选择扩大成全量清单。持久 PowerShell 仅在原生 Windows 门禁验证，因为其终端行为与平台相关。所有产品可见的 PaperAI 浏览器快照仍是每个 pull request 的必需检查。

稳定的 `all checks passed` 结论只评估当前仓库拥有的 job 集合。PaperAI 在工作流源码中保留上游 job，使同步仍可审查，但会跳过这些 job，而不是重复执行另一产品的发布矩阵。拥有上游专属外部状态的自动化同样按仓库身份选择：DSH issue 自动化以及 DSH 或 vendored-framework npm 发布 job 只在 `deepseek-harness/deepseek-harness` 运行。跳过一个由上游拥有的 job 不算 PaperAI 产品失败。

代码 job 通过 `fetch-depth: 0` 保留完整提交历史，并指定 `filter: blob:none`。Checkout 按需下载选定版本的文件内容，改动源码覆盖率和归档验证仍可读取 pull request 的精确基线。这避开了 GitHub 未过滤历史 pack 中无法解析的 blob delta，不会截断提交历史或削弱检查。读取历史文件可能需要额外网络请求。

聚焦测试选择同时包含产品包测试与被修改共享模块的所属测试。产品测试间接执行共享代码，不能替代共享模块自身的行为覆盖；工作流回归测试约束这些共享测试套件的选择。CI 将 Vitest 选项直接放在 pnpm 脚本名之后，不插入会终止 Vitest 选项解析的 `--`。涉及路径的 MCP fixture（测试前置数据）使用当前平台的绝对路径和分隔符，使 Linux 与 Windows 验证相同的导出限制。

托管真实 API 工作流沿用已有凭证策略：上游默认启用，下游仓库只有在配置 `DEEPSEEK_API_KEY_EXTERNAL` 后，才用 `DSH_REAL_API_E2E_ENABLED=true` 显式启用。

npm、Python 与 GitHub Actions 的常规 Dependabot 版本更新通过 `open-pull-requests-limit: 0` 关闭。PaperAI 通过有意识的 DSH 同步与明确的产品依赖工作获取这些基线。Dependabot 安全更新是独立通道，不受版本更新数量限制。

PaperAI 发布产品包之前需要自己的发布族。把 `@paperai/*` 包塞进 DSH 发布族不能替代这项设计：上游发布族拥有不同的 scope、成员规则、版本线与 registry 所有权。

## 曾考虑的替代方案

**让所有继承工作流运行，并复制全部上游凭证与组织配置。** PaperAI 不拥有上游 Project 或 npm 发布族；复制凭证会把同步来的实现细节变成产品前置条件。

**修改 DSH 发布族以包含 `@paperai/*`。** 这会混合两个包 scope 与发布所有者，还会让上游发布验证依赖下游产品包。

**独立合并常规 Dependabot 更新。** 看似很小的更新也可能越过 DSH 兼容策略，或夹带无关 lockfile 漂移。有意识的基线同步保留单一、经过审查的依赖状态；安全更新保留紧急例外路径。

**删除继承工作流。** 删除能减少表面噪声，却会让上游同步更难审计，并可能在工作流职责变化时静默丢失可移植检查。

**在 PaperAI 以更小 worker 数运行每个可移植 DSH 门禁。** 这仍会在四核 runner 上重复完整覆盖率、兼容性、语言和平台清单。pull request 的大部分时间会用于验证同步来的底座，而不是 PaperAI profile，并把上游覆盖率债务变成下游产品失败。

## 后果

PaperAI pull request 会在仓库能够分配的 runner 上报告与产品相关的 CI，不再因缺少上游权限、无限排队或上游拥有的底座穷举检查而失败。有意识的 DSH 同步与发布准备仍必须在采用新基线前验证上游矩阵。仓库不再收到常规版本更新 PR，因此维护者必须安排明确的 PaperAI 依赖升级；安全公告仍可产生聚焦更新。DSH 与 vendored-framework 发布继续在其所属仓库中验证；在产品专属发布族完成设计和测试前，PaperAI 发布保持不可用。
