import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'

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
