import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const runnerPrivatePnpmDestination = '${{ runner.temp }}/setup-pnpm'
const nativeWindowsPnpmDestination = '${{ runner.temp }}/setup-pnpm-js'

describe('CI workflow', () => {
  it('isolates every pnpm action setup destination per runner', () => {
    const files = ['.github/workflows/ci.yml', '.github/workflows/ci-master.yml']
    const setups: Array<{ jobName: string; step: unknown }> = []
    for (const file of files) {
      const workflow: unknown = yaml.load(readFileSync(resolve(root, file), 'utf8'))
      if (!isRecord(workflow) || !isRecord(workflow.jobs)) throw new TypeError(`${file} must define jobs`)
      for (const [jobName, job] of Object.entries(workflow.jobs)) {
        if (!isRecord(job) || !Array.isArray(job.steps)) continue
        for (const step of job.steps) {
          if (!isRecord(step) || typeof step.uses !== 'string' || !step.uses.startsWith('pnpm/action-setup@')) continue
          setups.push({ jobName, step })
        }
      }
    }

    expect(setups.length).toBeGreaterThan(0)
    for (const { jobName, step } of setups) {
      expect(step, `${jobName} must not share pnpm/action-setup's default destination`).toMatchObject({
        with: {
          dest: jobName === 'windows-native'
            ? nativeWindowsPnpmDestination
            : runnerPrivatePnpmDestination,
        },
      })
      if (jobName === 'windows-native') expect(step).not.toMatchObject({ with: { standalone: true } })
    }
  })

  it('separates the upstream release matrix from the downstream PaperAI gates', () => {
    const workflow = loadWorkflow('.github/workflows/ci.yml')
    const masterWorkflow = loadWorkflow('.github/workflows/ci-master.yml')
    if (!isRecord(workflow.jobs) || !isRecord(masterWorkflow.jobs)) {
      throw new TypeError('CI workflows must define jobs')
    }

    const upstreamJobs = [
      'node-24',
      'node-24-coverage',
      'node-24-consumers',
      'node-compat',
      'python-sdk',
      'python-runtime',
      'windows',
      'windows-native',
    ]
    for (const name of upstreamJobs) {
      const job = workflow.jobs[name]
      if (!isRecord(job)) throw new TypeError(`${name} must be defined`)
      expect(job.if).toContain("github.repository == 'deepseek-harness/deepseek-harness'")
    }

    for (const name of ['paperai-code', 'paperai-ui', 'paperai-windows']) {
      const job = workflow.jobs[name]
      if (!isRecord(job) || !Array.isArray(job.steps)) {
        throw new TypeError(`${name} must define steps`)
      }
      expect(job.if).toContain("github.repository != 'deepseek-harness/deepseek-harness'")
    }

    const code = workflow.jobs['paperai-code']
    const ui = workflow.jobs['paperai-ui']
    const paperaiWindows = workflow.jobs['paperai-windows']
    const aggregate = workflow.jobs['all-checks-passed']
    const windowsNative = workflow.jobs['windows-native']
    if (!isRecord(code)
      || !isRecord(ui)
      || !isRecord(paperaiWindows)
      || !isRecord(aggregate)
      || !isRecord(windowsNative)
      || !Array.isArray(code.steps)
      || !Array.isArray(ui.steps)
      || !Array.isArray(paperaiWindows.steps)
      || !Array.isArray(aggregate.steps)
      || !Array.isArray(aggregate.needs)) {
      throw new TypeError('PaperAI, aggregate, and native Windows jobs must be complete')
    }

    expect(code['runs-on']).toBe('ubuntu-24.04')
    expect(ui['runs-on']).toBe('ubuntu-24.04')
    expect(paperaiWindows['runs-on']).toBe('windows-2025')
    const codeCommands = commandText(code.steps)
    expect(codeCommands).toContain('pnpm run check:ci:static')
    expect(codeCommands).toContain('pnpm run typecheck:contracts-ready')
    expect(codeCommands).toContain('pnpm run lint:contracts-ready')
    expect(codeCommands).toContain('pnpm run test:paperai:ci')
    expect(codeCommands).toContain('--coverage.changed=')
    expect(codeCommands).toContain('--coverage.thresholds.perFile=true')
    expect(codeCommands).toContain('--coverage.thresholds.statements=85')
    expect(codeCommands).toContain('--coverage.thresholds.branches=65')
    expect(codeCommands).toContain('--coverage.thresholds.functions=85')
    expect(codeCommands).toContain('--coverage.thresholds.lines=85')
    expect(codeCommands).toContain('--coverage.reporter=text')

    const manifest: unknown = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
    if (!isRecord(manifest) || !isRecord(manifest.scripts)) {
      throw new TypeError('package.json must define scripts')
    }
    const paperaiCodeScript = manifest.scripts['test:paperai:ci']
    const paperaiWindowsScript = manifest.scripts['test:paperai:windows']
    if (typeof paperaiCodeScript !== 'string' || typeof paperaiWindowsScript !== 'string') {
      throw new TypeError('PaperAI CI scripts must be strings')
    }
    for (const selection of [
      'packages/client/ui-paperai-workbench/tests',
      'packages/interaction/permission-presets/tests',
      'packages/paperai',
    ]) {
      expect(paperaiCodeScript).toContain(selection)
    }
    expect(paperaiCodeScript).not.toContain('packages/shell/tool-pwsh-persistent/tests')
    for (const selection of [
      'packages/paperai/agent-acp/tests',
      'packages/paperai/project-service/tests/project-service.spec.ts',
      'packages/shell/tool-pwsh-persistent/tests/loader-composition.spec.ts',
    ]) {
      expect(paperaiWindowsScript).toContain(selection)
    }
    for (const criticalTest of [
      'packages/paperai/agent-acp/tests/provider-modes.integration.spec.ts',
      'packages/paperai/workbench-service/tests/workbench.spec.ts',
      'packages/client/ui-paperai-workbench/tests/controller.client.spec.ts',
      'packages/client/ui-paperai-workbench/tests/components.client.spec.tsx',
      'packages/paperai/project-service/tests/project-service.spec.ts',
    ]) {
      expect(existsSync(resolve(root, criticalTest)), criticalTest).toBe(true)
    }

    const uiCommands = commandText(ui.steps)
    expect(uiCommands).toContain('pnpm run build')
    expect(uiCommands).toContain('pnpm exec vitest run --config vitest.snapshot.config.ts')
    expect(uiCommands).toContain('pnpm exec vitest run --config vitest.web.config.ts')
    expect(uiCommands).not.toContain('pnpm run test:snapshot --')
    expect(uiCommands).not.toContain('pnpm run test:web:built --')
    expect(uiCommands).toContain('snapshot: pwsh-tool-turn matches')
    expect(uiCommands).not.toContain('persistent-pwsh-tool-turn')
    expect(uiCommands).toContain('scripts/translation-prompt.snapshot.ts')
    expect(uiCommands).toContain('apps/web/tests/paperai-permissions.e2e.ts')
    expect(uiCommands).toContain('apps/web/tests/paperai-workspace-navigation.e2e.ts')
    expect(uiCommands).toContain('apps/web/tests/built-boot.snapshot.ts')

    const windowsCommands = commandText(paperaiWindows.steps)
    expect(windowsCommands).toContain('pnpm run test:paperai:windows')
    expect(windowsCommands).toContain('snapshot: persistent-pwsh-tool-turn matches')
    expect(windowsCommands).not.toContain('check:ci:windows-complete')
    expect(typeof windowsNative['runs-on']).toBe('string')
    expect(windowsNative['runs-on']).toContain('DSH_CI_FAILOVER_WINDOWS')
    expect(windowsNative['runs-on']).toContain('dsh-windows-2025-16core')
    expect(commandText(windowsNative.steps as unknown[])).toContain('pnpm run check:ci:windows-complete')

    expect(aggregate.needs).toEqual(expect.arrayContaining([
      'paperai-code',
      'paperai-ui',
      'paperai-windows',
      'windows',
    ]))
    expect(aggregate.needs).not.toContain('windows-native')
    const aggregateConditions = aggregate.steps
      .filter(isRecord)
      .map(step => typeof step.if === 'string' ? step.if : '')
      .join('\n')
    expect(aggregateConditions).toContain("github.repository == 'deepseek-harness/deepseek-harness'")
    expect(aggregateConditions).toContain("github.repository != 'deepseek-harness/deepseek-harness'")
    expect(aggregateConditions).toContain("needs.paperai-code.result != 'success'")
    expect(aggregateConditions).toContain("needs.paperai-ui.result != 'success'")
    expect(aggregateConditions).toContain("needs.paperai-windows.result != 'success'")
    expect(aggregateConditions).toContain("needs.windows.result != 'success'")

    const wineAptCache = masterWorkflow.jobs['wine-apt-cache']
    const serialWindows = masterWorkflow.jobs['serial-windows']
    if (!isRecord(wineAptCache) || !isRecord(serialWindows)) {
      throw new TypeError('ci-master must define Wine cache and Windows standby jobs')
    }
    expect(wineAptCache.if).toBe("github.event_name == 'push' && github.ref == 'refs/heads/master'")
    expect(wineAptCache['runs-on']).toBe('ubuntu-latest')
    expect(serialWindows.if).toBe("github.event_name == 'push' && github.ref == 'refs/heads/master'")
    expect(serialWindows['runs-on']).toEqual(['self-hosted', 'dsh-win-ci', 'windows'])
  })

  it('exempts push from cancellation in ci-master, so one master merge does not cancel the running drill', () => {
    const workflow = loadWorkflow('.github/workflows/ci-master.yml')
    const prWorkflow = loadWorkflow('.github/workflows/ci.yml')
    if (!isRecord(workflow.jobs) || !isRecord(workflow.concurrency)) {
      throw new TypeError('ci-master workflow must define jobs and a workflow-level concurrency block')
    }
    if (!isRecord(prWorkflow.jobs)) {
      throw new TypeError('ci workflow must define jobs')
    }

    // Cancellation applies to the whole superseded RUN, so this has to be
    // decided at workflow level and gated on the event: a job-level group
    // cannot exempt its job from its run being cancelled. Only push is exempt —
    // a drill takes longer than the interval between master merges. The negated
    // form is load-bearing: `== 'pull_request'` would also stop cancelling
    // workflow_dispatch, and a re-dispatched runner benchmark holds up to 12
    // larger runners for 15 minutes in this same group on master.
    expect(workflow.concurrency['cancel-in-progress']).toBe("${{ github.event_name != 'push' }}")

    // The PR-only ci.yml still cancels a superseded run on a new push, so a
    // fresh head does not stack another complete run behind a stale one.
    // Unlike ci-master it has no push carve-out: every PR event supersedes.
    expect(prWorkflow.concurrency).toMatchObject({
      'cancel-in-progress': true,
    })

    // The exact event sets are what keep master-only jobs out of the PR check
    // panel: ci-master triggers only on push(master) + workflow_dispatch and
    // never on pull_request; ci.yml is exactly pull_request-only. Assert the
    // full sets so losing the wrong event, or gaining an extra one, fails.
    if (!isRecord(workflow.on) || !isRecord(prWorkflow.on)) {
      throw new TypeError('both CI workflows must define on')
    }
    expect(Object.keys(workflow.on).sort()).toEqual(['push', 'workflow_dispatch'])
    expect(Object.keys(prWorkflow.on)).toEqual(['pull_request'])

    // Neither drill may carry a job-level group: it would not exempt the job
    // from run-scoped cancellation.
    for (const name of ['serial-linux-selfhosted', 'serial-windows']) {
      const job = workflow.jobs[name]
      if (!isRecord(job)) throw new TypeError(`${name} must be defined`)
      expect(job.concurrency).toBeUndefined()
      // Both stay master-push-only; that is what makes the push carve-out safe.
      expect(job.if).toBe("github.event_name == 'push' && github.ref == 'refs/heads/master'")
    }

    // What bounds the cost of exempting push: a master push may only carry the
    // cache seeder and the two drills. Any job reachable on push would start
    // accumulating uncancelled runs, so the set is pinned here.
    const NOT_PUSH_REACHABLE = new Set([
      "github.event_name == 'workflow_dispatch' && inputs.suite == 'larger-runner-benchmark'",
      "github.event_name == 'workflow_dispatch' && inputs.suite == 'consolidated-runner-benchmark'",
    ])
    const pushReachable = Object.entries(workflow.jobs)
      .filter(([, job]) => {
        if (!isRecord(job)) return false
        if (job.if === undefined) return true // unconditional: runs on every event
        if (job.if === false) return false // `if: false` parses as a boolean
        if (typeof job.if !== 'string') return true // unrecognized shape: surface it
        return !NOT_PUSH_REACHABLE.has(job.if.trim())
      })
      .map(([name]) => name)
      .sort()
    expect(pushReachable).toEqual(['serial-linux-selfhosted', 'serial-windows', 'wine-apt-cache'])

    // Why workflow_dispatch must keep cancelling: each benchmark fans out to a
    // dozen larger runners at once, in this same group on master. If it stopped
    // cancelling, a re-dispatch would queue ahead of a drill instead of
    // replacing the stale measurement.
    for (const name of ['larger-runner-benchmark', 'consolidated-runner-benchmark']) {
      const job = workflow.jobs[name]
      if (!isRecord(job) || !isRecord(job.strategy)) {
        throw new TypeError(`${name} must define a matrix strategy`)
      }
      expect(job.strategy['max-parallel']).toBe(12)
      expect(job['timeout-minutes']).toBe(15)
    }
  })

  it('keeps supported LSP source under native Windows coverage', () => {
    const config = readFileSync(resolve(root, 'vitest.config.ts'), 'utf8')

    expect(config).not.toContain('packages/lsp/lsp-stdio/src/connection.ts')
    expect(config).not.toContain('packages/lsp/lsp-stdio/src/index.ts')
    expect(config).not.toContain('packages/lsp/lsp-stdio/src/instance.ts')
  })

  it('keeps the release-shaped Python runtime target in the upstream matrix', () => {
    const workflow = loadWorkflow('.github/workflows/ci.yml')
    const pythonRuntime = workflowJob(workflow, 'python-runtime')
    const aggregate = workflowJob(workflow, 'all-checks-passed')
    if (!Array.isArray(aggregate.needs)) {
      throw new TypeError('CI aggregate must define required job dependencies')
    }

    expect(pythonRuntime).toMatchObject({
      if: "github.event_name == 'pull_request' && github.repository == 'deepseek-harness/deepseek-harness'",
      name: 'python runtime / release-shaped Linux x64',
      uses: './.github/workflows/build-exe-for-python-sdk.yml',
      with: {
        targets: 'node24-linux-x64',
        ci: true,
      },
    })
    expect(aggregate.needs).toContain('python-runtime')
  })

  it('keeps every Vitest project process-isolated on native Windows', () => {
    const config = readFileSync(resolve(root, 'vitest.config.ts'), 'utf8')

    expect(config).not.toContain("pool: process.platform === 'win32' ? 'threads' : 'forks'")
    expect(config.match(/pool: 'forks'/g)).toHaveLength(2)
  })
})

