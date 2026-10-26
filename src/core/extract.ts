// Turns a source file into attachment references. Notes come from Obsidian's metadata cache,
// plus the raw text for reference definitions and base blocks; Canvas and Bases files are parsed here.
import type { CachedMetadata } from "obsidian";
import { readBase, readEmbeddedBases } from "./bases/bases";
import { readCanvas } from "./canvas/canvas";
import { hasKnownAttachmentExtension, isAttachmentPath } from "./fileTypes";
import { normalizeLabel, parseMarkdownLink, parseWikilink, splitLinktext } from "./markdown/links";
import { scanMarkdown } from "./markdown/scanner";
import { extname, isExternalTarget } from "./paths";
import type { CoverageIssue, Occurrence, Reference } from "./types";
import { propertyValues } from "./yaml/frontmatter";

/** A reference before resolution. */
export type FoundRef = Omit<Reference, "id" | "sourcePath" | "sourceKind" | "resolvedPath">;

export interface Extraction {
	refs: FoundRef[];
	issues: Omit<CoverageIssue, "sourcePath">[];
	/** Links to URLs and paths outside the vault, which are out of scope */
	external: number;
}

/** `![alt][label]`, `[text][label]` and `[label]` uses, which are read through their definitions. */
const REFERENCE_USE = /^!?\[[^\]]*\](?:\[[^\]]*\])?$/;

export function fromOccurrence(o: Occurrence): FoundRef {
	return {
		key: o.key,
		form: o.form,
		embed: o.embed,
		confidence: o.confidence,
		linkpath: o.linkpath,
		subpath: o.subpath,
		original: o.original,
		place: o.place,
		span: { start: o.start, end: o.end },
		...(o.usages !== undefined ? { usages: o.usages } : {}),
		...(o.blocked ? { blocked: o.blocked } : {}),
	};
}

/** True when the note's raw text is needed: for reference definitions or base blocks. */
export function markdownNeedsText(cache: CachedMetadata): boolean {
	if ((cache.referenceLinks?.length ?? 0) > 0) return true;
	if ((cache.sections ?? []).some((section) => section.type === "code")) return true;
	return [...(cache.links ?? []), ...(cache.embeds ?? [])].some((item) => REFERENCE_USE.test(item.original) && !item.original.startsWith("[["));
}

/** Code blocks Obsidian found, by start offset, so only live ```base blocks are read. */
export function codeBlockStarts(cache: CachedMetadata | null): Set<number> | null {
	if (!cache?.sections) return null;
	return new Set(cache.sections.filter((s) => s.type === "code").map((s) => s.position.start.offset));
}

function looksLikePath(value: string): boolean {
	if (value === "" || value.length > 260 || value.includes("\n")) return false;
	if (value.startsWith("#") || value.includes("[[") || value.includes("]]") || isExternalTarget(value)) return false;
	return /^[\p{L}\p{N}]{1,8}$/u.test(extname(value.split("#")[0] ?? ""));
}

export function extractMarkdown(cache: CachedMetadata | null, text: string | null): Extraction {
	const refs: FoundRef[] = [];
	const issues: Omit<CoverageIssue, "sourcePath">[] = [];
	let external = 0;
	if (!cache) {
		issues.push({ kind: "not-indexed", message: "Obsidian hasn't indexed this note yet. It's read again once Obsidian finishes." });
		return { refs, issues, external };
	}

	for (const item of [...(cache.embeds ?? []), ...(cache.links ?? [])]) {
		const { original } = item;
		const { path, subpath } = splitLinktext(item.link);
		if (path.trim() === "") continue;
		if (isExternalTarget(path)) {
			external++;
			continue;
		}
		const wiki = parseWikilink(original);
		const markdown = wiki ? null : parseMarkdownLink(original);
		if (!wiki && !markdown && REFERENCE_USE.test(original)) continue;
		let blocked: string | undefined;
		const ours = wiki?.path ?? markdown?.path;
		if (ours === undefined) blocked = "Attachment Lens can't read this link's syntax exactly, so it won't edit it.";
		else if (ours !== path) blocked = "Obsidian reads this link differently from how it's written, so it won't be edited automatically.";
		const start = item.position.start.offset;
		refs.push({
			key: `t:${start}`,
			form: wiki || original.includes("[[") ? "wikilink" : "markdown",
			embed: original.startsWith("!"),
			confidence: "explicit",
			linkpath: path,
			subpath,
			original,
			place: { type: "body", line: item.position.start.line + 1, col: item.position.start.col + 1 },
			span: { start, end: item.position.end.offset },
			...(blocked ? { blocked } : {}),
		});
	}

	if (cache.frontmatter) {
		for (const { key, index, value } of propertyValues(cache.frontmatter)) {
			const trimmed = value.trim();
			const wiki = parseWikilink(trimmed);
			const place = { type: "property" as const, key, index };
			const propertyKey = `p:${key}:${index ?? ""}`;
			if (wiki) {
				if (wiki.path.trim() === "" || isExternalTarget(wiki.path)) continue;
				refs.push({ key: propertyKey, form: "wikilink", embed: wiki.embed, confidence: "explicit", linkpath: wiki.path, subpath: wiki.subpath, original: value, place, span: null });
			} else if (looksLikePath(trimmed)) {
				const split = splitLinktext(trimmed);
				refs.push({ key: propertyKey, form: "path", embed: false, confidence: "uncertain", linkpath: split.path, subpath: split.subpath, original: value, place, span: null });
			}
		}
	}

	if (text !== null) {
		const scan = scanMarkdown(text, { skipFrontmatter: true });
		for (const def of scan.definitions) {
			if (isExternalTarget(def.linkpath) || def.linkpath.trim() === "") continue;
			const line = text.slice(0, def.start).split("\n").length;
			refs.push({
				key: `d:${normalizeLabel(def.label ?? "")}`,
				form: "refdef",
				embed: def.embed,
				confidence: "explicit",
				linkpath: def.linkpath,
				subpath: def.subpath,
				original: def.original,
				place: { type: "body", line, col: 1 },
				span: { start: def.start, end: def.end },
				usages: def.usages ?? 0,
			});
		}
		const bases = readEmbeddedBases(text, codeBlockStarts(cache));
		refs.push(...bases.occurrences.map(fromOccurrence));
		issues.push(...bases.issues);
	}
	return { refs, issues, external };
}

export function extractCanvas(text: string): Extraction {
	const read = readCanvas(text);
	return { refs: read.occurrences.map(fromOccurrence), issues: read.issues, external: 0 };
}

export function extractBaseFile(text: string): Extraction {
	const read = readBase(text, { offset: 0, keyPrefix: "", embedded: false, fileText: text });
	return { refs: read.occurrences.map(fromOccurrence), issues: read.issues, external: 0 };
}

/**
 * Whether a resolved or broken reference concerns an attachment. Links that open notes, boards or
 * bases are left to Obsidian, and so are broken links without a known attachment extension.
 */
export function isAttachmentReference(linkpath: string, resolvedPath: string | null): boolean {
	if (resolvedPath !== null) return isAttachmentPath(resolvedPath);
	return hasKnownAttachmentExtension(linkpath);
}
