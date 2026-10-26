# Community directory submission notes

Attachment Lens 0.1.0 is prepared for the Obsidian Community plugins directory but **not submitted, released or pushed**. This file lists what's ready and what has to happen first.

## Release blockers

1. **Repository.** The directory needs a public GitHub repository, expected at `jokeroct/attachment-lens` like your other plugins. Add its URL as `repository` in `package.json` (as the other plugins do), and use it in the submission entry below.
2. **Native verification on 1.14.0.** Checks ran on Obsidian 1.14.5 only (see [VERIFICATION.md](VERIFICATION.md)). `minAppVersion` is 1.14.0, and the lint rule `obsidianmd/no-unsupported-api` confirms that no API newer than 1.14.0 is used. Running once on 1.14.0, or raising `minAppVersion` to the oldest version actually tested, removes the remaining doubt.
3. **Desktop only.** `isDesktopOnly` is `true` until the Android phase is done ([ANDROID.md](ANDROID.md)).

## What's ready

- `manifest.json` with id `attachment-lens`, name, author MON.D.SAMA with `authorUrl`, version 0.1.0, `minAppVersion` 1.14.0, a description that ends with a period and doesn't mention "Obsidian" or "plugin", and `isDesktopOnly: true`.
- `versions.json` mapping 0.1.0 to 1.14.0, kept in sync by `npm version` through `scripts/version-bump.mjs`.
- MIT `LICENSE`. Bundled dependencies: `yaml` (ISC) and `@noble/hashes` (MIT). Their license notices are prepended to `main.js` by the build.
- `README.md` covering installation, usage, scan coverage, limitations, repair behavior, undo and privacy.
- `npm run package` writes `dist/attachment-lens-0.1.0/` with `main.js`, `manifest.json`, `styles.css` and checksums, plus a zip.
- ESLint passes with `eslint-plugin-obsidianmd`'s recommended rules, which the review bot also uses.

## Guideline checklist

| Guideline | Status |
| --- | --- |
| No `innerHTML`, `outerHTML` or `insertAdjacentHTML`; DOM built with `createEl` | Yes |
| No inline styles; styling through `styles.css` and theme variables (dynamic list offsets use `setCssProps`) | Yes |
| No default hotkeys; command names without the plugin name | Yes |
| Sentence case in UI text | Yes, with the plugin's name and Obsidian feature names kept |
| Settings tab without a top-level heading; uses `getSettingDefinitions` (1.13+) | Yes |
| `Vault#configDir` instead of a hard-coded `.obsidian` | Yes |
| Doesn't detach leaves in `onunload`; no view references stored on the plugin | Yes |
| Events registered with `registerEvent`/`registerDomEvent`, so they're released on unload | Yes |
| No Node.js or Electron APIs at runtime | Yes |
| No network requests, telemetry or ads | Yes |
| Uses `Vault.process` for writes to files that may be open | Yes |
| Doesn't use private APIs | Yes (the dev harness does, but it isn't packaged) |

## Submitting, when the blockers are cleared

1. Push the repository to GitHub.
2. Create a GitHub release whose tag is exactly `0.1.0` (no `v`), and attach `main.js`, `manifest.json` and `styles.css` as separate assets.
3. Fork `obsidianmd/obsidian-releases`, add this entry to the end of `community-plugins.json`, and open a pull request using its template:

```json
{
  "id": "attachment-lens",
  "name": "Attachment Lens",
  "author": "MON.D.SAMA",
  "description": "See where attachments are used, find broken attachment links, and repair them one at a time after reviewing the exact change.",
  "repo": "jokeroct/attachment-lens"
}
```

4. Answer the review bot's findings and any reviewer questions on the pull request.