describe('DeepSeek e2e workflow', () => {
  it('keeps downstream runs opt-in and prepares bubblewrap without a package transaction', () => {
    const workflow = loadWorkflow('.github/workflows/e2e.yml')
    const e2e = workflowJob(workflow, 'e2e')
    if (!Array.isArray(e2e.steps)) throw new TypeError('DeepSeek e2e workflow must define steps')

    expect(e2e.if).toBe(
      "(github.repository == 'deepseek-harness/deepseek-harness' || vars.DSH_REAL_API_E2E_ENABLED == 'true') && (github.event_name != 'pull_request' || !(github.event.pull_request.head.repo.fork || github.event.pull_request.user.login == 'dependabot[bot]'))",
    )
    const steps = e2e.steps.filter(isRecord)
    const preflight = steps.find(step => step.name === 'Preflight (require DEEPSEEK_API_KEY)')
    const liveTests = steps.find(step => step.name === 'E2E tests (real DeepSeek API)')
    const externalKey = { DEEPSEEK_API_KEY: '${{ secrets.DEEPSEEK_API_KEY_EXTERNAL }}' }
    expect(preflight).toMatchObject({ env: externalKey })
    expect(liveTests).toMatchObject({ env: externalKey })
    expect(steps.find(step => step.name === 'Prepare bubblewrap (unrestrict userns)')).toMatchObject({
      run: 'bash scripts/prepare-ci-bubblewrap.sh',
    })
    expect(JSON.stringify(steps)).not.toContain('apt-get')
  })
})

