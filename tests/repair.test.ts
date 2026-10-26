import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { codeBlockStarts, extractBaseFile, extractCanvas, extractMarkdown, type FoundRef } from "../src/core/extract";
import { parseJsonWithPositions } from "../src/core/canvas/json";
import { locateReference } from "../src/core/repair/locate";
import { applyEdit, buildDiff, EditMismatchError, makeEdit, renderTarget, verifyResult, type Verified } from "../src/core/repair/plan";
import { fakeCache, fixture } from "./helpers";

type Outcome = { ok: true; text: string } | { ok: false; stage: "locate" | "render" | "verify"; reason: string };

function refsOf(path: string, text: string): FoundRef[] {
	if (path.endsWith(".canvas")) return extractCanvas(text).refs;
	if (path.endsWith(".base")) return extractBaseFile(text).refs;
	return extractMarkdown(fakeCache(text), text).refs;
}

/** Runs the pure repair pipeline: locate, render, edit, verify. */
function repair(path: string, text: string, pick: (r: FoundRef) => boolean, newPath: string): Outcome {
	const ref = refsOf(path, text).find(pick);
	if (!ref) throw new Error(`No reference matched in ${path}`);
	const codeStarts = codeBlockStarts(fakeCache(text));
	const located = locateReference(text, ref, codeStarts);
	if (!located.ok) return { ok: false, stage: "locate", reason: located.reason };
	const rendered = renderTarget(newPath, located.occurrence);
	if (!rendered.ok) return { ok: false, stage: "render", reason: rendered.reason };
	const edit = makeEdit(text, located.occurrence, rendered.text);
	const result = applyEdit(text, edit);
	const verified: Verified = verifyResult(text, result, edit, located.occurrence, newPath, codeStarts);
	if (!verified.ok) return { ok: false, stage: "verify", reason: verified.reason };
	return { ok: true, text: result };
}

function expectOk(outcome: Outcome): string {
	if (!outcome.ok) throw new Error(`${outcome.stage}: ${outcome.reason}`);
	return outcome.text;
}

/** The result equals the original with exactly one substring replaced at `at`. */
function expectSingleChange(before: string, after: string, from: string, to: string): void {
	const at = before.indexOf(from);
	expect(at).toBeGreaterThanOrEqual(0);
	expect(after).toBe(before.slice(0, at) + to + before.slice(at + from.length));
}

describe("Markdown repairs", () => {
	it("changes only the path in a sized embed", () => {
		const path = "Travel/Kyoto trip 2024.md";
		const text = fixture(path);
		const out = expectOk(repair(path, text, (r) => r.linkpath === "kyoto-temple.jpeg", "kyoto-temple.jpg"));
		expectSingleChange(text, out, "![[kyoto-temple.jpeg|400]]", "![[kyoto-temple.jpg|400]]");
	});

	it("keeps subpaths and aliases", () => {
		const path = "Travel/Kyoto trip 2024.md";
		const text = fixture(path);
		const out = expectOk(repair(path, text, (r) => r.linkpath === "receipts-march.pdf", "Finance/receipts 2024.pdf"));
		expectSingleChange(text, out, "[[receipts-march.pdf#page=2|receipts]]", "[[Finance/receipts 2024.pdf#page=2|receipts]]");
	});

	it("keeps percent-encoding, angle brackets and Unicode encoding", () => {
		const path = "Links/Markdown links.md";
		const text = fixture(path);
		let out = expectOk(repair(path, text, (r) => r.original.startsWith("![Photo](../"), "../Assets/new photo (2).png"));
		expectSingleChange(text, out, "(../Assets/my%20photo%201.png)", "(../Assets/new%20photo%20%282%29.png)");
		out = expectOk(repair(path, text, (r) => r.original.includes("<"), "../Assets/new photo.png"));
		expectSingleChange(text, out, "<../Assets/my photo 1.png>", "<../Assets/new photo.png>");
		out = expectOk(repair(path, text, (r) => r.linkpath.includes("café"), "../Assets/Ünïcödé 写真.png"));
		expectSingleChange(text, out, "caf%C3%A9.png", "%C3%9Cn%C3%AFc%C3%B6d%C3%A9%20%E5%86%99%E7%9C%9F.png");
	});

	it("keeps a link title", () => {
		const path = "Links/Markdown links.md";
		const text = fixture(path);
		const out = expectOk(repair(path, text, (r) => r.linkpath.endsWith("attention-is-all-you-need.pdf"), "../Research/paper.pdf"));
		expectSingleChange(text, out, '(../Research/Papers/attention-is-all-you-need.pdf "The paper")', '(../Research/paper.pdf "The paper")');
	});

	it("repairs a reference definition and keeps its title", () => {
		const path = "Links/Reference style.md";
		const text = fixture(path);
		const ref = refsOf(path, text).find((r) => r.form === "refdef" && r.linkpath.endsWith("fig-1.png"));
		expect(ref?.usages).toBe(3);
		const out = expectOk(repair(path, text, (r) => r.form === "refdef" && r.linkpath.endsWith("fig-9.png"), "../Research/Figures/fig-3.png"));
		expectSingleChange(text, out, "[gone]: ../Research/Figures/fig-9.png", "[gone]: ../Research/Figures/fig-3.png");
		const angle = expectOk(repair(path, text, (r) => r.form === "refdef" && r.linkpath.endsWith("budget-2025.xlsx"), "../Finance/budget 2026.xlsx"));
		expectSingleChange(text, angle, "<../Finance/budget-2025.xlsx>", "<../Finance/budget 2026.xlsx>");
	});

	it("keeps the escaped table pipe", () => {
		const path = "Links/Tables and escapes.md";
		const text = fixture(path);
		const out = expectOk(repair(path, text, (r) => r.linkpath === "temple-old.jpg", "kyoto-temple.jpg"));
		expectSingleChange(text, out, "![[temple-old.jpg\\|120]]", "![[kyoto-temple.jpg\\|120]]");
	});

	it("keeps Windows line endings byte for byte", () => {
		const path = "Links/Windows line endings.md";
		const text = fixture(path);
		const out = expectOk(repair(path, text, (r) => r.linkpath === "kyoto-temple-old.jpg", "kyoto-temple.jpg"));
		expectSingleChange(text, out, "kyoto-temple-old.jpg", "kyoto-temple.jpg");
		expect(out.split("\r\n").length).toBe(text.split("\r\n").length);
		expect(out.replace(/\r\n/g, "")).not.toContain("\n");
	});

	it("refuses paths a wikilink can't hold", () => {
		const path = "Travel/Kyoto trip 2024.md";
		const outcome = repair(path, fixture(path), (r) => r.linkpath === "kyoto-temple.jpeg", "a#b.jpg");
		expect(outcome).toMatchObject({ ok: false, stage: "render" });
	});

	it("notices when the note changed after scanning", () => {
		const path = "Travel/Kyoto trip 2024.md";
		const text = fixture(path);
		const ref = refsOf(path, text).find((r) => r.linkpath === "kyoto-temple.jpeg") as FoundRef;
		const edited = `New first line\n${text}`;
		const located = locateReference(edited, ref, null);
		expect(located).toMatchObject({ ok: false, changed: true });
	});
});

