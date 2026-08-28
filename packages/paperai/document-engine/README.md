# `@paperai/document-engine`

English | [中文](README.zh.md)

Service Definition for PaperAI's Word capability seam, exposed as `ctx.documentEngine`. It defines health, text-node inspection, structured Office-path inspection, generated HTML preview, batched semantic mutation, and validation without coupling consumers to OfficeCLI or process transport.

Providers must serialize operations that address the same canonical Working DOCX. `applyMutations` owns one exclusive lease through save; consumers create and publish recoverable snapshots around that call. HTML is explicitly preview-only.

## Model Experience

### Engine-backed document operations

#### What the model sees

`ctx.documentEngine` adds no prompt, tool schema, or result. PaperAI MCP and workbench consumers decide whether inspected text, validation evidence, or operation failures become model-visible.

#### Token effect

Zero direct tokens. A consumer that projects an engine result into a model request owns those tokens and any output bound.

#### KV Cache effect

The service makes no model request. A DOCX change affects cache reuse only after a consumer places changed engine output into a later request.

## Known Limitations and Deferred Work

- v1 defines a DOCX/Word-shaped seam; alternate ODF or LaTeX providers would require a separate capability contract.
- Complex layout evidence stays provider-owned structured data until the gate package stabilizes individual rule schemas.