describe('E2B e2e workflow', () => {
  it('is manual-only and fails loud before running the focused live suite', () => {
    const workflow = loadWorkflow('.github/workflows/e2b-e2e.yml')
    expect(workflow.on).toEqual({ workflow_dispatch: null })
    if (!isRecord(workflow.jobs) || !isRecord(workflow.jobs.e2b) || !Array.isArray(workflow.jobs.e2b.steps)) {
      throw new TypeError('E2B e2e workflow must define the e2b job steps')
    }

    const steps = workflow.jobs.e2b.steps.filter(isRecord)
    const preflight = steps.find(step => step.name === 'Preflight (require E2B API key)')
    const e2b = steps.find(step => step.name === 'E2B tests (live sandbox)')

    expect(preflight).toMatchObject({
      env: { E2B_API_KEY: '${{ secrets.E2B_API_KEY_EXTERNAL }}' },
    })
    expect(preflight?.run).toContain('E2B_API_KEY_EXTERNAL repository secret')
    expect(e2b).toMatchObject({
      env: {
        E2B_API_KEY: '${{ secrets.E2B_API_KEY_EXTERNAL }}',
        DSH_E2E_MAX_WORKERS: '1',
        DSH_EXAMPLE_MODE: 'lib',
      },
    })
    expect(e2b?.run).toContain('packages/e2b/e2b/tests/composition.e2e.ts')
  })
})

