# `@paperai/domain`

English | [中文](README.zh.md)

Transport-neutral PaperAI vocabulary for projects, authoritative Working DOCX files, semantic nodes and mutations, template contracts, delivery gates, recoverable document commits, provenance, conflicts, and selected-section buffers.

Ids that cross package boundaries are compile-time branded and become ordinary strings on disk and wire. This package owns no persistence, OfficeCLI process, Cordis service, UI, transport, or Agent behavior; those packages depend on this vocabulary instead of redefining shapes.

`deliveryBlocked(report)` is the one transport-neutral interpretation used by export consumers: only an active hard error in `delivery-export` mode blocks formal delivery. Draft and continuous checks remain reportable without becoming an implicit save boundary.

## Model Experience

### Domain records

#### What the model sees

Types such as `DocumentCommit`, `TemplateContract`, and `GateReport` are not serialized into model context by this package. MCP or Agent consumers own every selected field and rendered result.

#### Token effect

Zero direct tokens. The consumer that projects a domain record owns the resulting schema, message, or tool-result tokens.

#### KV Cache effect

The package contributes no request content. A record change can affect cache reuse only after a consumer projects the changed value into a later request.

## Known Limitations and Deferred Work

- The first vocabulary targets Word/DOCX academic workflows; spreadsheet, presentation, LaTeX, and collaborative-editing records are absent.
- Visual pagination evidence remains an open-ended `actual`/`expected` payload until the OfficeCLI gate Provider owns a stable schema.
