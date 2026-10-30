/**
 * PaperAI's iOS token layer. Both schemes follow the iOS system palette:
 * grouped gray grounds under white (light) or black (dark) content, system
 * gray labels, translucent fills for hover and press, and system blue as the
 * one tint every interactive element, selection, focus ring, and filled
 * button paints with. Gold survives only as the brand mark and the
 * manuscript type accent. The layer also names the document-type accents the
 * workbench badges paint with and the elevation and material recipes the
 * PaperAI sheets read. It stacks over the shipped DSH palette through
 * `ctx.theme.overrideTokens`, so the base stylesheets stay untouched and the
 * user's light/dark/system preference keeps deciding which side applies.
 */
import type { ThemeTokenOverrides } from '@deepseek-ai/dsh-client-ui-theme/client'

/** Override-layer identity: one layer per source, replaced on re-apply. */
export const PAPERAI_THEME_SOURCE = 'paperai-brand'

/** One token: its light-scheme value, then its dark-scheme value. */
function pair(light: string, dark: string): { light: string; dark: string } {
  return { light, dark }
}

/** The SF Pro stack first, then the platform's own UI faces for CJK and Windows. */
const IOS_FONT_FAMILY = "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'SF Pro Display', 'PingFang SC', 'Hiragino Sans GB', 'Segoe UI Variable Text', 'Segoe UI', 'Microsoft YaHei', 'Helvetica Neue', Helvetica, Arial, sans-serif"