describe('Python release workflows', () => {
  it('keeps complete wheel validation separate from protected public publication', () => {
    const workflow = loadWorkflow('.github/workflows/python-release.yml')
    const dispatch = workflowEvent(workflow, 'workflow_dispatch')
    const pullRequest = workflowEvent(workflow, 'pull_request')
    const build = workflowJob(workflow, 'build')
    const pythonCompat = workflowJob(workflow, 'python-compat')
    const validate = workflowJob(workflow, 'validate')
    const publishRuntime = workflowJob(workflow, 'publish-runtime')
    const publishSdk = workflowJob(workflow, 'publish-sdk')
    if (!isRecord(dispatch.inputs)
      || !isRecord(dispatch.inputs.publish)
      || !Array.isArray(pythonCompat.steps)
      || !Array.isArray(validate.steps)
      || !Array.isArray(publishRuntime.steps)
      || !Array.isArray(publishSdk.steps)) {
      throw new TypeError('Python release workflow must define publish input and release steps')
    }

    expect(dispatch.inputs.publish).toMatchObject({ type: 'boolean', default: false })
    expect(pullRequest).toEqual({ types: ['labeled'] })
    expect(build).toMatchObject({
      if: "github.event_name == 'workflow_dispatch' || github.event.label.name == 'python-release-dry-run'",
      uses: './.github/workflows/build-exe-for-python-sdk.yml',
      with: {
        targets: 'node24-linux-x64,node24-linux-arm64,node24-macos-arm64',
        release: true,
      },
    })
    expect(pythonCompat.strategy).toMatchObject({ matrix: { python: ['3.10', '3.14'] } })
    const pythonCompatSteps = JSON.stringify(pythonCompat.steps)
    expect(pythonCompatSteps).toContain('dist/deepseek_harness_sdk-$VERSION-py3-none-any.whl')
    expect(pythonCompatSteps).toContain('dist/deepseek_harness_runtime_bin-$VERSION-py3-none-manylinux_2_28_x86_64.whl')
    expect(pythonCompatSteps).not.toContain('--find-links')
    const validateSteps = JSON.stringify(validate.steps)
    const authorize = validate.steps.filter(isRecord).find(step => step.name === 'Authorize publication request')
    if (!isRecord(authorize) || typeof authorize.run !== 'string') {
      throw new TypeError('Python release validation must authorize publication requests')
    }
    expect(validateSteps).toContain('PUBLIC_PYPI_RELEASE_ENABLED')
    expect(authorize).toMatchObject({
      env: {
        PYPI_PUBLISHER_REPOSITORY: '${{ vars.PYPI_PUBLISHER_REPOSITORY }}',
        REPOSITORY: '${{ github.repository }}',
      },
    })
    expect(authorize.run).toContain('[ "$REPOSITORY" = "$PYPI_PUBLISHER_REPOSITORY" ]')
    expect(validateSteps).toContain('100000000')
    expect(publishRuntime).toMatchObject({
      if: "github.event_name == 'workflow_dispatch' && inputs.publish",
      needs: 'validate',
      environment: 'pypi-runtime',
      permissions: { contents: 'read', 'id-token': 'write' },
    })
    expect(publishSdk).toMatchObject({
      if: "github.event_name == 'workflow_dispatch' && inputs.publish",
      needs: ['validate', 'publish-runtime'],
      environment: 'pypi',
      permissions: { contents: 'read', 'id-token': 'write' },
    })
    const runtimeSteps = publishRuntime.steps.filter(isRecord)
    const sdkSteps = publishSdk.steps.filter(isRecord)
    const runtimePublish = runtimeSteps.find(step => step.name === 'Publish runtime wheels')
    const sdkPublish = sdkSteps.find(step => step.name === 'Publish SDK wheel')
    const runtimeHashes = runtimeSteps.find(step => step.name === 'Verify release artifact hashes')
    const sdkHashes = sdkSteps.find(step => step.name === 'Verify release artifact hashes')
    expect([...runtimeSteps, ...sdkSteps].some(
      step => typeof step.uses === 'string' && step.uses.startsWith('actions/checkout@'),
    )).toBe(false)
    expect([...runtimeSteps, ...sdkSteps].filter(
      step => step.uses === 'pypa/gh-action-pypi-publish@release/v1',
    )).toHaveLength(2)
    expect(runtimePublish).toMatchObject({
      with: { 'packages-dir': 'dist/runtime/', attestations: false },
    })
    expect(sdkPublish).toMatchObject({
      with: { 'packages-dir': 'dist/sdk/', attestations: false },
    })
    expect(runtimeHashes).toMatchObject({ run: 'cd dist && sha256sum -c SHA256SUMS' })
    expect(sdkHashes).toMatchObject({ run: 'cd dist && sha256sum -c SHA256SUMS' })
  })

  it('exposes the native wheel builder to the release caller with normalized versions', () => {
    const workflow = loadWorkflow('.github/workflows/build-exe-for-python-sdk.yml')
    const call = workflowEvent(workflow, 'workflow_call')
    const plan = workflowJob(workflow, 'plan')
    const build = workflowJob(workflow, 'build')
    if (!isRecord(call.inputs) || !Array.isArray(plan.steps) || !Array.isArray(build.steps)) {
      throw new TypeError('Python wheel builder must define workflow_call inputs and plan steps')
    }

    const buildSteps: unknown[] = build.steps
    const manylinuxAddon = buildSteps.find(step => isRecord(step) && step.name === 'Rebuild Linux node-pty against manylinux 2.28')
    const macosCheck = buildSteps.find(step => isRecord(step) && step.name === 'Check macOS deployment target')
    const manylinuxSmoke = buildSteps.find(step => isRecord(step) && step.name === 'Run wheel in a manylinux 2.28 container')
    expect(call.inputs).toHaveProperty('targets')
    expect(call.inputs).toMatchObject({
      ci: { type: 'boolean', default: false },
      release: { type: 'boolean', default: false },
    })
    expect(workflow.concurrency).toMatchObject({
      group: 'build-single-exe-${{ github.workflow }}-${{ github.ref }}',
    })
    expect(plan.if).toContain('inputs.ci')
    expect(plan.if).toContain('inputs.release')
    expect(JSON.stringify(plan.steps)).toContain('pep440_version')
    const workflowJson = JSON.stringify(workflow)
    expect(workflowJson).toContain('macosx_14_0_arm64')
    expect(workflowJson).toContain('dist-python/$SDK_WHEEL')
    expect(workflowJson).toContain('dist-python/$RUNTIME_WHEEL')
    expect(workflowJson).toContain('/work/dist-python/$SDK_WHEEL')
    expect(workflowJson).toContain('/work/dist-python/$RUNTIME_WHEEL')
    expect(workflowJson).not.toContain('--find-links dist-python')
    expect(workflowJson).not.toContain('--find-links /work/dist-python')
    expect(manylinuxAddon).toMatchObject({ if: "runner.os == 'Linux'" })
    expect(JSON.stringify(manylinuxAddon)).toContain('manylinux_2_28_x86_64')
    expect(JSON.stringify(manylinuxAddon)).toContain('manylinux_2_28_aarch64')
    expect(JSON.stringify(manylinuxAddon)).toContain('npm_config_build_from_source=true pnpm run install')
    expect(JSON.stringify(manylinuxAddon)).toContain('$HOME/setup-pnpm:$HOME/setup-pnpm:ro')
    expect(JSON.stringify(manylinuxAddon)).toContain('node-pty-glibc-versions.txt')
    expect(JSON.stringify(manylinuxAddon)).toContain('le 2.28')
    expect(macosCheck).toMatchObject({ if: "runner.os == 'macOS'" })
    expect(JSON.stringify(macosCheck)).toContain('scripts/check-macos-deployment-target.py')
    expect(JSON.stringify(macosCheck)).toContain('$EXE-spawn-helper')
    expect(manylinuxSmoke).toMatchObject({ if: "runner.os == 'Linux'" })
    expect(JSON.stringify(manylinuxSmoke)).toContain('-e DSH_TELEMETRY_DISABLED')
  })

  it('uses the shared macOS deployment-target check in GitLab', () => {
    const workflow = loadWorkflow('.gitlab-ci.yml')
    const runtimeWheel = workflow['.runtime-wheel']
    if (!isRecord(runtimeWheel) || !Array.isArray(runtimeWheel.script)) {
      throw new TypeError('GitLab CI must define the runtime wheel script')
    }
    const runtimeScript: unknown[] = runtimeWheel.script
    const macosCheck = runtimeScript.find(
      step => typeof step === 'string' && step.includes('PLATFORM" = macos-arm64'),
    )
    if (typeof macosCheck !== 'string') {
      throw new TypeError('GitLab CI must check the macOS deployment target')
    }

    expect(macosCheck).toContain('scripts/check-macos-deployment-target.py')
    expect(macosCheck).toContain('"$EXE" "$EXE-spawn-helper"')
  })
})

