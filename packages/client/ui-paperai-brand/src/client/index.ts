/** PaperAI occupants for the generic browser-brand slots. */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-agent-preset/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import {
  ClaudeAgentMark,
  CodexAgentMark,
  PaperAIBrandMark,
  PaperAIBrandName,
} from './PaperAIBrand.tsx'

/** Required service: the UI slot registry. */
export const inject = ['slots']

/**
 * Fill every shipped brand slot as one declaration-aware registration set.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
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
  })
}
