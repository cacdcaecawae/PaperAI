# `@paperai/workbench-service`

English | [中文](README.zh.md)

Host Remote for the PaperAI workbench layered into the pinned DeepSeek Harness client. It lazily initializes the selected DSH Workspace as a PaperAI project, describes that project (its template set and its tracked documents), projects read-only OfficeCLI HTML with block-level node summaries, exposes one selected semantic-node buffer, and routes every save, template change, or restore through `ctx.paperCommits`.

`agentDiagnostics()` reads the optional ACP provider's cached observations; absent providers return an empty roster. `probeAgent()` requests explicit bounded initialization and fails when no provider is composed. `inspectProject()` reads an already registered project without creating context files or initializing it. `recoverWorking()` verifies that the plan's document belongs to that Workspace before delegating to the commit service and returning a fresh scan. Diagnostic transport types are re-exported through `/types` without importing Host implementations into the browser.

`overview()` describes one project: its name, whether its template set has been decided (`templateDecided`; choosing to write without a template is a decision too), the chosen set with its formats, and one row per tracked Word document carrying its document type and the name of its bound format. Only documents the domain tracks are listed; other files in the project directory are never projected. A chosen set that is no longer in the library reads as `null` while `templateDecided` stays true and `templatePackId` retains the chosen id. A `null` id denotes no choice or an explicit choice to write freely. After a durable `paperai` `documents` put references its existing head commit, the Host emits the JSON-safe `paperai/document-changed` event with `documentId`, `headCommitId`, and `updatedAt`.

`listTemplateLibrary()` lists every template set the user can choose from: built-in packs first, then custom sets — those holding at least one format in creation order, then the ones still empty. `createTemplateSet()`, `deleteTemplateSet()`, `addTemplateFormat()`, and `removeTemplateFormat()` maintain custom sets through `ctx.paperTemplates` and return the refreshed library; a custom set holds at most one format per document type, so adding a format for a type replaces the previous one. `setProjectTemplate()` records the project's choice through `ctx.paperProjects.setTemplateChoice()` — a `packId` naming an existing set, or `null` to write without a template — and returns the refreshed overview. Deleting a custom set makes projects that chose it report a missing template on their next overview, while formats already installed from it keep working.

The Working DOCX is authoritative. Preview HTML is output-only and is never accepted by a mutation method. Every edit carries both the observed document revision and head commit, and a successful edit immediately returns a recoverable version with human provenance.

`importDocument()` imports one browser-selected `.doc` or `.docx` as a free-writing document: no format is bound, and its document type stays `other` until the user or an Agent sets it. Document import and root-version creation form one workbench operation. If root submission rejects or is cancelled, the Host awaits non-cancellable document rollback before rejecting; the original upload or template source remains untouched. The root commit is the commit point: once it lands, the operation returns the created document and commit even if the preview cannot be rendered or the caller cancelled meanwhile — the projection is built without the caller's signal, a failed preview becomes an empty preview with the cause logged, and no retry can create a second document.

`createFromTemplate()` starts one document of a given document type from the project's template set through the same operation. It requires a decided set with a format for that type, installs the format's contract for the project (idempotent), confirms it — library formats ship reviewed requirements, so no separate review step gates the start — and binds it in the root commit beside the milestone. The format's usage decides the content source, never the caller: a form template is imported from its normalized asset and becomes the document itself, so a request carrying an upload is rejected; a formatting reference requires the manuscript upload it should govern and rejects without one. The name defaults to the format's display name.

`applyTemplate()` binds the project template's format for a document type through the commit path, adding a `set-document-type` mutation to the same commit when the type differs; binding the format that is already bound is rejected. `detachTemplate()` drops the bound format through an `unbind-template` commit, and the document keeps its type while writing freely from then on. `suggestDocumentType()` guesses a type from the document title, then from its opening paragraphs, and reports the basis (`title`, `content`, or `current` when nothing matched); it changes nothing by itself.

`diffVersion()` explains one version against its parent at paragraph level by reading both immutable snapshots through the document engine: adjacent removals and additions pair up as `changed` entries, a root version lists every paragraph as added, and `unchangedCount` reports the untouched paragraphs. `open()`, `readNode()`, `commit()`, `validate()`, and `restore()` keep the document projection itself; `restore()` creates a new version from an earlier one instead of moving the head backward.

`exportDocument()` returns a discriminated result. Draft publication and accepted delivery return `status: 'success'` with the output and milestone-backed workbench state. A delivery blocked by template errors returns `status: 'blocked'` with the unchanged revision and projected gate report; it creates neither an output nor an export milestone. Other export failures still reject. The service retains at most one gate slot per document. Each validation and export records its source revision and a unique claim. On an unchanged revision, only the latest claim may publish. An export that advances its source to a milestone revision may replace a later claim that still belongs to the source revision, but a gate operation begun from the milestone revision fences that export result. After commit, restore, or template association publishes a new revision, its mutation fence replaces only a claim still anchored to the old source; a gate claim begun from the published revision remains authoritative. A successful export also caches its report only while its milestone remains the head.

## Model Experience

### Browser workbench state

#### What the model sees

`ctx.paperaiWorkbench` serves browser projections and adds no prompt, tool schema, or result to an Agent request. Codex and Claude reach the same domain services separately through PaperAI MCP.

#### Token effect

Zero direct tokens. Project overviews, template library listings, preview HTML, and selected-node buffers remain browser state.

#### KV Cache effect

Workbench reads and writes do not assemble model requests, so they do not directly change provider cache reuse.

## Known Limitations and Deferred Work

- Browser editing is plain text, one block (semantic node) at a time; richer style mutations remain an OfficeCLI/domain extension.
- Only tracked documents are projected; other files in the project directory are neither listed nor edited by this Remote.
- The document-type guess is keyword-based over the title and opening text; it is a suggestion the user or an Agent confirms, not a classifier.
