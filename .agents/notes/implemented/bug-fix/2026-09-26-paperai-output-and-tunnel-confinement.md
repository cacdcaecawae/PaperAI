# Agent Note: PaperAI output and tunnel confinement

Status: implemented

English | [中文](2026-09-26-paperai-output-and-tunnel-confinement.zh.md)

## Problem

A project workspace contains immutable imports, Working DOCX files, templates, and historical snapshots. Allowing exports anywhere in that workspace permits a valid export request to replace another document's authoritative bytes. An SSH reverse tunnel to the shared Host web port also exposes routes whose loopback trust check cannot distinguish local callers from remote traffic.

## Decision

The export provider resolves the document's owning project and confines every caller to its `exports/` directory. The real parent must remain inside that directory before the milestone and before publication; the exports root itself cannot redirect elsewhere. This rule applies even to full-access sessions. The optional writable root remains an additional restriction.

SSH ACP runtimes own a dedicated loopback proxy. Only the descriptor's exact MCP URL path and bearer credential reach the local HTTP endpoint. The SSH tunnel forwards the proxy port; unrelated Host routes never reach the upstream server. Runtime teardown closes the proxy and its active connections. This implements the remote-session isolation promised by [ACP channels](../architecture/2026-09-08-paperai-acp-channels.md), whose session and provider decisions remain current.

## Alternatives considered

**Protect only enumerated document files.** That misses sibling documents, older snapshots, and future managed files. A dedicated output directory protects these without a growing deny list.

**Forward the shared web port and authenticate only MCP.** Requests to other routes bypass the MCP handler. The tunnel must terminate at an HTTP listener that admits only the intended endpoint.

## Consequences

Exports to arbitrary paths are refused; users can move a completed export afterward. Directory links within the export area remain usable when their real targets stay inside it. Each remote runtime owns one additional listener, and teardown awaits its closure. Provider and assembled application tests preserve sibling source, working, and snapshot bytes after rejected exports; HTTP tests verify route filtering, credential isolation, permitted MCP traffic, and listener disposal.