describe('Issue lifecycle workflow', () => {
  it('limits upstream issue automation to its owning repository', () => {
    const lifecycle = loadWorkflow('.github/workflows/issue-lifecycle.yml')
    const policy = loadWorkflow('.github/workflows/issue-policy.yml')
    const lifecycleJob = workflowJob(lifecycle, 'lifecycle')
    const policyJob = workflowJob(policy, 'policy')
    if (!Array.isArray(lifecycleJob.steps)) throw new TypeError('Issue lifecycle job must define steps')

    // Both workflows target the upstream repository and organization Project.
    // Synced downstream copies must not request the upstream App token or query
    // the upstream repository with a downstream GITHUB_TOKEN.
    expect(lifecycle.on).toHaveProperty('pull_request')
    expect(lifecycle.on).toHaveProperty('pull_request_review')
    const upstreamRepository = "${{ github.repository == 'deepseek-harness/deepseek-harness' }}"
    expect(lifecycleJob.if).toBe(upstreamRepository)
    expect(policyJob.if).toBe(upstreamRepository)
    // Keep the subscription-type gates: issue-lifecycle does not re-subscribe
    // ready_for_review (issue-policy owns that) and only reacts to submitted
    // review events.
    const lifecyclePullRequest = workflowEvent(lifecycle, 'pull_request')
    const lifecycleReview = workflowEvent(lifecycle, 'pull_request_review')
    expect(lifecyclePullRequest.types).not.toContain('ready_for_review')
    expect(lifecyclePullRequest.types).toContain('review_requested')
    expect(lifecycleReview.types).toEqual(['submitted'])
    const gated = "${{ github.event_name != 'pull_request_review' || github.event.review.state == 'changes_requested' }}"
    const steps = lifecycleJob.steps.filter(isRecord)
    const tokenStep = steps.find(s => s.name === 'Create project token')
    const handleStep = steps.find(s => s.name === 'Handle repository event')
    expect(tokenStep).toMatchObject({ if: gated })
    expect(handleStep).toMatchObject({ if: gated })

    // issue-policy owns PR validation; it is read-only and a real gate.
    const policyPullRequest = workflowEvent(policy, 'pull_request')
    expect(policyPullRequest.types).toContain('ready_for_review')
  })
})

