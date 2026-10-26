# Releasing and the Community directory

How Attachment Lens is released, and how it gets into Obsidian's Community directory.

**Status:** 1.0.0 is published and listed at [community.obsidian.md/plugins/attachment-lens](https://community.obsidian.md/plugins/attachment-lens). The automated review passed, with two recommendations about vault enumeration and clipboard access, which the plugin needs to list attachments and for its copy buttons.

## Releasing a version

1. Set the new version with `npm version <patch|minor|major> --no-git-tag-version`. This updates `package.json`, `manifest.json` and `versions.json` through `scripts/version-bump.mjs`.
2. Run `npm run check`, then commit and push.
3. Push a tag that matches the version exactly, without a `v`: `git tag 1.0.1 && git push origin 1.0.1`.
4. The **Release Obsidian plugin** workflow tests and builds the plugin, attests the files, and creates a draft release with `main.js`, `manifest.json` and `styles.css`.
5. Review the draft on GitHub, add release notes, and publish it. Obsidian picks up the new version from the published release.

## Community directory

Since May 2026, submissions go through [community.obsidian.md](https://community.obsidian.md), not pull requests to `obsidianmd/obsidian-releases`:

1. Sign in with the Obsidian account and link the GitHub account that owns the repository.
2. Choose **Add your plugin** and pick `jokeroct/attachment-lens`. The directory reads `manifest.json` from the default branch.
3. An automated review runs. Its findings show in the directory; the plugin can't be installed from Obsidian until errors are fixed. Fixes go out as a new release with a higher version.
4. After it passes, choose **Publish**. The listing can be edited later.

Plugins that pass only the automated review are listed with "This plugin has not been manually reviewed by Obsidian staff", like the other jokeroct plugins.

## What the plugin already meets

- `manifest.json`: id `attachment-lens` (lowercase, no "obsidian", doesn't end in "plugin"), name, version in x.y.z, `minAppVersion` 1.14.0, a description ending with a period, author MON.D.SAMA with `authorUrl`, `fundingUrl` for Ko-fi, and `isDesktopOnly: true`.
- `versions.json` maps each release to its minimum Obsidian version.
- MIT `LICENSE`. Bundled dependencies `yaml` (ISC) and `@noble/hashes` (MIT) have their notices prepended to `main.js` by the build.
- README with installation, usage and limitations; its opening is what the listing shows as an excerpt.
- ESLint passes with `eslint-plugin-obsidianmd`'s recommended rules, which mirror the review's checks.

## Guideline checklist

| Guideline | Status |
| --- | --- |
| No `innerHTML`, `outerHTML` or `insertAdjacentHTML`; DOM built with `createEl` | Yes |
| No inline styles; styling through `styles.css` and theme variables (list offsets use `setCssProps`) | Yes |
| No default hotkeys; command names without the plugin name | Yes |
| Sentence case in UI text | Yes, keeping the plugin's name and Obsidian feature names |
| Settings without a top-level heading; uses `getSettingDefinitions` (1.13+) | Yes |
| `Vault#configDir` instead of a hard-coded `.obsidian` | Yes |
| Doesn't detach leaves in `onunload`; no view references stored on the plugin | Yes |
| Events registered with `registerEvent`/`registerDomEvent`, released on unload | Yes |
| No Node.js or Electron APIs at runtime | Yes |
| No network requests, telemetry or ads | Yes |
| `Vault.process` for writes to files that may be open | Yes |
| No private APIs | Yes (the dev harness uses some, but it isn't packaged) |

## Still open

- **Obsidian 1.14.0.** Native checks ran on 1.14.5. The `obsidianmd/no-unsupported-api` lint rule confirms no API newer than 1.14.0 is used.
- **Mobile.** `isDesktopOnly` stays `true` until the Android phase ([ANDROID.md](ANDROID.md)).
