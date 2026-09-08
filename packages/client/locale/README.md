# @deepseek-ai/dsh-client-locale

English | [中文](README.zh.md)

Locale plugin: LocaleRuntime — the `zh`/`en` preference stored as `locale.preference` in `$DSH_HOME/settings.yaml`; when that explicit Host value is absent, a fresh browser starts provisionally in the language `navigator` asks for (primary-subtag matching, with `en` when it asks for no language this app ships). The Host read runs after plugin activation so an unavailable settings service cannot block the page; its result replaces the provisional browser value live. Remote browsers retain only a process-local selection because the settings API is loopback-only. `locale/change` fires on switches, and the plugin points `<html lang>` at the active locale (`zh-CN`/`en`) on activation and on every switch. The service also owns the ns×locale dictionary registry (typed `register(ns, {zh, en})` checked against `LocaleNamespaceMap`, `bind(ns)`→`TranslateNS<ns>`; lookup per key: the namespace's overlay, then its dictionary, in the active locale, then the same pair in `en`, then the `common` namespace the same way, then the key itself), and the product overlay seam `override(ns, dicts)`: a deployment restates only the keys it renames, as partial dictionaries per locale, over a namespace another package owns; each namespace keeps one overlay per locale at a time (a second throws), the overlay is consulted before that owner's dictionary, its disposer removes it, and like registration it bumps the revision so mounted outlets repaint. It implements the slot system's `LocaleFace`, and installs itself through `ctx.slots.installLocale`, backing the framework-injected `t` standard seat (`Translate`/`TranslateNS` are ui-slots types; import them from there — this package only re-exports for dictionary owners' convenience). The [Host-backed preferences decision](../../../.agents/notes/implemented/bug-fix/2026-08-06-host-backed-web-preferences.md) owns the persistence boundary.

## Model Experience

None, as the locale registry serves browser UI copy; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Some surfaces keep inline copy** — Settings rows, the sidebar, question composer, and model select use locale seats; other packages still own static text directly.
- **Registry-held text reads its translation once** — copy captured at registration time outside the slot render path (e.g. the `/model` command description in the command registry) keeps the language it was registered under until re-registration; slot-rendered copy follows switches live.
