import { beforeEach, describe, expect, it } from "vitest";
import type { RecoveryRecord } from "../src/core/repair/recovery";
import { LensController } from "../src/obsidian/controller";
import { RepairService, type RecoveryStore } from "../src/obsidian/repairService";
import { CancelToken, runFullScan, ScanCancelled } from "../src/obsidian/scanner";
import { FakeHost, ManualScheduler } from "./fakeHost";

class MemoryStore implements RecoveryStore {
	record: RecoveryRecord | null = null;
	saves = 0;
	get(): RecoveryRecord | null {
		return this.record;
	}
	set(record: RecoveryRecord | null): Promise<void> {
		this.saves++;
		this.record = record ? (JSON.parse(JSON.stringify(record)) as RecoveryRecord) : null;
		return Promise.resolve();
	}
}

async function scanned(host = FakeHost.fromFixtureVault()) {
	const scheduler = new ManualScheduler();
	const controller = new LensController(host, () => [], scheduler);
	await controller.scan();
	return { host, scheduler, controller };
}

describe("full scan of the fixture vault", () => {
	it("finds every reference and reports coverage gaps", async () => {
		const { controller } = await scanned();
		expect(controller.state.status).toBe("ready");
		const counts = controller.index.counts();
		expect(counts).toMatchObject({ attachments: 24, broken: 18, missing: 14, uncertain: 5, unreferenced: 9 });
		expect(controller.index.referenceCount()).toBe(63);
		expect(controller.index.externalCount()).toBe(6);

		const missing = controller.index.query("broken", "all", "", "name").map((i) => [i.name, i.refs.length]);
		expect(missing).toEqual([
			["bamboo-old.png", 2],
			["banner-dune.jpg", 2],
			["diagram-old.svg", 1],
			["fig-2.png", 1],
			["fig-3.png", 2],
			["fig-9.png", 1],
			["gone-photo.png", 1],
			["hero-old.png", 1],
			["kyoto-temple-old.jpg", 2],
			["kyoto-temple.jpeg", 1],
			["lecture-04.mp3", 1],
			["missing-scan.pdf", 1],
			["receipts-march.pdf", 1],
			["temple-old.jpg", 1],
		]);
		const unreferenced = controller.index.query("unreferenced", "all", "", "name").map((i) => i.id);
		expect(unreferenced).toEqual([
			"Assets/2024/cover.png",
			"Video/demo-walkthrough.mp4",
			"Research/Figures/fig-3.png",
			"Audio/Interviews/interview-2024-03-01.m4a",
			"Travel/attachments/kyoto temple.webp",
			"Assets/2024/kyoto-temple-2.jpg",
			"Audio/lecture-4.mp3",
			"Archives/site-backup-2023.zip",
			"Orphans/unused-scan.pdf",
		]);
		const issues = controller.index.issues().map((i) => [i.sourcePath, i.kind]);
		expect(issues).toEqual([
			["Bases/Dynamic.base", "dynamic"],
			["Boards/Malformed.canvas", "parse-error"],
		]);
		const temple = controller.index.getItem("Assets/2024/kyoto-temple.jpg");
		expect(temple?.refs.map((r) => r.sourcePath).sort()).toEqual([
			"Bases/Static.base",
			"Boards/Valid.canvas",
			"Links/Tables and escapes.md",
			"Properties/Explicit.md",
			"Travel/Kyoto trip 2024.md",
			"Travel/Kyoto trip 2024.md",
		]);
	});

	it("skips the config folder, the trash and excluded folders", async () => {
		const host = FakeHost.fromFixtureVault();
		host.setBinary(".obsidian/plugins/x/icon.png");
		host.setBinary(".trash/old.png");
		const scheduler = new ManualScheduler();
		const controller = new LensController(host, () => ["Archives", "Audio"], scheduler);
		await controller.scan();
		const paths = controller.index.attachmentList().map((a) => a.path);
		expect(paths).not.toContain(".obsidian/plugins/x/icon.png");
		expect(paths).not.toContain(".trash/old.png");
		expect(paths.some((p) => p.startsWith("Archives/") || p.startsWith("Audio/"))).toBe(false);
		expect(paths).toHaveLength(21);
	});

	it("waits for notes Obsidian hasn't indexed and reports the ones still missing", async () => {
		const host = FakeHost.fromFixtureVault();
		host.unindexed.add("Reading/Dune.md");
		const scheduler = new ManualScheduler();
		const controller = new LensController(host, () => [], scheduler, 50);
		const phases: string[] = [];
		controller.subscribe(() => {
			if (controller.state.status === "scanning") phases.push(controller.state.progress.phase);
		});
		await controller.scan();
		expect(phases[0]).toBe("waiting");
		expect(controller.index.issues().map((i) => [i.sourcePath, i.kind])).toContainEqual(["Reading/Dune.md", "not-indexed"]);
	});

	it("can be cancelled and keeps no partial results", async () => {
		const host = FakeHost.fromFixtureVault();
		const scheduler = new ManualScheduler();
		scheduler.budgetMs = 0;
		const controller = new LensController(host, () => [], scheduler);
		scheduler.onYield = () => {
			if (controller.state.status === "scanning" && controller.state.progress.phase === "reading") controller.cancel();
		};
		await controller.scan();
		expect(controller.state.status).toBe("cancelled");
		expect(controller.index.counts().attachments).toBe(0);
	});

	it("reports a failure without keeping results", async () => {
		const host = FakeHost.fromFixtureVault();
		host.listFiles = () => {
			throw new Error("listing failed");
		};
		const { controller } = await scanned(host);
		expect(controller.state).toMatchObject({ status: "error", message: "listing failed" });
	});
});