describe("Property repairs", () => {
	it("keeps comments, spacing and quote style in YAML", () => {
		const path = "Properties/YAML style.md";
		const text = fixture(path);
		const out = expectOk(repair(path, text, (r) => r.linkpath === "kyoto-temple-old.jpg", "kyoto-temple.jpg"));
		expectSingleChange(text, out, '"[[kyoto-temple-old.jpg]]"', '"[[kyoto-temple.jpg]]"');
		const cover = expectOk(repair(path, text, (r) => r.linkpath === "cover.png", "Assets/2024/cover.png"));
		expectSingleChange(text, cover, 'cover:   "[[cover.png]]"   # trailing comment', 'cover:   "[[Assets/2024/cover.png]]"   # trailing comment');
	});

	it("escapes quotes for the scalar style", () => {
		const path = "Properties/YAML style.md";
		const text = fixture(path);
		const out = expectOk(repair(path, text, (r) => r.linkpath === "my photo 1.png", "Assets/it's.png"));
		expectSingleChange(text, out, "'[[my photo 1.png]]'", "'[[Assets/it''s.png]]'");
		const dq = expectOk(repair(path, text, (r) => r.linkpath === "cover.png", 'Assets/say "hi".png'));
		expect((parse(dq.split("---")[1] as string) as Record<string, string>).cover).toBe('[[Assets/say "hi".png]]');
	});

	it("refuses values behind YAML anchors", () => {
		const path = "Properties/YAML style.md";
		const text = fixture(path);
		expect(repair(path, text, (r) => r.place.type === "property" && r.place.key === "again", "Misc/notes.txt")).toMatchObject({ ok: false, stage: "locate" });
		expect(repair(path, text, (r) => r.place.type === "property" && r.place.key === "thumb", "Misc/notes.txt")).toMatchObject({ ok: false, stage: "locate" });
	});

	it("repairs list items and plain-text values", () => {
		const explicit = "Properties/Explicit.md";
		const text = fixture(explicit);
		const out = expectOk(repair(explicit, text, (r) => r.linkpath === "missing-scan.pdf", "Inbox/scan-0042.pdf"));
		expectSingleChange(text, out, "[[missing-scan.pdf]]", "[[Inbox/scan-0042.pdf]]");
		const flow = expectOk(repair(explicit, text, (r) => r.linkpath === "report.docx", "Finance/report.docx"));
		expectSingleChange(text, flow, '"[[report.docx]]"]', '"[[Finance/report.docx]]"]');

		const dune = "Reading/Dune.md";
		const duneText = fixture(dune);
		const ref = refsOf(dune, duneText).find((r) => r.linkpath === "banner-dune.jpg");
		expect(ref?.confidence).toBe("uncertain");
		const plain = expectOk(repair(dune, duneText, (r) => r.linkpath === "banner-dune.jpg", "Assets/Covers/banner-dune.jpeg"));
		expectSingleChange(duneText, plain, "banner: banner-dune.jpg", "banner: Assets/Covers/banner-dune.jpeg");
	});

	it("refuses plain values the new path would break", () => {
		const dune = "Reading/Dune.md";
		expect(repair(dune, fixture(dune), (r) => r.linkpath === "banner-dune.jpg", "Assets/a: b.png")).toMatchObject({ ok: false, stage: "verify" });
		const uncertain = "Properties/Uncertain.md";
		expect(repair(uncertain, fixture(uncertain), (r) => r.linkpath === "scan-0042.pdf", "Inbox/scan, copy.pdf")).toMatchObject({ ok: false, stage: "verify" });
	});
});

