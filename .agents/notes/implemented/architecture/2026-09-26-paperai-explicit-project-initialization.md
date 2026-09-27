# Agent Note: PaperAI project initialization requires an explicit action

Status: implemented

English | [中文](2026-09-26-paperai-explicit-project-initialization.zh.md)

## Problem

PaperAI shares DSH's Workspace registry. A Workspace record establishes a navigation target, not permission to write PaperAI directories, Git metadata, or Agent instructions into it. Initializing projects from browser subscriptions or read operations changes unrelated repositories and can recreate moved directories.

## Decision

The [workbench service](../../../../packages/paperai/workbench-service/README.md) owns initialization for browser actions. Choosing a project template, including no template, importing a document, or starting a document from a template may initialize an unregistered project. These operations first require the Workspace root to be an existing directory. The requirement holds inside the serialized initialization itself, not only in a preflight: the service calls `paperProjects.create` with `existingRoot: true`, which refuses a missing or non-directory root, and creating the project's subdirectories never recreates a root that disappears meanwhile. The workbench's own writes that follow in an existing project (upload staging, document import staging, exports) create their directories one level at a time below the root in the same way, so the must-exist rule stays part of each of those writing operations instead of a check made earlier in the request. The snapshot and candidate directories of the commit that follows are created by commit-service and are outside this guarantee. They reuse an existing project without running the layout and charter preparation again. That includes a project whose Workspace was deleted and whose directory was registered again: `paperProjects.create` finds it by its canonical root and adopts it, rewriting only the record's Workspace association, so `PAPERAI.md`, `AGENTS.md`, `CLAUDE.md`, and Git metadata stay untouched.

The shared API gateway also requires an existing directory for `session.create` requests naming a Workspace. The session initializer checks the root immediately before it creates or resumes the Agent, in place of the recursive directory creation that plain `cwd` requests keep, so automatic startup session selection cannot recreate a removed Workspace.

Overview and document-open reads never create projects. An unregistered Workspace has a read-only overview with its title, no template decision, and no documents. The existing start-page controls let the user choose a template or import. Opening a document and project diagnostics require an existing project. Reads find a project by its Workspace id or by its canonical root: when a Workspace is deleted and the same directory is registered again, the new registration gets a new id, and the project stays visible with its documents and template decision. Opening or editing one of its documents reports the new Workspace id. Only an explicit action rewrites the record's Workspace association. An edit resolves the association before its commit, so the projection returned after the durable write depends on no lookup that can fail. The browser requests overviews for mounted views and does not initialize the entire Workspace ledger.

## Alternatives considered

**Remove only the startup subscription.** Mounted views and direct Remote callers still reach overview, so UI timing cannot authorize filesystem mutation.

**Add a separate `paperProjects.adopt` method.** The workbench would be its only caller, and the project service already defines one create-or-adopt operation with no separate open-project action. `create` therefore adopts a recorded directory itself and runs the layout, charter, and Git work only for a directory without a project record. The adoption checks inside that serialized operation that the root is still a directory, so a root replaced by a regular file is never published.

**Separate the Workspace registry or add an initialization flag.** Neither is necessary to make reads safe. A shared registry remains useful for navigation, and the existing explicit document and template actions supply the required intent without another persisted state.

## Consequences

Selecting or viewing a directory alone does not install PaperAI instructions. A missing directory produces an error and remains absent. Existing projects and unrelated DSH Workspaces can coexist in one ledger. Already written project files are not removed automatically because they may contain user edits. A native DSH session that ran before the explicit action receives the installed writing charter at its next model request: `agent-instructions` compares the files of its visible baseline, including the root `AGENTS.md` and `CLAUDE.md`, at every entering step and appends the replacement as a logged session message, the same path that already carries charter rewrites after document changes.

Verification covers read-only Remote calls, explicit initialization, missing and non-directory roots, including a re-registered root replaced by a regular file, roots removed while initialization, session creation, or a later write is in flight, Workspace re-registration of a project directory for reads, explicit actions, and edits whose root lookup fails after the commit, project-root mismatches, and browser startup plus mounted views over unrelated Workspaces. The keyless browser snapshot records the usable template and import controls before and after an explicit template choice.
