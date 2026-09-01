# Agent Note: PaperAI owns product automation and inherits DSH baselines

Status: implemented

English | [中文](2026-09-01-paperai-downstream-automation-ownership.zh.md)

## Problem

PaperAI carries synchronized DeepSeek Harness workflows and dependency manifests in the same repository as its product packages. Several inherited workflows assume that they run inside `deepseek-harness/deepseek-harness`: issue automation addresses that repository and its organization Project, real-API tests require its secret, and npm release checks pack only the DSH and vendored-framework release families. Running those jobs unchanged in PaperAI produces infrastructure failures unrelated to PaperAI behavior. Routine Dependabot version updates also move the synchronized baseline ahead of DSH one dependency at a time and regenerate large lockfile diffs from stale branches.

## Decision

Portable, keyless build, test, coverage, snapshot, and platform jobs continue to run in PaperAI. Automation that owns upstream-only external state is selected by repository identity: DSH issue automation and DSH or vendored-framework npm release jobs run only in `deepseek-harness/deepseek-harness`. PaperAI retains the workflow sources so upstream synchronization stays reviewable, but a skipped upstream-owned job is not a PaperAI product failure.

The hosted real-API workflow follows its existing credential policy: upstream is enabled by default, while a downstream repository opts in with `DSH_REAL_API_E2E_ENABLED=true` only after configuring `DEEPSEEK_API_KEY_EXTERNAL`.

Routine Dependabot version updates are disabled for npm, Python, and GitHub Actions with `open-pull-requests-limit: 0`. PaperAI receives those baselines through deliberate DSH synchronization and explicit product dependency work. Dependabot security updates remain a separate channel and are not subject to the version-update limit.

PaperAI needs its own release family before it publishes product packages. Adding `@paperai/*` packages to the DSH family is not a substitute: the upstream family has a different scope, membership rule, version line, and registry ownership.

## Alternatives considered

**Let every inherited workflow run and duplicate all upstream credentials and organization configuration.** PaperAI does not own the upstream Project or npm release family, and duplicating credentials would make a synchronized implementation detail a product prerequisite.

**Patch the DSH release family to include `@paperai/*`.** This mixes two package scopes and release owners. It also makes an upstream release verification depend on downstream product packages.

**Merge routine Dependabot updates independently.** Small-looking updates can cross DSH compatibility policy or carry unrelated lockfile churn. Deliberate baseline synchronization preserves one reviewed dependency state; security updates retain an urgent exception path.

**Delete the inherited workflows.** Deletion reduces visible noise but makes upstream synchronization harder to audit and can silently remove portable checks when workflow responsibilities change.

## Consequences

PaperAI pull requests report product-relevant CI instead of failures caused by missing upstream authority. The repository no longer receives routine version-update pull requests, so maintainers must synchronize DSH and schedule explicit PaperAI dependency upgrades. Security advisories can still produce focused updates. DSH and vendored-framework publication remain verified in their owning repository, while PaperAI publication stays unavailable until a product-specific release family is designed and tested.
