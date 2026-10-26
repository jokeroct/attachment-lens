import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CachedMetadata } from "obsidian";
import { parse } from "yaml";
import { findFences, scanMarkdown } from "../src/core/markdown/scanner";
import { findFrontmatterBlock } from "../src/core/yaml/frontmatter";
import { lineColAt } from "../src/core/text";

export const VAULT = join(import.meta.dirname, "..", "test-vault");

/** Reads a fixture file exactly as stored, without changing line endings. */
export function fixture(path: string): string {
	return readFileSync(join(VAULT, path), "utf8");
}

function loc(text: string, offset: number) {
	const { line, col } = lineColAt(text, offset);
	return { line: line - 1, col: col - 1, offset };
}

/**
 * A stand-in for Obsidian's metadata cache, built with Attachment Lens's own scanner. It follows
 * the documented cache shapes; the native harness checks the real cache.
 */
export function fakeCache(text: string): CachedMetadata {
	const scan = scanMarkdown(text, { skipFrontmatter: true });
	const links: NonNullable<CachedMetadata["links"]> = [];
	const embeds: NonNullable<CachedMetadata["embeds"]> = [];
	for (const link of scan.links) {
		const item = {
			link: link.linkpath + link.subpath,
			original: link.original,
			displayText: "",
			position: { start: loc(text, link.start), end: loc(text, link.end) },
		};
		(link.embed ? embeds : links).push(item);
	}
	const cache: CachedMetadata = { links, embeds };
	const fm = findFrontmatterBlock(text);
	if (fm) {
		cache.frontmatter = (parse(fm.text) as Record<string, unknown> | null) ?? {};
	}
	const fences = findFences(text);
	cache.sections = fences.map((f) => ({ type: "code", position: { start: loc(text, f.start), end: loc(text, f.end) } }));
	if (scan.uses.length > 0) {
		cache.referenceLinks = scan.uses.map((use) => ({ id: use.label, link: "", position: { start: loc(text, use.start), end: loc(text, use.end) } }));
	}
	return cache;
}
