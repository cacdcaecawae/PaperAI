# Agent Note: PaperAI document paths retain durable ownership

Status: implemented

English | [中文](2026-09-03-paperai-document-path-ownership.zh.md)

## Problem

The project guide placed Word documents in public project directories, while imports published them inside hidden application data. Filename allocation checked only files on disk. Removing those files left their document records intact, allowing a later import to assign the same paths to a second document.

## Decision

New imports publish immutable originals under `documents/source` and editable DOCX files under `documents/working`. Import staging and version snapshots remain under `.paperai`. Existing documents use their recorded paths; opening a project does not move its files.

Publication reserves the case-insensitive, Unicode-normalized names of every tracked document as well as existing files. Missing files do not release a durable document's name. Exclusive filesystem publication still arbitrates concurrent imports. A filename suffix allocates a new document independently of an older missing file.

## Alternatives considered

**Keep user documents inside hidden application data.** This contradicts the project guide and makes ordinary Word files difficult to find.

**Allocate from existing files alone.** A missing file is not evidence that its document record was deleted. Reusing its path makes two document identities read one file.

**Remove records when their files disappear.** Temporary unavailability would discard document identity and its history references without a user decision.

## Consequences

New projects expose their Word files at the documented paths. Existing records and paths remain valid, and missing documents retain their metadata for explicit recovery. Import regressions cover a missing source and working pair; the assembled new-project scenario chooses a template, creates one document, and checks its public working path.
