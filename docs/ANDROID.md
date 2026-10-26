# Android continuation note

Version 0.1.0 is desktop only (`isDesktopOnly: true`). This is what remains for Android.

## Already portable

- **No Node.js or Electron at runtime.** `main.js` requires only `obsidian`. The SHA-256 fingerprints come from `@noble/hashes`, which is pure JavaScript.
- **Pure core.** `src/core` (parsers, link writing, suggestions, repair planning, recovery, index) has no Obsidian or platform imports and is covered by unit tests.
- **Public APIs only.** Vault, MetadataCache, Workspace, `Vault.process`, `getResourcePath` and `getFirstLinkpathDest` all exist on mobile.
- **Narrow layout.** Below 600 px the panel already switches to one column: list, then details with a Back button. That's the phone layout.
- **Chunked scanning.** The time budget per batch (12 ms) also suits slower phones. The large-vault test shows no batch blocking for long.

## Remaining interface work

1. **Opening the panel.** On phones, open it in the main area or the right drawer, and check the toolbar wraps without hiding Rescan or Undo.
2. **Touch targets.** Make list rows, chips, candidates and the icon buttons at least 44 px tall on mobile (`body.is-mobile` / `Platform.isMobile`). Rows are 44 px now; chips and inline icon buttons are smaller.
3. **Hover-only affordances.** There are none, but tooltips (Undo, the "No references detected" warning) need a visible alternative on touch, for example a short text under the toolbar.
4. **Keyboard assumptions.** Ctrl/Cmd+F and arrow-key navigation don't exist without a keyboard. Make search reachable by tap (it already is) and check that every action is a visible button.
5. **Review dialog.** Obsidian shows modals full screen on phones. Check that the diff scrolls sideways instead of wrapping illegibly, and that Apply stays reachable above the on-screen keyboard after ticking the uncertain-reference box.
6. **Previews.** `getResourcePath` works on mobile; confirm that large images don't stall the details pane, and consider a size limit for previews.
7. **Open in Obsidian / Open source.** `openFile` and `eState.line` behave differently on mobile; check jumping to the line in notes.
8. **Copy buttons.** `navigator.clipboard` may be refused in the mobile web view; the code already falls back to a notice.

## Remaining behavior checks on a device

- **Editor guard.** Confirm the "unsaved edits" check (editor text compared with the file on disk) behaves the same with the mobile editor's save timing.
- **Open boards.** Confirm `FileView` detection works with Canvas and Bases views on mobile.
- **Sync.** Plugin data (`data.json`) holds the undo point. With Obsidian Sync or another sync tool, an undo point from another device can arrive. `onExternalSettingsChange` reloads it, and undo still checks the file's fingerprint, so a stale record is refused rather than applied. Test this across two devices.
- **Performance.** Time a full scan of a large vault on a mid-range phone, and check that scrolling the list stays smooth.
- **Startup indexing.** Mobile indexes more slowly after launch. The scan waits up to 20 s for Obsidian's index, and notes that aren't indexed yet are reported under Coverage details. Check how often that happens on a phone.

## Testing approach

Run the dev harness's checks on a device. Phones have no `require("electron")`, so the harness's screenshot code needs a mobile path, or screenshots are taken by hand. Then set `isDesktopOnly` to `false`, bump the minor version and update `versions.json`.
