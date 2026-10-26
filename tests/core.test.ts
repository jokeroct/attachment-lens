import { describe, expect, it } from "vitest";
import { extractMarkdown, isAttachmentReference } from "../src/core/extract";
import { fingerprint } from "../src/core/hash";
import { missingKey, ReferenceIndex } from "../src/core/index";
import { chooseLinkText, classifyPathStyle } from "../src/core/repair/linktext";
import { classifyRecovery, computeUndo, parseRecoveryRecord, type RecoveryRecord } from "../src/core/repair/recovery";
import { rankCandidates, searchPaths } from "../src/core/suggest";
import type { Reference } from "../src/core/types";
import { fakeCache, fixture } from "./helpers";

describe("link text", () => {
	it("classifies the original style", () => {
		expect(classifyPathStyle("a.png")).toBe("name");
		expect(classifyPathStyle("Assets/a.png")).toBe("vault");
		expect(classifyPathStyle("/Assets/a.png")).toBe("rooted");
		expect(classifyPathStyle("../a.png")).toBe("relative");
		expect(classifyPathStyle("./a.png")).toBe("relative");
	});

	it("keeps short names unless they would open another file", () => {
		const unique = chooseLinkText("kyoto-temple.jpeg", "link", "Assets/2024/kyoto-temple.jpg", "Travel/Kyoto trip 2024.md", (t) =>
			t === "kyoto-temple.jpg" || t === "Assets/2024/kyoto-temple.jpg" ? "Assets/2024/kyoto-temple.jpg" : null,
		);
		expect(unique).toMatchObject({ ok: true, text: "kyoto-temple.jpg" });

		const ambiguous = chooseLinkText("cover.jpg", "link", "Assets/2024/cover.png", "Notes/a.md", (t) =>
			t === "cover.png" ? "Assets/2023/cover.png" : t === "Assets/2024/cover.png" ? "Assets/2024/cover.png" : null,
		);
		expect(ambiguous).toMatchObject({ ok: true, text: "Assets/2024/cover.png" });
		expect(ambiguous.ok && ambiguous.note).toBe("Full vault path, because “cover.png” would open Assets/2023/cover.png from this source");
	});

	it("writes relative paths for relative originals", () => {
		const choice = chooseLinkText("../old/a.png", "link", "Assets/a b.png", "Links/Relative/Deep note.md", (t) => (t === "../../Assets/a b.png" ? "Assets/a b.png" : null));
		expect(choice).toMatchObject({ ok: true, text: "../../Assets/a b.png" });
		const below = chooseLinkText("./x.png", "link", "Links/Relative/img/a.png", "Links/Relative/Deep note.md", (t) => (t === "./img/a.png" ? "Links/Relative/img/a.png" : null));
		expect(below).toMatchObject({ ok: true, text: "./img/a.png" });
	});

	it("uses the exact vault path where a field requires one, and fails when nothing resolves", () => {
		expect(chooseLinkText("a.png", "exact", "Assets/a.png", "Boards/b.canvas", (t) => (t === "Assets/a.png" ? t : null))).toMatchObject({ ok: true, text: "Assets/a.png" });
		expect(chooseLinkText("a.png", "link", "Assets/a.png", "x.md", () => null)).toMatchObject({ ok: false });
	});
});

