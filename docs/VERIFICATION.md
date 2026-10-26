# Verification report: Attachment Lens 0.1.0 (desktop)

Date: 26–27 October 2026. Machine: Windows 11 Pro. Obsidian 1.14.5 (installer build), Node 24.18.

## Summary

| Area | Result |
| --- | --- |
| Type check (`tsc`, strict, `noUncheckedIndexedAccess`) | Passed |
| Lint (ESLint 9 with `eslint-plugin-obsidianmd` recommended rules) | Passed, 0 problems |
| Unit and integration tests (Vitest) | Passed, 92 of 92 |
| Production build | Passed. `main.js` 216 KB; it requires only `obsidian` |
| Native checks in Obsidian 1.14.5 (harness) | Passed, 14 of 14 checks with 107 assertions |
| Real-keyboard pass in Obsidian (computer use) | Passed after fixes, see below |
| Light and dark themes | Passed: 28 screenshots of all designed states reviewed |
| Package for manual installation | Passed: `dist/attachment-lens-0.1.0/` and a zip that opens correctly |

No check is failing at the end of this round. The issues found along the way, and their fixes, are listed below.

## Automated tests (92)

- **Link syntax:** wikilinks, embeds, sizes (`|300`, `|300x200`), aliases, subpaths (`#page=3`, headings, blocks), escaped table pipes, Markdown links with `%20`, angle brackets, titles, nested parentheses, Unicode percent-encoding, reference definitions. Writers round-trip every path they produce.
- **Scanner:** code blocks, code spans and escapes skipped; links in `%%` comments counted (matching Obsidian); images nested in links; frontmatter skipped; reference definitions with use counts; definitions inside paragraphs rejected; Windows line endings.
- **YAML:** exact spans for quoted, single-quoted and plain values, list and flow-list items, comments and odd spacing; anchors, aliases, duplicate keys and multi-line values refused; escape mapping.
- **Canvas:** file cards, subpaths, group backgrounds, links inside text cards with JSON escapes (`\"`, `\n`, `\u00e9`) mapped to exact characters; invalid JSON reported with line and column.
- **Bases:** static `link()`/`file()`/`image()`/`hasLink()` literals in filters, formulas and view filters; dynamic expressions reported, not evaluated; wikilink strings as uncertain; embedded `base` blocks; fences nested in other fences ignored; invalid YAML.
- **Repairs:** for every source type, the result equals the original with exactly one substring replaced (Markdown, CRLF files, YAML with comments, JSON, single-quoted YAML around an expression). Refusals for paths a form can't hold. Stale text detection.
- **Link text:** short name kept unless it would open another file (then full path, with the reason), relative stays relative, Canvas and `file()`/`image()` get vault paths.
- **Suggestions:** deterministic ranking and reasons; ties by path; unrelated files left out.
- **Recovery:** unapplied, applied, conflict and missing classification; undo only over an unchanged repaired file; record validation; SHA-256 against a known vector.
- **Scanning with an in-memory vault:** full scan of the fixture vault (counts, missing files, unreferenced files, coverage issues), exclusions, waiting for unindexed notes, cancellation, failure, incremental create/rename/delete/modify, folder renames, changes queued during a scan.
- **Guarded repair service:** preview, apply, read back, undo; full-path fallback with reason; stale source (before and during the write) keeps the previous undo point; deleted replacement; failed write leaves the file and undo point alone; uncertain confirmation; open board and unsaved editor blocked; undo conflict; restart classification without writes.
- **Synthetic large vault:** 30,000 attachments and 6,000 notes; the longest stretch between yields stays under 100 ms (budget 12 ms).

## Native checks in Obsidian 1.14.5

Run with `node scripts/dev-test.mjs --vault <dev vault>` in the developer's shared test vault. The fixtures were copied in as top-level folders and removed afterwards. The vault's workspace layout was restored, and its other files weren't touched. Attachment Lens and its harness stay installed there, like the other plugins' harnesses.

