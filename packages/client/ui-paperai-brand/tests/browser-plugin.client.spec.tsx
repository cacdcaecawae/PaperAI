// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import type { ThemeTokenOverrides } from '@deepseek-ai/dsh-client-ui-theme/client'
import { apply, inject, PROJECT_COPY } from '../src/client/index.ts'
import { PAPERAI_THEME_SOURCE, PAPERAI_TOKENS } from '../src/client/theme.ts'
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
const ACP_CHANNEL_MARK = 'paperai.acp.channel.mark' as const

type Rgba = [number, number, number, number]

/** A `#rrggbb` or `rgba(r, g, b, a)` token value as channels. */
function rgba(value: string): Rgba {
  if (value.startsWith('#')) return [1, 3, 5].map(i => Number.parseInt(value.slice(i, i + 2), 16)).concat(1) as Rgba
  const [r = 0, g = 0, b = 0, a = 1] = value.replace(/^rgba?\(|\)$/gu, '').split(',').map(Number)
  return [r, g, b, a]
}

/** `top` painted over an opaque `ground`. */
function over(top: Rgba, ground: Rgba): Rgba {
  return [0, 1, 2].map(i => top[i]! * top[3] + ground[i]! * (1 - top[3])).concat(1) as Rgba
}

function contrastRatio(first: Rgba, second: Rgba): number {
  const luminance = (color: Rgba): number => color.slice(0, 3)
    .map(c => c / 255)
    .map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
    .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i]!, 0)
  const [a, b] = [first, second].map(luminance).sort((x, y) => y - x)
  return (a! + 0.05) / (b! + 0.05)
}

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
  // The theme registry as the token layer sees it: one override layer per source.
  const layers = new Map<string, ThemeTokenOverrides>()
  ctx.provide('theme', {
    overrideTokens(source: string, tokens: ThemeTokenOverrides) {
      layers.set(source, tokens)
      return () => { layers.delete(source) }
    },
  } as never)
  const declareHoles = () => slots.register({
    name: 'root',
    children: {
      ...Object.fromEntries(HOLES.map(name => [name, { kind: 'single', scope: 'root' }])),
      [AGENT_PRESET_MARK]: { kind: 'keyed', scope: 'root' },
      [ACP_CHANNEL_MARK]: { kind: 'keyed', scope: 'root' },
    },
  } as never, () => null)
  const disposeHoles = declare ? declareHoles() : undefined
  return { ctx, slots, locale, layers, declareHoles, disposeHoles }
}