describe('npm release workflows', () => {
  it('keeps publication dispatch-only and scopes inherited pack jobs to upstream', () => {
    const upstreamRepository = "${{ github.repository == 'deepseek-harness/deepseek-harness' }}"
    // The synchronized pack workflows remain present, but only their owning
    // repository has the matching release families and registry authority.
    for (const file of ['release.yml', 'release-vendor.yml']) {
      const workflow = loadWorkflow(`.github/workflows/${file}`)
      if (!isRecord(workflow.jobs)) throw new TypeError(`${file} must define jobs`)
      expect(Object.keys(workflow.jobs).sort()).toEqual(['pack'])
      expect(workflowJob(workflow, 'pack').if).toBe(upstreamRepository)
    }

    // publication is workflow_dispatch-only (never a PR check) and keeps the
    // npm-publish environment plus the shared dist-tag group.
    for (const file of ['release-publish.yml', 'release-vendor-publish.yml']) {
      const workflow = loadWorkflow(`.github/workflows/${file}`)
      if (!isRecord(workflow.on) || !isRecord(workflow.jobs)) throw new TypeError(`${file} must define on and jobs`)
      expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch'])
      const publish = workflow.jobs.publish
      if (!isRecord(publish)) throw new TypeError(`${file} must define a publish job`)
      expect(publish.environment).toBe('npm-publish')
      expect(publish.concurrency).toMatchObject({ group: 'Release-publish' })
    }
  })
})