| Check | What it confirmed |
| --- | --- |
| cache | What Obsidian's cache reports: `referenceLinks` lists definitions; `%20` is decoded; escaped table pipes are read correctly; links in `%%` comments are indexed; `../`, `./` and `/` paths resolve through `getFirstLinkpathDest`; a bare duplicate name resolves to the file nearest the source |
| scan | All 24 fixture attachments listed; every planted broken target found and nothing else; malformed board and dynamic base reported; code examples not counted; every explicit note reference resolves the same way as Obsidian's own `resolvedLinks`/`unresolvedLinks` |
| processThrow | Throwing inside `Vault.process` leaves the file and its modified time unchanged and reaches the caller |
| repairs | 12 scenarios: wikilink embed, relative Markdown link, reference definition, table embed, CRLF note, property list item, YAML with comments, uncertain plain property, Canvas file card, Canvas text card, `.base` file, embedded base. Each changed only the reference, showed as resolved, was confirmed by Obsidian's index where it applies, and was undone exactly. Apply took 3–7 ms |
| openEditor | Repair and undo with the note open in an editor; the editor shows the new text |
| unsavedEditor | Unsaved editor changes block the preview |
| canvasOpen | An open board blocks Apply; Check again clears it after closing |
| stale | A note changed after the preview is refused and the newer edit kept |
| undoConflict | Undo over newer edits is refused, the file is kept, and the current line is shown |
| recovery | After a plugin restart, a pending record is reported as applied, not applied or conflict, without writing; undo still works after restart |
| incremental | A new attachment fixes its broken link, a renamed one moves, an edited note adds and removes a reference, all without a rescan |
| keyboard | Home, arrows, End, Enter into details, Escape back, picker arrows and Escape (synthetic events); every focusable control has a name |
| screens | All 28 state screenshots, light and dark; Apply closes the dialog; undo from the panel works |
| large | 3,000 attachments and 1,500 notes in the vault: scan completes with no long tasks (over 50 ms) reported by the browser |

### Real-keyboard pass

Done with computer use in the dev vault window, keys only after one click to focus the window. Flow: command palette → **Show broken references** → arrow keys → Enter into the details → Enter on **Repair…** → arrow keys among candidates → Tab to **Review change** → Enter → Escape out of the dialog → Escape out of the picker → Escape to the list → End. Plus Tab through the toolbar, banners and filters. Focus rings are visible on the list, rows, buttons, candidates and chips.

## Issues found in Obsidian and fixed

1. A repair re-read the note before Obsidian had re-indexed it, so property and definition repairs briefly still showed as broken, and Apply waited out a 3-second timeout. Fixed by listening for the re-index before writing.
2. Links in `%% comments %%` are indexed by Obsidian; the scanner skipped them for Canvas text cards. Now counted everywhere.
3. Obsidian's cache leaves out links to URLs, so an "external links" count would be wrong. Removed from the panel.
4. Panel updates paused while the window was hidden (frames don't run). Added a timer fallback.
5. **Show broken references** didn't apply when the panel's tab hadn't been loaded since startup. Now loads the tab first and selects the first row.
6. Focus was lost after closing the review dialog or the picker with Escape, so the next Escape left the panel. Focus now returns to Review change, then Repair…, then the list.
7. The review dialog started with focus on **Apply repair**. It now starts on the dialog, so writing takes a deliberate Tab and Enter.
8. Filter chips had no visible focus ring. Added.
9. **Show in Attachment Lens** in a narrow sidebar stayed on the list. It now opens the details.
10. The success banner stayed after an undo made elsewhere. It now hides once its undo point is gone.

## Not performed

- **Obsidian 1.14.0.** Only 1.14.5 was available. API use is limited to 1.14.0 and older, checked by the `no-unsupported-api` lint rule.
- **macOS and Linux.** Only Windows was tested.
- **Screen readers.** ARIA roles and names are in place (listbox, options, radiogroup, labelled buttons), but nothing was tested with NVDA, JAWS or VoiceOver.
- **Community themes.** Only the default theme, in light and dark. The harness switches themes with Obsidian's `theme-light`/`theme-dark` body classes, which drive the same variables as the appearance setting.
- **Popout windows.** Not tested.
- **Sync between devices.** Not tested (see [ANDROID.md](ANDROID.md)).
- **A real vault of tens of thousands of files.** Native: 3,000 attachments and 1,500 notes. 30,000/6,000 only with the in-memory test.
- **Scanning-progress screenshot.** It shows a simulated progress state, because a real scan of the test vault finishes in milliseconds.
- **Your personal vaults.** Not opened or modified, as agreed.

## Reproducing

```bash
npm install
npm run check
npm run package
node scripts/dev-test.mjs --vault "path/to/test vault"
```

Native results and screenshots land in `.dev-results/`, which git ignores.
