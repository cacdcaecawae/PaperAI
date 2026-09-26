# `@paperai/template-pack-hit`

English | [中文](README.zh.md)

Built-in `HIT 硕士毕设` contribution for `ctx.paperTemplates`. The package contains a pinned manifest and the exact school files supplied for this product: proposal report, midterm report, and the engineering thesis writing example.

Each member retains the original `.doc`, a read-only DOCX normalization for OfficeCLI, byte size, SHA-256, original filename, source snapshot version, compatible `DocumentRole` values, and usage. The proposal and midterm members are `form-template`; the thesis example is `format-reference`, so association never copies its example research content.

The package MIT declaration covers the PaperAI code. The institutional Word files remain reference materials under their issuer's terms; see [`ASSET_NOTICE.md`](ASSET_NOTICE.md).

The plugin registers the pack through a Cordis effect and removes it when the plugin fiber disposes. Installation verifies every asset against `assets/manifest.json`; the directory from which the files were originally supplied is not a runtime dependency.

The `format-rules-v2` suffix identifies a compilation revision; all original and normalized asset bytes retain their 2026-08-28 snapshot hashes. Existing documents keep their confirmed contracts until the author reapplies the manuscript format. Reapplication installs the revised generic-section rules without changing the manuscript body.

The opt-in `tests/hit-delivery.real.spec.ts` compiles the shipped thesis example and exports independent research to the project's `exports/` directory through the project, repository, template, document, commit, and export services. Run it with `DSH_PAPERAI_OFFICECLI_REAL=1` and, for an external OfficeCLI 1.0.145 binary, `DSH_PAPERAI_OFFICECLI_COMMAND`.

## Model Experience

### HIT template metadata

#### What the model sees

Registering `HIT_TEMPLATE_PACK` adds no prompt or tool result. An Agent sees member names or compiled requirements only when a command, UI bridge, or MCP tool asks the template service to project them.

#### Token effect

Zero direct tokens during registration. The consumer that renders selected metadata or a compiled contract owns the data-dependent result tokens.

#### KV Cache effect

Pack registration does not alter model requests. A selected template affects cache reuse only after a consumer places its metadata or requirements into later context.

## Known Limitations and Deferred Work

- The package identifies its provenance as the user-provided 2026-08-28 snapshot because the source files carry no authoritative release identifier.
- The writing example is an engineering-format reference; other HIT disciplines need separate reviewed members before they can claim equivalent delivery coverage.
