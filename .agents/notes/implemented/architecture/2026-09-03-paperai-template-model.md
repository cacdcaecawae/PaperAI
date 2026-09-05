# Agent Note: Template sets per institution with one format per document type

Status: implemented

English | [中文](2026-09-03-paperai-template-model.zh.md)

## Problem

PaperAI ships an institution's Word templates (the HIT master's set holds a proposal form, a midterm-report form, and a thesis formatting sample) and lets users add their own. The first client treated each template file as a peer catalog entry and asked the user to pick one per document, in the sidebar under the project and again in a Templates tab, so templates appeared as a level of the project hierarchy rather than as configuration, and every document start repeated a choice the institution had already made. Every import asked for a document role whether or not a template would ever apply. The user's verdict was that the arrangement was unreadable: a template belongs in settings, a project picks one, and the document's kind should do the rest.

## Decision

A 模板 (template) is one institution's whole set of thesis formats, holding at most one 格式 (format) per 文档类型 (document type): proposal, midterm, manuscript, final, or other. Sets live in the global 模板库 (template library) in settings, the built-in HIT set beside the custom sets the user creates, and belong to no project. The [glossary](../../../../CONTEXT.md) defines the terms; the [UI overhaul note](../feature/2026-09-03-paperai-ui-overhaul.md) records the surfaces built on this model.

A project chooses one set or none, and the choice is a recorded decision: `ProjectRecord.templatePackId` names the set and `templateDecidedAt` marks when the user answered, including the answer "none", so the start page asks an undecided project once per visit and never asks a decided one. Choosing or switching the set later changes nothing in existing documents.

The document type decides the format. A document created from the project's set carries the type the user started (新建开题报告 starts a proposal) and its root version binds that type's format. A free import asks no type: the document is type `other` with no format. The type is asked only when a format is applied: the Host guesses it from the title and then the opening paragraphs, the user confirms or picks another, and the binding lands as one version carrying `set-document-type` (when the type changes) and `bind-template`. The user rebinds by choosing another type or detaches the format (`unbind-template`), and an Agent does the same through the `set-document-type` mutation of `paperai_commit_document`; a type change drops a bound format unless the same commit binds another, and setting the type a document already has is rejected.

A custom set is built by adding one Word file per document type with its usage: a form template is the document itself, and a formatting reference governs a manuscript the user uploads. Custom sets persist at `<storageRoot>/library/library.json` with their files in the template asset store; the built-in set comes from the shipped pack manifest. A custom set can be deleted while projects reference it: those projects show a missing template until they choose again, and documents keep their bound formats.

## Alternatives considered

**Templates as a level of the sidebar hierarchy.** Rejected: a template is configuration, not content of one project, and listing it beside documents and Sessions is what made the sidebar unreadable.

**Picking a template file per document from a flat catalog.** Rejected: the institution's set already pairs each file with a document type, so a per-document choice repeats a decision the set encodes; the project-level choice makes the pick automatic and keeps one institution per project.

**Asking the document type at import.** Rejected: free writing must not be interrogated, and the type matters only when a format applies; asking at apply time, with a Host guess to confirm, keeps import one gesture.

**Choosing the template when the project is created.** Rejected: creating a project is choosing a folder, and some projects never use a template; the once-per-visit dialog asks when the answer matters, and "none" is a valid, recorded answer.

**Binding by document only, with no project-level choice.** Rejected: every new document would ask again which institution's format to use, and the start page could not offer typed start actions.

## Consequences

Template choice is project state and format binding is document state, so the two evolve separately: switching a project's set does not rewrite documents, and a document keeps its format when the project drops the set. "None" is a first-class decision, so the domain distinguishes an undecided project from a templateless one. A set holds one format per type, so an institution with two proposal variants needs two sets. Every type change is a version, so the ledger shows who retyped a document and when. A guessed type is only a suggestion; the binding always waits for a human or an Agent to commit it.