describe("suggestions", () => {
	const attachments = [
		{ path: "Assets/2024/kyoto-temple.jpg", refCount: 3 },
		{ path: "Assets/2024/kyoto-temple-2.jpg", refCount: 0 },
		{ path: "Travel/attachments/kyoto temple.webp", refCount: 0 },
		{ path: "Research/Papers/attention-is-all-you-need.pdf", refCount: 4 },
		{ path: "Audio/lecture-4.mp3", refCount: 0 },
	];

	it("ranks by name and path similarity and explains each candidate", () => {
		const ranked = rankCandidates("kyoto-temple.jpeg", "Travel/Kyoto trip 2024.md", attachments, 5);
		expect(ranked.map((c) => c.path)).toEqual(["Assets/2024/kyoto-temple.jpg", "Assets/2024/kyoto-temple-2.jpg", "Travel/attachments/kyoto temple.webp"]);
		expect(ranked[0]?.reasons.map((r) => r.text)).toEqual(["Same name, .jpg instead of .jpeg", "Same type: image"]);
		expect(ranked[1]?.reasons.map((r) => r.text)).toContain("Same name, ignoring a copy number");
		expect(ranked[2]?.reasons).toContainEqual({ text: "Different format: WebP", warn: true });
		expect(ranked[2]?.reasons.map((r) => r.text)).toContain("Near the source");
	});

	it("finds near names and leaves unrelated files out", () => {
		const ranked = rankCandidates("lecture-04.mp3", "Links/Wikilinks.md", attachments, 5);
		expect(ranked.map((c) => c.path)).toEqual(["Audio/lecture-4.mp3"]);
		expect(rankCandidates("zebra.png", "a.md", attachments, 5)).toEqual([]);
	});

	it("is deterministic and orders ties by path", () => {
		const twins = [{ path: "b/cover.png", refCount: 1 }, { path: "a/cover.png", refCount: 1 }];
		expect(rankCandidates("cover.png", "x.md", twins, 5).map((c) => c.path)).toEqual(["a/cover.png", "b/cover.png"]);
	});

	it("searches paths by every word", () => {
		const paths = attachments.map((a) => a.path);
		expect(searchPaths("kyoto 2024", paths, 10)).toEqual(["Assets/2024/kyoto-temple-2.jpg", "Assets/2024/kyoto-temple.jpg"]);
		expect(searchPaths("  ", paths, 10)).toEqual([]);
	});
});

