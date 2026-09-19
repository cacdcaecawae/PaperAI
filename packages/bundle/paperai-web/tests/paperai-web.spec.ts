import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { Config as PiAiConfig } from '@deepseek-ai/dsh-llm-pi-ai'
import { assertServiceable, resolveProfiles } from '@deepseek-ai/dsh-llm-pi-ai/src/config.ts'

describe('PaperAI web profile bundle', () => {
  it('mounts the PaperAI client plugins and document layout without replacing the Agent loop', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      dsh?: { bundle?: { patch?: string } }
    }
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(manifest.dependencies).toHaveProperty('@paperai/ui-brand')
    expect(manifest.dependencies).toHaveProperty('@paperai/ui-workbench')
    expect(manifest.dependencies).toHaveProperty('@paperai/document-engine-officecli')
    expect(manifest.dependencies).toHaveProperty('@paperai/repository')
    expect(manifest.dependencies).toHaveProperty('@deepseek-ai/dsh-storage-sqlite')

    const parsed = yaml.load(
      readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8'),
      { schema: entryListSchema },
    )
    expect(Array.isArray(parsed)).toBe(true)
    const patches = parsed as Array<{
      id?: string
      disabled?: boolean
      config?: Record<string, unknown>
      insert?: Array<{ id?: string; name?: string }>
    }>
    expect(patches.find(row => row.id === 'ui-brand-official')).toMatchObject({ disabled: true })
    expect(patches.find(row => row.id === 'agent-presets')).toMatchObject({
      config: { default: 'codex' },
    })
    expect(patches.find(row => row.id === 'sandbox-policy')).toBeUndefined()
    expect(patches.find(row => row.id === 'approval')).toBeUndefined()
    expect(patches.find(row => row.id === 'ui-settings-models')).toMatchObject({
      config: {
        onboarding: { welcomeNotice: false, deepSeekCredential: false },
      },
    })
    expect(patches.find(row => row.id === 'ui-layout')).toBeUndefined()
    expect(patches.flatMap(row => row.insert ?? [])).toContainEqual({
      id: 'paperai-repository',
      name: '@paperai/repository',
    })
    expect(patches.flatMap(row => row.insert ?? [])).toContainEqual(expect.objectContaining({
      id: 'paperai-storage-sqlite',
      name: '@deepseek-ai/dsh-storage-sqlite',
    }))
    expect(patches.flatMap(row => row.insert ?? [])).toContainEqual({
      id: 'paperai-document-engine-officecli',
      name: '@paperai/document-engine-officecli',
    })
    expect(patches.flatMap(row => row.insert ?? [])).toContainEqual({
      id: 'ui-paperai-brand',
      name: '@paperai/ui-brand',
    })
    expect(patches.flatMap(row => row.insert ?? [])).toContainEqual({
      id: 'ui-paperai-workbench',
      name: '@paperai/ui-workbench',
    })
    expect(patches.some(row => row.id === 'agent-loop')).toBe(false)
  })
})

describe('PaperAI Bailian route', () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const patches = yaml.load(
    readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8'),
    { schema: entryListSchema },
  ) as Array<{ id?: string; config?: Record<string, unknown> }>
  const row = patches.find(entry => entry.id === 'llm-pi-ai')

  it('declares the DashScope compatible-mode route the pi-ai catalog does not ship', () => {
    expect(row).toBeDefined()
    // The adapter's own schema: a compat switch it does not offer, a missing
    // capacity, or a malformed reasoning map is refused here, not at boot.
    const config = new PiAiConfig(row?.config)
    const bailian = config.providers?.bailian
    expect(bailian).toMatchObject({
      displayName: '阿里云百炼',
      apiKeyEnv: 'DASHSCOPE_API_KEY',
      api: 'openai-completions',
      baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      compat: { thinkingFormat: 'qwen', supportsDeveloperRole: false, maxTokensField: 'max_tokens' },
    })
    expect(bailian?.models?.map(model => model.id)).toEqual([
      'qwen3.7-plus', 'qwen3.7-max', 'qwen3.6-plus', 'qwen3.6-flash',
      'deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v3.2',
      'glm-5.2', 'kimi-k2.6', 'kimi-k2.7-code', 'MiniMax-M2.5',
    ])
    // Every model reasons through Qwen-style enable_thinking, with off offered.
    for (const model of bailian?.models ?? []) {
      expect(model.reasoningEfforts).toEqual({ off: null, high: 'high' })
      expect(model.contextWindow).toBeGreaterThan(0)
      expect(model.maxTokens).toBeGreaterThan(0)
    }
  })

  it('resolves into a serviceable route, not just a schema-valid one', () => {
    // Parsing the row proves only that the fields typecheck. The Host registers
    // assertServiceable as this namespace's settings `validate` hook, and that
    // is what refuses an endpoint, protocol, compat switch, or model the
    // adapter cannot actually serve — so a row that parses but cannot run must
    // fail here rather than at boot.
    const config = new PiAiConfig(row?.config)
    expect(() => { assertServiceable(config) }).not.toThrow()

    const bailian = resolveProfiles(config.providers).get('bailian')
    expect(bailian).toMatchObject({ provider: 'bailian', displayName: '阿里云百炼', apiKeyEnv: 'DASHSCOPE_API_KEY' })
    // The materialized pi-ai provider carries the endpoint every model requests
    // against; without it pi-ai would fall back to its own id-based detection.
    expect((bailian?.piProvider as { baseUrl?: string } | undefined)?.baseUrl)
      .toBe('https://dashscope.aliyuncs.com/compatible-mode/v1')
    // All eleven models materialized with their declared output caps.
    expect([...(bailian?.configuredMaxTokens.keys() ?? [])]).toEqual(
      (row?.config as { providers?: { bailian?: { models?: Array<{ id: string }> } } })
        ?.providers?.bailian?.models?.map(model => model.id),
    )
  })
})