describe("incremental updates", () => {
	it("re-resolves links when an attachment appears, moves or disappears", async () => {
		const { host, scheduler, controller } = await scanned();
		host.setBinary("Audio/lecture-04.mp3");
		controller.onChanged("Audio/lecture-04.mp3");
		expect(scheduler.pending).toBe(1);
		scheduler.runTimers();
		await controller.flush();
		expect(controller.index.counts().broken).toBe(17);
		expect(controller.index.getItem("Audio/lecture-04.mp3")?.refs).toHaveLength(1);

		host.remove("Audio/lecture-04.mp3");
		host.setBinary("Audio/old/lecture-04.mp3");
		controller.onRenamed("Audio/old/lecture-04.mp3", "Audio/lecture-04.mp3");
		scheduler.runTimers();
		await controller.flush();
		expect(controller.index.getItem("Audio/old/lecture-04.mp3")?.refs).toHaveLength(1);

		host.remove("Audio/old/lecture-04.mp3");
		controller.onDeleted("Audio/old/lecture-04.mp3");
		scheduler.runTimers();
		await controller.flush();
		expect(controller.index.counts().broken).toBe(18);
	});

	it("re-reads only the note that changed, debounced", async () => {
		const { host, scheduler, controller } = await scanned();
		const path = "Reading/Dune.md";
		host.setText(path, `${await host.read(path)}\n![[Assets/2024/kyoto-temple-2.jpg]]\n`);
		controller.onChanged(path);
		controller.onChanged(path);
		expect(scheduler.pending).toBe(1);
		scheduler.runTimers();
		await controller.flush();
		expect(controller.index.getItem("Assets/2024/kyoto-temple-2.jpg")?.refs.map((r) => r.sourcePath)).toEqual([path]);
		expect(controller.index.counts().unreferenced).toBe(8);
	});

	it("moves everything under a renamed folder", async () => {
		const { host, scheduler, controller } = await scanned();
		for (const path of [...host.files.keys()].filter((p) => p.startsWith("Research/"))) {
			const entry = host.files.get(path);
			host.files.delete(path);
			if (entry) host.files.set(path.replace("Research/", "Science/"), entry);
		}
		controller.onRenamed("Science", "Research");
		scheduler.runTimers();
		await controller.flush();
		const paths = controller.index.attachmentList().map((a) => a.path);
		expect(paths.filter((p) => p.startsWith("Research/"))).toEqual([]);
		expect(paths.filter((p) => p.startsWith("Science/")).sort()).toEqual([
			"Science/Figures/fig-1.png",
			"Science/Figures/fig-3.png",
			"Science/Papers/attention-is-all-you-need.pdf",
		]);
	});

	it("queues changes made during a scan", async () => {
		const host = FakeHost.fromFixtureVault();
		const scheduler = new ManualScheduler();
		const controller = new LensController(host, () => [], scheduler);
		scheduler.onYield = () => {
			if (!host.files.has("Audio/lecture-04.mp3") && controller.state.status === "scanning") {
				host.setBinary("Audio/lecture-04.mp3");
				controller.onChanged("Audio/lecture-04.mp3");
			}
		};
		await controller.scan();
		scheduler.runTimers();
		await controller.flush();
		expect(controller.index.getItem("Audio/lecture-04.mp3")?.refs).toHaveLength(1);
	});
});

