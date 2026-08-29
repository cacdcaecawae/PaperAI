# Agent Note: Workspace list-to-detail navigation

Status: implemented

English | [中文](2026-08-30-workspace-detail-navigation.zh.md)

## Problem

Expanding a Workspace inline placed project resources between a Workspace row and its Session rows. Project actions, resource categories, and peer Workspaces shared one tree level, so adding PaperAI documents, templates, experiments, and future project resources made the sidebar hierarchy ambiguous.

## Decision

The grouped sidebar is a Workspace list. Activating a real Workspace row by pointer, Enter, or Space opens a second-level detail view in the same sidebar region. Its header pairs a compact back action with the Workspace title and canonical-path subtitle. The back action restores focus to the originating Workspace row. Additive `sidebar.workspaces.content` entries own their project section headings; `ui-workspace` supplies the matching Session heading and local New Session action in the same scroll region. An unoccupied content slot renders no empty project section.

`ui-workspace` owns navigation, Session presentation, focus behavior, and the additive detail slot. Resource plugins such as `ui-paperai-workbench` continue to own only their resource sections and actions. Ungrouped remains a disclosure row because it has no Workspace identity or project resources. Search and the flat Session presentation remain global alternatives and do not embed the detail.

The detail uses the existing sidebar row density, semantic theme aliases, shared icons, focus outline, and short hover transitions. Empty resource and Session sections name the action that creates their first item. Its navigation state is local viewing state: returning to the list or switching to the flat presentation exits the detail without changing the selected Session.

Component coverage pins pointer and keyboard entry, return navigation and focus restoration, slot owner facts, empty states, Session actions, ordering, and focus semantics. A keyless browser snapshot boots the PaperAI web composition and pins the assembled Workspace detail with real projected document resources.

## Alternatives considered

**Keep inline expansion.** This preserves the original tree mechanics but continues to mix project resources with peer Workspace and Session rows; every added resource category increases that ambiguity.

**Let PaperAI render an overlay from its content entry.** A slot occupant cannot own the browser header, sibling Session rows, or return navigation without bypassing slot ownership and coupling a generic Workspace interaction to one product plugin.

**Introduce a separate page router.** The interaction is confined to one sidebar region and does not need browser-history semantics. A local second-level view preserves the shell and Session selection with less global state.

## Consequences

Workspace rows become navigation targets rather than disclosure controls, while Ungrouped keeps disclosure semantics. Resource plugins gain a stable project-level composition area and the Workspace list remains compact as categories grow. Users perform one extra back action to switch between peer Workspaces, and global search intentionally replaces the detail while a query is active.
