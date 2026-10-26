import { describe, expect, it } from "vitest";
import { findFences, scanMarkdown } from "../src/core/markdown/scanner";
import { fixture } from "./helpers";

const paths = (text: string) => scanMarkdown(text, { skipFrontmatter: true }).links.map((l) => l.linkpath);

describe("scanMarkdown", () => {
	it("finds wikilinks, embeds and Markdown links with exact spans", () => {
		const text = "See ![[a.png|300]] and [b](sub/b%20c.pdf#page=2).";
		const scan = scanMarkdown(text);
		expect(scan.links).toHaveLength(2);
		const [a, b] = scan.links;
		expect(a).toMatchObject({ form: "wikilink", embed: true, linkpath: "a.png", original: "![[a.png|300]]" });
		expect(text.slice(a?.pathStart, a?.pathEnd)).toBe("a.png");
		expect(b).toMatchObject({ form: "markdown", embed: false, linkpath: "sub/b c.pdf", subpath: "#page=2" });
		expect(text.slice(b?.pathStart, b?.pathEnd)).toBe("sub/b%20c.pdf");
	});

	it("skips code blocks, code spans and escapes, but not comments", () => {
		expect(paths(fixture("Links/Code examples.md"))).toEqual([]);
		// Obsidian's index counts links in %% comments, so the scanner does too.
		expect(paths(fixture("Links/Comments.md"))).toEqual(["site-backup-2023.zip"]);
		expect(paths("``a `![[x.png]]` b`` and \\[\\[y.png\\]\\] and \\[n\\](z.png)")).toEqual([]);
		expect(paths("Unclosed `![[x.png]] is literal")).toEqual(["x.png"]);
	});

	it("finds an image nested inside a link", () => {
		expect(paths("[![thumb](t.png)](full.png)")).toEqual(["full.png", "t.png"]);
	});

	it("skips frontmatter when asked", () => {
		const text = '---\ncover: "[[a.png]]"\n---\n![[b.png]]';
		expect(paths(text)).toEqual(["b.png"]);
		expect(scanMarkdown(text).links.map((l) => l.linkpath)).toEqual(["a.png", "b.png"]);
	});

	it("reads reference definitions and counts their uses", () => {
		const scan = scanMarkdown(fixture("Links/Reference style.md"));
		const byLabel = new Map(scan.definitions.map((d) => [d.label ?? "", d]));
		expect(byLabel.get("fig1")).toMatchObject({ linkpath: "../Research/Figures/fig-1.png", usages: 3, embed: true });
		expect(byLabel.get("budget")).toMatchObject({ linkpath: "../Finance/budget-2025.xlsx", usages: 1, embed: false });
		expect(byLabel.get("gone")).toMatchObject({ usages: 0 });
		expect(scan.links).toEqual([]);
	});

	it("doesn't treat a definition-like line inside a paragraph as a definition", () => {
		const scan = scanMarkdown("Some text\n[a]: b.png\n");
		expect(scan.definitions).toEqual([]);
	});

	it("handles escaped table pipes and Windows line endings", () => {
		const scan = scanMarkdown(fixture("Links/Tables and escapes.md"));
		expect(scan.links.map((l) => [l.linkpath, l.original])).toEqual([
			["kyoto-temple.jpg", "![[kyoto-temple.jpg\\|120]]"],
			["temple-old.jpg", "![[temple-old.jpg\\|120]]"],
		]);
		const crlf = fixture("Links/Windows line endings.md");
		expect(crlf).toContain("\r\n");
		expect(scanMarkdown(crlf).links.map((l) => l.linkpath)).toEqual(["kyoto-temple-old.jpg"]);
	});
});

describe("findFences", () => {
	it("finds base blocks and ignores fences nested in longer fences", () => {
		const fences = findFences(fixture("Bases/Embedded.md"));
		expect(fences.map((f) => f.info)).toEqual(["base", "markdown"]);
		expect(fences.every((f) => f.closed)).toBe(true);
	});

	it("treats an unclosed fence as running to the end", () => {
		const fences = findFences("a\n```\ncode\n");
		expect(fences).toHaveLength(1);
		expect(fences[0]?.closed).toBe(false);
	});
});
