# `@paperai/project-service`

[English](README.md) | 中文

`ctx.paperProjects` 负责 PaperAI 唯一的“创建或接管目录”操作。用户选择或给出一个目录后，服务会幂等初始化目录，把规范路径关联到 DSH Workspace Registry，并通过 `ctx.paperRepository` 写入唯一的 `ProjectRecord`。产品中不存在独立的“打开项目”操作。

## 项目结构

服务只创建缺失目录，绝不改写已有文件。

```text
PAPERAI.md
documents/
  source/
  working/
  history/
templates/
references/
figures/
experiments/
  data/
  results/
code/
exports/
  drafts/
  delivery/
```

`documents/source/` 保存不可变的导入原件，`documents/working/` 保存权威 Working DOCX，`documents/history/` 保存可恢复快照。`PAPERAI.md` 为后续 Agent 提供精简的当前目标、进展、工作约定和下一步。服务以独占创建方式生成该文件；文件已存在时绝不覆盖，同名路径若不是普通文件则初始化失败且不会替换该路径。

## 服务 API

```ts
import type { ProjectRecord } from '@paperai/domain'
import type { ProjectGitStatus } from '@paperai/project-service'

interface CreatePaperProjectInput {
  rootPath: string
  name?: string
}

interface CreatePaperProjectResult {
  project: ProjectRecord
  projectCreated: boolean
  contextFile: 'created' | 'preserved'
  git: ProjectGitStatus
}
```

`create(input)` 串行执行初始化。同一规范路径重复调用时，会保留项目 id、名称、创建时间、上下文文件和全部用户文件。路径已有 DSH Workspace 时直接复用；项目记录关联的 Workspace 被重建时，只修复关联，不改变项目身份。

文件系统、Workspace 或 Repository 的致命失败只会删除本次创建且内容未变的文件和空目录。Repository 发布失败时，本次新注册的 Workspace 也会删除。服务从不递归删除已有内容；回滚本身失败时，会同时报告初始错误和清理错误。

项目发布后，服务通过可选的 `ctx.subprocess` 以精确 argv、无 Shell 的方式执行 Git。目录处于已有仓库中时直接复用，否则在项目根目录执行 `git init --initial-branch <名称>`。Subprocess Provider 或 Git 缺失、超时、输出超限或初始化非零退出时，返回 `git.status: 'degraded'`，但保留已经可用的项目。

## 配置

| 字段 | 默认值 | 含义 |
|---|---:|---|
| `gitCommand` | `git` | 由 Subprocess Provider 解析的可执行文件名或绝对路径。 |
| `gitInitialBranch` | `main` | 新 Git 仓库的初始分支。 |
| `gitTimeoutMs` | `15000` | 每条 Git 命令的超时。 |
| `gitOutputMaxBytes` | `262144` | 每个 Git 输出流的内存上限。 |
| `gitTerminateGraceMs` | `2000` | 进程树终止宽限时间。 |

所有数值限制必须是正安全整数。空白命令、分支、路径和显式项目名会在发布前失败。

## 模型体验

### `PAPERAI.md` Workspace 上下文

#### 模型看到的内容

创建项目不会改变模型请求。后续 Agent 只有通过普通 Workspace 工具读取 `PAPERAI.md` 时，才会看到精简的目标、进展、工作约定和下一步标题；用户或 Agent 后续编辑的内容会替代初始内容，成为持久项目上下文。

#### Token 影响

创建项目时为零。后续读取会消耗所选 `PAPERAI.md` 内容及承载它的 Workspace 工具结果所需的 token。

#### KV Cache 影响

创建项目时没有影响。后续读取会作为工具结果进入普通对话前缀，因此修改 `PAPERAI.md` 可能使该位置之后的缓存无法复用，但不会改变本包拥有的系统提示词。

## 已知限制与延期工作

- 如果进程在文件系统或 Workspace 初始化完成后、Repository 发布前崩溃，可能留下可复用的项目目录或无 `ProjectRecord` 的 Workspace；下一次 `create()` 会让同一路径收敛到完整状态。
- 本包尚不负责项目移动和删除；调用方不得从“创建或接管”操作推断这些能力。