describe("guarded repair", () => {
	let host: FakeHost;
	let controller: LensController;
	let store: MemoryStore;
	let service: RepairService;
	const note = "Travel/Kyoto trip 2024.md";
	const brokenId = () => controller.index.brokenRefs().find((r) => r.sourcePath === note && r.linkpath === "kyoto-temple.jpeg")?.id as string;

	beforeEach(async () => {
		({ host, controller } = await scanned());
		store = new MemoryStore();
		service = new RepairService(host, controller, store, () => 1000);
	});

	it("previews, applies, verifies and undoes one reference", async () => {
		const before = await host.read(note);
		const preview = await service.preview(brokenId(), "Assets/2024/kyoto-temple.jpg");
		expect(preview.ok).toBe(true);
		if (!preview.ok) return;
		expect(preview.plan).toMatchObject({ writtenAs: "kyoto-temple.jpg", place: "line 16", typeChange: null, blocked: null, replaces: null });
		expect(preview.plan.diff.filter((l) => l.sign !== " ").map((l) => l.text)).toEqual(["![[kyoto-temple.jpeg|400]]", "![[kyoto-temple.jpg|400]]"]);

		const applied = await service.apply(preview.plan, false);
		expect(applied).toMatchObject({ ok: true, warning: null });
		const after = await host.read(note);
		expect(after).toBe(before.replace("![[kyoto-temple.jpeg|400]]", "![[kyoto-temple.jpg|400]]"));
		expect(store.record).toMatchObject({ state: "applied", sourcePath: note, before: "kyoto-temple.jpeg", after: "kyoto-temple.jpg" });
		expect(controller.index.counts().broken).toBe(17);

		const undone = await service.undo();
		expect(undone.ok).toBe(true);
		expect(await host.read(note)).toBe(before);
		expect(store.record).toBeNull();
		expect(controller.index.counts().broken).toBe(18);
	});

	it("writes the full path when the short name would open another file", async () => {
		const id = controller.index.brokenRefs().find((r) => r.linkpath === "temple-old.jpg")?.id as string;
		const preview = await service.preview(id, "Assets/2024/cover.png");
		expect(preview.ok && preview.plan.writtenAs).toBe("Assets/2024/cover.png");
		expect(preview.ok && preview.plan.writtenNote).toBe("Full vault path, because “cover.png” would open Assets/2023/cover.png from this source");
		expect(preview.ok && preview.plan.typeChange).toMatch(/JPEG image to PNG image/);
	});

	it("refuses when the note changed after the preview, and keeps the previous undo point", async () => {
		const first = await service.preview(controller.index.brokenRefs().find((r) => r.linkpath === "receipts-march.pdf")?.id as string, "Inbox/scan-0042.pdf");
		if (!first.ok) throw new Error(first.reason);
		await service.apply(first.plan, false);
		const undoPoint = store.record;

		const preview = await service.preview(brokenId(), "Assets/2024/kyoto-temple.jpg");
		if (!preview.ok) throw new Error(preview.reason);
		const edited = `${await host.read(note)}More text.\n`;
		host.setText(note, edited);
		const result = await service.apply(preview.plan, false);
		expect(result).toMatchObject({ ok: false, kind: "stale" });
		expect(await host.read(note)).toBe(edited);
		expect(store.record).toEqual(undoPoint);
	});

	it("refuses when the note changes during the write itself", async () => {
		const preview = await service.preview(brokenId(), "Assets/2024/kyoto-temple.jpg");
		if (!preview.ok) throw new Error(preview.reason);
		host.beforeProcess = (path) => host.setText(path, "Someone else's edit\n");
		const result = await service.apply(preview.plan, false);
		expect(result).toMatchObject({ ok: false, kind: "stale" });
		expect(await host.read(note)).toBe("Someone else's edit\n");
		expect(store.record).toBeNull();
	});

	it("refuses when the replacement disappeared", async () => {
		const preview = await service.preview(brokenId(), "Assets/2024/kyoto-temple.jpg");
		if (!preview.ok) throw new Error(preview.reason);
		host.remove("Assets/2024/kyoto-temple.jpg");
		expect(await service.apply(preview.plan, false)).toMatchObject({ ok: false, kind: "replacement-missing" });
		expect(host.writes).toBe(0);
	});

	it("reports a failed write and leaves the file and undo point alone", async () => {
		const before = await host.read(note);
		const preview = await service.preview(brokenId(), "Assets/2024/kyoto-temple.jpg");
		if (!preview.ok) throw new Error(preview.reason);
		host.failNextWrite = new Error("EBUSY: file is locked");
		const result = await service.apply(preview.plan, false);
		expect(result).toMatchObject({ ok: false, kind: "write-failed" });
		expect(result.ok === false && result.message).toMatch(/EBUSY/);
		expect(await host.read(note)).toBe(before);
		expect(store.record).toBeNull();
	});

	it("needs confirmation for uncertain references", async () => {
		const id = controller.index.brokenRefs().find((r) => r.sourcePath === "Reading/Dune.md")?.id as string;
		const preview = await service.preview(id, "Assets/Covers/banner-dune.jpeg");
		if (!preview.ok) throw new Error(preview.reason);
		expect(await service.apply(preview.plan, false)).toMatchObject({ ok: false, kind: "unconfirmed-uncertain" });
		expect(await service.apply(preview.plan, true)).toMatchObject({ ok: true });
		expect(await host.read("Reading/Dune.md")).toContain("banner: banner-dune.jpeg");
	});

	it("blocks open boards and notes with unsaved edits", async () => {
		const canvasRef = controller.index.brokenRefs().find((r) => r.sourcePath === "Boards/Valid.canvas" && r.linkpath === "Research/old/fig-3.png")?.id as string;
		host.openViews.add("Boards/Valid.canvas");
		const preview = await service.preview(canvasRef, "Research/Figures/fig-3.png");
		if (!preview.ok) throw new Error(preview.reason);
		expect(preview.plan.blocked).toMatch(/^Close Valid.canvas before applying/);
		expect(preview.plan.writtenAs).toBe("Research/Figures/fig-3.png");
		expect(await service.apply(preview.plan, false)).toMatchObject({ ok: false, kind: "blocked" });
		host.openViews.clear();
		expect(await service.apply(preview.plan, false)).toMatchObject({ ok: true });

		host.editors.set(note, ["unsaved text"]);
		expect(await service.preview(brokenId(), "Assets/2024/kyoto-temple.jpg")).toMatchObject({ ok: false });
	});

	it("refuses an undo over newer edits", async () => {
		const preview = await service.preview(brokenId(), "Assets/2024/kyoto-temple.jpg");
		if (!preview.ok) throw new Error(preview.reason);
		await service.apply(preview.plan, false);
		const edited = (await host.read(note)).replace("|400]]", "|500]]");
		host.setText(note, edited);
		const undo = await service.undo();
		expect(undo).toMatchObject({ ok: false, kind: "conflict", currentLine: "![[kyoto-temple.jpg|500]]" });
		expect(await host.read(note)).toBe(edited);
		expect(store.record?.state).toBe("applied");
	});

	it("classifies an interrupted repair on the next start without writing", async () => {
		const before = await host.read(note);
		const preview = await service.preview(brokenId(), "Assets/2024/kyoto-temple.jpg");
		if (!preview.ok) throw new Error(preview.reason);
		await service.apply(preview.plan, false);
		const pending = { ...(store.record as RecoveryRecord), state: "pending" as const };
		const writesBefore = host.writes;

		store.record = { ...pending };
		expect((await service.checkRecovery())?.status).toBe("applied");
		expect(store.record?.state).toBe("applied");

		host.setText(note, before);
		store.record = { ...pending };
		expect((await service.checkRecovery())?.status).toBe("unapplied");
		expect(store.record).toBeNull();

		host.setText(note, "something else\n");
		store.record = { ...pending };
		const conflict = await service.checkRecovery();
		expect(conflict?.status).toBe("conflict");
		expect(store.record?.state).toBe("pending");
		await service.dismissRecovery();
		expect(store.record).toBeNull();

		host.remove(note);
		store.record = { ...pending };
		expect((await service.checkRecovery())?.status).toBe("missing");
		expect(host.writes).toBe(writesBefore);
	});
});

