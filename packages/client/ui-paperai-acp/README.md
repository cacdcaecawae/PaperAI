# @paperai/ui-acp

English | [中文](README.zh.md)

ACP settings and conversation controls for PaperAI. The directory exposes Codex and Claude with separate diagnostic results and conversation usage. **检测通过 / 待检测 / 检测失败** describe the last diagnostic; **正在使用 / 未使用** indicate whether an open conversation holds a provider connection. Both channels can be in use concurrently in different conversations. Loss of Host observations makes usage unknown until a successful refresh; it does not imply that another conversation stopped.

The **一键检测** button runs channel diagnostics in parallel without sending a model prompt. Channel logos come from the keyed `paperai.acp.channel.mark` slot, supplied by the product's brand plugin.

Saving edited fields also removes their legacy copies atomically, so a pending migration cannot restore cleared credentials. Unedited credentials remain untouched.

The settings section supports per-channel launch configuration, write-only credentials, default Agent/model, proxy, personal instructions, model favorites, explicit probes, and managed installation actions. Available account, provider-routing, and external-history operations follow the adapter's advertised capabilities. Import opens an existing local association or creates a separate conversation; failure preserves the currently selected conversation and its draft.

The conversation header exposes the connected adapter's current model and other session options. Applying an option refreshes the same session's shared model directory, so the composer and `/model` reflect the Host-confirmed model, effort, and switches. Model search and favorites do not change the live catalog. An explicit custom model ID is sent to the provider for validation. Permission-owned options remain under the existing permission selector.

The plugin reads the shared settings mirror and uses the generated PaperAI Remote mounted by the workbench. Controllers own asynchronous operations, stale-response rejection, and session-scoped disposal. It introduces neither another settings store on disk nor another Remote mount. [The ACP service](../../paperai/agent-acp/README.md) owns process, permission, history, and protocol semantics.

Settings use the shared DSH controls and Chinese/English locale, grouped by connection setup, credentials/network, models/permissions, and advanced preferences. Installation progress and conversation usage remain separate; raw failure details expand beneath an actionable message. Failed channel-configuration and provider-routing saves preserve their inputs for retry. Credentials remain write-only and destructive account or installation actions retain their confirmation.

Selecting another Agent immediately clears the previous Agent's session options and invalidates its pending responses. Loading and first-load failure remain visible even before session details exist, with an explicit retry. Background refreshes retain a rejected option's reason; explicit refresh clears it. Options are locked while refreshing, applying, or disconnected, including provider-declared read-only model options.

## Model Experience

### ACP settings

#### What the model sees

Opening settings, observing status, and probing channels add no model input. Saved `language` and `personalPrompt` instructions apply through the ACP service; selected models and options affect subsequent provider requests.

#### Token effect

The UI adds no prompt tokens. The ACP service owns the text and tools it sends.

#### KV Cache effect

The UI does not retain provider caches. Applying a different model or prompt preference can change later request prefixes.

## Known Limitations and Deferred Work

- The directory exposes only Codex and Claude. Additional ACP templates and custom channel identities are not enabled.
- Account and external-history buttons depend on actual adapter capabilities. CLI-only login methods display their native command.
- SSH execution requires an explicitly configured remote POSIX host; the directory distinguishes that host from the local PaperAI project.
