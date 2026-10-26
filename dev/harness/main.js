// Test-vault-only harness for Attachment Lens. Not part of the plugin and never packaged.
// Runs the checks named in .al-run-checks against the real plugin and Obsidian's real APIs, writes
// what each one found to .al-test-results.json and screenshots to .al-shots/, then writes
// .al-checks-done. It may use private Obsidian APIs (plugin reload, window capture); the plugin may not.
const { apiVersion, MarkdownView, Plugin } = require("obsidian");
const { remote } = require("electron");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const RESULTS = ".al-test-results.json";
const TRIGGER = ".al-run-checks";
const DONE = ".al-checks-done";
const SHOTS = ".al-shots";
const PLUGIN_ID = "attachment-lens";
const VIEW_TYPE = "attachment-lens";
const CHECKS = ["cache", "scan", "processThrow", "repairs", "openEditor", "unsavedEditor", "canvasOpen", "stale", "undoConflict", "recovery", "incremental", "keyboard", "screens", "large"];

module.exports = class AttachmentLensHarness extends Plugin {
	onload() {
		for (const name of CHECKS) this.addCommand({ id: name, name: `Run check: ${name}`, callback: () => this.run([name]) });
		this.app.workspace.onLayoutReady(() => {
			void this.poll();
			this.registerInterval(window.setInterval(() => void this.poll(), 2000));
		});
	}

	async poll() {
		const { adapter } = this.app.vault;
		if (this.running || !(await adapter.exists(TRIGGER))) return;
		const names = (await adapter.read(TRIGGER)).split(/[\s,]+/).filter(Boolean);
		await adapter.remove(TRIGGER);
		await this.run(names.filter((n) => n !== "close"));
		if (names.includes("close")) setTimeout(() => remote.getCurrentWindow().close(), 500);
	}

	get lens() {
		return this.app.plugins.plugins[PLUGIN_ID];
	}

	async run(names) {
		this.running = true;
		const { adapter } = this.app.vault;
		const results = {};
		try {
			await sleep(1500);
			// Pick up a freshly installed main.js without restarting Obsidian.
			await this.reloadLens();
			for (const name of names) results[name] = await this.record(name, () => this[name]());
		} finally {
			await adapter.write(RESULTS, JSON.stringify({ obsidian: apiVersion, ranAt: new Date().toISOString(), results }, null, 2));
			this.running = false;
			await adapter.write(DONE, new Date().toISOString());
		}
	}

	async record(name, check) {
		const errors = [];
		const onError = (event) => errors.push(String(event.error?.stack ?? event.reason?.stack ?? event.message ?? event.reason));
		const consoleError = console.error;
		console.error = (...args) => {
			errors.push(args.map((a) => (a instanceof Error ? a.stack : String(a))).join(" "));
			consoleError.apply(console, args);
		};
		window.addEventListener("error", onError);
		window.addEventListener("unhandledrejection", onError);
		const started = Date.now();
		let result;
		try {
			result = (await check()) ?? {};
		} catch (error) {
			result = { checks: {}, error: String(error?.stack ?? error) };
		} finally {
			console.error = consoleError;
			window.removeEventListener("error", onError);
			window.removeEventListener("unhandledrejection", onError);
		}
		const checks = result.checks ?? {};
		const relevant = errors.filter((e) => /attachment-lens|AttachmentLens|al-/.test(e) || /TypeError|ReferenceError/.test(e));
		return { pass: !result.error && Object.values(checks).every(Boolean) && relevant.length === 0, ms: Date.now() - started, ...result, errors: relevant };
	}

	async reloadLens() {
		await this.app.plugins.disablePlugin(PLUGIN_ID);
		await this.app.plugins.enablePlugin(PLUGIN_ID);
		await sleep(500);
	}

	// Helpers

	file(path) {
		const file = this.app.vault.getFileByPath(path);
		if (!file) throw new Error(`Missing fixture ${path}`);
		return file;
	}

	read(path) {
		return this.app.vault.read(this.file(path));
	}

	/** Writes a fixture back and, for notes, waits until Obsidian has re-indexed it. */
	async write(path, text) {
		const file = this.file(path);
		const indexed = file.extension === "md" ? this.waitIndexed(path) : Promise.resolve();
		await this.app.vault.modify(file, text);
		await indexed;
	}

	waitIndexed(path, timeout = 3000) {
		return new Promise((resolve) => {
			const ref = this.app.metadataCache.on("changed", (file) => {
				if (file.path !== path) return;
				this.app.metadataCache.offref(ref);
				resolve(true);
			});
			setTimeout(() => {
				this.app.metadataCache.offref(ref);
				resolve(false);
			}, timeout);
		});
	}

	async waitFor(condition, timeout = 6000) {
		const end = Date.now() + timeout;
		while (Date.now() < end) {
			if (await condition()) return true;
			await sleep(100);
		}
		return false;
	}

	async rescan() {
		await this.lens.controller.scan();
		if (this.lens.controller.state.status !== "ready") throw new Error(`Scan ended as ${this.lens.controller.state.status}`);
	}

	broken(source, linkpath) {
		const ref = this.lens.controller.index.brokenRefs().find((r) => r.sourcePath === source && r.linkpath === linkpath);
		if (!ref) throw new Error(`No broken reference to ${linkpath} in ${source}`);
		return ref;
	}

	async closeLeavesOf(path) {
		const leaves = [];
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (leaf.view?.file?.path === path) leaves.push(leaf);
		});
		for (const leaf of leaves) leaf.detach();
		await sleep(200);
	}

	view() {
		const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
		return leaf?.view ?? null;
	}

	// Checks

	/** What Obsidian's own cache and resolver say about the fixtures. Mostly recorded for the report. */
	async cache() {
		const mc = this.app.metadataCache;
		const pick = (path) => {
			const c = mc.getCache(path) ?? {};
			const items = (list) => (list ?? []).map((i) => ({ link: i.link, original: i.original, start: i.position.start.offset }));
			return { links: items(c.links), embeds: items(c.embeds), referenceLinks: (c.referenceLinks ?? []).map((r) => ({ id: r.id, link: r.link, start: r.position.start.offset, original: (this.textCache?.[path] ?? "").slice(r.position.start.offset, r.position.end.offset) })), frontmatterLinks: c.frontmatterLinks ?? [] };
		};
		this.textCache = {};
		for (const p of ["Links/Reference style.md", "Links/Comments.md", "Links/Markdown links.md", "Links/Tables and escapes.md", "Properties/Explicit.md", "Properties/YAML style.md"]) this.textCache[p] = await this.read(p);
		const resolve = (link, from) => mc.getFirstLinkpathDest(link, from)?.path ?? null;
		const info = {
			referenceStyle: pick("Links/Reference style.md"),
			comments: pick("Links/Comments.md"),
			markdownLinks: pick("Links/Markdown links.md"),
			tables: pick("Links/Tables and escapes.md"),
			explicitProperties: pick("Properties/Explicit.md"),
			yamlStyle: pick("Properties/YAML style.md"),
			resolution: {
				relativeFromLinks: resolve("../Assets/my photo 1.png", "Links/Markdown links.md"),
				dotRelative: resolve("./Relative/Deep note.md", "Links/Markdown links.md"),
				twoUp: resolve("../../Travel/attachments/bamboo-grove.png", "Links/Relative/Deep note.md"),
				vaultPathFromSubfolder: resolve("Misc/diagram.svg", "Links/Markdown links.md"),
				rooted: resolve("/Misc/diagram.svg", "Links/Markdown links.md"),
				bareCover: resolve("cover.png", "Links/Wikilinks.md"),
				bareCoverFromAssets2024: resolve("cover.png", "Assets/2024/x.md"),
				caseInsensitive: resolve("MISC/NOTES.TXT", "Welcome.md"),
				canvasTextLink: resolve("Finance/budget-2025.xlsx", "Boards/Valid.canvas"),
			},
		};
		return {
			checks: {
				"cache reads the escaped table pipe as kyoto-temple.jpg": info.tables.embeds.some((e) => e.link === "kyoto-temple.jpg"),
				"cache decodes %20 in Markdown links": info.markdownLinks.embeds.some((e) => e.link === "../Assets/my photo 1.png"),
			},
			info,
		};
	}

	async scan() {
		// The vault may hold other projects' files; judge only what the fixtures added.
		const roots = JSON.parse(await this.app.vault.adapter.read(".al-fixtures.json"));
		const ours = (path) => roots.includes(path.split("/")[0]);
		const started = performance.now();
		await this.rescan();
		const ms = Math.round(performance.now() - started);
		const index = this.lens.controller.index;
		const counts = index.counts();
		const fixtureAttachments = index.attachmentList().filter((a) => ours(a.path)).length;
		const missing = index
			.query("broken", "all", "", "name")
			.filter((i) => i.refs.every((r) => ours(r.sourcePath)))
			.map((i) => [i.name, i.refs.length]);
		const unreferenced = index.query("unreferenced", "all", "", "name").map((i) => i.id).filter(ours);
		const issues = index.issues().map((i) => [i.sourcePath, i.kind, i.message]);
		// Parity with Obsidian's own link index for notes
		const mismatches = [];
		const mc = this.app.metadataCache;
		for (const source of index.sourcePaths().filter((p) => p.endsWith(".md"))) {
			const resolved = mc.resolvedLinks[source] ?? {};
			const unresolved = mc.unresolvedLinks[source] ?? {};
			for (const ref of index.getSource(source).refs) {
				// Plain-text properties are uncertain precisely because Obsidian doesn't treat them as links.
				if (ref.form === "refdef" || ref.place.type === "base" || ref.confidence === "uncertain") continue;
				if (ref.resolvedPath && !(ref.resolvedPath in resolved)) mismatches.push(`${source}: ours ${ref.linkpath} → ${ref.resolvedPath}, Obsidian doesn't list it as resolved`);
				if (!ref.resolvedPath && ref.confidence === "explicit" && !(ref.linkpath in unresolved)) mismatches.push(`${source}: ours ${ref.linkpath} broken, Obsidian doesn't list it as unresolved`);
			}
		}
		const expectedMissing = ["bamboo-old.png", "banner-dune.jpg", "diagram-old.svg", "fig-2.png", "fig-3.png", "fig-9.png", "gone-photo.png", "hero-old.png", "kyoto-temple-old.jpg", "kyoto-temple.jpeg", "lecture-04.mp3", "missing-scan.pdf", "receipts-march.pdf", "temple-old.jpg"];
		return {
			checks: {
				"24 fixture attachments listed": fixtureAttachments === 24,
				"every planted broken target found": expectedMissing.every((name) => missing.some(([n]) => n === name)),
				"no unexpected broken targets": missing.every(([n]) => expectedMissing.includes(n)),
				"malformed board reported": issues.some(([p, k]) => p === "Boards/Malformed.canvas" && k === "parse-error"),
				"dynamic base expressions reported": issues.some(([p, k]) => p === "Bases/Dynamic.base" && k === "dynamic"),
				"code examples don't count": unreferenced.includes("Assets/2024/kyoto-temple-2.jpg"),
				"resolution matches Obsidian's link index": mismatches.length === 0,
			},
			info: { ms, counts, references: index.referenceCount(), external: index.externalCount(), missing, unreferenced, issues, mismatches },
		};
	}

	/** Does throwing inside Vault.process leave the file untouched? The guard relies on it. */
	async processThrow() {
		const path = "Harness/process-check.md";
		if (!this.app.vault.getAbstractFileByPath("Harness")) await this.app.vault.createFolder("Harness");
		const existing = this.app.vault.getFileByPath(path);
		const file = existing ?? (await this.app.vault.create(path, "original text\n"));
		if (existing) await this.app.vault.modify(file, "original text\n");
		await sleep(300);
		const mtime = file.stat.mtime;
		let threw = false;
		try {
			await this.app.vault.process(file, () => {
				throw new Error("cancel");
			});
		} catch {
			threw = true;
		}
		await sleep(300);
		const text = await this.app.vault.read(file);
		const diskMtime = (await this.app.vault.adapter.stat(path))?.mtime;
		const unchangedTime = file.stat.mtime === mtime;
		const result = await this.app.vault.process(file, (data) => data.replace("original", "changed"));
		return {
			checks: {
				"the error reaches the caller": threw,
				"the file is unchanged": text === "original text\n",
				"the modified time is unchanged": unchangedTime && diskMtime === mtime,
				"a normal process call writes": result === "changed text\n" && (await this.app.vault.read(file)) === "changed text\n",
			},
		};
	}

	/** One repair per source type: preview, apply, read back, undo, read back. */
	async repairs() {
		await this.rescan();
		const scenarios = [
			{ name: "wikilink embed", source: "Travel/Kyoto trip 2024.md", linkpath: "kyoto-temple.jpeg", target: "Assets/2024/kyoto-temple.jpg", from: "![[kyoto-temple.jpeg|400]]", to: "![[kyoto-temple.jpg|400]]" },
			{ name: "relative Markdown link", source: "Links/Markdown links.md", linkpath: "../Research/old/fig-2.png", target: "Research/Figures/fig-1.png", from: "(../Research/old/fig-2.png)", to: null },
			{ name: "reference definition", source: "Links/Reference style.md", linkpath: "../Research/Figures/fig-9.png", target: "Research/Figures/fig-3.png", from: "[gone]: ../Research/Figures/fig-9.png", to: null },
			{ name: "table embed", source: "Links/Tables and escapes.md", linkpath: "temple-old.jpg", target: "Assets/2024/kyoto-temple.jpg", from: "![[temple-old.jpg\\|120]]", to: "![[kyoto-temple.jpg\\|120]]" },
			{ name: "Windows line endings", source: "Links/Windows line endings.md", linkpath: "kyoto-temple-old.jpg", target: "Assets/2024/kyoto-temple.jpg", from: "![[kyoto-temple-old.jpg]]", to: "![[kyoto-temple.jpg]]" },
			{ name: "property list item", source: "Properties/Explicit.md", linkpath: "missing-scan.pdf", target: "Inbox/scan-0042.pdf", from: '"[[missing-scan.pdf]]"', to: '"[[scan-0042.pdf]]"' },
			{ name: "YAML with comments", source: "Properties/YAML style.md", linkpath: "kyoto-temple-old.jpg", target: "Assets/2024/kyoto-temple.jpg", from: '"[[kyoto-temple-old.jpg]]"', to: '"[[kyoto-temple.jpg]]"' },
			{ name: "uncertain plain property", source: "Reading/Dune.md", linkpath: "banner-dune.jpg", target: "Assets/Covers/banner-dune.jpeg", from: "banner: banner-dune.jpg", to: "banner: banner-dune.jpeg", confirm: true },
			{ name: "Canvas file card", source: "Boards/Valid.canvas", linkpath: "Research/old/fig-3.png", target: "Research/Figures/fig-3.png", from: '"file":"Research/old/fig-3.png"', to: '"file":"Research/Figures/fig-3.png"' },
			{ name: "Canvas text card", source: "Boards/Valid.canvas", linkpath: "gone-photo.png", target: "Assets/my photo 1.png", from: "![[gone-photo.png]]", to: "![[my photo 1.png]]" },
			{ name: "base file", source: "Bases/Static.base", linkpath: "hero-old.png", target: "Assets/2024/cover.png", from: 'image("hero-old.png")', to: 'image("Assets/2024/cover.png")' },
			{ name: "embedded base", source: "Bases/Embedded.md", linkpath: "Travel/attachments/bamboo-old.png", target: "Travel/attachments/bamboo-grove.png", from: 'image("Travel/attachments/bamboo-old.png")', to: 'image("Travel/attachments/bamboo-grove.png")' },
		];
		const checks = {};
		const info = {};
		for (const s of scenarios) {
			const before = await this.read(s.source);
			const ref = this.broken(s.source, s.linkpath);
			const preview = await this.lens.repairs.preview(ref.id, s.target);
			if (!preview.ok) {
				checks[`${s.name}: preview`] = false;
				info[s.name] = { previewError: preview.reason };
				continue;
			}
			const plan = preview.plan;
			const t0 = performance.now();
			const applied = await this.lens.applyRepair(plan, s.confirm === true);
			const applyMs = Math.round(performance.now() - t0);
			const after = await this.read(s.source);
			const to = s.to ?? s.from.replace(plan.edit.before, plan.edit.after);
			const expected = before.replace(s.from, to);
			checks[`${s.name}: applied`] = applied.ok === true;
			checks[`${s.name}: only the reference changed`] = after === expected && before.includes(s.from);
			// The edit stays inside the reference, so it keeps its key.
			checks[`${s.name}: index shows it resolved`] = Boolean(this.lens.controller.index.getSource(s.source)?.refs.some((r) => r.key === ref.key && r.resolvedPath === s.target));
			if (s.source.endsWith(".md") && ref.place.type !== "base") {
				await this.waitFor(() => (this.app.metadataCache.resolvedLinks[s.source] ?? {})[s.target] !== undefined, 3000);
				// Plain-text properties aren't links to Obsidian, so its index can't confirm them.
				if (ref.confidence === "explicit") checks[`${s.name}: Obsidian resolves the new link`] = ref.form === "refdef" || (this.app.metadataCache.resolvedLinks[s.source] ?? {})[s.target] !== undefined;
			}
			const undone = await this.lens.repairs.undo();
			checks[`${s.name}: undo restores the file`] = undone.ok === true && (await this.read(s.source)) === before;
			info[s.name] = { applyMs, writtenAs: plan.writtenAs, note: plan.writtenNote, warning: applied.ok ? applied.warning : applied.message, typeChange: plan.typeChange };
		}
		return { checks, info };
	}

	/** Repair while the note is open in an editor, then undo. */
	async openEditor() {
		await this.rescan();
		const path = "Travel/Kyoto trip 2024.md";
		const leaf = this.app.workspace.getLeaf("tab");
		await leaf.openFile(this.file(path), { state: { mode: "source" } });
		await sleep(500);
		const before = await this.read(path);
		const preview = await this.lens.repairs.preview(this.broken(path, "kyoto-temple.jpeg").id, "Assets/2024/kyoto-temple.jpg");
		const applied = preview.ok ? await this.lens.applyRepair(preview.plan, false) : { ok: false };
		await sleep(800);
		const view = leaf.view;
		const editorAfter = view instanceof MarkdownView ? view.editor.getValue() : null;
		const diskAfter = await this.read(path);
		const undone = await this.lens.repairs.undo();
		await sleep(800);
		const editorUndone = view instanceof MarkdownView ? view.editor.getValue() : null;
		leaf.detach();
		return {
			checks: {
				"preview works with the note open": preview.ok === true,
				"repair applied": applied.ok === true,
				"open editor shows the repaired text": editorAfter === diskAfter && diskAfter !== before,
				"undo applied": undone.ok === true,
				"open editor shows the original after undo": editorUndone === before,
			},
			info: { previewError: preview.ok ? null : preview.reason },
		};
	}

	/** An editor with unsaved edits must block the repair. */
	async unsavedEditor() {
		await this.rescan();
		const path = "Travel/Kyoto trip 2024.md";
		const before = await this.read(path);
		const leaf = this.app.workspace.getLeaf("tab");
		await leaf.openFile(this.file(path), { state: { mode: "source" } });
		await sleep(400);
		const view = leaf.view;
		view.editor.replaceRange("Typing… ", { line: 7, ch: 0 });
		const preview = await this.lens.repairs.preview(this.broken(path, "kyoto-temple.jpeg").id, "Assets/2024/kyoto-temple.jpg");
		view.editor.undo();
		await sleep(2500);
		leaf.detach();
		await sleep(300);
		const now = await this.read(path);
		if (now !== before) await this.write(path, before);
		return {
			checks: { "preview refuses while edits are unsaved": preview.ok === false && /haven't been saved/.test(preview.reason) },
			info: { reason: preview.ok ? null : preview.reason },
		};
	}

	/** An open board blocks Apply until it's closed. */
	async canvasOpen() {
		await this.rescan();
		const path = "Boards/Valid.canvas";
		const leaf = this.app.workspace.getLeaf("tab");
		await leaf.openFile(this.file(path));
		await sleep(800);
		const preview = await this.lens.repairs.preview(this.broken(path, "Research/old/fig-3.png").id, "Research/Figures/fig-3.png");
		const blocked = preview.ok ? preview.plan.blocked : null;
		const apply = preview.ok ? await this.lens.repairs.apply(preview.plan, false) : null;
		leaf.detach();
		await sleep(300);
		const recheck = preview.ok ? this.lens.repairs.recheckBlocked(preview.plan) : "no plan";
		return {
			checks: {
				"preview says to close the board": typeof blocked === "string" && blocked.startsWith("Close Valid.canvas"),
				"apply refuses while it's open": apply?.ok === false && apply.kind === "blocked",
				"check again clears after closing": recheck === null,
			},
			info: { blocked, viewType: leaf.view?.getViewType?.() },
		};
	}

	async stale() {
		await this.rescan();
		const path = "Travel/Kyoto trip 2024.md";
		const before = await this.read(path);
		const preview = await this.lens.repairs.preview(this.broken(path, "kyoto-temple.jpeg").id, "Assets/2024/kyoto-temple.jpg");
		await this.write(path, `${before}Edited after the preview.\n`);
		const result = preview.ok ? await this.lens.repairs.apply(preview.plan, false) : null;
		const after = await this.read(path);
		await this.write(path, before);
		return {
			checks: {
				"apply refuses a changed note": result?.ok === false && result.kind === "stale",
				"the newer edit is kept": after === `${before}Edited after the preview.\n`,
			},
		};
	}

	async undoConflict() {
		await this.rescan();
		const path = "Travel/Kyoto trip 2024.md";
		const before = await this.read(path);
		const preview = await this.lens.repairs.preview(this.broken(path, "kyoto-temple.jpeg").id, "Assets/2024/kyoto-temple.jpg");
		await this.lens.applyRepair(preview.plan, false);
		const edited = (await this.read(path)).replace("|400]]", "|500]]");
		await this.write(path, edited);
		const undo = await this.lens.repairs.undo();
		const after = await this.read(path);
		await this.lens.repairs.discardUndo();
		await this.write(path, before);
		return {
			checks: {
				"undo refuses over newer edits": undo.ok === false && undo.kind === "conflict",
				"the file keeps the newer edit": after === edited,
				"the conflict shows the current line": undo.currentLine === "![[kyoto-temple.jpg|500]]",
			},
		};
	}

	/** A pending record survives a plugin restart and is classified without writing. */
	async recovery() {
		await this.rescan();
		const path = "Travel/Kyoto trip 2024.md";
		const before = await this.read(path);
		const preview = await this.lens.repairs.preview(this.broken(path, "kyoto-temple.jpeg").id, "Assets/2024/kyoto-temple.jpg");
		await this.lens.applyRepair(preview.plan, false);
		const repaired = await this.read(path);
		const pending = { ...this.lens.recovery, state: "pending" };
		const checks = {};
		const restartWith = async (record) => {
			await this.lens.saveData({ settings: this.lens.settings, recovery: record });
			await this.reloadLens();
			await this.waitFor(() => this.lens.recoveryNotice !== null, 4000);
			return this.lens.recoveryNotice;
		};
		let notice = await restartWith(pending);
		checks["written repair is reported as applied"] = notice?.status === "applied" && this.lens.recovery?.state === "applied";
		checks["file untouched by recovery (applied)"] = (await this.read(path)) === repaired;
		checks["undo still works after restart"] = (await this.lens.repairs.undo()).ok === true && (await this.read(path)) === before;
		notice = await restartWith(pending);
		checks["unwritten repair is reported as not applied"] = notice?.status === "unapplied" && this.lens.recovery === null;
		await this.write(path, `${before}Changed elsewhere.\n`);
		notice = await restartWith(pending);
		checks["changed file is reported as a conflict"] = notice?.status === "conflict";
		checks["file untouched by recovery (conflict)"] = (await this.read(path)) === `${before}Changed elsewhere.\n`;
		await this.lens.dismissRecovery();
		checks["dismiss clears the record"] = this.lens.recovery === null;
		await this.write(path, before);
		return { checks };
	}

	/** Results follow file changes after the first scan, without a full rescan. */
	async incremental() {
		await this.rescan();
		const index = this.lens.controller.index;
		const brokenBefore = index.counts().broken;
		const file = await this.app.vault.createBinary("Audio/lecture-04.mp3", new Uint8Array([1, 2, 3]).buffer);
		const created = await this.waitFor(() => index.counts().broken === brokenBefore - 1);
		await this.app.vault.rename(file, "Audio/old/lecture-04.mp3").catch(async () => {
			await this.app.vault.createFolder("Audio/old");
			await this.app.vault.rename(file, "Audio/old/lecture-04.mp3");
		});
		const renamed = await this.waitFor(() => index.getAttachment("Audio/old/lecture-04.mp3") !== undefined && index.getAttachment("Audio/lecture-04.mp3") === undefined);
		const note = "Reading/Dune.md";
		const text = await this.read(note);
		await this.write(note, `${text}\n![[kyoto-temple-2.jpg]]\n`);
		const noted = await this.waitFor(() => index.refsTo("Assets/2024/kyoto-temple-2.jpg").length === 1);
		await this.write(note, text);
		const reverted = await this.waitFor(() => index.refsTo("Assets/2024/kyoto-temple-2.jpg").length === 0);
		return {
			checks: {
				"new attachment fixes its broken link": created,
				"renamed attachment moves in the list": renamed,
				"edited note adds a reference": noted,
				"reverted note removes it": reverted,
				"no full rescan happened": this.lens.controller.state.status === "ready",
			},
		};
	}

	/** Keyboard handling, driven with synthetic events. A real-keyboard pass is done separately. */
	async keyboard() {
		await this.rescan();
		const lens = await this.lens.activateView("all");
		await sleep(400);
		const root = lens.contentEl;
		const listEl = root.querySelector(".al-list-scroll");
		const key = (el, k, extra = {}) => el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...extra }));
		listEl.focus();
		key(listEl, "Home");
		const first = lens.viewState.selected;
		key(listEl, "ArrowDown");
		key(listEl, "ArrowDown");
		const third = lens.viewState.selected;
		key(listEl, "End");
		const last = lens.viewState.selected;
		key(listEl, "Home");
		key(listEl, "Enter");
		await sleep(100);
		const inDetails = root.querySelector(".al-details").contains(document.activeElement);
		key(document.activeElement, "Escape");
		await sleep(100);
		const backInList = document.activeElement === listEl;
		const focusable = [...root.querySelectorAll("button, input, select, [tabindex='0']")].filter((el) => !el.disabled);
		const unnamed = focusable.filter((el) => !(el.getAttribute("aria-label") || el.textContent.trim() || el.getAttribute("placeholder"))).map((el) => el.outerHTML.slice(0, 80));
		// Picker keyboard: arrow keys move the choice, Escape closes it
		lens.showFilter("broken");
		await sleep(200);
		// A missing file with several candidates, so there is somewhere for the arrow keys to go
		const several = this.lens.controller.index.query("broken", "all", "", "name").findIndex((i) => i.name === "kyoto-temple.jpeg");
		lens.list.select(several, true);
		await sleep(200);
		const repairButton = root.querySelector("[data-repair]");
		repairButton?.click();
		await sleep(200);
		const firstCandidate = root.querySelector(".al-candidate");
		firstCandidate?.click();
		const chosen1 = root.querySelector(".al-candidate.is-selected .al-candidate-path")?.textContent;
		key(root.querySelector(".al-candidate.is-selected"), "ArrowDown");
		const chosen2 = root.querySelector(".al-candidate.is-selected .al-candidate-path")?.textContent;
		key(root.querySelector(".al-candidate.is-selected"), "Escape");
		await sleep(100);
		const pickerClosed = root.querySelector(".al-picker") === null;
		return {
			checks: {
				"Home selects the first row": first !== null,
				"arrow keys move the selection": third !== first && third !== null,
				"End selects the last row": last !== third,
				"Enter moves focus into the details": inDetails,
				"Escape returns focus to the list": backInList,
				"every focusable control has a name": unnamed.length === 0,
				"picker arrow keys change the choice": Boolean(chosen1) && chosen2 !== chosen1,
				"Escape closes the picker": pickerClosed,
			},
			info: { unnamed, focusableCount: focusable.length },
		};
	}

	setTheme(theme) {
		document.body.removeClass("theme-light", "theme-dark");
		document.body.addClass(theme === "dark" ? "theme-dark" : "theme-light");
	}

	async shot(name) {
		await sleep(350);
		const image = await remote.getCurrentWebContents().capturePage();
		const png = image.toPNG();
		const { adapter } = this.app.vault;
		if (!(await adapter.exists(SHOTS))) await adapter.mkdir(SHOTS);
		await adapter.writeBinary(`${SHOTS}/${name}.png`, png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength));
		return `${SHOTS}/${name}.png`;
	}

	/** Screenshots of every designed state, in light and dark. */
	async screens() {
		const original = document.body.hasClass("theme-dark") ? "dark" : "light";
		const shots = [];
		const undoResults = [];
		const lens = this.lens;
		const controller = lens.controller;
		// One clean main-area tab with the panel. Open it first, so a tab group always remains.
		const view = await lens.activateView();
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (leaf.getRoot() === this.app.workspace.rootSplit && leaf !== view.leaf) leaf.detach();
		});
		await sleep(400);
		const click = async (selector) => {
			const el = view.contentEl.querySelector(selector) ?? document.querySelector(selector);
			el?.click();
			await sleep(250);
			return Boolean(el);
		};
		try {
			for (const theme of ["light", "dark"]) {
				this.setTheme(theme);
				const s = async (name) => shots.push(await this.shot(`${name}-${theme}`));

				controller.index.clear();
				controller.setState({ status: "idle" });
				await s("A-before-first-scan");
				controller.setState({ status: "scanning", progress: { phase: "reading", done: 1482, total: 2263, refs: 6912, broken: 0 } });
				await s("B-scanning");
				controller.setState({ status: "cancelled" });
				await s("B-cancelled");
				controller.setState({ status: "error", message: "TypeError: Cannot read properties of undefined (reading 'path')", detail: "TypeError: …" });
				await s("H-scan-error");

				await this.rescan();
				view.reveal("Assets/2024/kyoto-temple.jpg");
				await s("C-attachment-details");

				view.showFilter("broken");
				await sleep(200);
				const missingIndex = controller.index.query("broken", "all", "", "name").findIndex((i) => i.name === "kyoto-temple.jpeg");
				view.list.select(missingIndex, true);
				await sleep(200);
				await click("[data-repair]");
				await click(".al-candidate");
				await s("D-broken-with-suggestions");

				await click(".al-picker-foot .mod-cta");
				await sleep(600);
				await s("E-review");
				document.querySelector(".al-review-modal .al-modal-foot .mod-cta")?.click();
				const closed = await this.waitFor(() => !document.querySelector(".al-review-modal"), 6000);
				const applyMs = Date.now();
				await s("F-repaired-with-undo");
				undoResults.push({ theme, closed, undoBefore: lens.repairs.canUndo() });
				await lens.runUndo();
				await sleep(400);
				undoResults[undoResults.length - 1].undoAfter = lens.repairs.canUndo();
				undoResults[undoResults.length - 1].ms = Date.now() - applyMs;

				const dune = controller.index.brokenRefs().find((r) => r.sourcePath === "Reading/Dune.md");
				if (dune) {
					const done = lens.startReview(dune.id, "Assets/Covers/banner-dune.jpeg", () => {});
					await sleep(700);
					await s("E-review-uncertain");
					// The dialog's own Back button; a scripted click on Obsidian's close button doesn't close it.
					document.querySelector(".al-review-modal .al-modal-foot button:not(.mod-cta)")?.click();
					await done;
				}

				view.showFilter("all");
				view.searchBox.setValue("invoice");
				view.viewState.search = "invoice";
				view.refreshList(true);
				await sleep(200);
				await s("G-no-search-results");
				view.searchBox.setValue("");
				view.viewState.search = "";
				view.refreshList(true);

				await click(".al-banners .al-banner-warning button");
				await s("H-coverage-details");

				lens.recoveryNotice = { status: "conflict", record: { sourcePath: "Travel/Kyoto trip 2024.md", summary: { lineBefore: "![[kyoto-temple.jpeg|400]]" } }, currentLine: "![[kyoto-temple.jpg|500]]" };
				lens.notifyUi();
				await s("I-interrupted-repair");
				lens.recoveryNotice = null;
				lens.notifyUi();

				// Narrow layout in the right sidebar
				const side = this.app.workspace.getRightLeaf(false);
				await side.setViewState({ type: VIEW_TYPE, active: true });
				this.app.workspace.revealLeaf(side);
				await sleep(600);
				await s("C-narrow-list");
				side.view.reveal("Assets/2024/kyoto-temple.jpg");
				await sleep(300);
				await s("C-narrow-details");
				side.detach();
				await sleep(300);
			}
		} finally {
			this.setTheme(original);
		}
		return {
			checks: {
				"all screenshots taken": shots.length === 28,
				"Apply closes the dialog": undoResults.every((r) => r.closed),
				"the repair could be undone from the panel": undoResults.every((r) => r.undoBefore && !r.undoAfter),
			},
			info: { shots, undoResults },
		};
	}

	/** A bigger vault inside Obsidian: how long the scan takes and how long the longest task blocks. */
	async large() {
		const { vault } = this.app;
		if (!vault.getAbstractFileByPath("Large")) {
			await vault.createFolder("Large");
			for (let f = 0; f < 20; f++) await vault.createFolder(`Large/f${f}`);
			const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer;
			for (let i = 0; i < 3000; i++) await vault.createBinary(`Large/f${i % 20}/img-${i}.png`, png);
			for (let i = 0; i < 1500; i++) await vault.create(`Large/f${i % 20}/note-${i}.md`, `# Note ${i}\n\n![[img-${i}.png]]\n![[img-${(i * 7) % 3100}.png]]\n[[Note ${i + 1}]]\n`);
			await this.waitFor(() => this.app.metadataCache.getCache("Large/f19/note-1499.md") !== null, 60000);
			await sleep(2000);
		}
		const tasks = [];
		const observer = new PerformanceObserver((list) => {
			for (const entry of list.getEntries()) tasks.push(Math.round(entry.duration));
		});
		observer.observe({ entryTypes: ["longtask"] });
		const started = performance.now();
		await this.rescan();
		const ms = Math.round(performance.now() - started);
		await sleep(200);
		observer.disconnect();
		const counts = this.lens.controller.index.counts();
		const longest = tasks.length ? Math.max(...tasks) : 0;
		return {
			checks: { "scan completes": counts.attachments >= 3000, "no task blocks the UI for more than 200 ms": longest <= 200 },
			info: { ms, attachments: counts.attachments, references: this.lens.controller.index.referenceCount(), longTasks: tasks.length, longestTaskMs: longest },
		};
	}
};
