# Agent Note: PaperAI writing workflow and structural drafts

Status: implemented

English | [中文](2026-09-12-paperai-writing-workflow.zh.md)

## Problem

The page editor prevented ordinary Enter, exposed formatting only after selecting text, and could not preserve paragraph structure through the commit service. An empty conversation occupied document space. Project template prompts appeared automatically, layout choices disappeared on reload, and modal focus could escape behind the dialog. A refreshed draft was checked against text alone, allowing an outside formatting change to be overwritten. These failures interrupted the same writing workflow across projects, documents, settings, and Agent collaboration.

## Decision

Working DOCX remains the source of truth. Browser drafts attach to original indexed nodes and may carry replacement paragraphs, character runs, and paragraph layout. The commit service validates them against the base revision, compiles them into existing mutations, and publishes through its candidate-and-version transaction. OfficeCLI resolves addresses before a structural batch and applies original nodes in reverse document order, keeping later splits from retargeting earlier edits. New paragraphs inherit character defaults as well as paragraph layout. The commit path reindexes the resulting DOCX. Raw document XML is checked before paragraph reconstruction: projected run children omit manual page/column breaks, symbols, soft hyphens, and fields. Unsupported inline content rejects the write; unaffected document content remains in the candidate file.

The persistent toolbar operates on a retained caret or selection and supports local draft history. Character readings distinguish mixed, inherited, and explicit formatting. Enter, soft breaks, plain-text paste, and composition input use the same draft path. A newer document revision conflicts existing drafts even when their text still matches, protecting outside formatting changes. History restoration is a separately confirmed new version. In-memory drafts are explicitly described as lost on reload.

Documents default to writing mode; collaboration is an explicit preference, also entered by submitting a Word reference to the composer. The existing layout service persists preferred widths and sidebar collapse, while transient panel visibility stays unpersisted. A Session-scoped workbench store persists writing and zoom preferences. Auxiliary panels open one at a time and restore focus; narrow panels stack beside the reading flow. Templates open on request, destructive template actions explain their impact, exports wait for saved drafts, and the status bar separates saving from other failed operations. Version comparison counts recorded format-only operations without claiming a detailed format diff.

DSH owns navigation, conversation, approval, tool rendering, and shared UI. Modal focus uses the already-installed `focus-trap` dependency, including portaled menus; nested Escape closes only the active surface. ACP driver changes clear obsolete model choices, errors retain a retry path, and failed settings saves retain their input. Both model-option entry points refresh the shared model directory. Model choices continue to come from the connected driver, and permission defaults are unchanged. MCP server construction validates its three numeric limits explicitly: a resolved configuration also contains route and server-name strings, which must not fail authenticated initialization.

Initial session titles use the first non-empty visible line of the first prompt. Expanded references remain in the logged message and model input. An ACP title that repeats a complete multi-line prompt after normalization retains the existing title, keeping reference metadata out of the conversation heading. A single-line prompt remains eligible as a native title, and user-pinned titles retain precedence.

This partially supersedes the [UI overhaul](2026-09-03-paperai-ui-overhaul.md) and [minimal workbench](2026-09-09-paperai-minimal-workbench-and-outside-edits.md) decisions for template prompting, editor commands, focus defaults, and panel behavior, and the [character-formatting](2026-09-10-paperai-character-formatting.md) decision for toolbar placement and supported run properties. Their plugin ownership, template model, resident-engine lifecycle, version publication, and run-inheritance decisions remain active. The [session-title decision](2026-07-21-log-backed-session-titles.md) retains its ownership and timing rules; the fallback now selects one visible line before applying its word and byte limits.

## Alternatives considered

**A separate rich-editor document store.** It would require independent addressing and DOCX serialization. Original-node drafts extend the existing transaction without making browser HTML authoritative.

**Persist all layout state.** Restoring a temporary comparison panel or focus claim can hide a newly selected conversation. Only user preferences are persisted; document content and transient surfaces follow their existing lifetimes.

**Treat equal text as an unchanged draft base.** Text equality cannot detect changed fonts, layout, or embedded objects. Revision checks deliberately require resolving drafts after any newer head.

**Native dialog alone.** Existing DSH menus portal to the document body; a modal top layer makes those controls inactive. One shared focus trap supports those consumers without per-page dialog implementations.

## Testing

Component and controller tests exercise panel persistence, keyboard resizing, modal focus, portaled menus, driver changes, retries, structural input, composition, draft undo/redo, formatting, conflict retention, and version actions. Host tests exercise validation, stable structural addresses, run/layout commands, protected objects, and format-operation counts. A real OfficeCLI round trip splits a synthetic document while modifying another paragraph, reads back font and paragraph settings, and checks untouched table, equation, drawing, header, footer, and image content. Further round trips verify that unsupported breaks, fields, symbols, subscript, superscript, strike, and hidden text reject reconstruction without changing the DOCX bytes. An SDK HTTP client initializes the real MCP service, lists tools, and calls a project tool. The assembled PaperAI browser scenarios cover navigation, permissions, editing, checking, versions, export, and viewport/theme/locale layouts.

## Consequences

One browser editing host allows native selections across paragraphs. Original indexed blocks still own drafts, and unindexed content and cross-block text mutations remain protected.

Browser formatting covers the represented character values. Script-specific font or size differences, themed colors, and unsupported underline variants reject paragraph reconstruction because flattening them would discard formatting. Soft breaks use the paragraph setter for the first run and newline-aware insertion for subsequent runs; run formatting is applied separately. Editor commands collect every changed block before publishing synchronous store updates, so a subscriber cannot repaint an uncollected block. Quoting a selection or preparing a format fix appends to the existing composer draft and preserves attachments.

The PaperAI CI recipe includes shared primitives, session titles, and the connection fixture because their behavior participates in the assembled writing workflow.

Ordinary body paragraphs can be split and formatted without changing the document authority. Unsupported rich paragraphs and structural table editing remain protected; the browser cannot author every Word run property. Drafts and their undo history are temporary, detailed format diffs are unavailable, and preview pagination is not final Word pagination. The [workbench README](../../../../packages/client/ui-paperai-workbench/README.md) owns the current command and lifetime details.
