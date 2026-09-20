# Agent Note: PaperAI roster: the native DSH engine beside the two ACP channels

Status: implemented

English | [中文](2026-09-17-paperai-native-engine-in-roster.zh.md)

## Problem

Since the [ACP channels decision](../architecture/2026-09-08-paperai-acp-channels.md), the PaperAI launcher restricted its product-owned preset root to `codex` and `claude`, and the [product-profile note](../architecture/2026-08-28-paperai-product-profile.md) said the native engine "remains available to explicit deployment configuration". That path did not exist: `composeProfile` in `apps/cli/src/profile-boot.ts` appends the launcher's roots overlay after the home patch and every `--patch` overlay and overwrites `roots`, so no deployment could add the `dsh` preset back. The picker offered two entries, both reading 暂无描述 because the contributed presets carried no description, and a person who wanted to write with a model API of their own had no engine at all. The complete `dsh` composition under `packages/bundle/paperai-web/config/agent-presets/` kept shipping unused.

## Decision

The PaperAI profile discovers its whole product-owned preset root. `profilePresetRoots('paperai')` returns the root without an id filter, so the picker lists three engines in their declared `order`: `DSH 标准`, `Codex`, and `Claude`. Codex stays the deployment default; the user preset root stays off.

Each entry's copy is one short line naming the transport, not the persona: `自定义模型，直连 API。` for the native engine, `本地 Codex ACP 通道。` and `本地 Claude ACP 通道。` for the channels. The native engine's copy lives in its `preset.yml`. The channels' copy lives as `description` on `ACP_TEMPLATES` in `@paperai/agent-acp`, and `PaperAiAcpAgents` passes it when it registers the contributed preset. A contribution shadows the file preset of the same id, so the two channel `preset.yml` files carry the same line for a composition without the ACP plugin.

**Non-interference.** The engines share only the roster, the project charter, and the version ledger. A native session mounts the `dsh` composition (the writing persona, `agent-instructions`, `@paperai/tool-document`, and the standard rows) on the DSH loop, with the stock model directory and the DeepSeek credential from Settings → Models; the Host's `acpSession` answers `null` for it, so the ACP session control renders nothing in its header. An ACP session is created through the channel's contributed factory route and never mounts the `dsh` rows. The ACP settings page still lists the two channels only; the general preset settings row offers the whole roster for the default.

This partially supersedes the [product-profile note](../architecture/2026-08-28-paperai-product-profile.md) for the roster and the [ACP channels decision](../architecture/2026-09-08-paperai-acp-channels.md) for which engines PaperAI exposes; their other decisions stand.

## Alternatives considered

**Keep the filter and honor a deployment's `roots`.** Letting a home patch win over the launcher's overlay would make the documented path real, but the shipped product would still lack the engine, and every profile would inherit a merge rule written for one. The roster is a product fact; shipping it is simpler than documenting a patch.

**Derive the channel copy from the file presets.** Merging a contribution with the discovered preset of the same id inside `dsh-agent-presets` would push PaperAI copy into the shared registry and change a rule every profile depends on. The template table already owns each channel's name, and the description sits beside it.

**Keep the long descriptions.** They restated the persona in a menu; the menu is for choosing a transport, and one line does that.

## Consequences

The picker offers the native engine again, with the copy the user asked for, and the launcher carries no dead `ids` plumbing. `apps/cli/tests/profile-preset-roots.spec.ts` pins the three ids, `apps/web/tests/paperai-dsh-preset.e2e.ts` pins the native composition and the `null` ACP answer, and the `agent-presets` browser golden pins the channel copy. The native engine needs a DeepSeek key entered under Settings → Models, since PaperAI keeps the first-run credential dialog off; a fresh install still opens on Codex.
