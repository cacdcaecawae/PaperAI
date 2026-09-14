# @paperai/ui-brand

English | [中文](README.zh.md)

This package supplies the PaperAI identity through the existing `sidebar.brand.mark`, `sidebar.brand.name`, and `conversation.hero.brand.mark` slots and the `paperai.start.mark` seat that `@paperai/ui-workbench` declares on its start page, plus decorative Codex, Claude, and built-in DSH-engine marks through the keyed `conversation.hero.agentPreset.mark` slot. The mark is the product's traced logo, a robot-headed pen nib over an open book squeezed to a golden rectangle, shipped as one even-odd path in `brand-paths.ts` and painted with `currentColor`: a host reserves a square edge, the portrait artwork fills that edge in height and takes its width from the artwork's ratio, so the sidebar, the hero, and the start page show the same mark at their own sizes. The wordmark is the outlines of `PaperAI` at the DSH wordmark's 24px height in the primary label ink, carrying `data-brand-name="PaperAI"` for tests and tooling rather than rendering text. There is no descriptor line and no hero copy. Color is the package's ink-and-gold token layer: `theme.ts` stacks alias-token overrides over the shipped DSH palette through `ctx.theme.overrideTokens` (warm paper surfaces, an ink primary button, and old-gold accents in light; deep slate surfaces, a gold primary button, and champagne hairlines in dark) and defines the `--paperai-type-*` accents the workbench paints its document-type badges with. Every token carries a light and a dark value, so the user's light/dark/system preference keeps deciding which side applies, and disposing the plugin lifts the layer. Every mark is hidden from assistive technology because the adjacent wordmark or preset name owns the accessible label.

The plugin also overlays the product vocabulary on the shell. `PROJECT_COPY` restates, in both `zh` and `en`, every `workspace` and `conversation` key that names a workspace, from the sidebar section, grouping, add, back, detail, and sessions labels through the picker, conflict, rename, and delete copy, the actions menu, and the hero's workspace placeholder and chip, as a project, and installs them through `ctx.locale.override`. Keys not listed keep the DSH copy, both locales carry the same key set so no language falls back to the other, and disposing the plugin lifts the overlay.

The three brand occupants install as one declaration-aware registration set through nested `slots.inject()` calls, and the start-page mark and the preset marks ride their own declarations. The package therefore works whether its row activates before or after the sidebar, conversation, and workbench declarers, withdraws all occupants when any declaration collapses, and leaves no partial brand mix during HMR. It retains no runtime state. The node half is an empty Loader seat, and the browser title remains outside this package.

A PaperAI product profile must disable `@deepseek-ai/dsh-client-ui-brand-official` before mounting this package because both plugins own the same single-occupant slots.

The ACP directory's keyed `paperai.acp.channel.mark` slot reuses the Codex and Claude preset marks. Its registrations follow the ACP settings declaration and leave with it.

## Model Experience

### Browser brand presentation

#### What the model sees

Nothing; the package only occupies `sidebar.brand.mark`, `sidebar.brand.name`, `conversation.hero.brand.mark`, `paperai.start.mark`, `conversation.hero.agentPreset.mark`, and `paperai.acp.channel.mark` in the browser and restates shell copy.

#### Token effect

Zero; the package registers no prompt, tool schema, session event, or model request input.

#### KV Cache effect

None; browser-only brand rendering does not assemble or send provider requests.

## Known Limitations and Deferred Work

- **Exclusive slot ownership** — a product profile must not mount this package beside another occupant such as `@deepseek-ai/dsh-client-ui-brand-official`; the single slots reject equal-priority duplicates.
- **Browser title is independent** — this package does not set the build-time page title.
- **The vocabulary overlay is namespace-bound** — only the `workspace` and `conversation` namespaces are restated; copy that other DSH packages own keeps DSH's own wording.