describe("large vault", () => {
	it("scans 30,000 attachments and 6,000 notes in short batches", async () => {
		const host = new FakeHost();
		for (let i = 0; i < 30_000; i++) host.setBinary(`Attachments/${Math.floor(i / 500)}/image-${i}.png`, 1000 + i);
		for (let i = 0; i < 6_000; i++) {
			const links = [0, 1, 2].map((k) => `![[image-${(i * 5 + k) % 30_500}.png]]`).join("\n");
			host.setText(`Notes/${Math.floor(i / 200)}/note-${i}.md`, `# Note ${i}\n\n${links}\n`);
		}
		// Resolution by name only, as fast as Obsidian's own lookup.
		const byName = new Map([...host.files.keys()].map((p) => [p.slice(p.lastIndexOf("/") + 1), p]));
		host.resolveLink = (linkpath) => byName.get(linkpath) ?? null;

		const scheduler = new ManualScheduler();
		scheduler.budgetMs = 12;
		let longest = 0;
		let last = performance.now();
		const yieldToUi = scheduler.yieldToUi;
		scheduler.yieldToUi = async () => {
			const now = performance.now();
			longest = Math.max(longest, now - last);
			await yieldToUi();
			last = performance.now();
		};
		const token = new CancelToken();
		const started = performance.now();
		const result = await runFullScan(host, [], token, scheduler, () => {});
		const elapsed = performance.now() - started;
		expect(result.attachments).toHaveLength(30_000);
		expect([...result.sources.values()].reduce((n, e) => n + e.refs.length, 0)).toBe(18_000);
		expect(scheduler.yields).toBeGreaterThan(2);
		// A batch can overrun the budget by one file's work; 100 ms leaves room for slow CI machines.
		expect(longest).toBeLessThan(100);
		expect(elapsed).toBeLessThan(30_000);
	}, 60_000);

	it("stops promptly when cancelled", async () => {
		const host = new FakeHost();
		for (let i = 0; i < 2_000; i++) host.setText(`n-${i}.md`, "![[a.png]]");
		const scheduler = new ManualScheduler();
		scheduler.budgetMs = 0;
		const token = new CancelToken();
		scheduler.onYield = () => token.cancel();
		await expect(runFullScan(host, [], token, scheduler, () => {})).rejects.toBeInstanceOf(ScanCancelled);
	});
});
