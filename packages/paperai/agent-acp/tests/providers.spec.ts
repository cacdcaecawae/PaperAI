import { describe, expect, it } from 'vitest'
import z from '@deepseek-ai/schemastery'
import { migrateProviders, resolveProviders } from '../src/providers.ts'
import { redactSecrets } from '@deepseek-ai/dsh-settings'
import { Config } from '../src/index.ts'

describe('ACP channel configuration', () => {
  it('opens exactly Codex and Claude locally when no SSH configuration is saved', () => {
    const providers = resolveProviders(Config({ providers: { codex: { apiKey: 'sample', proxy: 'http://localhost:8888' } } }))
    expect(providers.map(provider => [provider.id, provider.enabled, provider.ssh])).toEqual([['codex', true, undefined], ['claude', true, undefined]])
    expect(providers[0]?.env).toMatchObject({ OPENAI_API_KEY: 'sample', HTTPS_PROXY: 'http://localhost:8888' })
    expect(providers[1]?.env).not.toHaveProperty('OPENAI_API_KEY')
  })

  it('rejects other channels, identity substitutions, blank commands and incomplete SSH settings', () => {
    expect(() => resolveProviders({ providers: { other: { command: 'other' } } })).toThrow('only Codex and Claude')
    expect(() => resolveProviders({ providers: { codex: { template: 'claude' } } })).toThrow('identity')
    expect(() => resolveProviders({ providers: { codex: { command: ' ' } } })).toThrow('non-empty')
    expect(() => z.resolve({ providers: { claude: { ssh: {} } } }, Config, {})).toThrow('host')
    expect(() => resolveProviders({ providers: { claude: { ssh: { host: '-oProxyCommand=bad', cwd: '/repo' } } } })).toThrow('SSH requires')
  })

  it('reads legacy launch settings, preserves canonical overrides, and redacts both formats', () => {
    const legacy = {
      codex: { command: 'legacy-codex', apiKey: 'legacy-key', env: { TOKEN: 'legacy-env', KEEP: 'value' } },
      claude: { apiKey: 'legacy-claude' },
      providers: { codex: { apiKey: 'canonical-key', env: { TOKEN: 'canonical-env' } } },
    }
    const config = Config(legacy)
    expect(migrateProviders(config)).toMatchObject({ providers: {
      codex: { command: 'legacy-codex', apiKey: 'canonical-key', env: { TOKEN: 'canonical-env', KEEP: 'value' } },
      claude: { apiKey: 'legacy-claude' },
    } })
    expect(migrateProviders(config)).not.toHaveProperty('codex')
    expect(migrateProviders(config)).not.toHaveProperty('claude')
    expect(legacy.codex.apiKey).toBe('legacy-key')
    expect(resolveProviders(config)[0]).toMatchObject({ command: 'legacy-codex', env: { OPENAI_API_KEY: 'canonical-key' } })
    expect(resolveProviders(config)[1]?.env).toMatchObject({ ANTHROPIC_API_KEY: 'legacy-claude' })
    const wire = JSON.stringify(redactSecrets(Config as z<never>, config))
    for (const secret of ['legacy-key', 'legacy-env', 'legacy-claude', 'canonical-key', 'canonical-env'])
      expect(wire).not.toContain(secret)
    expect(() => Config({ codex: { apiKey: 123 } } as never)).toThrow()
    expect(migrateProviders({ codex: null, claude: null })).toEqual({ providers: {} })
  })
})