describe("recovery record", () => {
	const before = "line\n![[a.jpeg|400]]\nend";
	const after = "line\n![[a.jpg|400]]\nend";
	const record: RecoveryRecord = {
		version: 1,
		state: "applied",
		sourcePath: "a.md",
		start: 8,
		before: "a.jpeg",
		after: "a.jpg",
		beforeHash: fingerprint(before),
		afterHash: fingerprint(after),
		createdAt: 1,
		appliedAt: 2,
		summary: { originalTarget: "a.jpeg", newTarget: "a.jpg", place: "line 2", lineBefore: "![[a.jpeg|400]]", lineAfter: "![[a.jpg|400]]" },
	};

	it("classifies the file against the record", () => {
		expect(classifyRecovery(record, before)).toBe("unapplied");
		expect(classifyRecovery(record, after)).toBe("applied");
		expect(classifyRecovery(record, `${after}\nmore`)).toBe("conflict");
		expect(classifyRecovery(record, null)).toBe("missing");
	});

	it("undoes only an unchanged repaired file", () => {
		expect(computeUndo(record, after)).toEqual({ ok: true, text: before });
		expect(computeUndo(record, `${after} edited`)).toEqual({ ok: false, reason: "conflict" });
	});

	it("validates stored records", () => {
		expect(parseRecoveryRecord(JSON.parse(JSON.stringify(record)))).toEqual(record);
		expect(parseRecoveryRecord({ ...record, version: 2 })).toBeNull();
		expect(parseRecoveryRecord({ ...record, summary: null })).toBeNull();
		expect(parseRecoveryRecord("nope")).toBeNull();
	});

	it("fingerprints match SHA-256", () => {
		expect(fingerprint("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
		expect(fingerprint("é")).toBe(fingerprint("é"));
	});
});

describe("Markdown extraction", () => {
	it("reads body links, properties and definitions", () => {
		const text = fixture("Travel/Kyoto trip 2024.md");
		const { refs, external } = extractMarkdown(fakeCache(text), text);
		expect(external).toBe(0);
		expect(refs.map((r) => [r.form, r.linkpath, r.subpath, r.confidence, r.place.type])).toEqual([
			["wikilink", "bamboo-grove.png", "", "explicit", "body"],
			["wikilink", "kyoto-temple.jpeg", "", "explicit", "body"],
			["wikilink", "kyoto-temple.jpg", "", "explicit", "body"],
			["wikilink", "receipts-march.pdf", "#page=2", "explicit", "body"],
			["wikilink", "kyoto-temple.jpg", "", "explicit", "property"],
		]);
	});

	it("marks plain-text properties uncertain and skips tags and non-paths", () => {
		const text = fixture("Properties/Uncertain.md");
		const { refs } = extractMarkdown(fakeCache(text), text);
		expect(refs.map((r) => [r.linkpath, r.confidence])).toEqual([
			["budget-2025.xlsx", "uncertain"],
			["report.docx", "uncertain"],
			["scan-0042.pdf", "uncertain"],
			["Meeting at 3.30pm", "uncertain"],
		]);
		// The last one is dropped later because it neither resolves nor has a known attachment extension.
		expect(isAttachmentReference("Meeting at 3.30pm", null)).toBe(false);
		expect(isAttachmentReference("banner-dune.jpg", null)).toBe(true);
		expect(isAttachmentReference("Welcome", "Welcome.md")).toBe(false);
		expect(isAttachmentReference("data", "Misc/data.xyz")).toBe(true);
	});

	it("counts external links and reports notes Obsidian hasn't indexed", () => {
		const text = fixture("Links/External.md");
		expect(extractMarkdown(fakeCache(text), text)).toMatchObject({ refs: [], external: 4 });
		expect(extractMarkdown(null, null).issues[0]?.kind).toBe("not-indexed");
	});
});

describe("index", () => {
	const ref = (over: Partial<Reference>): Reference => ({
		id: `${over.sourcePath ?? "n.md"}\u0000${over.key ?? "k"}`,
		key: "k",
		sourcePath: "n.md",
		sourceKind: "markdown",
		form: "wikilink",
		embed: true,
		confidence: "explicit",
		linkpath: "a.png",
		subpath: "",
		original: "![[a.png]]",
		place: { type: "body", line: 1, col: 1 },
		span: { start: 0, end: 10 },
		resolvedPath: null,
		...over,
	});
	const att = (path: string, size = 1) => ({ path, name: path.split("/").pop() as string, ext: "png", category: "image" as const, size, mtime: size });

	it("counts, filters, groups missing files and follows resolution changes", () => {
		const index = new ReferenceIndex();
		index.setAttachment(att("Assets/a.png", 5));
		index.setAttachment(att("Assets/b.png", 9));
		const broken1 = ref({ key: "1", linkpath: "gone.png" });
		const broken2 = ref({ key: "2", sourcePath: "m.md", id: "m.md\u00002", linkpath: "gone.png" });
		const ok = ref({ key: "3", linkpath: "a.png", resolvedPath: "Assets/a.png" });
		const unsure = ref({ key: "4", linkpath: "b.png", resolvedPath: "Assets/b.png", confidence: "uncertain", form: "path" });
		index.setSource("n.md", { kind: "markdown", refs: [broken1, ok, unsure], issues: [], external: 0 });
		index.setSource("m.md", { kind: "markdown", refs: [broken2], issues: [], external: 2 });

		expect(index.counts()).toMatchObject({ attachments: 2, broken: 2, missing: 1, unreferenced: 0, uncertain: 1 });
		const missing = index.query("broken", "all", "", "name");
		expect(missing).toHaveLength(1);
		expect(missing[0]).toMatchObject({ kind: "missing", name: "gone.png" });
		expect(missing[0]?.refs).toHaveLength(2);
		expect(index.query("all", "all", "", "size").map((i) => i.id)).toEqual(["Assets/b.png", "Assets/a.png"]);
		expect(index.query("uncertain", "all", "", "name").map((i) => i.id)).toEqual(["Assets/b.png"]);
		expect(index.query("all", "all", "assets a.png", "name").map((i) => i.id)).toEqual(["Assets/a.png"]);
		expect(index.externalCount()).toBe(2);

		index.resolve(broken1, "Assets/a.png", true);
		expect(index.counts()).toMatchObject({ broken: 1 });
		expect(index.refsTo("Assets/a.png")).toHaveLength(2);
		index.resolve(unsure, null, false);
		expect(index.counts()).toMatchObject({ uncertain: 0, unreferenced: 1 });
		index.deleteSource("m.md");
		expect(index.counts()).toMatchObject({ broken: 0, missing: 0 });
		expect(index.getRef("n.md\u00003")).toBe(ok);
	});

	it("groups relative and plain missing paths by where they point", () => {
		expect(missingKey({ linkpath: "../Assets/Gone.png", sourcePath: "Notes/x.md" })).toBe("assets/gone.png");
		expect(missingKey({ linkpath: "/Assets/Gone.png", sourcePath: "x.md" })).toBe("assets/gone.png");
	});
});
