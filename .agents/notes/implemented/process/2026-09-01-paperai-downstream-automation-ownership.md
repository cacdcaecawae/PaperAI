# Agent Note: PaperAI owns product automation and inherits DSH baselines

Status: implemented

English | [中文](2026-09-01-paperai-downstream-automation-ownership.zh.md)

## Problem

PaperAI carries synchronized DeepSeek Harness workflows and dependency manifests in the same repository as its product packages. Several inherited workflows assume that they run inside `deepseek-harness/deepseek-harness`: issue automation addresses that repository and its organization Project, real-API tests require its secret, npm release checks pack only the DSH and vendored-framework release families, and the primary pull-request jobs target DSH-owned larger or self-hosted runner labels. Running those jobs unchanged in PaperAI produces infrastructure failures or permanently queued checks unrelated to PaperAI behavior. Routine Dependabot version updates also move the synchronized baseline ahead of DSH one dependency at a time and regenerate large lockfile diffs from stale branches.

## Decision

Pull-request CI is selected by repository identity. DSH keeps its complete release matrix, larger and failover runner pools, per-file 100% coverage, Node compatibility matrix, Python SDK and runtime checks, Wine lane, complete native Windows inventory, and full snapshot inventory. A synchronized downstream repository runs three product gates on standard hosted runners: a Linux code gate for static, type, lint, documentation, focused product tests, and per-file coverage of changed source at 85% statements, functions, and lines plus 65% branches; a Linux assembled-UI gate for one complete build, published-artifact checks, affected protocol snapshots, and PaperAI's keyless browser snapshots; and a focused native Windows gate for ACP, OfficeCLI, export, project-path identity, and persistent PowerShell integration. Snapshot jobs call Vitest directly with explicit configuration and file paths, so command forwarding cannot expand a focused selection into the full inventory. Persistent PowerShell coverage runs only in the native Windows gate because its terminal behavior is platform-specific. Product-visible PaperAI browser snapshots remain required on every pull request.

The stable `all checks passed` verdict evaluates only the job set owned by the current repository. PaperAI retains the upstream jobs in the workflow source so synchronization stays reviewable, but skips them instead of replaying a release matrix for a different product. Automation that owns upstream-only external state is also selected by repository identity: DSH issue automation and DSH or vendored-framework npm release jobs run only in `deepseek-harness/deepseek-harness`. A skipped upstream-owned job is not a PaperAI product failure.

The code job retains complete commit history with `fetch-depth: 0` and requests `filter: blob:none`. Checkout downloads the selected revision's file contents on demand, while changed-source coverage and archive verification can still read the exact pull-request base. This avoids the unresolved blob delta in the unfiltered GitHub history pack without truncating ancestry or weakening checks. Historical file reads can require additional network requests.

Focused test selection includes the owning tests for changed shared modules as well as product packages. Incidental execution through product tests does not replace direct coverage of a shared module's behavior; the workflow regression test guards the selected shared suites. CI passes Vitest options directly after the pnpm script name, without an intervening `--` that terminates Vitest option parsing. Path-sensitive MCP fixtures use native absolute paths and separators so Linux and Windows exercise the same export restrictions.

The hosted real-API workflow follows its existing credential policy: upstream is enabled by default, while a downstream repository opts in with `DSH_REAL_API_E2E_ENABLED=true` only after configuring `DEEPSEEK_API_KEY_EXTERNAL`.

Routine Dependabot version updates are disabled for npm, Python, and GitHub Actions with `open-pull-requests-limit: 0`. PaperAI receives those baselines through deliberate DSH synchronization and explicit product dependency work. Dependabot security updates remain a separate channel and are not subject to the version-update limit.

PaperAI needs its own release family before it publishes product packages. Adding `@paperai/*` packages to the DSH family is not a substitute: the upstream family has a different scope, membership rule, version line, and registry ownership.

## Alternatives considered

**Let every inherited workflow run and duplicate all upstream credentials and organization configuration.** PaperAI does not own the upstream Project or npm release family, and duplicating credentials would make a synchronized implementation detail a product prerequisite.

**Patch the DSH release family to include `@paperai/*`.** This mixes two package scopes and release owners. It also makes an upstream release verification depend on downstream product packages.

**Merge routine Dependabot updates independently.** Small-looking updates can cross DSH compatibility policy or carry unrelated lockfile churn. Deliberate baseline synchronization preserves one reviewed dependency state; security updates retain an urgent exception path.

**Delete the inherited workflows.** Deletion reduces visible noise but makes upstream synchronization harder to audit and can silently remove portable checks when workflow responsibilities change.

**Run every portable DSH gate in PaperAI with smaller worker counts.** This still repeats full coverage, compatibility, language, and platform inventories on four-core runners. It spends most pull-request time validating the synchronized foundation rather than the PaperAI profile and turns upstream coverage debt into downstream product failures.

## Consequences

The workflow regression test pins complete history, on-demand file downloads, and disabled credential persistence together. A fresh checkout must resolve the merge revision, read the exact base's files, and compute its diff before product checks run.

PaperAI pull requests report product-relevant CI on runners the repository can allocate, instead of failures, indefinite queues, or exhaustive foundation checks owned upstream. Deliberate DSH synchronization and release preparation must still verify the upstream matrix before adopting a new baseline. The repository no longer receives routine version-update pull requests, so maintainers must schedule explicit PaperAI dependency upgrades; security advisories can still produce focused updates. DSH and vendored-framework publication remain verified in their owning repository, while PaperAI publication stays unavailable until a product-specific release family is designed and tested.
