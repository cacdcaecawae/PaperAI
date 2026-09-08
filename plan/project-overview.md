# Project Overview

Last updated: 2026-09-03

PaperAI is a local academic-document workbench built on the complete DeepSeek Harness and vendored Cordis platform. Users organize projects, import Word documents, write manually or with DSH, Codex, and Claude, inspect document versions, apply institutional formats, and export DOCX files.

The Working DOCX is authoritative. OfficeCLI provides the Word engine; previews and browser text buffers are derived views. Completed edits pass through Document Commits with provenance. PaperAI contributes Host and client plugins while reusing the harness's settings, permissions, Session runtime, and UI extension points.

The current terminology lives in [CONTEXT.md](../CONTEXT.md). Architecture and implementation obligations live in [AGENTS.md](../AGENTS.md) and [docs/architecture.md](../docs/architecture.md). The mutable objective is [goal.md](goal.md).
