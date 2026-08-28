# @deepseek-ai/dsh-client-ui-layout

English | [中文](README.zh.md)

Shell plugin: three-column AppFrame (drag handles and concession chain) plus the `ctx.layout` panel-transition service; it registers into the runtime-owned `root` slot and declares `sidebar`, `conversation`, `details`, and `shell.overlay`. The sidebar resize boundary is an invisible hit strip, while the details boundary retains its floating pill. A closed sidebar retains a 56px control rail while details closes to zero width.

The optional `Config` fields `centerMin`, `detailsMin`, `detailsDefault`, and `detailsMax` are positive integer CSS-pixel values. Their defaults are `640`, `300`, `360`, and `520`; `detailsMin <= detailsDefault <= detailsMax` must hold or the plugin fails to load. Details shrinks toward `detailsMin` while preserving `centerMin`. Dragging details clamps to the configured range, and opening a closed details column uses `detailsDefault`.

`detailsVisibility` controls which current Session may retain an open details column. The default, `nonblank-session`, preserves the DSH behavior: hero, no-session, and blank-Session states render details at zero width without changing the stored preference. `current-session` also admits a blank current Session, allowing a product plugin to call `ctx.layout.openDetails()` before the first nonblank Agent turn; it does not create a Session or open the panel by itself. Selecting a different eligible Session still closes details before paint.

`detailsNarrowMode` controls the result when an open details column cannot coexist with `centerMin` and `detailsMin`. The default `close` renders details at zero and gives the remaining width to center. `focus` keeps the current sidebar, makes the mounted center column inactive at zero width, and gives the remaining frame to details. The normal sidebar breakpoint, toggle, and resize behavior stays active in focus mode. Both modes preserve stored width preferences and recover the three-column split automatically when it fits again.

AppFrame always mounts the conversation and details column positions. The transient layout store starts the sidebar at its default width and details closed, and it never reads or writes `localStorage`. The conversation owner share is empty, while the sidebar owner share contains only `collapsed` and `width`; registrants obtain business data from standard hooks and actions from their own inject faces.

The package also seats the theme presenter: it consumes resolved `ctx.theme` snapshots and projects them onto the document (`html { color-scheme }` for native UA chrome, `body[data-ds-dark-theme]` from the active color scheme, the theme's alias tokens as inline variables on body, and one owned `<meta name="theme-color">` whose content follows the computed body background). Measuring after palette and token application keeps the rendered background as the single color authority; disposing the presenter removes its metadata node with its other global writes.

The root and `/client` entries export the typed layout `Config`, `DetailsNarrowMode`, `DetailsVisibility`, and `LayoutGeometry` contracts. `/client` additionally exports the plugin body (`apply`/`inject`), `LayoutController`, and the four owner-share interfaces. AppFrame, the panel store, and the concession solver remain package-internal.

## Model Experience

None, as the layout shell manages browser viewing state; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Panel geometry is transient** — reload restores the sidebar default and details closed; switching between distinct eligible Session ids also closes details and forgets its dragged width, while ineligible states render details at zero width without modifying geometry.
- **Details eligibility does not open the panel or provide a Session** — `current-session` only permits a blank current Session to retain an already-open details preference.
- **Rendered geometry may differ from stored preferences** — concession, close mode, and focus mode are derived from the current frame; consumers must use the frame's owner props rather than treating stored widths as rendered widths.
- **No scroll anchoring during squeeze reflow** — layout changes may move the reader's viewport.
