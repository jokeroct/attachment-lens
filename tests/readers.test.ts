import { describe, expect, it } from "vitest";
import { parseDocument, type Scalar } from "yaml";
import { readBase, readEmbeddedBases } from "../src/core/bases/bases";
import { scanExpression } from "../src/core/bases/expression";
import { readCanvas } from "../src/core/canvas/canvas";
import { parseJsonWithPositions } from "../src/core/canvas/json";
import { locateProperty } from "../src/core/yaml/frontmatter";
import { mapScalar } from "../src/core/yaml/scalars";
import { fixture } from "./helpers";

describe("YAML properties", () => {
	const yamlStyle = fixture("Properties/YAML style.md");

	it("pins down values with comments and odd spacing around them", () => {
		const cover = locateProperty(yamlStyle, "cover", null);
		expect(cover.ok).toBe(true);
		if (!cover.ok) return;
		expect(cover.scalar).toMatchObject({ value: "[[cover.png]]", style: "QUOTE_DOUBLE" });
		expect(yamlStyle.slice(cover.scalar.rawStart, cover.scalar.rawEnd)).toBe('"[[cover.png]]"');
		const item = locateProperty(yamlStyle, "gallery", 1);
		expect(item.ok && item.scalar.value).toBe("[[kyoto-temple-old.jpg]]");
		const first = locateProperty(yamlStyle, "gallery", 0);
		expect(first.ok && first.scalar.style).toBe("QUOTE_SINGLE");
	});

	it("refuses anchors, aliases, duplicates and missing keys", () => {
		expect(locateProperty(yamlStyle, "thumb", null).ok).toBe(false);
		expect(locateProperty(yamlStyle, "again", null).ok).toBe(false);
		expect(locateProperty(yamlStyle, "nothing", null).ok).toBe(false);
		expect(locateProperty("---\na: x.png\na: y.png\n---\n", "a", null).ok).toBe(false);
		expect(locateProperty('---\na: "x\n  y.png"\n---\n', "a", null).ok).toBe(false);
		expect(locateProperty("no frontmatter", "a", null).ok).toBe(false);
	});

	it("maps escaped scalars back to source characters", () => {
		const src = 'a: "x\\"y\\u00e9 z.png"\nb: \'it\'\'s.png\'\n';
		const doc = parseDocument(src);
		const a = mapScalar(src, doc.get("a", true) as Scalar, 10);
		expect(a?.value).toBe('x"yé z.png');
		// "z" is the 4th decoded character and sits after the 6-character é escape.
		expect(src[(a?.map[4] as number) - 10]).toBe(" ");
		expect(src.slice((a?.map[5] as number) - 10, (a?.map[10] as number) - 10)).toBe("z.png");
		const b = mapScalar(src, doc.get("b", true) as Scalar, 0);
		expect(b?.value).toBe("it's.png");
		expect(src.slice(b?.map[3], b?.map[8])).toBe("s.png");
	});
});

describe("Canvas reader", () => {
	const canvas = fixture("Boards/Valid.canvas");

	it("reads file cards, backgrounds and links in text cards", () => {
		const read = readCanvas(canvas);
		expect(read.issues).toEqual([]);
		expect(read.occurrences.map((o) => [o.key, o.linkpath, o.subpath, o.form])).toEqual([
			["c:g1:background", "Travel/attachments/bamboo-grove.png", "", "path"],
			["c:a1b2:file", "Assets/2024/kyoto-temple.jpg", "", "path"],
			["c:n7f2:file", "Research/old/fig-3.png", "", "path"],
			["c:p9:file", "Research/Papers/attention-is-all-you-need.pdf", "#page=3", "path"],
			["c:t1:text:0", "my photo 1.png", "", "wikilink"],
			["c:t1:text:1", "Finance/budget-2025.xlsx", "", "markdown"],
			["c:t1:text:2", "gone-photo.png", "", "wikilink"],
			["c:n1:file", "Welcome.md", "", "path"],
		]);
	});

	it("maps text-card links to the exact JSON characters", () => {
		for (const o of readCanvas(canvas).occurrences) {
			expect(canvas.slice(o.pathStart, o.pathEnd)).toBe(o.linkpath);
		}
		const tricky = JSON.stringify({ nodes: [{ id: "t", type: "text", text: 'Café "q"\n![[a b.png|2]]', x: 0, y: 0, width: 1, height: 1 }] }).replace("é", "\\u00e9");
		const [o] = readCanvas(tricky).occurrences;
		expect(o?.linkpath).toBe("a b.png");
		expect(tricky.slice(o?.pathStart, o?.pathEnd)).toBe("a b.png");
		expect(tricky.slice(o?.start, o?.end)).toBe("![[a b.png|2]]");
	});

	it("reports invalid JSON with its position and reads nothing", () => {
		const read = readCanvas(fixture("Boards/Malformed.canvas"));
		expect(read.occurrences).toEqual([]);
		expect(read.issues[0]?.kind).toBe("parse-error");
		expect(read.issues[0]?.message).toMatch(/line 4, column 2/);
	});

	it("parses JSON with positions", () => {
		const node = parseJsonWithPositions('﻿{"a": [1, "x\\"y", true, null]}');
		expect(node.type).toBe("object");
		expect(() => parseJsonWithPositions('{"a": 1,}')).toThrow(/line 1/);
	});
});

