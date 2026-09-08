/** Per-instance npm installations; publication never changes an in-use installation directory. */

import { existsSync, readFileSync } from 'node:fs'
import { mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { writeFileAtomic, withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { TextRetainer } from '@deepseek-ai/dsh-output-retention'
import type { AcpProviderDefinition } from './runtime.ts'
import type { AcpTemplate } from './providers.ts'

const manifestSchema = z.object({ packageName: z.string(), binName: z.string(), directory: z.string() })
const packageSchema = z.object({ version: z.string(), bin: z.union([z.string(), z.record(z.string(), z.string())]) })

/**
 * Resolve the installation root from deployment configuration and DSH_HOME.
 * @param configured - explicit managed installation root, when configured.
 * @returns absolute root containing only PaperAI-managed ACP installations.
 */
export function installationRoot(configured?: string): string {
  return resolve(configured ?? join(resolveDshHome(), 'paperai', 'acp'))
}

function child(root: string, path: string): string {
  const result = resolve(root, path)
  const offset = relative(root, result)
  if (offset === '' || offset === '..' || offset.startsWith(`..${sep}`) || isAbsolute(offset))
    throw new Error('ACP installation path escapes its managed directory')
  return result
}

function activeFile(root: string, id: string): string {
  return join(child(root, id), 'active.json')
}

/**
 * Read a published managed installation, leaving explicit commands authoritative.
 * @param root - managed installation root.
 * @param provider - template-resolved instance.
 * @param explicitCommand - whether the user overrode the template launch command.
 * @returns launch override and installed package version, or undefined when no installation is published.
 */
export function managedInstallation(
  root: string,
  provider: AcpProviderDefinition,
  explicitCommand: boolean,
): { provider: AcpProviderDefinition; version: string; directory: string } | undefined {
  if (explicitCommand) return undefined
  const active = activeFile(root, provider.id)
  if (!existsSync(active)) return undefined
  const manifest = manifestSchema.parse(JSON.parse(readFileSync(active, 'utf8')))
  if (manifest.packageName !== provider.packageName || manifest.binName !== provider.binName)
    throw new Error('Managed ACP installation does not match this channel type')
  const directory = child(child(root, provider.id), manifest.directory)
  const packageRoot = child(join(directory, 'node_modules'), manifest.packageName)
  const pkg = packageSchema.parse(JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')))
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin[manifest.binName]
  if (bin === undefined) throw new Error('Managed ACP package does not expose its declared command')
  const executable = child(packageRoot, bin)
  const source = readFileSync(executable).subarray(0, 160).toString('utf8')
  const node = /^#![^\n]*\bnode\b/u.test(source) || /\.[cm]?js$/u.test(executable)
  return {
    directory,
    version: pkg.version,
    provider: {
      ...provider,
      command: node ? process.execPath : executable,
      args: [...(node ? [executable] : []), ...(provider.args ?? [])],
      env: {
        ...provider.env,
        PATH: `${join(directory, 'node_modules', '.bin')}${delimiter}${provider.env?.PATH ?? process.env.PATH ?? ''}`,
      },
    },
  }
}

/**
 * Install or update a declared npm template and publish it only after successful validation.
 * @param ctx - existing subprocess capability.
 * @param root - managed installation root.
 * @param provider - instance receiving its own installation.
 * @param template - trusted template installation metadata.
 * @param limits - validated output and process teardown limits.
 * @param signal - explicit operation cancellation.
 * @param output - receives bounded process output snapshots.
 */
export async function installAdapter(
  ctx: Context,
  root: string,
  provider: AcpProviderDefinition,
  template: AcpTemplate,
  limits: { outputBytes: number; graceMs: number },
  signal: AbortSignal,
  output: (text: string) => void,
): Promise<void> {
  const packageName = template.packageName
  if (packageName === undefined) throw new Error('此渠道需按官方文档安装原生 CLI')
  const instanceRoot = child(root, provider.id)
  await mkdir(instanceRoot, { recursive: true })
  await withFileLock(activeFile(root, provider.id), async () => {
    const name = `install-${randomUUID()}`
    const directory = child(instanceRoot, name)
    await mkdir(directory)
    let published = false
    try {
      await writeFile(join(directory, 'package.json'), JSON.stringify({ private: true, type: 'module' }) + '\n')
      const npm = await ctx.subprocess.resolveExecutable('npm', undefined, signal)
      const npmCli =
        process.platform === 'win32'
          ? join(dirname(npm), 'node_modules', 'npm', 'bin', 'npm-cli.js')
          : await realpath(npm)
      if (!existsSync(npmCli)) throw new Error('未找到 npm CLI；请安装包含 npm 的 Node.js')
      const packages = [...new Set([packageName, ...(template.cliPackage === undefined ? [] : [template.cliPackage])])]
      const retained = new TextRetainer({ kind: 'tail', maxBytes: limits.outputBytes })
      const report = (chunk: Buffer): void => {
        retained.push(chunk)
        output(retained.finish().text)
      }
      const task = ctx.subprocess.spawn({
        argv: [
          process.execPath,
          npmCli,
          'install',
          '--prefix',
          directory,
          '--no-audit',
          '--no-fund',
          '--save-exact',
          ...packages.map(pkg => `${pkg}@latest`),
        ],
        cwd: directory,
        env: provider.env,
        signal,
        graceMs: limits.graceMs,
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
      })
      task.stdout?.on('data', report)
      task.stderr?.on('data', report)
      try {
        const result = await task.done
        signal.throwIfAborted()
        if (result.exitCode !== 0) throw new Error(`npm 安装失败，退出码 ${String(result.exitCode ?? result.signal)}`)
      } finally {
        task.terminate()
        await task.waitForExit()
      }
      // Validate the package's declared executable before publishing the new generation.
      const packageRoot = child(join(directory, 'node_modules'), packageName)
      const pkg = packageSchema.parse(JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')))
      const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin[provider.binName]
      if (bin === undefined || !existsSync(child(packageRoot, bin))) throw new Error('安装包缺少 ACP 可执行入口')
      signal.throwIfAborted()
      await writeFileAtomic(
        activeFile(root, provider.id),
        JSON.stringify({ packageName, binName: provider.binName, directory: name }) + '\n',
        { mode: 0o600, dirMode: 0o700 },
      )
      published = true
    } finally {
      if (!published) await rm(child(instanceRoot, basename(directory)), { recursive: true, force: true })
    }
  })
}

/**
 * Unpublish and remove only the currently managed installation; external and bundled CLIs are untouched.
 * @param root - configured installation root.
 * @param provider - idle instance whose managed installation is being removed.
 */
export async function uninstallAdapter(root: string, provider: AcpProviderDefinition): Promise<void> {
  const active = activeFile(root, provider.id)
  await withFileLock(active, async () => {
    const installed = managedInstallation(root, provider, false)
    if (installed === undefined) throw new Error('此渠道没有 PaperAI 管理的安装')
    await rm(active)
    await rm(child(child(root, provider.id), basename(installed.directory)), { recursive: true, force: true })
  })
}
