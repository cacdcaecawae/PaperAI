import { describe, expect, it } from 'vitest'
import z from '@deepseek-ai/schemastery'
import { resolveProviders } from '../src/providers.ts'
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
    expect(() => resolveProviders(z.resolve({ codex: { command: 'old' } }, Config, {})[0] as Config)).toThrow('previous top-level')
    expect(() => resolveProviders({ providers: { claude: { ssh: { host: '-oProxyCommand=bad', cwd: '/repo' } } } })).toThrow('SSH requires')
  })
})
