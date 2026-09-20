# Agent Note: The DSH baseline PaperAI forked, and how to compute against it

Status: implemented

English | [中文](2026-08-28-paperai-dsh-baseline.zh.md)

## Problem

PaperAI is DeepSeek Harness source with a product layer grown inside the same tree, and several decisions here promise that a later DSH update can be re-applied. None of them says which DSH this tree started from, and git cannot answer: the root commit `e99b7625a4` has no parents, so `git merge-base` between our history and upstream's returns nothing and every ancestry question fails. Without a recorded fork point, "a later DSH merge" is a phrase no one can act on, and a maintainer measuring the gap picks a commit by date and gets a number that is wrong by a thousand commits.

## Decision

**The fork point is upstream `b150a551b8`, tag `dsh-v0.1.1-rc.2`, dated 2026-08-21.** Our root commit `e99b7625a4` ("chore: import DeepSeek Harness baseline") is a tree-identical squashed snapshot of it: `git rev-parse e99b7625a4^{tree}` and `git rev-parse b150a551b8^{tree}` both print `53915efe4e2126cc7779b73dfc8a3bcec5318c44`, and the diff between them is empty. [`THIRD_PARTY_NOTICES.md`](../../../../THIRD_PARTY_NOTICES.md) carries the same commit as the attribution copy; the two must not drift apart. The upstream repository is `https://github.com/deepseek-ai/deepseek-harness.git`, conventionally the `upstream` remote.

**A base update is therefore a three-way merge, not a re-port** — but only once the missing ancestry is supplied, and two traps sit in the way.

The first is the absent merge base. `git merge-base origin/main upstream/master` exits empty because the import has no parents. Supply the base explicitly, as `--merge-base=b150a551b8`, or graft it once with `git replace --graft e99b7625a4 b150a551b8`, which is safe precisely because the trees are identical.

The second is the shallow clone. `.git/shallow` holds exactly `b150a551b8`, so its recorded parents are absent from the object store: `git rev-list --max-parents=0 upstream/master` reports two roots and `git merge-base --is-ancestor` answers false for genuine ancestors. Run `git fetch upstream --unshallow` before quoting any number.

**Measure the gap as `dsh-v0.1.1-rc.2..upstream/master`, never by date.** Upstream lands between 49 and 326 commits a day, so a commit picked for sharing our import's date is already a thousand commits past the anchor and produces a diff six times too large. As measured on 2026-09-19, that range held 4659 commits (3203 non-merge) carrying 0.1.1-rc.2 to 0.1.6-alpha.2, and `git merge-tree --write-tree --merge-base=b150a551b8 origin/main upstream/master` reported 292 conflicted paths with none under `packages/paperai/*`, `packages/client/ui-paperai-*` or `packages/bundle/paperai-web`.

**The conflict count understates the work, because the product's largest integration points have no upstream file left to conflict with.** Upstream has since deleted `packages/host/apiproxy`, `packages/client/runtime`, `packages/api/remotes/src/agent-lookup.ts`, the `IApiClient` type, and the layout `details` column that the document workbench hangs on. Our own side is the smaller one and is what gets replayed: 58 commits touching 875 files, against upstream's 12,150. PaperAI edits inside shared DSH packages reach 29 packages, 13 under `packages/client` and 16 outside it, so an inventory naming only UI packages is incomplete by construction.

## Alternatives considered

**Consume DSH as a published dependency instead of importing its tree.** The product layer changes shared DSH files directly — the client slots, the layout service, the agent factory — and those are not extension points a package boundary exposes. A dependency would have forced every such change upstream first, which the product's pace did not allow.

**Clone with full upstream history instead of squashing.** It would have given a real merge base and made this note unnecessary. It also would have carried 18,000 unrelated commits into a product repository whose own history is the thing maintainers read. The graft above restores the one property the squash gave up, at the cost of one command.

**Track a moving upstream branch rather than pinning a release tag.** A tag is a state someone released and tested; `master` is whatever landed that hour. Pinning is what makes the fork point quotable at all.

## Consequences

Anyone can now compute the gap correctly and say what a base update costs, and the five decisions that promise a later DSH merge have something concrete to point at. The cost is a standing obligation: this note, `THIRD_PARTY_NOTICES.md`, and the actual root commit state the same fork point, and a future re-baseline must move all three together. The measured figures above are dated by construction and will age; the fork point and the two computation traps will not. Nothing here decides whether to update the base — only how to measure it.
