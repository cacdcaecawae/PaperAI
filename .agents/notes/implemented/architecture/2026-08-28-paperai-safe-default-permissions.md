# Agent Note: PaperAI inherits the DSH safe permission default

Status: implemented

English | [中文](2026-08-28-paperai-safe-default-permissions.zh.md)

## Problem

The PaperAI product bundle overrode the DSH permission rows so every fresh session started with `danger-full-access` and approval policy `never`. This granted unrestricted filesystem and command authority before the user made a permission choice. The existing DSH Full access selector requires an explicit risk acknowledgement, but an automatic product-bundle default never passes through that interaction.

The override also gave PaperAI a second owner for permission defaults. It could drift from the pinned DSH foundation and made a product-wide security decision without a dedicated architecture record.

## Decision

PaperAI does not override the `sandbox-policy` or `approval` rows. With no stored permission setting or deployment/profile override, the product profile inherits the values owned by `@deepseek-ai/dsh-base`: `workspace-write` sandboxing and approval policy `ask`. A stored `permissionPresets.defaultPreset`, `DSH_PERMISSION_MODE`, or a higher configuration layer remains an explicit override for future sessions.

Full access remains an available DSH permission preset. A user who selects it in the client completes the existing risk acknowledgement. A deployment operator may still set `DSH_PERMISSION_MODE` explicitly; this is an operator-owned configuration choice rather than a silent PaperAI product default.

This changes the default for newly created sessions. Restored sessions continue from their logged permission state, so reopening a session does not silently replace the authority under which its history was produced.

Codex and Claude ACP client file callbacks resolve through `ctx.fs`. Each final write is stamped with `ctx.sandboxPolicy.resolve({ session })`, so the current Session mode and Workspace root are enforced even if an ACP provider omits or mishandles a permission request. Every ACP process owns a non-reusable file-I/O generation combined with the request, current Agent activity, and handle-lifecycle signals. Cancelling a turn permanently revokes that generation; a following turn closes the old process and resumes the provider session in a fresh process before accepting callbacks, so a delayed old request cannot borrow new-turn authority. A generic ACP permission response does not widen a later file callback: the protocol provides no grant identifier on `fs/write_text_file`, so treating the latest approval as an unscoped filesystem capability would be unsafe.

## Verification

The PaperAI bundle test rejects product-owned `sandbox-policy` and `approval` rows. The built CLI config-dump test composes the real `paperai` profile and snapshots both effective rows as DSH-base contributions with `workspace-write` and `ask` defaults. A Web scaffold test boots the PaperAI overlay and proves that a real fresh Session logs the `workspace-write` preset, `workspace-write` sandbox mode, and `ask` approval policy. ACP integration tests use disjoint fallback and Session roots outside the platform temporary area: in-Workspace writes succeed, fallback-root and read-only writes fail at the final filesystem operation, and an already-dispatched write receives the revoked generation signal and cannot publish while the replacement turn resumes the ACP session in a fresh process.

## Alternatives considered

**Keep unrestricted access as the default and show an informational warning.** A warning is not a permission choice, and it would leave the product granting unrestricted authority before acknowledgement.

**Add a PaperAI-specific confirmation during project creation.** This would duplicate the DSH permission selector and split responsibility for the same session state across two UI paths.

**Default to read-only.** PaperAI must create and revise files inside the selected thesis Workspace. Read-only would turn ordinary document work into repeated escalation requests.

**Repeat the DSH safe values in the PaperAI patch.** Copying `workspace-write` and `ask` would produce the right current values but retain two owners and permit future drift. Removing the overrides preserves one source of truth.

## Consequences

Under the unoverridden base default, fresh PaperAI sessions can write within their Workspace and request approval when an operation needs more authority. Unrestricted filesystem changes and commands require an explicit user or deployment choice. ACP file callbacks remain confined until the Session preset itself changes; this avoids inventing a broad grant from an unrelated provider approval. PaperAI follows the same tested permission lifecycle as the DSH foundation and retains the standard Full access option for users who need it.
