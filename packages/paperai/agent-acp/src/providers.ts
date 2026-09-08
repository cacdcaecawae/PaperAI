/** ACP templates and instance configuration, independent of conversation state. */

import z from '@deepseek-ai/schemastery'
import { createHash } from 'node:crypto'
import type { AcpProviderDefinition } from './runtime.ts'
import { sshLaunch, type AcpSshConfig } from './ssh.ts'

/** Launch and defaults for one separately configured ACP instance. */
export interface AcpProviderConfig {
  /** Channel identity; must match the containing codex or claude key. */
  readonly template?: string
  /** Display name in the directory and preset picker. */
  readonly name?: string
  /** Whether new conversations may select this channel. */
  readonly enabled?: boolean
  /** ACP executable override; omission selects the managed or bundled adapter. */
  readonly command?: string
  /** Executable arguments, passed without a shell. */
  readonly args?: string[]
  /** Secret process environment overrides. */
  readonly env?: Record<string, string>
  /** Secret credential mapped to the channel's native environment variable. */
  readonly apiKey?: string
  /** Provider API endpoint override. */
  readonly baseURL?: string
  /** Proxy URL applied to HTTP, HTTPS, and ALL_PROXY. */
  readonly proxy?: string
  /** Preferred model for new sessions; custom ids are validated by the provider. */
  readonly model?: string
  /** Preferred reasoning level; unavailable defaults warn and retain the provider selection. */
  readonly reasoningEffort?: string
  /** Preferred boolean driver options; unavailable defaults warn and are skipped. */
  readonly switches?: Record<string, boolean>
  /** Preferred session options; unavailable values and standing permission modes warn and are skipped. */
  readonly configOptions?: Record<string, string | boolean>
  /** Model ids promoted in this channel's model picker. */
  readonly favoriteModels?: string[]
  /** Native ACP mode ids keyed by DSH sandbox mode. */
  readonly permissionModes?: Record<string, string>
  /** User instructions appended to ordinary prompts and logged. */
  readonly personalPrompt?: string
  /** Requested response language appended to ordinary prompts and logged. */
  readonly language?: string
  /** Remote POSIX execution; omission uses the current Host. */
  readonly ssh?: AcpSshConfig
}

/** Deployment limits and the settings-backed ACP instance directory. */
export interface AcpConfig {
  /** Maximum isolated handshake duration in milliseconds. */
  readonly probeTimeoutMs?: number
  /** Milliseconds before an automatic retry after a failed probe. */
  readonly failureCooldownMs?: number
  /** Maximum conversation startup duration in milliseconds. */
  readonly startupTimeoutMs?: number
  /** Maximum number of simultaneous isolated channel probes. */
  readonly probeConcurrency?: number
  /** Maximum active terminals and retained released outputs per runtime. */
  readonly terminalLimit?: number
  /** Maximum retained bytes per terminal or tool output. */
  readonly terminalOutputBytes?: number
  /** Process-tree graceful shutdown duration in milliseconds. */
  readonly processGraceMs?: number
  /** Maximum duration of an isolated management operation in milliseconds. */
  readonly managementTimeoutMs?: number
  /** Maximum managed npm installation duration in milliseconds. */
  readonly installTimeoutMs?: number
  /** Managed adapter root; omission selects paperai/acp under DSH_HOME. */
  readonly installationDirectory?: string
  /** Channel overrides keyed only by codex or claude. */
  readonly providers?: Record<string, AcpProviderConfig>
  /** Legacy launch settings, migrated into providers.codex when user settings are writable. */
  readonly codex?: AcpProviderConfig | null
  /** Legacy launch settings, migrated into providers.claude when user settings are writable. */
  readonly claude?: AcpProviderConfig | null
}

/** Public template metadata; installation operations use these declared packages only. */
export interface AcpTemplate {
  readonly id: AcpProviderDefinition['id']
  readonly name: string
  readonly command: string
  readonly args: readonly string[]
  readonly cli: string
  readonly url: string
  readonly login: string
  readonly packageName?: string
  readonly cliPackage?: string
  readonly bundled?: boolean
  readonly apiKeyEnv?: string
  readonly baseURLEnv?: string
}

/** ACP command templates; discovery never installs them. DSH remains its native preset. */
export const ACP_TEMPLATES: readonly AcpTemplate[] = [
  { id: 'codex', name: 'Codex', command: 'codex-acp', args: [], cli: 'codex', packageName: '@agentclientprotocol/codex-acp', cliPackage: '@openai/codex', bundled: true, apiKeyEnv: 'OPENAI_API_KEY', baseURLEnv: 'OPENAI_BASE_URL', url: 'https://github.com/zed-industries/codex-acp', login: 'codex login' },
  { id: 'claude', name: 'Claude', command: 'claude-agent-acp', args: [], cli: 'claude', packageName: '@agentclientprotocol/claude-agent-acp', cliPackage: '@anthropic-ai/claude-code', bundled: true, apiKeyEnv: 'ANTHROPIC_API_KEY', baseURLEnv: 'ANTHROPIC_BASE_URL', url: 'https://github.com/zed-industries/claude-agent-acp', login: 'claude auth login' },
]

