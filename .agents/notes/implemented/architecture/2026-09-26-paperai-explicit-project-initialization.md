# Agent Note: PaperAI project initialization requires an explicit action

Status: implemented

English | [中文](2026-09-26-paperai-explicit-project-initialization.zh.md)

## Problem

PaperAI shares DSH's Workspace registry. A Workspace record establishes a navigation target, not permission to write PaperAI directories, Git metadata, or Agent instructions into it. Initializing projects from browser subscriptions or read operations changes unrelated repositories and can recreate moved directories.

## Decision

The [workbench service](../../../../packages/paperai/workbench-service/README.md) owns initialization for browser actions. Choosing a project template, including no template, importing a document, or starting a document from a template may initialize an unregistered project. These operations first require the Workspace root to be an existing directory. The requirement holds inside the serialized initialization itself, not only in a preflight: the service calls `paperProjects.create` with `existingRoot: true`, which refuses a missing or non-directory root, and creating the project's subdirectories never recreates a root that disappears meanwhile. They reuse an existing project without running the layout and charter preparation again.

The shared API gateway also requires an existing directory for `session.create` requests naming a Workspace. The session initializer checks the root immediately before it creates or resumes the Agent, in place of the recursive directory creation that plain `cwd` requests keep, so automatic startup session selection cannot recreate a removed Workspace.

Overview and document-open reads never create projects. An unregistered Workspace has a read-only overview with its title, no template decision, and no documents. The existing start-page controls let the user choose a template or import. Opening a document and project diagnostics require an existing project. Reads find a project by its Workspace id or by its canonical root: when a Workspace is deleted and the same directory is registered again, the new registration gets a new id, and the project stays visible with its documents and template decision. Opening or editing one of its documents reports the new Workspace id. Only an initializing action rewrites the record's Workspace association. The browser requests overviews for mounted views and does not initialize the entire Workspace ledger.

## Alternatives considered

**Remove only the startup subscription.** Mounted views and direct Remote callers still reach overview, so UI timing cannot authorize filesystem mutation.

**Separate the Workspace registry or add an initialization flag.** Neither is necessary to make reads safe. A shared registry remains useful for navigation, and the existing explicit document and template actions supply the required intent without another persisted state.

## Consequences

Selecting or viewing a directory alone does not install PaperAI instructions. A missing directory produces an error and remains absent. Existing projects and unrelated DSH Workspaces can coexist in one ledger. Already written project files are not removed automatically because they may contain user edits.

Verification covers read-only Remote calls, explicit initialization, missing and non-directory roots, roots removed while initialization or session creation is in flight, Workspace re-registration of a project directory, project-root mismatches, and browser startup plus mounted views over unrelated Workspaces. The keyless browser snapshot records the usable template and import controls before and after an explicit template choice.
