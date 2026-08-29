# `@paperai/workbench-service`

English | [中文](README.zh.md)

Host Remote for the PaperAI workbench layered into the pinned DeepSeek Harness client. It lazily initializes the selected DSH Workspace as a PaperAI project, projects resource rows and read-only OfficeCLI HTML, exposes one selected semantic-node buffer, and routes every save or restore through `ctx.paperCommits`.

The resource list keeps Working documents and template contracts as domain-owned rows. It recursively projects only real, non-empty trees under `figures/`, `experiments/`, and `code/`, does not follow symbolic links, and never derives Working-document or template rows from raw files. After a durable `paperai` `documents` put references its existing head commit, the Host emits the JSON-safe `paperai/document-changed` event with `documentId`, `headCommitId`, and `updatedAt`.

The Working DOCX is authoritative. Preview HTML is output-only and is never accepted by a mutation method. Every edit carries both the observed document revision and head commit, and a successful edit immediately returns a recoverable version with human provenance.

Document import and root-version creation form one workbench operation. If root submission rejects or is cancelled, the Host awaits non-cancellable document rollback before rejecting; the original upload or template source remains untouched. Once root submission succeeds, a later preview/open failure does not remove the committed document.

`exportDocument()` returns a discriminated result. Draft publication and accepted delivery return `status: 'success'` with the output and milestone-backed workbench state. A delivery blocked by template errors returns `status: 'blocked'` with the unchanged revision and projected gate report; it creates neither an output nor an export milestone. Other export failures still reject. The service retains at most one gate slot per document. Each validation and export records its source revision and a unique claim. On an unchanged revision, only the latest claim may publish. An export that advances its source to a milestone revision may replace a later claim that still belongs to the source revision, but a gate operation begun from the milestone revision fences that export result. After commit, restore, or template association publishes a new revision, its mutation fence replaces only a claim still anchored to the old source; a gate claim begun from the published revision remains authoritative. A successful export also caches its report only while its milestone remains the head.

## Model Experience

### Browser workbench state

#### What the model sees

`ctx.paperaiWorkbench` serves browser projections and adds no prompt, tool schema, or result to an Agent request. Codex and Claude reach the same domain services separately through PaperAI MCP.

#### Token effect

Zero direct tokens. Resource rows, preview HTML, and selected-node buffers remain browser state.

#### KV Cache effect

Workbench reads and writes do not assemble model requests, so they do not directly change provider cache reuse.

## Known Limitations and Deferred Work

- v1 browser editing is plain text for one semantic node; richer style mutations remain an OfficeCLI/domain extension.
- Filesystem resources other than Working documents are projected as navigation context and are not edited by this Remote.
