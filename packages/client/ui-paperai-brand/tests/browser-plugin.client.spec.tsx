// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { apply, inject } from '../src/client/index.ts'
import {
  ClaudeAgentMark,
  CodexAgentMark,
  PaperAIBrandMark,
  PaperAIBrandName,
  DshAgentMark,
} from '../src/client/PaperAIBrand.tsx'

afterEach(cleanup)

const HOLES = [
  'sidebar.brand.mark',
  'sidebar.brand.name',
  'conversation.hero.brand.mark',
] as const
const AGENT_PRESET_MARK = 'conversation.hero.agentPreset.mark' as const

async function bench(declare = true) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  const themeLayers: { source: string; tokens: Record<string, { light: string; dark: string }> }[] = []
  ctx.provide('theme', {
    overrideTokens: (source: string, tokens: Record<string, { light: string; dark: string }>) => {
      const layer = { source, tokens }
      themeLayers.push(layer)
      return () => {
        const at = themeLayers.indexOf(layer)
        if (at >= 0) themeLayers.splice(at, 1)
      }
    },
  } as never)
  const declareHoles = () => slots.register({
    name: 'root',
    children: {
      ...Object.fromEntries(HOLES.map(name => [name, { kind: 'single', scope: 'root' }])),
      [AGENT_PRESET_MARK]: { kind: 'keyed', scope: 'root' },
    },
  } as never, () => null)
  const disposeHoles = declare ? declareHoles() : undefined
  return { ctx, slots, themeLayers, declareHoles, disposeHoles }
}

describe('PaperAI browser-brand plugin', () => {
  it('declares the slot and theme services it uses', () => {
    expect(inject).toEqual(['slots', 'theme'])
  })

  it('installs one dual-scheme accent layer and removes it on teardown', async () => {
    const { ctx, themeLayers } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(themeLayers).toHaveLength(1)
    expect(themeLayers[0]?.source).toBe('paperai-brand')
    const tokens = themeLayers[0]?.tokens ?? {}
    expect(Object.keys(tokens).length).toBeGreaterThan(0)
    for (const value of Object.values(tokens)) {
      expect(typeof value.light).toBe('string')
      expect(typeof value.dark).toBe('string')
    }
    await fiber.dispose()
    expect(themeLayers).toHaveLength(0)
  })

  it('fills declarations before or after apply and removes every occupant on teardown', async () => {
    const before = await bench()
    const fiber = before.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    for (const hole of HOLES) expect(before.slots.entries(hole)).toHaveLength(1)
    expect(before.slots.entries(AGENT_PRESET_MARK)).toHaveLength(3)

    before.disposeHoles?.()
    for (const hole of HOLES) expect(before.slots.entries(hole)).toHaveLength(0)
    expect(before.slots.entries(AGENT_PRESET_MARK)).toHaveLength(0)
    before.declareHoles()
    await Promise.resolve()
    for (const hole of HOLES) expect(before.slots.entries(hole)).toHaveLength(1)
    expect(before.slots.entries(AGENT_PRESET_MARK)).toHaveLength(3)

    await fiber.dispose()
    for (const hole of HOLES) expect(before.slots.entries(hole)).toHaveLength(0)
    expect(before.slots.entries(AGENT_PRESET_MARK)).toHaveLength(0)

    const after = await bench(false)
    await after.ctx.plugin({ inject: [...inject], apply }).await()
    for (const hole of HOLES) expect(after.slots.entries(hole)).toHaveLength(0)
    after.declareHoles()
    await Promise.resolve()
    for (const hole of HOLES) expect(after.slots.entries(hole)).toHaveLength(1)
    expect(after.slots.entries(AGENT_PRESET_MARK)).toHaveLength(3)
  })

  it('renders the Chinese product wordmark and host-sized document mark', () => {
    const name = render(<PaperAIBrandName />)
    expect(screen.getByText('paperai')).toBeDefined()
    expect(screen.getByText('论文工作台')).toBeDefined()
    name.unmount()

    const mark = render(<PaperAIBrandMark size={34} className="hero-mark" />)
    const svg = mark.container.querySelector('svg')
    expect(svg?.getAttribute('aria-hidden')).toBe('true')
    expect(svg?.getAttribute('focusable')).toBe('false')
    expect(svg?.getAttribute('viewBox')).toBe('0 0 24 24')
    expect(svg?.getAttribute('width')).toBe('34')
    expect(svg?.getAttribute('class')?.split(' ')).toContain('hero-mark')
    mark.rerender(<PaperAIBrandMark size={24} />)
    expect(mark.container.querySelector('svg')?.getAttribute('width')).toBe('24')
  })

  it('keeps provider marks decorative beside their preset names', () => {
    const marks = render(<>
      <CodexAgentMark presetId="codex" size={18} />
      <ClaudeAgentMark presetId="claude" size={18} />
      <DshAgentMark presetId="dsh" size={18} />
    </>)
    for (const svg of marks.container.querySelectorAll('svg')) {
      expect(svg.getAttribute('aria-hidden')).toBe('true')
      expect(svg.getAttribute('focusable')).toBe('false')
      expect(svg.getAttribute('role')).toBeNull()
      expect(svg.getAttribute('aria-label')).toBeNull()
    }
  })
})
