# PaperAI

English | [中文](README.zh.md)

PaperAI is a local, Agent-driven academic Word workbench. It keeps one Working DOCX as the editable authority, lets Codex, Claude, or the built-in DeepSeek Harness Agent work through the same versioned document tools, and validates formal exports against confirmed institutional templates.

The product is built on the pinned [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) client, Host, session, settings, model, permission, and plugin foundation. PaperAI adds the document, template, commit, MCP, ACP, and workbench product layer while preserving the upstream DSH interaction language.

## V1 workflow

- Select a local workspace; PaperAI initializes the project layout and Git repository idempotently.
- Import `.docx` directly or normalize legacy `.doc` through read-only Microsoft Word automation on Windows.
- Use the built-in `HIT 硕士毕设` pack or upload a custom Word template, review its parsed contract, and confirm it.
- Edit one semantic section at a time or let a local Codex/Claude ACP Agent use authenticated PaperAI MCP tools.
- Recover, compare, and restore every human or Agent document commit with actor, client, provider, and model provenance.
- Export drafts at any time; formal delivery runs the confirmed template gate first.

The source Word files and templates are preserved. OfficeCLI generates previews and applies structured mutations to derived Working copies only.

## Run from source

Requirements: Node.js, pnpm, Git, and the local ACP provider you intend to use. Microsoft Word Desktop is required only for legacy `.doc` normalization on Windows.

```sh
git clone https://github.com/cacdcaecawae/PaperAI.git
cd PaperAI
pnpm install
pnpm run build
pnpm paperai
```

Provider API keys and endpoints can be configured in the stock DSH settings surface. The UI reports unavailable local dependencies explicitly instead of presenting inert controls.

## Architecture and development

- Product decision: [PaperAI product profile ADR](.agents/notes/implemented/architecture/2026-08-28-paperai-product-profile.md)
- DSH architecture: [docs/architecture.md](docs/architecture.md)
- Contributor setup: [docs/development.md](docs/development.md)
- Agent instructions: [AGENTS.md](AGENTS.md)

## License and attribution

PaperAI code and the retained DeepSeek Harness foundation are distributed under [MIT](LICENSE). DeepSeek Harness attribution and all direct dependency licenses are retained in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Institutional template assets are not relicensed by PaperAI; see the template pack's [asset notice](packages/paperai/template-pack-hit/ASSET_NOTICE.md).