describe('Dependabot version updates', () => {
  it('leaves routine baselines to DSH synchronization', () => {
    const config = loadWorkflow('.github/dependabot.yml')
    if (!Array.isArray(config.updates)) throw new TypeError('dependabot.yml must define updates')
    expect(config.updates).toHaveLength(3)
    for (const update of config.updates) {
      if (!isRecord(update)) throw new TypeError('each Dependabot update must be an object')
      expect(update['open-pull-requests-limit']).toBe(0)
    }
  })
})

describe('Documentation site publication', () => {
  it('keeps Pages deployment dispatch-only from a dsh-v* tag', () => {
    const workflow = loadWorkflow('.github/workflows/docs-pages.yml')
    const build = workflowJob(workflow, 'build')
    const deploy = workflowJob(workflow, 'deploy')
    if (!isRecord(workflow.on) || !isRecord(workflow.env) || !Array.isArray(build.steps)) {
      throw new TypeError('Documentation deployment must define on, env, and build steps')
    }

    // The site presents a released snapshot: a merge must never publish it, and
    // publication must never appear as a PR check.
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch'])

    // RELEASE_PUBLISH makes release:verify reject every ref that is not a dsh-v*
    // tag naming this tree's version, so the site and the npm sequence share one
    // definition of a released version.
    const steps = build.steps.filter(isRecord)
    const verify = steps.find(step => step.name === 'Verify release version')
    const checkout = steps.find(
      step => typeof step.uses === 'string' && step.uses.startsWith('actions/checkout@'),
    )
    expect(verify).toMatchObject({
      env: { RELEASE_PUBLISH: 'true' },
      run: 'pnpm run release:verify --family dsh',
    })
    // Complete history: the release scripts read tags.
    expect(checkout).toMatchObject({ with: { 'fetch-depth': 0 } })

    // Projected source links stay on the public repository's master. That
    // repository advances only to each release commit, so its master never
    // carries unreleased work, while it retains only the most recent tags:
    // following the dispatched tag would leave every source link on a deploy
    // from an older tag unresolvable.
    expect(workflow.env.DOCS_REPOSITORY_REF).toBe('master')

    // The environment owns the deployment tag policy and the required reviewers.
    expect(deploy.environment).toMatchObject({ name: 'github-pages' })
  })
})