describe("Bases reader", () => {
	it("finds static literals in filters, formulas and view filters", () => {
		const text = fixture("Bases/Static.base");
		const read = readBase(text, { offset: 0, keyPrefix: "", embedded: false, fileText: text });
		expect(read.issues).toEqual([]);
		expect(read.occurrences.map((o) => [o.key, o.linkpath, o.form, o.confidence, o.place.type === "base" ? o.place.fn : ""])).toEqual([
			["b:filters.and[0]:0", "attention-is-all-you-need.pdf", "path", "explicit", "hasLink"],
			["b:formulas.thumb:0", "Assets/2024/kyoto-temple.jpg", "path", "explicit", "image"],
			["b:formulas.hero:0", "hero-old.png", "path", "explicit", "image"],
			["b:formulas.doc:0", "report.docx", "wikilink", "explicit", "link"],
			["b:formulas.sheet:0", "Finance/budget-2025.xlsx", "path", "explicit", "file"],
			["b:views[0].filters.and[0]:0", "diagram-old.svg", "path", "explicit", "hasLink"],
		]);
		for (const o of read.occurrences) expect(text.slice(o.pathStart, o.pathEnd)).toBe(o.linkpath);
	});

	it("reports dynamic expressions and treats wikilink strings as uncertain", () => {
		const text = fixture("Bases/Dynamic.base");
		const read = readBase(text, { offset: 0, keyPrefix: "", embedded: false, fileText: text });
		expect(read.occurrences.map((o) => [o.linkpath, o.confidence])).toEqual([["banner-dune.jpg", "uncertain"]]);
		expect(read.issues).toHaveLength(1);
		expect(read.issues[0]?.message).toMatch(/^2 expressions/);
		expect(read.issues[0]?.detail).toBe('formula thumb: image(cover_dir + "/" + file.name + ".png")');
		const [o] = read.occurrences;
		expect(text.slice(o?.pathStart, o?.pathEnd)).toBe("banner-dune.jpg");
	});

	it("reads live base blocks in notes only", () => {
		const text = fixture("Bases/Embedded.md");
		const read = readEmbeddedBases(text, null);
		expect(read.occurrences.map((o) => [o.key, o.linkpath])).toEqual([
			["e0:b:formulas.pic:0", "Travel/attachments/bamboo-grove.png"],
			["e0:b:formulas.old:0", "Travel/attachments/bamboo-old.png"],
		]);
		for (const o of read.occurrences) expect(text.slice(o.pathStart, o.pathEnd)).toBe(o.linkpath);
	});

	it("reports invalid YAML", () => {
		const read = readBase("formulas:\n  a: [unclosed\n", { offset: 0, keyPrefix: "", embedded: false, fileText: "" });
		expect(read.issues[0]?.kind).toBe("parse-error");
	});

	it("tokenizes calls without evaluating them", () => {
		expect(scanExpression('file(link("[[a.png]]"))').literals.map((l) => l.fn)).toEqual(["link"]);
		expect(scanExpression('file(link("[[a.png]]"))').dynamic).toEqual([]);
		expect(scanExpression("this.file.hasLink(file)").dynamic).toEqual([]);
		expect(scanExpression('image("a" + b)').dynamic).toHaveLength(1);
		expect(scanExpression('note.file("x.png")').literals).toEqual([]);
		expect(scanExpression('"unclosed').malformed).toBe(true);
		expect(scanExpression('link("a\\"b.png")').literals[0]?.token.escaped).toBe(true);
	});
});
