# `@paperai/bundle-web`

English | [中文](README.zh.md)

The PaperAI product layer over the pinned DeepSeek Harness Web profile. It is applied after `@deepseek-ai/dsh-base` and `@deepseek-ai/dsh-web-app`, preserving the DSH Host, Harness/Loop, sessions, settings, credentials, model selection, permissions, workspace infrastructure, transport, and client plugin tree.

[`cordis.patch.yml`](cordis.patch.yml) disables only the upstream official-brand contribution and inserts the PaperAI brand and document-workbench plugins through the existing client slots. Document services and UI plugins join this layer as independently owned rows; generic DSH behavior is not copied into the product bundle.

The PaperAI workbench configures the existing `ui-layout` service with a 420–960 px details range, a 600 px opening width, a 560 px center floor, and `current-session` details eligibility.

Permissions remain owned by `@deepseek-ai/dsh-base`. When neither the user's stored permission default nor a deployment or profile override selects another preset, a fresh PaperAI session starts with `workspace-write` and `ask`: it can edit the selected Workspace, while operations requiring broader authority request approval. Full access remains available through the standard DSH permission selector, including its explicit risk acknowledgement, and through deliberate deployment configuration.

The fresh PaperAI roster contains three system presets: the existing full `standard` DSH Agent, Codex, and Claude. The launcher selects `standard` from the shared DSH preset root and adds the two PaperAI ACP compositions; it does not copy or fork the DSH composition. Other DSH profiles retain the complete shipped roster, and locally authored presets remain available from the normal user root.

Run the source profile with `pnpm paperai`. A profile-local `cordis.patch.yml` and the DSH home patch still apply above this bundle, so normal DSH configuration and plugin management remain available.

## Model Experience

### PaperAI profile composition

#### What the model sees

`@paperai/bundle-web` adds no prompt text, tool schema, or result itself. It mounts the PaperAI Agent, MCP, and document-service rows; each mounted package owns the context it contributes.

#### Token effect

Zero direct tokens. Mounted packages own any prompt, tool-schema, and tool-result tokens.

#### KV Cache effect

The bundle does not assemble model requests. Changing its patch composition can change the mounted prompt or tool set for later sessions; the affected package owns the resulting cache behavior.

## Known Limitations and Deferred Work

- PaperAI is currently an in-repository private product profile rather than a separately published npm bundle.
- Later PaperAI rows must remain additive and carry their own Loader/composition tests and invariants.