/** Alias-token overrides plus the `--paperai-*` accents, shadows, and materials. */
export const PAPERAI_TOKENS: ThemeTokenOverrides = Object.freeze({
  '--dsw-font-family': pair(IOS_FONT_FAMILY, IOS_FONT_FAMILY),

  // Surfaces: systemBackground over systemGroupedBackground. Layer 2 is the grouped
  // ground (the desk, the settings panel, the inspector); layers 1 and 3 are the cards
  // on it, which in dark take the elevated #2c2c2e so a card still reads on the ground.
  '--dsw-alias-bg-base': pair('#ffffff', '#000000'),
  '--dsw-alias-bg-layer-1': pair('#ffffff', '#2c2c2e'),
  '--dsw-alias-bg-layer-2': pair('#f2f2f7', '#1c1c1e'),
  '--dsw-alias-bg-layer-3': pair('#ffffff', '#2c2c2e'),
  '--dsw-alias-bg-overlay': pair('#e5e5ea', '#3a3a3c'),
  '--dsw-alias-bg-module-platform': pair('rgba(118, 118, 128, 0.12)', 'rgba(118, 118, 128, 0.24)'),
  '--dsw-alias-bg-multi-select': pair('#f2f2f7', '#1c1c1e'),
  '--dsw-alias-bg-mask-1': pair('rgba(0, 0, 0, 0.2)', 'rgba(0, 0, 0, 0.48)'),
  '--dsw-specific-sidebar-fill': pair('#f2f2f7', '#1c1c1e'),
  '--dsw-specific-sidebar-nav-item-hover': pair('rgba(118, 118, 128, 0.12)', 'rgba(118, 118, 128, 0.24)'),
  '--dsw-specific-sidebar-nav-item-active': pair('rgba(118, 118, 128, 0.2)', 'rgba(118, 118, 128, 0.32)'),
  '--dsw-specific-sidebar-nav-item-active-accent': pair('rgba(0, 102, 204, 0.12)', 'rgba(64, 156, 255, 0.18)'),
  '--dsw-specific-input-major': pair('#ffffff', '#1c1c1e'),
  '--dsw-specific-selector': pair('rgba(118, 118, 128, 0.12)', 'rgba(118, 118, 128, 0.24)'),
  '--dsw-specific-menu': pair('rgba(249, 249, 249, 0.94)', 'rgba(37, 37, 37, 0.94)'),
  '--dsw-specific-tip': pair('#f2f2f7', '#1c1c1e'),
  // The user's own message is an iMessage bubble: the tint fill, white text.
  '--dsw-specific-bubble': pair('#0066cc', '#0071e3'),
  '--dsw-specific-bubble-highlight': pair('#0058b0', '#0062c4'),
  '--dsw-specific-bubble-foreground': pair('#ffffff', '#ffffff'),
  '--dsw-alias-toast-bg': pair('rgba(30, 30, 30, 0.92)', 'rgba(58, 58, 60, 0.94)'),
  '--dsw-alias-tooltip-bg': pair('rgba(30, 30, 30, 0.92)', 'rgba(58, 58, 60, 0.94)'),

  // Separators: the iOS hairline, opaque enough to hold at 1 px on every ground.
  '--dsw-alias-border-l1': pair('rgba(60, 60, 67, 0.12)', 'rgba(84, 84, 88, 0.36)'),
  '--dsw-alias-border-l2': pair('rgba(60, 60, 67, 0.2)', 'rgba(84, 84, 88, 0.6)'),
  '--dsw-alias-border-l3': pair('rgba(60, 60, 67, 0.29)', 'rgba(84, 84, 88, 0.72)'),
  '--dsw-alias-border-l4': pair('rgba(60, 60, 67, 0.36)', 'rgba(84, 84, 88, 0.85)'),

  // Tint: system blue is the brand accent, the focus ring, and the one filled action. Each
  // scheme splits it. Fills under white type take #0066cc and #0071e3 (5.6:1 and 4.7:1, where
  // #007aff holds 4.0:1), and a hovered fill darkens instead of lightening. Type and marks take
  // #0060c0 and #64b0ff, which still clear 4.5:1 on the translucent tint and gray fills a
  // badge, a current row, or a pop-up trigger lays under them on the grouped ground or a card.
  '--dsw-alias-brand-primary': pair('#0060c0', '#64b0ff'),
  '--dsw-alias-brand-primary-invert': pair('#ffffff', '#ffffff'),
  '--dsw-alias-brand-text': pair('#000000', '#ffffff'),
  '--dsw-alias-button-primary-fill': pair('#0066cc', '#0071e3'),
  '--dsw-alias-button-primary-hover': pair('#0058b0', '#0062c4'),
  '--dsw-alias-button-primary-foreground': pair('#ffffff', '#ffffff'),
  '--dsw-alias-button-primary-dimmed': pair('rgba(118, 118, 128, 0.12)', 'rgba(118, 118, 128, 0.24)'),
  '--dsw-alias-button-info-fill': pair('#0066cc', '#0071e3'),
  '--dsw-alias-button-info-hover': pair('#0058b0', '#0062c4'),
  '--dsw-alias-button-elevated-fill': pair('#ffffff', '#2c2c2e'),
  '--dsw-alias-button-floating-fill': pair('#ffffff', '#2c2c2e'),
  '--dsw-alias-button-floating-hover': pair('#f2f2f7', '#3a3a3c'),
  '--dsw-alias-button-ghost-active-fill': pair('#e5e5ea', '#3a3a3c'),

  // Selected, linked, and focused states.
  '--dsw-alias-state-business-primary': pair('#0060c0', '#64b0ff'),
  '--dsw-alias-state-business-tertiary': pair('rgba(0, 102, 204, 0.12)', 'rgba(64, 156, 255, 0.18)'),

  // System status colors. They color status type as well as marks, so each takes a value that
  // holds 4.5:1 on the grounds and on its own tint, a danger button's hover fill included: deep
  // reds #c80013 and #ff8a82 (#ff3b30 holds 3.6:1 on white), and in light a deep green and a
  // burnt orange, since the iOS #34c759 and #ff9500 hold about 2:1 as type.
  '--dsw-alias-state-error-primary': pair('#c80013', '#ff8a82'),
  '--dsw-alias-state-error-secondary': pair('#ff6961', '#ff6961'),
  '--dsw-alias-state-success-primary': pair('#1b7031', '#30d158'),
  '--dsw-alias-state-success-secondary': pair('#30d158', '#32d74b'),
  '--dsw-alias-state-success-tertiary': pair('rgba(52, 199, 89, 0.14)', 'rgba(48, 209, 88, 0.2)'),
  '--dsw-alias-state-warn-primary': pair('#b83000', '#ff9f0a'),
  '--dsw-alias-state-warn-secondary': pair('#ffb340', '#ffb340'),
  '--dsw-alias-state-warn-tertiary': pair('rgba(255, 149, 0, 0.14)', 'rgba(255, 159, 10, 0.2)'),
  '--dsw-alias-state-warn-label': pair('#b83000', '#ffb340'),

  // Fills: the iOS translucent gray fills for hover, press, and toggled controls.
  '--dsw-alias-interactive-bg-hover': pair('rgba(118, 118, 128, 0.12)', 'rgba(118, 118, 128, 0.24)'),
  '--dsw-alias-interactive-bg-active': pair('rgba(118, 118, 128, 0.2)', 'rgba(118, 118, 128, 0.36)'),
  '--dsw-alias-interactive-bg-hover-accent': pair('rgba(118, 118, 128, 0.24)', 'rgba(118, 118, 128, 0.4)'),
  '--dsw-alias-interactive-bg-hover-solid': pair('#e5e5ea', '#2c2c2e'),
  '--dsw-alias-interactive-bg-hover-danger': pair('rgba(255, 59, 48, 0.1)', 'rgba(255, 69, 58, 0.18)'),

  // Labels: the iOS increased-contrast grays. Secondary, tertiary, and caption type sits on
  // white and #2c2c2e cards, the grouped grounds, and the translucent gray fills of badges and
  // hovered rows; each value holds 4.5:1 over all of them. Quaternary and dimmed are disabled
  // and placeholder ink, which the contrast minimum exempts.
  '--dsw-alias-label-primary': pair('#000000', '#ffffff'),
  '--dsw-alias-label-primary-dimmed': pair('#1c1c1e', '#ebebf5'),
  '--dsw-alias-label-secondary': pair('#545458', '#c7c7cc'),
  '--dsw-alias-label-tertiary': pair('#636366', '#aeaeb2'),
  '--dsw-alias-label-quaternary': pair('#aeaeb2', '#636366'),
  '--dsw-alias-label-caption': pair('#636366', '#aeaeb2'),
  '--dsw-alias-label-dimmed': pair('#c7c7cc', '#48484a'),

  // Markdown surfaces in the conversation.
  '--dsw-alias-markdown-code-block': pair('#f2f2f7', '#1c1c1e'),
  '--dsw-alias-markdown-code-block-banner': pair('#e5e5ea', '#2c2c2e'),
  '--dsw-alias-markdown-inline-code': pair('rgba(118, 118, 128, 0.12)', 'rgba(118, 118, 128, 0.24)'),
  '--dsw-alias-markdown-citation': pair('rgba(118, 118, 128, 0.12)', 'rgba(118, 118, 128, 0.24)'),
  '--dsw-alias-markdown-tag': pair('rgba(118, 118, 128, 0.12)', 'rgba(118, 118, 128, 0.24)'),
  '--dsw-alias-markdown-placeholder': pair('#f2f2f7', '#1c1c1e'),

  // The focus ring (the tint at half strength, drawn outside the control), the
  // bar and thick materials iOS lays over scrolling content, and a segmented
  // control's selected segment and track.
  '--dsw-alias-focus-ring': pair('rgba(0, 102, 204, 0.5)', 'rgba(64, 156, 255, 0.6)'),
  '--dsw-alias-material-bar': pair('rgba(255, 255, 255, 0.78)', 'rgba(22, 22, 24, 0.78)'),
  '--dsw-alias-material-thick': pair('rgba(249, 249, 249, 0.86)', 'rgba(37, 37, 37, 0.86)'),
  '--dsw-alias-segment-fill': pair('#ffffff', '#636366'),
  '--dsw-alias-segment-track': pair('rgba(118, 118, 128, 0.12)', 'rgba(118, 118, 128, 0.24)'),

  // Scrollbars.
  '--dsw-alias-scrollbar-bg-l1': pair('#c7c7cc', '#48484a'),
  '--dsw-alias-scrollbar-bg-l2': pair('#c7c7cc', '#48484a'),
  '--dsw-alias-scrollbar-hover-l1': pair('#aeaeb2', '#636366'),
  '--dsw-alias-scrollbar-hover-l2': pair('#aeaeb2', '#636366'),

  // Shared DSH elevations, softened to the iOS lift.
  '--dsw-shadow-lv1': pair('0 1px 3px rgba(0, 0, 0, 0.06)', '0 1px 3px rgba(0, 0, 0, 0.5)'),
  '--dsw-shadow-lv2': pair('0 2px 10px rgba(0, 0, 0, 0.06), 0 0 0 0.5px rgba(0, 0, 0, 0.04)', '0 2px 10px rgba(0, 0, 0, 0.5), 0 0 0 0.5px rgba(255, 255, 255, 0.06)'),
  '--dsw-shadow-segment': pair('0 3px 8px rgba(0, 0, 0, 0.12), 0 3px 1px rgba(0, 0, 0, 0.04)', '0 3px 8px rgba(0, 0, 0, 0.4)'),
  '--dsw-shadow-lv3': pair('0 0 0 0.5px rgba(0, 0, 0, 0.06), 0 10px 40px rgba(0, 0, 0, 0.14)', '0 0 0 0.5px rgba(255, 255, 255, 0.1), 0 10px 40px rgba(0, 0, 0, 0.6)'),

  // Elevation: the page over the desk, and the pills and menus floating over everything.
  '--paperai-page-shadow': pair('0 1px 2px rgba(0, 0, 0, 0.04), 0 8px 28px rgba(0, 0, 0, 0.08)', '0 1px 2px rgba(0, 0, 0, 0.5), 0 8px 28px rgba(0, 0, 0, 0.6)'),
  '--paperai-float-shadow': pair('0 4px 20px rgba(0, 0, 0, 0.1), 0 0 0 0.5px rgba(0, 0, 0, 0.04)', '0 4px 20px rgba(0, 0, 0, 0.5), 0 0 0 0.5px rgba(255, 255, 255, 0.08)'),
  // An inset grouped row's resting lift: none in light (white on gray reads), a hairline glow in dark.
  '--paperai-card-shadow': pair('0 0 0 0.5px rgba(0, 0, 0, 0.02)', '0 0 0 0.5px rgba(255, 255, 255, 0.04)'),
  // The brand mark keeps its gold on both schemes.
  '--paperai-brand-gold': pair('#b8860b', '#e2b457'),

  // Ink drawn ON the page. The sheet is white in both schemes, so a mark made on it holds one
  // value instead of following the app: the dark tint is lighter and reads poorer on white.
  '--paperai-page-accent': pair('#0071e3', '#0071e3'),
  '--paperai-page-loss': pair('#c4001a', '#c4001a'),
  '--paperai-page-gain': pair('#1b7031', '#1b7031'),
  // Tint type on the page: on a conflict band's own tint the accent reads 3.6:1, under AA for
  // 13 px labels, where this holds 6.5:1 and still clears 4.5:1 on a pressed button's fill.
  '--paperai-page-ink': pair('#0058c6', '#0058c6'),

  // Document-type accents the workbench badges and icons read: iOS system hues, deepened in light
  // and lifted in dark until the badge type holds 4.5:1 on its own tint.
  '--paperai-type-proposal': pair('#0060c0', '#64b0ff'),
  '--paperai-type-proposal-tint': pair('rgba(0, 102, 204, 0.12)', 'rgba(64, 156, 255, 0.18)'),
  '--paperai-type-midterm': pair('#8e3fb8', '#d99bf8'),
  '--paperai-type-midterm-tint': pair('rgba(175, 82, 222, 0.12)', 'rgba(191, 90, 242, 0.22)'),
  '--paperai-type-manuscript': pair('#8a6100', '#e8c06c'),
  '--paperai-type-manuscript-tint': pair('rgba(255, 204, 0, 0.18)', 'rgba(255, 214, 10, 0.2)'),
  '--paperai-type-final': pair('#1b7031', '#30d158'),
  '--paperai-type-final-tint': pair('rgba(52, 199, 89, 0.14)', 'rgba(48, 209, 88, 0.2)'),
  '--paperai-type-other': pair('#636366', '#aeaeb2'),
  '--paperai-type-other-tint': pair('rgba(118, 118, 128, 0.12)', 'rgba(118, 118, 128, 0.24)'),
})