describe("Canvas repairs", () => {
	const path = "Boards/Valid.canvas";
	const text = fixture(path);
	const withoutField = (json: string, id: string, field: string) => {
		const data = JSON.parse(json) as { nodes: Record<string, unknown>[] };
		for (const node of data.nodes) if (node.id === id) delete node[field];
		return data;
	};

	it("changes one file field and nothing else", () => {
		const out = expectOk(repair(path, text, (r) => r.key === "c:n7f2:file", "Research/Figures/fig-3.png"));
		expectSingleChange(text, out, '"file":"Research/old/fig-3.png"', '"file":"Research/Figures/fig-3.png"');
		expect(withoutField(out, "n7f2", "file")).toEqual(withoutField(text, "n7f2", "file"));
	});

	it("edits a link inside a text card's JSON string", () => {
		const out = expectOk(repair(path, text, (r) => r.linkpath === "gone-photo.png", 'Assets/my "best" photo.png'));
		expectSingleChange(text, out, "![[gone-photo.png]]", '![[Assets/my \\"best\\" photo.png]]');
		const md = expectOk(repair(path, text, (r) => r.key === "c:t1:text:1", "Finance/budget 2026.xlsx"));
		expectSingleChange(text, md, "(Finance/budget-2025.xlsx)", "(Finance/budget%202026.xlsx)");
		expect(() => parseJsonWithPositions(md)).not.toThrow();
	});
});

describe("Bases repairs", () => {
	it("changes one string literal in a .base file", () => {
		const path = "Bases/Static.base";
		const text = fixture(path);
		const out = expectOk(repair(path, text, (r) => r.linkpath === "hero-old.png", "Assets/2024/cover.png"));
		expectSingleChange(text, out, 'image("hero-old.png")', 'image("Assets/2024/cover.png")');
		const wiki = expectOk(repair(path, text, (r) => r.linkpath === "report.docx", "Finance/report.docx"));
		expectSingleChange(text, wiki, 'link("[[report.docx]]")', 'link("[[Finance/report.docx]]")');
	});

	it("refuses a path that needs new escaping", () => {
		const path = "Bases/Static.base";
		expect(repair(path, fixture(path), (r) => r.linkpath === "hero-old.png", 'Assets/say "hi".png')).toMatchObject({ ok: false, stage: "render" });
	});

	it("keeps single-quoted YAML around an expression", () => {
		const path = "Bases/Dynamic.base";
		const text = fixture(path);
		const out = expectOk(repair(path, text, (r) => r.linkpath === "banner-dune.jpg", "Assets/Covers/banner-dune.jpeg"));
		expectSingleChange(text, out, "[[banner-dune.jpg]]", "[[Assets/Covers/banner-dune.jpeg]]");
	});

	it("repairs a base block inside a note", () => {
		const path = "Bases/Embedded.md";
		const text = fixture(path);
		const out = expectOk(repair(path, text, (r) => r.linkpath === "Travel/attachments/bamboo-old.png", "Travel/attachments/bamboo-grove.png"));
		expectSingleChange(text, out, 'old: image("Travel/attachments/bamboo-old.png")', 'old: image("Travel/attachments/bamboo-grove.png")');
	});
});

describe("edit guard and diff", () => {
	it("refuses to apply an edit to text that moved", () => {
		expect(() => applyEdit("abc", { start: 0, end: 1, before: "x", after: "y" })).toThrow(EditMismatchError);
	});

	it("shows the change with context and marks the changed characters", () => {
		const path = "Travel/Kyoto trip 2024.md";
		const text = fixture(path);
		const ref = refsOf(path, text).find((r) => r.linkpath === "kyoto-temple.jpeg") as FoundRef;
		const located = locateReference(text, ref, null);
		if (!located.ok) throw new Error(located.reason);
		const edit = makeEdit(text, located.occurrence, "kyoto-temple.jpg");
		const diff = buildDiff(text, applyEdit(text, edit), edit);
		expect(diff.map((l) => l.sign)).toEqual([" ", " ", "-", "+", " ", " "]);
		const removed = diff.find((l) => l.sign === "-");
		expect(removed?.text).toBe("![[kyoto-temple.jpeg|400]]");
		expect(removed?.text.slice(...(removed.mark as [number, number]))).toBe("e");
		expect(diff.find((l) => l.sign === "+")?.text).toBe("![[kyoto-temple.jpg|400]]");
	});
});
