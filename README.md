# Attachment Lens

See where your attachments are used, find broken attachment links, and repair them one reference at a time after reviewing the exact change.

Attachment Lens is a free, open-source plugin for [Obsidian](https://obsidian.md). Version 0.1.0 is desktop only and isn't in the Community plugins directory yet.

![Attachment Lens showing an attachment and the places it is used](docs/screenshots/C-attachment-details-light.png)

## What it does

- Lists every attachment in the vault (images, PDFs, audio, video, documents, archives and any other file that isn't a note, Canvas board or base), with search, filters by type and status, and sorting.
- Shows where each attachment is referenced: in note text, in properties, in Canvas boards and in bases, with the exact syntax and the surrounding line.
- Finds broken attachment references and suggests existing files that could be the intended target, explaining why each is suggested.
- Repairs one reference at a time. You review the exact change first, and every repair can be undone.

Scanning never changes files. Repairs change only the one reference you reviewed. Attachment files themselves are never renamed, moved or deleted.

## Installation

Until it's in the Community plugins directory, install it by hand:

1. Download `main.js`, `manifest.json` and `styles.css` from the release (or build them, see below).
2. In your vault, create the folder `.obsidian/plugins/attachment-lens/`. If you changed Obsidian's configuration folder, use that instead of `.obsidian`.
3. Copy the three files into it.
4. In Obsidian, open **Settings → Community plugins**, reload the list and turn on **Attachment Lens**.

Requires Obsidian 1.14.0 or newer on desktop.

## Using it

Open the panel with the paperclip icon in the ribbon, or the command **Attachment Lens: Open**. It opens as a tab and can be dragged into a sidebar. In a narrow sidebar the list and the details take turns, with a Back button.

1. **Scan vault.** Nothing is read until you start the first scan. Progress is shown, and **Cancel scan** (or Escape) stops it without keeping partial results. After the first scan, results follow your edits, renames and deletions automatically. The results live in memory; after restarting Obsidian, scan again, or turn on **Scan when the panel opens** in the settings.
2. **Browse.** Filters: **All attachments**, **Broken references**, **No references detected** and **Uncertain references**, plus a type menu and sorting. Search matches file names and vault paths.
3. **Inspect.** Selecting an attachment shows a preview (images only, loaded on demand), its path, type, size and date, and every reference with its source and location. **Open source** opens the note at that line, or the board or base. **Open in Obsidian** is offered for formats Obsidian opens itself (images, audio, video, PDF).
4. **Repair.** In **Broken references**, choose **Repair…** on a reference, pick a replacement, choose **Review change**, check the dialog and choose **Apply repair**.

Keyboard: Ctrl/Cmd+F focuses search; arrow keys, Home, End, Page Up and Page Down move through the list; Enter opens the details; Escape goes back. In the replacement list, arrow keys move between candidates.

Commands: **Open**, **Scan vault**, **Show broken references**, **Undo last repair**. Attachments also get **Show in Attachment Lens** in the file menu.

## What gets scanned

| Source | Recognized | Counts as |
| --- | --- | --- |
| Notes | `[[photo.png]]`, `![[photo.png\|300]]`, `[[paper.pdf#page=3\|alias]]`, `![](my%20photo.png)`, `![](<my photo.png>)`, reference definitions such as `[fig]: images/fig.png` | Explicit |
| Properties | `cover: "[[photo.png]]"` and list items with link syntax | Explicit |
| Properties | Plain text that looks like a file, such as `banner: dune.jpg` | Uncertain |
| Canvas boards | File cards, group backgrounds, links inside text cards | Explicit |
| Bases (`.base` files and `base` code blocks in notes) | One static string in `link()`, `file()`, `image()` or `hasLink()` | Explicit |
| Bases | A quoted `"[[photo.png]]"` elsewhere in an expression | Uncertain |

Links inside code blocks and code spans are ignored, except `base` blocks. Links inside `%% comments %%` count, as they do in Obsidian's own link index. Links to websites and to files outside the vault aren't checked. Links to notes, boards and bases are left to Obsidian.

A broken link counts as an attachment reference when its target has a known attachment extension (such as `.png`, `.pdf`, `.mp3` or `.zip`). A broken `[[John.Smith]]` is treated as a link to a note.

**Not covered:** HTML tags such as `<img src>`, Dataview and Templater code, CSS snippets, plugin file formats such as compressed Excalidraw drawings, nested property objects, base blocks inside Canvas text cards or callouts, and anything a Bases formula computes at runtime. That's why an attachment without references is described as **No references detected in supported sources**, not as unused. When a source couldn't be read completely (invalid JSON, invalid YAML, expressions that weren't evaluated, notes Obsidian hadn't indexed yet), the panel says so and lists the files under **Coverage details**.

![Choosing a replacement for a missing image](docs/screenshots/D-broken-with-suggestions-dark.png)

## How repairs work

Suggestions are ranked by file name, extension and folder similarity, and each one lists its reasons ("Same name, .jpg instead of .jpeg", "Near the source", "Different format: WebP"). Nothing is selected for you, and a similar name doesn't mean it's the right file. You can also search all attachments.

The review dialog shows the source and location, the original and new target, how the new link will be written, any change of file type, and the exact change with the surrounding lines. The link keeps its form: a short name stays a short name unless that would open a different file with the same name, a relative path stays relative, and a full path stays full. Aliases, sizes, captions, subpaths such as `#page=3`, angle brackets, URL encoding, YAML quoting and JSON escaping are kept, and nothing else in the file changes.

When you choose **Apply repair**:

1. The file is read again and must match the text the preview was built from. A note open in an editor must have no unsaved changes, and a Canvas board or base must not be open in a tab, because those can save over outside changes.
2. The replacement must still exist, and the new link must open it from that source, using Obsidian's own link resolution.
3. An undo point is saved to the plugin's data before anything is written.
4. The change is written with Obsidian's atomic `Vault.process`, which compares the text one last time.
5. The file is read back and must contain exactly the expected result, and the new link is checked against Obsidian's index.

![The review dialog with the exact change](docs/screenshots/E-review-light.png)

If the file changed after the preview, nothing is written and you're asked to refresh the preview. Uncertain references need one extra confirmation.

## Undo and recovery

**Undo last repair** (toolbar, success banner or command) restores the previous text, also after restarting Obsidian. Only one undo point is kept: a new successful repair replaces it, and the review dialog tells you which one it replaces.

Undo only runs when the file still matches the repaired version exactly. If it changed since, undo is refused and both versions of the line are shown, so you can fix it by hand. It never overwrites newer edits.

If Obsidian closes during a repair, the next start compares the file with the saved undo point and reports whether the repair was not applied, applied (undo is then available) or the file has changed since. Recovery never edits files.

## Privacy

No network requests, no telemetry, no accounts. The plugin stores its settings and the single undo point in its `data.json`. The undo point holds the file path, the replaced characters, the new characters, the line before and after, and SHA-256 fingerprints of the file before and after the repair.

## Settings

- **Excluded folders**: one per line. The configuration folder and `.trash` are always skipped.
- **Number of suggestions**: 3 to 10, default 5.
- **Scan when the panel opens**: off by default.

## Development

```bash
npm install
npm run check      # type check, lint, unit and integration tests, production build
npm run dev        # rebuild main.js on change
npm run package    # dist/attachment-lens-0.1.0/ and a .zip for manual installation
```

Tests use the fixture vault in `test-vault/`. `npm run fixtures` regenerates its binary attachments.

Native checks run inside Obsidian through a dev-only harness plugin in `dev/harness/`, which is never packaged:

```bash
node scripts/dev-test.mjs --vault "path/to/a/test vault"
```

The test vault must already be in Obsidian's vault list with community plugins allowed. The script copies the fixtures in, runs the checks, saves results and screenshots to `.dev-results/` and removes what it added. It refuses to run if the vault already has folders with the fixtures' names.

Code layout: `src/core` holds pure parsing, resolution, ranking and repair planning with no Obsidian imports; `src/obsidian` adapts it to Obsidian's API; `src/ui` is the view and dialogs.

## License

MIT. See [LICENSE](LICENSE).
