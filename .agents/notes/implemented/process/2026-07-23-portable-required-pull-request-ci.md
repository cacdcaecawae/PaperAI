# Agent Note: Portable pull-request CI recovery boundary

Status: implemented

English | [中文](2026-07-23-portable-required-pull-request-ci.zh.md)

## Problem

Required pull-request jobs assigned to organization-owned runner labels remain queued when GitHub cannot allocate those pools. The workflow is valid and standard GitHub-hosted jobs can still pass, but `all checks passed` never starts and an otherwise healthy pull request cannot satisfy branch protection.

Billing health, a runner definition's `Ready` state, and a large autoscaling ceiling do not prove that a named pool can receive a job. Required correctness checks need a known portable recovery path even when the ordinary low-latency path depends on repository-external runner provisioning.

## Decision

[CI](../../../../.github/workflows/ci.yml) is pull-request-only. In `deepseek-harness/deepseek-harness`, it runs the required primary Node 24 jobs on repo-restricted enterprise 16-core pools, while the stable `all checks passed` aggregate runs on standard hosted Linux. The required Windows job runs Windows Node under Wine on standard hosted Linux for the blocking surfaces; an independent native job uses the enterprise Windows pool but does not participate in the aggregate ([dual Windows decision](2026-08-08-native-windows-pull-request-ci.md)). Standard hosted jobs retain Node 22.19, Node 26, the Python SDK unit suite, and the [release-shaped Linux x64 Python runtime validation](../testing/2026-08-12-required-python-runtime-pull-request-ci.md), while the serial references in `ci-master.yml` remain the complete unsharded cross-platform definitions. Synchronized downstream repositories select `ubuntu-24.04` and `windows-2025` for the primary jobs before allocation, as the [downstream automation ownership decision](2026-09-01-paperai-downstream-automation-ownership.md) requires.

The three Linux primary jobs, Node compatibility, Python SDK unit suite, Python runtime validation, and `windows node 24 / wine blocking` remain dependencies of `all checks passed`; `windows node 24 / native complete` is deliberately absent. In the upstream repository, enterprise runner outages use the repository-variable [failover runbook](2026-07-26-ci-failover-runbook.md). Downstream repositories never select those enterprise or self-hosted labels.

The [larger-runner decision](2026-07-22-evidence-based-larger-hosted-runners.md) owns the current primary topology and its measurements. The [serial cross-platform reference](2026-07-21-serial-cross-platform-ci-reference.md) remains the independent completeness check, now provided by the self-hosted `vm-backup`/`dsh-win-ci` standby lanes on `master`; the only hosted serial reference is the disabled `serial-macos`. The manual larger-runner suites retain size comparisons without expanding the ordinary required matrix.

## Alternatives considered

**Keep the Linux primary jobs and aggregate on standard capacity.** This removes the remaining enterprise allocation dependency, but complete standard-runner jobs give materially slower feedback and still experience shared-capacity queues. The current split retains portable compatibility and serial evidence while spending enterprise capacity on the Linux primary critical path.

**Select enterprise size from advertised core count.** Benchmarks show non-monotonic scaling and setup variance, so exact complete-job measurements choose the required pools instead.

**Skip or demote checks while capacity is unavailable.** This would make the status green by dropping evidence rather than by running the repository's required contracts.

**Use one worker policy on every host.** Outer gate concurrency and inner tool workers contend differently on Linux, Windows, and standard runners; measured host-specific bounds avoid turning additional cores into slower execution.

## Consequences

Ordinary upstream DSH pull requests spend enterprise capacity on the Linux critical path while the Wine job keeps the required Windows verdict on standard Linux allocation. Downstream pull requests spend standard hosted capacity for the same portable job inventory. The independent native job does not delay or change the aggregate. A live exact-head run distinguishes the commands branch protection consumes from the separate diagnostic contract; queue delay is reported separately from each job's `startedAt` to `completedAt` execution interval.

Standard compatibility and required Wine jobs remain useful when upstream enterprise allocation is degraded, while the failover variables restore the primary route only after a newly triggered run proves the standby pool can receive work. Downstream repositories already use the complete standard-hosted route and do not depend on that recovery mechanism.
