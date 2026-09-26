# Agent Note: PaperAI project initialization requires an explicit action

Status: implemented

English | [中文](2026-09-26-paperai-explicit-project-initialization.zh.md)

## Problem

PaperAI shares DSH's Workspace registry. A Workspace record establishes a navigation target, not permission to write PaperAI directories, Git metadata, or Agent instructions into it. Initializing projects from browser subscriptions or read operations changes unrelated repositories and can recreate moved directories.

## Decision

The [workbench service](../../../../packages/paperai/workbench-service/README.md) owns initialization for browser actions. Choosing a project template, including no template, importing a document, or starting a document from a template may initialize an unregistered project. These operations first require the Workspace root to be an existing directory. They reuse an existing project without running the layout and charter preparation again.

The shared API gateway also requires an existing directory for `session.create` requests naming a Workspace. Automatic startup session selection cannot recreate a removed Workspace through the session initializer.

Overview and document-open reads never create projects. An unregistered Workspace has a read-only overview with its title, no template decision, and no documents. The existing start-page controls let the user choose a template or import. Opening a document and project diagnostics require an existing project. The browser requests overviews for mounted views and does not initialize the entire Workspace ledger.

## Alternatives considered

**Remove only the startup subscription.** Mounted views and direct Remote callers still reach overview, so UI timing cannot authorize filesystem mutation.

**Separate the Workspace registry or add an initialization flag.** Neither is necessary to make reads safe. A shared registry remains useful for navigation, and the existing explicit document and template actions supply the required intent without another persisted state.

## Consequences

Selecting or viewing a directory alone does not install PaperAI instructions. A missing directory produces an error and remains absent. Existing projects and unrelated DSH Workspaces can coexist in one ledger. Already written project files are not removed automatically because they may contain user edits.

Verification covers read-only Remote calls, explicit initialization, missing and non-directory roots, project-root mismatches, and browser startup plus mounted views over unrelated Workspaces. The keyless browser snapshot records the usable template and import controls before and after an explicit template choice.
