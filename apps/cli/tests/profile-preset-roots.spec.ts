import { discoverPresets } from '@deepseek-ai/dsh-agent-presets'
import { describe, expect, it } from 'vitest'
import { profilePresetRoots } from '../src/profile-boot.ts'

describe('profile preset roots', () => {
  it('opens only Codex and Claude in the PaperAI profile', async () => {
    const presets = await discoverPresets(profilePresetRoots('paperai'))

    expect(presets.map(preset => preset.id).sort()).toEqual(['claude', 'codex'])
  })

  it.each(['web', 'headless'])('keeps the complete shipped DSH roster for %s', async (profile) => {
    const presets = await discoverPresets(profilePresetRoots(profile))

    expect(presets.map(preset => preset.id)).toEqual(['standard', 'code', 'minimal', 'cordis'])
  })
})