describe('PaperAI browser-brand plugin', () => {
  it('declares the slot, locale, and theme services it uses', () => {
    expect(inject).toEqual(['slots', 'locale', 'theme'])
  })

  it('stacks the iOS token layer over the shipped palette and lifts it on teardown', async () => {
    const { ctx, layers } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(layers.get(PAPERAI_THEME_SOURCE)).toBe(PAPERAI_TOKENS)
    // Every token names both palettes, so neither scheme inherits a value meant for the other.
    for (const [name, modes] of Object.entries(PAPERAI_TOKENS)) {
      expect(name).toMatch(/^--(?:dsw-|paperai-)/u)
      expect(modes.light).not.toBe('')
      expect(modes.dark).not.toBe('')
    }
    // Each scheme splits the tint: type and marks take their own value, apart from the fills under white type.
    expect(PAPERAI_TOKENS['--dsw-alias-state-business-primary']?.dark).not.toBe(PAPERAI_TOKENS['--dsw-alias-button-primary-fill']?.dark)
    // DSH reads label-primary-foreground as label-primary's inverse (a checked checkbox's
    // mark); the layer leaves it alone and colors type on its blue fills through their own pairs.
    expect(PAPERAI_TOKENS['--dsw-alias-label-primary-foreground']).toBeUndefined()
    // The workbench badges read one accent and one tint per document type.
    for (const type of ['proposal', 'midterm', 'manuscript', 'final', 'other']) {
      expect(PAPERAI_TOKENS[`--paperai-type-${type}`]).toBeDefined()
      expect(PAPERAI_TOKENS[`--paperai-type-${type}-tint`]).toBeDefined()
    }
    await fiber.dispose()
    expect(layers.has(PAPERAI_THEME_SOURCE)).toBe(false)
  })

  it('keeps every text token at WCAG AA 4.5:1 on the grounds and fills it sits on, in both schemes', () => {
    // [fill or '', type]: the fill is painted over each opaque ground, then the type over that.
    const grounds = ['--dsw-alias-bg-base', '--dsw-alias-bg-layer-1', '--dsw-alias-bg-layer-2', '--dsw-alias-bg-layer-3', '--dsw-specific-sidebar-fill']
    const grayFills = ['', '--dsw-alias-bg-module-platform', '--dsw-alias-interactive-bg-hover', '--dsw-alias-button-ghost-active-fill']
    const neutralType = ['secondary', 'tertiary', 'caption'].map(label => `--dsw-alias-label-${label}`)
      .concat('--dsw-alias-state-business-primary', '--dsw-alias-state-error-primary', '--dsw-alias-state-warn-label')
    const pairs: (readonly [string, string])[] = [
      ['--dsw-specific-bubble', '--dsw-specific-bubble-foreground'],
      ['--dsw-alias-button-primary-fill', '--dsw-alias-button-primary-foreground'],
      ['--dsw-alias-button-primary-hover', '--dsw-alias-button-primary-foreground'],
      ...grayFills.flatMap(fill => neutralType.map(type => [fill, type] as const)),
      // Badges, the current row, and status strips set type in their own hue over its tint.
      ...['--dsw-alias-state-business-tertiary', '--dsw-specific-sidebar-nav-item-active-accent']
        .map(fill => [fill, '--dsw-alias-state-business-primary'] as const),
      ['--dsw-alias-interactive-bg-hover-danger', '--dsw-alias-state-error-primary'],
      ['', '--dsw-alias-state-success-primary'], ['--dsw-alias-state-success-tertiary', '--dsw-alias-state-success-primary'],
      ['', '--dsw-alias-state-warn-primary'], ['--dsw-alias-state-warn-tertiary', '--dsw-alias-state-warn-primary'],
      ['--dsw-alias-state-warn-tertiary', '--dsw-alias-state-warn-label'],
      ...['proposal', 'midterm', 'manuscript', 'final', 'other']
        .map(type => [`--paperai-type-${type}-tint`, `--paperai-type-${type}`] as const),
    ]
    const failures: string[] = []
    for (const scheme of ['light', 'dark'] as const) {
      const token = (name: string): Rgba => rgba(PAPERAI_TOKENS[name]![scheme])
      for (const [fill, type] of pairs) {
        for (const ground of grounds) {
          const back = fill === '' ? token(ground) : over(token(fill), token(ground))
          const ratio = contrastRatio(over(token(type), back), back)
          if (ratio < 4.5) failures.push(`${scheme} ${type} on ${fill || 'bare'} over ${ground}: ${ratio.toFixed(2)}`)
        }
      }
      // Ink drawn on the sheet, which stays white in both schemes.
      for (const ink of ['accent', 'loss', 'gain', 'ink'].map(name => `--paperai-page-${name}`)) {
        const ratio = contrastRatio(token(ink), [255, 255, 255, 1])
        if (ratio < 4.5) failures.push(`${scheme} ${ink} on the page: ${ratio.toFixed(2)}`)
      }
    }
    expect(failures).toEqual([])
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
    expect(before.slots.entries(ACP_CHANNEL_MARK)).toHaveLength(2)

    before.disposeHoles?.()
    for (const hole of HOLES) expect(before.slots.entries(hole)).toHaveLength(0)
    expect(before.slots.entries(AGENT_PRESET_MARK)).toHaveLength(0)
    expect(before.slots.entries(ACP_CHANNEL_MARK)).toHaveLength(0)
    before.declareHoles()
    await Promise.resolve()
    for (const hole of HOLES) expect(before.slots.entries(hole)).toHaveLength(1)
    expect(before.slots.entries(AGENT_PRESET_MARK)).toHaveLength(3)
    expect(before.slots.entries(ACP_CHANNEL_MARK)).toHaveLength(2)

    await fiber.dispose()
    for (const hole of HOLES) expect(before.slots.entries(hole)).toHaveLength(0)
    expect(before.slots.entries(AGENT_PRESET_MARK)).toHaveLength(0)
    expect(before.slots.entries(ACP_CHANNEL_MARK)).toHaveLength(0)

    const after = await bench(false)
    await after.ctx.plugin({ inject: [...inject], apply }).await()
    for (const hole of HOLES) expect(after.slots.entries(hole)).toHaveLength(0)
    after.declareHoles()
    await Promise.resolve()
    for (const hole of HOLES) expect(after.slots.entries(hole)).toHaveLength(1)
    expect(after.slots.entries(AGENT_PRESET_MARK)).toHaveLength(3)
    expect(after.slots.entries(ACP_CHANNEL_MARK)).toHaveLength(2)
  })

  it('renders the outlined wordmark and the host-sized golden-ratio mark', () => {
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
