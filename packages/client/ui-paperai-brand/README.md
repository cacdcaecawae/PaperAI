# @paperai/ui-brand

English | [中文](README.zh.md)

This package supplies the PaperAI identity through the existing `sidebar.brand.mark`, `sidebar.brand.name`, and `conversation.hero.brand.mark` slots, plus decorative Codex, Claude, and built-in DSH-engine marks through the keyed `conversation.hero.agentPreset.mark` slot. It renders a restrained document mark with the `paperai` wordmark and the Chinese descriptor `论文工作台`, following DSH component conventions with CSS Modules and semantic design tokens without introducing another shell or theme. Provider marks stay hidden from assistive technology because the adjacent preset name owns their accessible label.

The plugin also installs one `ctx.theme.overrideTokens` layer (`PAPERAI_THEME_TOKENS`): the DeepSeek blue accent family becomes the academic pine green, with matching soft chat and sidebar surfaces, defined for both color schemes. Neutrals, typography, spacing, and layout tokens stay shipped, and disposing the plugin removes the layer.

The three occupants install as one declaration-aware registration set through nested `slots.inject()` calls. The package therefore works whether its row activates before or after the sidebar and conversation declarers, withdraws all occupants when any declaration collapses, and leaves no partial brand mix during HMR. It retains no runtime state. The node half is an empty Loader seat, and the browser title remains outside this package.

A PaperAI product profile must disable `@deepseek-ai/dsh-client-ui-brand-official` before mounting this package because both plugins own the same single-occupant slots.

## Model Experience

### Browser brand presentation

#### What the model sees

Nothing; the package only occupies `sidebar.brand.mark`, `sidebar.brand.name`, `conversation.hero.brand.mark`, and `conversation.hero.agentPreset.mark` in the browser.

#### Token effect

Zero; the package registers no prompt, tool schema, session event, or model request input.

#### KV Cache effect

None; browser-only brand rendering does not assemble or send provider requests.

## Known Limitations and Deferred Work

- **Exclusive slot ownership** — a product profile must not mount this package beside another occupant such as `@deepseek-ai/dsh-client-ui-brand-official`; the single slots reject equal-priority duplicates.
- **Browser title is independent** — this package does not set the build-time page title.
