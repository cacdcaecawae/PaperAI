import { discoverPresets } from '@deepseek-ai/dsh-agent-presets'
import { describe, expect, it } from 'vitest'
import { profilePresetRoots } from '../src/profile-boot.ts'

describe('profile preset roots', () => {
  it('exposes exactly one PaperAI writing agent per engine: DSH, Codex, and Claude', async () => {
    const presets = await discoverPresets(profilePresetRoots('paperai'))

    expect(presets.map(preset => preset.id).sort()).toEqual(['claude', 'codex', 'dsh'])
  })

  it.each(['web', 'headless'])('keeps the complete shipped DSH roster for %s', async (profile) => {
    const presets = await discoverPresets(profilePresetRoots(profile))

    expect(presets.map(preset => preset.id)).toEqual(['standard', 'code', 'minimal', 'cordis'])
  })
})
