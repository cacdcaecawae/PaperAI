# Goal

Last updated: 2026-08-28

Build PaperAI v1 as a polished local academic-document workbench on the complete pinned DeepSeek Harness foundation.

Success means a user can choose a project directory, import institutional DOC/DOCX files, work manually or through DSH/Codex/Claude, inspect every recoverable document change, enforce a confirmed Word template contract, and export a compliant DOCX from one DSH-native interface.

## Product invariants

- The full DSH Host, Harness/Loop, session, permissions, settings, credentials, models, and client plugin system are the platform.
- DSH, local Codex, and local Claude are peer top-level Agents; Codex and Claude use ACP.
- The Working DOCX is the only authoritative editable body; HTML is preview and Tiptap is a selected-section buffer.
- OfficeCLI is the v1 Word engine.
- Imported sources and templates stay immutable; all edits target derived working copies.
- Every completed human or Agent edit creates a recoverable Document Commit with provenance.
- Draft export remains available; delivery export runs the template gate.
- DSH UI plugins and semantic tokens are reused; PaperAI adds only product-specific slots and narrow extension seams.

## Delivery constraints

- Functional breadth and coherent product experience precede distribution/security hardening.
- Prefer pinned MIT, Apache-2.0, or BSD dependencies and existing DSH/Open Source capabilities.
- Verify services, Loader composition, browser workflows, constrained-width layout, and real Word fixtures.
- Preserve the legacy implementation through its archive branch/bundle while replacing `main`.
- Use Git and local `gh`; push the completed reset to `cacdcaecawae/PaperAI` with `--force-with-lease`.
