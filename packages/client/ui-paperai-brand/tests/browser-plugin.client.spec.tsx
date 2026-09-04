// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { apply, inject, PROJECT_COPY } from '../src/client/index.ts'
import {
  ClaudeAgentMark,
  CodexAgentMark,
  PaperAIBrandMark,
  PaperAIBrandName,
  DshAgentMark,
} from '../src/client/PaperAIBrand.tsx'
import { MARK_VIEW_BOX, WORDMARK_VIEW_BOX } from '../src/client/brand-paths.ts'

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
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('zh')
  // The DSH dictionaries the overlay renames, registered as their owners would.
  locale.register('workspace', 'zh', { 'section.workspaces': '工作区', 'session.new': '新会话' })
  locale.register('workspace', 'en', { 'section.workspaces': 'Workspaces', 'session.new': 'New Session' })
  locale.register('conversation', 'zh', { 'hero.chooseWorkspace': '选择工作区', 'hero.headline': '探索未至之境' })
  locale.register('conversation', 'en', { 'hero.chooseWorkspace': 'Choose workspace', 'hero.headline': 'Explore' })
  ctx.provide('locale', locale)
  const declareHoles = () => slots.register({
    name: 'root',
    children: {
      ...Object.fromEntries(HOLES.map(name => [name, { kind: 'single', scope: 'root' }])),
      [AGENT_PRESET_MARK]: { kind: 'keyed', scope: 'root' },
    },
  } as never, () => null)
  const disposeHoles = declare ? declareHoles() : undefined
  return { ctx, slots, locale, declareHoles, disposeHoles }
}

describe('PaperAI browser-brand plugin', () => {
  it('declares the slot and locale services it uses and leaves the theme alone', () => {
    expect(inject).toEqual(['slots', 'locale'])
  })

  it('renames the shell\'s workspace vocabulary to projects in both locales and lifts it on teardown', async () => {
    const { ctx, locale } = await bench()
    const workspace = locale.bind('workspace')
    const conversation = locale.bind('conversation')
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(workspace('section.workspaces')).toBe('项目')
    expect(workspace('session.new')).toBe('新会话')
    expect(conversation('hero.chooseWorkspace')).toBe('选择项目')
    expect(conversation('hero.headline')).toBe('探索未至之境')
    locale.setLocale('en')
    expect(workspace('section.workspaces')).toBe('Projects')
    expect(conversation('hero.chooseWorkspace')).toBe('Choose project')
    // Every overlaid key exists in both locales, so no language falls back to the other.
    expect(Object.keys(PROJECT_COPY.workspace.zh).sort()).toEqual(Object.keys(PROJECT_COPY.workspace.en).sort())
    expect(Object.keys(PROJECT_COPY.conversation.zh).sort()).toEqual(Object.keys(PROJECT_COPY.conversation.en).sort())
    for (const value of [...Object.values(PROJECT_COPY.workspace.zh), ...Object.values(PROJECT_COPY.conversation.zh)]) {
      expect(value).not.toContain('工作区')
    }
    await fiber.dispose()
    expect(workspace('section.workspaces')).toBe('Workspaces')
    expect(conversation('hero.chooseWorkspace')).toBe('Choose workspace')
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

  it('renders the outlined wordmark and the host-sized golden-ratio mark in the surrounding ink', () => {
    const name = render(<PaperAIBrandName />)
    const wordmark = name.container.querySelector('svg')
    expect(wordmark?.getAttribute('aria-hidden')).toBe('true')
    expect(wordmark?.getAttribute('data-brand-name')).toBe('PaperAI')
    expect(wordmark?.getAttribute('viewBox')).toBe(WORDMARK_VIEW_BOX)
    expect(wordmark?.getAttribute('height')).toBe('24')
    expect(wordmark?.querySelector('path')?.getAttribute('fill')).toBe('currentColor')
    name.unmount()

    const mark = render(<PaperAIBrandMark size={34} className="hero-mark" />)
    const svg = mark.container.querySelector('svg')
    expect(svg?.getAttribute('aria-hidden')).toBe('true')
    expect(svg?.getAttribute('focusable')).toBe('false')
    expect(svg?.getAttribute('viewBox')).toBe(MARK_VIEW_BOX)
    // The mark is portrait: the host's square edge becomes the height.
    expect(svg?.getAttribute('height')).toBe('34')
    expect(Number(svg?.getAttribute('width'))).toBeCloseTo(34 * 400 / 644, 1)
    expect(svg?.getAttribute('class')?.split(' ')).toContain('hero-mark')
    expect(svg?.querySelector('path')?.getAttribute('fill-rule')).toBe('evenodd')
    mark.rerender(<PaperAIBrandMark size={24} />)
    expect(mark.container.querySelector('svg')?.getAttribute('height')).toBe('24')
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
