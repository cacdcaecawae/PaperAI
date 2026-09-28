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

Legacy conversion binds only its Word instance to a Windows job before opening the source. Once the job is assigned, timeout or cancellation also releases Word and its file locks; Word startup and blank-document creation precede the assignment, so a hang or termination in that phase can leave the new Word instance running. Documents requiring an open password fail without an interactive prompt; document-close failures still attempt Word shutdown.

`validateAssociation()` rejects draft, cross-project, template-source, and incompatible `DocumentRole` bindings; its optional `role` names the document type the same commit switches to, so a type change and a binding travel together. The actual `bind-template` publication belongs to `paperCommits`, so every association receives a recoverable version and actor provenance. A `format-reference` binding never copies the reference body.

`check()` reads the current Working DOCX and evaluates confirmation, role, required fields, fixed text, sections, supported style/page rules, minimum characters, references, placeholders, tables, and Office validation. Draft export may retain a failing report; errors in `delivery-export` block formal delivery through `deliveryBlocked()`. A document with no attached template checks in templateless free mode: the report passes with no findings, so draft and formal delivery exports proceed without template checks.

The service publishes an evidence-only template source and compiled nodes before writing the contract record last. Template sources are excluded from normal Working-document lists. A failed compilation is therefore absent from template listings, and a deterministic retry can complete unpublished records.

A formatting reference contributes required sections from its pack member's `requiredSections`: each declared heading must occur in the sample, compared by title as below, or compilation fails. Registering a pack refuses `requiredSections` on a member of any other usage, since nothing would compile them, and refuses an empty list, which would switch the section check off, and a title that names no section once its number and notes are removed or names the same section as another. A reference without that declaration, including a custom upload, requires every unnumbered heading of the sample, such as a standalone 致谢, an originality declaration, or `ABSTRACT`. A heading is a paragraph in a Word heading style (`heading 1` or its localized `标题 1`, through level 9) or, set in body text, a numbered title (a section number as listed below followed by at most 40 characters without sentence punctuation, so a numbered sentence stays body text) or a common section title: 摘要, Abstract, 目录, 结论, 参考文献, 致谢, Acknowledgements, or an originality declaration; OfficeCLI reports no outline level, so any other title set in body text is not recognized; numbered chapter and section headings (第1章, 第一章, 第一节, 1.1, `一、`, `1、`, `1)`, ①, Chapter 1), figure and table captions, parenthesized annotations, and headings that describe their own format (条标题 4号字，建议段前0.5行), told by an annotation opening or a size or spacing measurement rather than by words such as 字体 or 页眉, stay example content. No API edits or disables a compiled rule, so an unwanted required section is removed by uploading a sample without that heading. TOC entries, citations, and annotated cover text do not become required content or fixed-text rules. In a check, a formatting reference's required section is met only by a heading of the document with that whole title, apart from its section number (第5章, 第一节, Chapter 1, ①, 1、, 1), 一、, or 1.1), a trailing parenthesized note, whitespace, and case, not by a TOC entry, a sentence that names it, or a longer title such as 参考文献综述; a form template's outline items are plain paragraphs once filled in, so they may appear anywhere in its text. Supported explicit formatting and quantitative instructions still compile; form templates retain their fields, fixed text, outline, and table requirements.

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