describe('Git hooks', () => {
  it('leaves frozen Agent Note sidecars to the archive verifier', () => {
    const lefthook = loadWorkflow('lefthook.yml')

    for (const hookName of ['pre-commit', 'pre-merge-commit']) {
      const hook = lefthook[hookName]
      if (!isRecord(hook) || !Array.isArray(hook.jobs)) {
        throw new TypeError(`lefthook must define ${hookName} jobs`)
      }
      const pairing: unknown = hook.jobs.find(
        (job: unknown) => isRecord(job) && job.name === 'translation pairing (staged records)',
      )

      expect(pairing).toMatchObject({ exclude: ['.agents/notes/archived/**'] })
    }
  })
})

function loadWorkflow(path: string): Record<string, unknown> {
  const workflow: unknown = yaml.load(readFileSync(resolve(root, path), 'utf8'))
  if (!isRecord(workflow)) throw new TypeError(`${path} must define a workflow`)
  return workflow
}

function workflowEvent(workflow: Record<string, unknown>, event: string): Record<string, unknown> {
  if (!isRecord(workflow.on) || !isRecord(workflow.on[event])) {
    throw new TypeError(`workflow must define the ${event} event`)
  }
  return workflow.on[event]
}

function workflowJob(workflow: Record<string, unknown>, job: string): Record<string, unknown> {
  if (!isRecord(workflow.jobs) || !isRecord(workflow.jobs[job])) {
    throw new TypeError(`workflow must define the ${job} job`)
  }
  return workflow.jobs[job]
}

function commandText(steps: unknown[]): string {
  return steps
    .filter((step): step is Record<string, unknown> & { run: string } => (
      isRecord(step) && typeof step.run === 'string'
    ))
    .map(step => step.run)
    .join('\n')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
