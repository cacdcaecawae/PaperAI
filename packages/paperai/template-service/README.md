# `@paperai/template-service`

English | [中文](README.zh.md)

`ctx.paperTemplates` owns PaperAI template sets — built-in packs and the user's custom template library — together with immutable Word imports, OfficeCLI contract compilation, user confirmation, role-safe association, and delivery checks. It stores exact source bytes separately from the DOCX used for inspection, so neither built-in nor uploaded templates are mutated.

## Configuration

- `storageRoot` is the required absolute content-addressed asset root; the custom template library lives under it.
- `maxUploadBytes` bounds each source and normalized asset; the default is 128 MiB.
- `converterTimeoutMs`, `converterOutputMaxBytes`, and `converterTerminateGraceMs` bound legacy `.doc` conversion.
- `wordComPowerShellCommand` selects Windows PowerShell for Word COM conversion. Windows defaults to `powershell.exe`; an empty value makes custom `.doc` upload fail explicitly. Built-in packs carry normalized DOCX assets and do not require Word at runtime.

## Semantics

Pack plugins call `registerPack()` through a Cordis effect. `listPacks()` returns asset-free summaries tagged with their `kind`: built-in packs in display-name order, then the custom sets that hold at least one format, in creation order. `installPack()` resolves built-in packs and custom sets alike and verifies manifest sizes and SHA-256 values before copying exact source and normalized bytes into immutable content-addressed paths. The deterministic project/pack/member/version/source identity makes installation idempotent; a custom set keeps a fixed pack version, so adding one format never recompiles the others.

The template library holds the user's custom sets, one format per document type. `listLibraryPacks()` lists them including sets that hold no format yet; `createLibraryPack()` creates an empty set with a unique name; `addLibraryFormat()` stages an uploaded `.doc` or `.docx` under the library directory, retains it through the same content-addressed asset store, and records it as the set's format for one document type, replacing any previous format of that type; `removeLibraryFormat()` drops a type's format; `deleteLibraryPack()` removes a set while contracts already installed from it stay valid. A format's usage is `form-template` (a form that becomes the document itself) or `format-reference` (an example that governs an uploaded manuscript). The manifest at `<storageRoot>/library/library.json` is read once at construction and rewritten atomically after every change; a manifest that fails validation starts the library empty and is moved aside by the next write instead of being overwritten.

`upload()` accepts `.docx` and `.doc`. It copies the selected file before inspection; legacy `.doc` uses a read-only Word COM open and writes a separate DOCX. The compiler reads complete text nodes and one `/body` inspection to derive a draft `TemplateContract` with source evidence, fields, slots, fixed text, required sections, fonts, sizes, paragraph spacing, page settings, and supported quantitative rules. The contract becomes `confirmed` only through `confirm()`.

`validateAssociation()` rejects draft, cross-project, template-source, and incompatible `DocumentRole` bindings; its optional `role` names the document type the same commit switches to, so a type change and a binding travel together. The actual `bind-template` publication belongs to `paperCommits`, so every association receives a recoverable version and actor provenance. A `format-reference` binding never copies the reference body.

`check()` reads the current Working DOCX and evaluates confirmation, role, required fields, fixed text, sections, supported style/page rules, minimum characters, references, placeholders, tables, and Office validation. Draft export may retain a failing report; errors in `delivery-export` block formal delivery through `deliveryBlocked()`. A document with no attached template checks in templateless free mode: the report passes with no findings, so draft and formal delivery exports proceed without template checks.

The service publishes an evidence-only template source and compiled nodes before writing the contract record last. Template sources are excluded from normal Working-document lists. A failed compilation is therefore absent from template listings, and a deterministic retry can complete unpublished records.

## Model Experience

### Template contracts and gate reports

#### What the model sees

`ctx.paperTemplates` adds no prompt, tool schema, or result. Commands, MCP tools, and UI bridges decide which contract fields and gate findings are shown to an Agent.

#### Token effect

Zero direct tokens. The consumer that renders a contract or report owns its data-dependent token count and output bounds.

#### KV Cache effect

Template parsing and checks do not send model requests. A contract or finding affects cache reuse only after a consumer projects it into later context.

## Known Limitations and Deferred Work

- Legacy `.doc` upload — as a project template or as a library format — requires Microsoft Word on Windows; deployments without it accept `.docx` and pre-normalized built-in packs.
- The first delivery checker compares semantic text and OfficeCLI format properties but does not perform page-image visual regression.
- Template draft editing is stored by the repository owner; this package currently exposes compilation, review reads, and the confirmation transition rather than a field-level draft patch API.
- The custom template library is per installation under `storageRoot`; it is not shared between machines, and deleting a set leaves its retained asset files in the content-addressed store.