// An absent SSH block selects local execution; it must not default to an empty object.
const sshConfig: z<AcpSshConfig> = z({ type: 'object', dict: { host: z.string().required(), cwd: z.string().required(), user: z.string(), port: z.number().min(1).max(65535).step(1), identityFile: z.string(), node: z.string() } })

/** Settings schema; process environment and credentials are never returned as plaintext. */
export const AcpProviderConfigSchema: z<AcpProviderConfig> = z.object({
  template: z.string(), name: z.string(), enabled: z.boolean(),
  command: z.string(), args: z.array(z.string()),
  env: z.dict(z.string()).role('secret'), apiKey: z.string().role('secret'),
  baseURL: z.string(), proxy: z.string(), model: z.string(), reasoningEffort: z.string(),
  switches: z.dict(z.boolean()), configOptions: z.dict(z.union([z.string(), z.boolean()])),
  favoriteModels: z.array(z.string()), permissionModes: z.dict(z.string()),
  personalPrompt: z.string(), language: z.string(),
  ssh: sshConfig,
})

/**
 * Move legacy channel fields under providers without mutating the stored input.
 * @param config - schema-validated ACP settings; canonical fields take precedence.
 * @returns settings with legacy fields removed and their credentials preserved.
 */
export function migrateProviders(config: AcpConfig): AcpConfig {
  if (config.codex === undefined && config.claude === undefined) return config
  const { codex, claude, ...current } = config
  const providers = { ...current.providers }
  for (const [id, legacy] of Object.entries({ codex, claude })) {
    if (legacy == null) continue
    const canonical = providers[id]
    providers[id] = {
      ...legacy, ...canonical,
      ...(legacy.env === undefined && canonical?.env === undefined ? {} : { env: { ...legacy.env, ...canonical?.env } }),
    }
  }
  return { ...current, providers }
}

/**
 * Identify settings that affect adapter startup and isolated operations.
 * @param provider - resolved channel, including private launch values.
 * @returns a digest excluding display names and prompt-only preferences.
 */
export function providerLaunchKey(provider: AcpProviderDefinition): string {
  return createHash('sha256').update(JSON.stringify([
    provider.id, provider.enabled, provider.packageName, provider.binName,
    provider.command, provider.args, provider.env, provider.ssh, provider.permissionModes,
  ])).digest('hex')
}

/**
 * Resolve templates and instance overrides without opening files or spawning processes.
 * @param config - resolved settings, including secret launch values.
 * @returns Codex and Claude with their configured launch values.
 */
export function resolveProviders(config: AcpConfig): AcpProviderDefinition[] {
  config = migrateProviders(config)
  for (const id of Object.keys(config.providers ?? {})) {
    if (!ACP_TEMPLATES.some(template => template.id === id)) throw new Error(`ACP currently supports only Codex and Claude: ${id}`)
  }
  return ACP_TEMPLATES.map((template) => {
    const id = template.id
    const settings = config.providers?.[id] ?? {}
    if (settings.ssh !== undefined) sshLaunch(settings.ssh, [])
    const templateId = settings.template ?? id
    if (templateId !== id) throw new Error(`ACP channel ${id} cannot change its provider identity`)
    if (settings.command !== undefined && !settings.command.trim()) throw new Error(`ACP channel ${id} requires a non-empty command`)
    const env = {
      ...settings.env,
      ...settings.apiKey === undefined || template.apiKeyEnv === undefined ? {} : { [template.apiKeyEnv]: settings.apiKey },
      ...settings.baseURL === undefined || template.baseURLEnv === undefined ? {} : { [template.baseURLEnv]: settings.baseURL },
      ...settings.proxy === undefined || settings.proxy === '' ? {} : { HTTP_PROXY: settings.proxy, HTTPS_PROXY: settings.proxy, ALL_PROXY: settings.proxy },
    }
    return {
      id, name: settings.name ?? template.name,
      template: templateId,
      enabled: settings.enabled ?? true,
      packageName: template.packageName ?? '', binName: template.command,
      ...settings.command !== undefined ? { command: settings.command }
        : template.bundled === true && settings.ssh === undefined ? {} : { command: template.command },
      args: settings.args ?? template.args, env,
      ...settings.ssh === undefined ? {} : { ssh: settings.ssh },
      ...settings.personalPrompt === undefined ? {} : { personalPrompt: settings.personalPrompt },
      ...settings.language === undefined ? {} : { language: settings.language },
      ...settings.permissionModes === undefined ? {} : { permissionModes: settings.permissionModes },
    }
  })
}
