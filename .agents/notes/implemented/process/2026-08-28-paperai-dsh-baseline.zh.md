# Agent Note: PaperAI 分叉自哪一份 DSH，以及如何据此度量

Status: implemented

[English](2026-08-28-paperai-dsh-baseline.md) | 中文

## 问题

PaperAI 是 DeepSeek Harness 的源码，产品层在同一棵树里生长，而这里有好几条决策承诺"后续的 DSH 更新可以重新应用"。但没有任何一条说明这棵树起始于哪一份 DSH，git 也答不上来：根提交 `e99b7625a4` 没有父提交，因此我们的历史与上游之间 `git merge-base` 返回空，所有祖先判断都会失败。没有记录在案的分叉点，"后续的 DSH 合并"就是一句无人能执行的话；而按日期挑一个提交来度量差距，得到的数字会差上千个提交。

## 决策

**分叉点是上游 `b150a551b8`，标签 `dsh-v0.1.1-rc.2`，日期 2026-08-21。** 我们的根提交 `e99b7625a4`（"chore: import DeepSeek Harness baseline"）是它的树级完全一致的压缩快照：`git rev-parse e99b7625a4^{tree}` 与 `git rev-parse b150a551b8^{tree}` 都输出 `53915efe4e2126cc7779b73dfc8a3bcec5318c44`，两者之间的 diff 为空。[`THIRD_PARTY_NOTICES.md`](../../../../THIRD_PARTY_NOTICES.md) 以署名副本的形式记载了同一个提交，两者不得脱节。上游仓库是 `https://github.com/deepseek-ai/deepseek-harness.git`，习惯上作为 `upstream` remote。

**因此基座更新是一次三方合并，而不是重新移植**——但前提是补齐缺失的祖先关系，而这条路上有两个坑。

第一个是缺失的合并基准。`git merge-base origin/main upstream/master` 返回空，因为导入提交没有父提交。要么显式给出基准 `--merge-base=b150a551b8`，要么用 `git replace --graft e99b7625a4 b150a551b8` 嫁接一次——正因为两棵树完全一致，这样做是安全的。

第二个是浅克隆。`.git/shallow` 里恰好只有 `b150a551b8`，它记录的父提交并不在对象库中：`git rev-list --max-parents=0 upstream/master` 会报告两个根，而 `git merge-base --is-ancestor` 对真实祖先也答 false。引用任何数字之前，先跑 `git fetch upstream --unshallow`。

**度量区间用 `dsh-v0.1.1-rc.2..upstream/master`，绝不要按日期。** 上游每天落 49 到 326 个提交，因此为了贴合导入日期而挑的提交早已在锚点之后上千个提交，算出的差异会大出六倍。按 2026-09-19 的实测，该区间有 4659 个提交（3203 个非合并），版本从 0.1.1-rc.2 到 0.1.6-alpha.2；`git merge-tree --write-tree --merge-base=b150a551b8 origin/main upstream/master` 报告 292 个冲突路径，其中没有一个落在 `packages/paperai/*`、`packages/client/ui-paperai-*` 或 `packages/bundle/paperai-web` 下。

**冲突数严重低估了工作量，因为产品最吃重的几个接入点在上游已经没有文件可供冲突。** 上游此后整体删除了 `packages/host/apiproxy`、`packages/client/runtime`、`packages/api/remotes/src/agent-lookup.ts`、`IApiClient` 类型，以及文档工作台所依附的布局 details 栏。我们这一侧是更小的一侧，也是被重放的一侧：58 个提交、875 个文件，对上游的 12,150 个文件。PaperAI 在共享 DSH 包内的改动触及 29 个包，13 个在 `packages/client` 下、16 个在其外，因此任何只列举 UI 包的清单，从构造上就是不完整的。

## 曾考虑的替代方案

**把 DSH 当作已发布依赖来消费，而不是导入其源码树。** 产品层直接改动共享的 DSH 文件——客户端插槽、布局服务、Agent 工厂——这些都不是包边界会暴露的扩展点。走依赖会迫使每一处这样的改动先上游化，而产品的节奏承受不起。

**完整克隆上游历史，而不是压缩导入。** 那样会天然拥有合并基准，本笔记也就不必存在。但它也会把 18,000 个无关提交带进一个维护者主要阅读自身历史的产品仓库。上面的嫁接用一条命令，就补回了压缩所放弃的那一项性质。

**跟踪移动中的上游分支，而不是钉在发布标签上。** 标签是有人发布并测试过的状态，`master` 则是那一小时恰好合入的内容。正是钉住标签，才让分叉点可被引用。

## 后果

任何人现在都能正确计算差距并说清基座更新的代价，那五条承诺"后续 DSH 合并"的决策也有了可指向的具体对象。代价是一项长期义务：本笔记、`THIRD_PARTY_NOTICES.md` 与实际的根提交陈述同一个分叉点，将来重设基线必须三者同步移动。上文的实测数字按构造带有日期属性、会逐渐过时；分叉点与那两个计算陷阱不会。本笔记不决定是否更新基座，只规定如何度量它。
