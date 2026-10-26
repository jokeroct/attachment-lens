import { describe, expect, it } from "vitest";
import {
	parseMarkdownLink,
	parseReferenceDefinition,
	parseWikilink,
	renderMarkdownPath,
	renderWikilinkPath,
	splitLinktext,
} from "../src/core/markdown/links";
import { safeDecode } from "../src/core/paths";

describe("parseWikilink", () => {
	it("reads embeds, sizes, aliases and subpaths", () => {
		const w = parseWikilink("![[kyoto-temple.jpeg|400]]");
		expect(w).toMatchObject({ embed: true, path: "kyoto-temple.jpeg", subpath: "", alias: "400", escapedPipe: false });
		expect("![[kyoto-temple.jpeg|400]]".slice(w?.pathStart, w?.pathEnd)).toBe("kyoto-temple.jpeg");

		expect(parseWikilink("[[paper.pdf#page=3|The paper]]")).toMatchObject({ embed: false, path: "paper.pdf", subpath: "#page=3", alias: "The paper" });
		expect(parseWikilink("[[Assets/2023/cover.png]]")).toMatchObject({ path: "Assets/2023/cover.png", alias: null });
		expect(parseWikilink("![[my photo 1.png|300x200]]")).toMatchObject({ path: "my photo 1.png", alias: "300x200" });
	});

	it("handles the escaped pipe Obsidian writes inside tables", () => {
		const text = "![[kyoto-temple.jpg\\|120]]";
		const w = parseWikilink(text);
		expect(w).toMatchObject({ path: "kyoto-temple.jpg", alias: "120", escapedPipe: true });
		expect(text.slice(w?.pathStart, w?.pathEnd)).toBe("kyoto-temple.jpg");
	});

	it("rejects text that isn't exactly one wikilink", () => {
		expect(parseWikilink("[[a.png]] and [[b.png]]")).toBeNull();
		expect(parseWikilink("[[a.png")).toBeNull();
		expect(parseWikilink("[[]]")).toBeNull();
		expect(parseWikilink("[[a\nb.png]]")).toBeNull();
	});
});

describe("parseMarkdownLink", () => {
	it("decodes percent-encoded paths and keeps the raw span", () => {
		const text = "![Photo](../Assets/my%20photo%201.png)";
		const m = parseMarkdownLink(text);
		expect(m).toMatchObject({ embed: true, text: "Photo", path: "../Assets/my photo 1.png", angle: false, subpath: "" });
		expect(text.slice(m?.pathStart, m?.pathEnd)).toBe("../Assets/my%20photo%201.png");
	});

	it("reads angle brackets, titles, subpaths and Unicode encoding", () => {
		expect(parseMarkdownLink("![Photo|250](<../Assets/my photo 1.png>)")).toMatchObject({ angle: true, path: "../Assets/my photo 1.png", text: "Photo|250" });
		expect(parseMarkdownLink('[Paper](paper.pdf "The paper")')).toMatchObject({ path: "paper.pdf" });
		expect(parseMarkdownLink("[p](paper.pdf#page=3)")).toMatchObject({ path: "paper.pdf", subpath: "#page=3" });
		expect(parseMarkdownLink("![Café](../Assets/caf%C3%A9.png)")).toMatchObject({ path: "../Assets/café.png", encodesUnicode: true });
		expect(parseMarkdownLink("[a](b(c).png)")).toMatchObject({ path: "b(c).png" });
		expect(parseMarkdownLink('[the "budget"](Finance/budget-2025.xlsx)')).toMatchObject({ path: "Finance/budget-2025.xlsx" });
	});

	it("rejects malformed links", () => {
		expect(parseMarkdownLink("[a](b.png")).toBeNull();
		expect(parseMarkdownLink("[a]()")).toBeNull();
		expect(parseMarkdownLink("[a] (b.png)")).toBeNull();
		expect(parseMarkdownLink("[a](b.png) trailing")).toBeNull();
	});
});

describe("parseReferenceDefinition", () => {
	it("reads plain and angle-bracket destinations with titles", () => {
		const line = '[fig1]: ../Research/Figures/fig-1.png "Figure 1"';
		const d = parseReferenceDefinition(line);
		expect(d).toMatchObject({ label: "fig1", path: "../Research/Figures/fig-1.png", angle: false });
		expect(line.slice(d?.pathStart, d?.pathEnd)).toBe("../Research/Figures/fig-1.png");
		const angle = "[budget]: <../Finance/budget 2025.xlsx>";
		const a = parseReferenceDefinition(angle);
		expect(a).toMatchObject({ angle: true, path: "../Finance/budget 2025.xlsx" });
		expect(angle.slice(a?.pathStart, a?.pathEnd)).toBe("../Finance/budget 2025.xlsx");
	});

	it("rejects lines that aren't definitions", () => {
		expect(parseReferenceDefinition("    [a]: b.png")).toBeNull();
		expect(parseReferenceDefinition("[a] b.png")).toBeNull();
		expect(parseReferenceDefinition("text [a]: b.png")).toBeNull();
	});
});

describe("writers", () => {
	it("encodes Markdown paths so they decode back exactly", () => {
		const paths = ["Assets/my photo 1.png", "a(b)c.png", "Assets/Ünïcödé 写真.png", "100%.png", "x#y.png", "it's.png", "[a].png"];
		for (const path of paths) {
			for (const encodesUnicode of [false, true]) {
				const out = renderMarkdownPath(path, { angle: false, encodesUnicode });
				expect(out).not.toBeNull();
				expect(out).not.toMatch(/[\s()#]/);
				expect(safeDecode(out as string)).toBe(path);
				const link = parseMarkdownLink(`![](${out as string})`);
				expect(link?.path).toBe(path);
				expect(link?.subpath).toBe("");
			}
		}
		expect(renderMarkdownPath("café.png", { angle: false, encodesUnicode: false })).toBe("café.png");
		expect(renderMarkdownPath("café.png", { angle: false, encodesUnicode: true })).toBe("caf%C3%A9.png");
	});

	it("keeps angle-bracket style and refuses what it can't hold", () => {
		expect(renderMarkdownPath("my photo.png", { angle: true, encodesUnicode: false })).toBe("my photo.png");
		expect(renderMarkdownPath("a>b.png", { angle: true, encodesUnicode: false })).toBeNull();
		expect(renderWikilinkPath("Assets/my photo 1.png")).toBe("Assets/my photo 1.png");
		expect(renderWikilinkPath("a|b.png")).toBeNull();
		expect(renderWikilinkPath("a#b.png")).toBeNull();
		expect(renderWikilinkPath("a]b.png")).toBeNull();
	});

	it("splits linktext like Obsidian", () => {
		expect(splitLinktext("paper.pdf#page=3")).toEqual({ path: "paper.pdf", subpath: "#page=3" });
		expect(splitLinktext("a.png")).toEqual({ path: "a.png", subpath: "" });
	});
});
