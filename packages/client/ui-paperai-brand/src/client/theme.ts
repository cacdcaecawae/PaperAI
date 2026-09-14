/**
 * PaperAI's ink-and-gold token layer. Light keeps the page metaphor: warm
 * paper surfaces, ink text, an ink primary button, old-gold accents. Dark moves
 * to deep slate surfaces with a gold primary and champagne hairlines. The layer
 * also names the document-type accents the workbench badges paint with. It
 * stacks over the shipped DSH palette through `ctx.theme.overrideTokens`, so
 * the base stylesheets stay untouched and the user's light/dark/system
 * preference keeps deciding which side applies.
 */
import type { ThemeTokenOverrides } from '@deepseek-ai/dsh-client-ui-theme/client'

/** Override-layer identity: one layer per source, replaced on re-apply. */
export const PAPERAI_THEME_SOURCE = 'paperai-brand'

/** One token: its light-scheme value, then its dark-scheme value. */
function pair(light: string, dark: string): { light: string; dark: string } {
  return { light, dark }
}

/** Alias-token overrides plus the `--paperai-*` document-type accents. */
export const PAPERAI_TOKENS: ThemeTokenOverrides = Object.freeze({
  // Surfaces: warm paper in light, deep slate in dark.
  '--dsw-alias-bg-base': pair('#fbfaf7', '#0f1318'),
  '--dsw-alias-bg-layer-1': pair('#ffffff', '#151a21'),
  '--dsw-alias-bg-layer-2': pair('#f6f4ee', '#1b212a'),
  '--dsw-alias-bg-layer-3': pair('#efece4', '#222a34'),
  '--dsw-alias-bg-overlay': pair('#e9e5db', '#2a333f'),
  '--dsw-alias-bg-module-platform': pair('#f6f4ee', '#1b212a'),
  '--dsw-alias-bg-multi-select': pair('#f6f4ee', '#1b212a'),
  '--dsw-specific-sidebar-fill': pair('#f4f1ea', '#0c1015'),
  '--dsw-specific-sidebar-nav-item-hover': pair('#ebe6da', '#171d25'),
  '--dsw-specific-sidebar-nav-item-active': pair('#e5dfd0', '#1f2730'),
  '--dsw-specific-sidebar-nav-item-active-accent': pair('rgba(154, 106, 26, 0.14)', 'rgba(226, 180, 87, 0.16)'),
  '--dsw-specific-input-major': pair('#ffffff', '#161c24'),
  '--dsw-specific-selector': pair('#f6f4ee', '#1f2730'),
  '--dsw-specific-menu': pair('#efece4', '#222a34'),
  '--dsw-specific-tip': pair('#f6f4ee', '#1b212a'),
  '--dsw-specific-bubble': pair('#f3ecdc', '#1f2937'),
  '--dsw-specific-bubble-highlight': pair('#e9dbb9', '#2b3648'),
  '--dsw-alias-toast-bg': pair('#2b2823', '#2a333f'),
  '--dsw-alias-tooltip-bg': pair('#2b2823', '#2a333f'),

  // Hairlines: warm ink alpha in light, champagne alpha in dark.
  '--dsw-alias-border-l1': pair('rgba(78, 60, 24, 0.06)', 'rgba(226, 196, 140, 0.07)'),
  '--dsw-alias-border-l2': pair('rgba(78, 60, 24, 0.12)', 'rgba(226, 196, 140, 0.13)'),
  '--dsw-alias-border-l3': pair('rgba(78, 60, 24, 0.18)', 'rgba(226, 196, 140, 0.2)'),
  '--dsw-alias-border-l4': pair('rgba(78, 60, 24, 0.24)', 'rgba(226, 196, 140, 0.28)'),

  // Brand and primary action: ink on paper, gold on slate. The shipped
  // primary-foreground tokens already give white-on-ink and ink-on-gold.
  '--dsw-alias-brand-primary': pair('#1c1a17', '#e2b457'),
  '--dsw-alias-brand-primary-invert': pair('#fbfaf7', '#0f1318'),
  '--dsw-alias-brand-text': pair('#1c1a17', '#f3d99a'),
  '--dsw-alias-button-primary-fill': pair('#1c1a17', '#e2b457'),
  '--dsw-alias-button-primary-hover': pair('#3a352d', '#edc26e'),
  '--dsw-alias-button-primary-dimmed': pair('#e6e1d5', '#2a333f'),

  // Accent for selected, linked, and focused states: old gold both ways.
  '--dsw-alias-state-business-primary': pair('#9a6a1a', '#e2b457'),
  '--dsw-alias-state-business-tertiary': pair('rgba(154, 106, 26, 0.14)', 'rgba(226, 180, 87, 0.18)'),

  // Interaction fills.
  '--dsw-alias-interactive-bg-hover': pair('rgba(92, 72, 28, 0.07)', 'rgba(255, 255, 255, 0.07)'),
  '--dsw-alias-interactive-bg-active': pair('rgba(92, 72, 28, 0.12)', 'rgba(226, 180, 87, 0.14)'),
  '--dsw-alias-interactive-bg-hover-accent': pair('rgba(92, 72, 28, 0.16)', 'rgba(255, 255, 255, 0.16)'),
  '--dsw-alias-interactive-bg-hover-solid': pair('#efece4', '#222a34'),

  // Text.
  '--dsw-alias-label-primary': pair('#1c1a17', '#eef1f5'),
  '--dsw-alias-label-primary-dimmed': pair('#2b2823', '#dfe4ea'),
  '--dsw-alias-label-secondary': pair('#5c554a', '#b9c1cb'),
  '--dsw-alias-label-tertiary': pair('#8a8272', '#8792a0'),
  '--dsw-alias-label-quaternary': pair('#a8a091', '#6b7683'),
  '--dsw-alias-label-caption': pair('#a8a091', '#6b7683'),
  '--dsw-alias-label-dimmed': pair('#d9d3c6', '#3a4451'),

  // Markdown surfaces in the conversation.
  '--dsw-alias-markdown-code-block': pair('#f4f1ea', '#0b0f14'),
  '--dsw-alias-markdown-code-block-banner': pair('#efece4', '#151a21'),
  '--dsw-alias-markdown-inline-code': pair('#ede8dc', '#222a34'),
  '--dsw-alias-markdown-citation': pair('#ede8dc', '#222a34'),
  '--dsw-alias-markdown-tag': pair('#efece4', '#1b212a'),
  '--dsw-alias-markdown-placeholder': pair('#f6f4ee', '#1b212a'),

  // Scrollbars.
  '--dsw-alias-scrollbar-bg-l1': pair('#dcd6c8', '#2c3541'),
  '--dsw-alias-scrollbar-bg-l2': pair('#dcd6c8', '#2c3541'),
  '--dsw-alias-scrollbar-hover-l1': pair('#c9c1ae', '#3b4654'),
  '--dsw-alias-scrollbar-hover-l2': pair('#c9c1ae', '#3b4654'),

  // Document-type accents the workbench badges and icons read.
  '--paperai-type-proposal': pair('#2563eb', '#7fb0ff'),
  '--paperai-type-proposal-tint': pair('rgba(37, 99, 235, 0.12)', 'rgba(127, 176, 255, 0.16)'),
  '--paperai-type-midterm': pair('#7c3aed', '#b794ff'),
  '--paperai-type-midterm-tint': pair('rgba(124, 58, 237, 0.12)', 'rgba(183, 148, 255, 0.16)'),
  '--paperai-type-manuscript': pair('#9a6a1a', '#e2b457'),
  '--paperai-type-manuscript-tint': pair('rgba(154, 106, 26, 0.14)', 'rgba(226, 180, 87, 0.18)'),
  '--paperai-type-final': pair('#15803d', '#5ad38f'),
  '--paperai-type-final-tint': pair('rgba(21, 128, 61, 0.12)', 'rgba(90, 211, 143, 0.16)'),
  '--paperai-type-other': pair('#8a8272', '#8792a0'),
  '--paperai-type-other-tint': pair('rgba(92, 72, 28, 0.08)', 'rgba(255, 255, 255, 0.08)'),
})
