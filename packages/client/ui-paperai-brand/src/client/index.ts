/** PaperAI occupants for the generic browser-brand slots and the product theme layer. */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-agent-preset/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { ThemeTokenOverrides } from '@deepseek-ai/dsh-client-ui-theme/client'
import {
  ClaudeAgentMark,
  CodexAgentMark,
  PaperAIBrandMark,
  PaperAIBrandName,
  DshAgentMark,
} from './PaperAIBrand.tsx'

/** Required services: the UI slot registry and the semantic theme. */
export const inject = ['slots', 'theme']

/**
 * PaperAI's accent layer over the shipped semantic tokens: the DeepSeek blue
 * accent family becomes the academic pine green, with matching soft surfaces,
 * in both color schemes. Neutrals, typography, and layout tokens stay shipped.
 */
export const PAPERAI_THEME_TOKENS: ThemeTokenOverrides = {
  '--dsw-alias-state-business-primary': { light: 'rgb(31, 107, 78)', dark: 'rgb(88, 178, 140)' },
  '--dsw-alias-state-business-tertiary': { light: 'rgb(227, 238, 231)', dark: 'rgb(34, 50, 42)' },
  '--dsw-alias-brand-primary-new-colorprimary-new-color': { light: 'rgb(31, 107, 78)', dark: 'rgb(88, 178, 140)' },
  '--dsw-alias-button-info-fill': { light: 'rgb(31, 107, 78)', dark: 'rgb(45, 125, 94)' },
  '--dsw-alias-button-info-hover': { light: 'rgb(42, 127, 96)', dark: 'rgb(56, 143, 110)' },
  '--dsw-specific-bubble': { light: 'rgb(239, 245, 241)', dark: 'rgb(30, 42, 36)' },
  '--dsw-specific-bubble-highlight': { light: 'rgb(220, 233, 225)', dark: 'rgb(42, 58, 49)' },
  '--dsw-specific-sidebar-nav-item-active-accent': { light: 'rgb(220, 233, 225)', dark: 'rgb(42, 58, 49)' },
}

/**
 * Fill every shipped brand slot and install the PaperAI theme layer.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.theme.overrideTokens('paperai-brand', PAPERAI_THEME_TOKENS))
  ctx.slots.inject('sidebar.brand.mark', () =>
    ctx.slots.inject('sidebar.brand.name', () =>
      ctx.slots.inject('conversation.hero.brand.mark', function* () {
        yield ctx.slots.register({ name: 'sidebar.brand.mark' }, PaperAIBrandMark)
        yield ctx.slots.register({ name: 'sidebar.brand.name' }, PaperAIBrandName)
        yield ctx.slots.register({ name: 'conversation.hero.brand.mark' }, PaperAIBrandMark)
      })))
  ctx.slots.inject('conversation.hero.agentPreset.mark', function* () {
    yield ctx.slots.register({ name: 'conversation.hero.agentPreset.mark', key: 'codex' }, CodexAgentMark)
    yield ctx.slots.register({ name: 'conversation.hero.agentPreset.mark', key: 'claude' }, ClaudeAgentMark)
    yield ctx.slots.register({ name: 'conversation.hero.agentPreset.mark', key: 'dsh' }, DshAgentMark)
  })
}
