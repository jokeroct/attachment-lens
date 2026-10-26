// Parsers and writers for single link occurrences. Offsets are relative to the parsed text.
import { safeDecode } from "../paths";

export interface ParsedWikilink {
	embed: boolean;
	/** Span of the path before any "#subpath" or "|alias". */
	pathStart: number;
	pathEnd: number;
	path: string;
	/** "#heading", "#^block" or "#page=3", or "" */
	subpath: string;
	/** Text after the separator: an alias, a caption or an image size such as "400". */
	alias: string | null;
	/** True when the separator is "\|", as Obsidian writes it inside tables. */
	escapedPipe: boolean;
}

/** Parses text that is exactly one wikilink, such as `![[photo.png|400]]`. */
export function parseWikilink(text: string): ParsedWikilink | null {
	const embed = text.startsWith("!");
	const open = embed ? 1 : 0;
	if (!text.startsWith("[[", open) || !text.endsWith("]]")) return null;
	const innerStart = open + 2;
	const innerEnd = text.length - 2;
	if (innerEnd <= innerStart) return null;
	const inner = text.slice(innerStart, innerEnd);
	if (inner.includes("\n") || inner.includes("[[") || inner.includes("]]")) return null;
	const pipe = inner.indexOf("|");
	let linkEnd = pipe === -1 ? inner.length : pipe;
	let escapedPipe = false;
	if (pipe > 0 && inner[pipe - 1] === "\\") {
		escapedPipe = true;
		linkEnd = pipe - 1;
	}
	const link = inner.slice(0, linkEnd);
	const hash = link.indexOf("#");
	const path = hash === -1 ? link : link.slice(0, hash);
	return {
		embed,
		pathStart: innerStart,
		pathEnd: innerStart + path.length,
		path,
		subpath: hash === -1 ? "" : link.slice(hash),
		alias: pipe === -1 ? null : inner.slice(pipe + 1),
		escapedPipe,
	};
}

export interface ParsedDestination {
	/** True for `<path with spaces.png>` */
	angle: boolean;
	/** Span of the raw (possibly percent-encoded) path, before any "#". */
	pathStart: number;
	pathEnd: number;
	rawPath: string;
	/** Percent-decoded path */
	path: string;
	/** Percent-decoded "#..." part, or "" */
	subpath: string;
	/** True when non-ASCII characters were percent-encoded, as in `caf%C3%A9.png` */
	encodesUnicode: boolean;
}

/** Splits a raw Markdown destination (without angle brackets) into path and subpath. */
function splitDestination(raw: string, offset: number, angle: boolean): ParsedDestination {
	const hash = raw.indexOf("#");
	const rawPath = hash === -1 ? raw : raw.slice(0, hash);
	return {
		angle,
		pathStart: offset,
		pathEnd: offset + rawPath.length,
		rawPath,
		path: safeDecode(rawPath),
		subpath: hash === -1 ? "" : safeDecode(raw.slice(hash)),
		encodesUnicode: /%[c-fC-F][0-9a-fA-F]%[89abAB][0-9a-fA-F]/.test(rawPath),
	};
}

export interface ParsedMarkdownLink extends ParsedDestination {
	embed: boolean;
	text: string;
}

/** Index just past the "]" that closes the "[" at `open`, or -1. Handles nesting and escapes. */
export function findClosingBracket(text: string, open: number): number {
	let depth = 0;
	for (let i = open; i < text.length; i++) {
		const ch = text[i];
		if (ch === "\\") {
			i++;
			continue;
		}
		if (ch === "\n" && text[i + 1] === "\n") return -1;
		if (ch === "[") depth++;
		else if (ch === "]") {
			depth--;
			if (depth === 0) return i + 1;
		}
	}
	return -1;
}

/**
 * Finds the end of an inline destination starting at `open` (the "(").
 * Returns the index just past ")" and the destination's raw span, or null.
 */
export function scanInlineDestination(text: string, open: number): { end: number; destStart: number; destEnd: number; angle: boolean } | null {
	let i = open + 1;
	while (text[i] === " " || text[i] === "\t") i++;
	let destStart: number;
	let destEnd: number;
	let angle = false;
	if (text[i] === "<") {
		angle = true;
		destStart = i + 1;
		const close = text.indexOf(">", destStart);
		if (close === -1) return null;
		const dest = text.slice(destStart, close);
		if (dest.includes("\n") || dest.includes("<")) return null;
		destEnd = close;
		i = close + 1;
	} else {
		destStart = i;
		let depth = 0;
		for (; i < text.length; i++) {
			const ch = text[i];
			if (ch === "\\") {
				i++;
				continue;
			}
			if (ch === " " || ch === "\t" || ch === "\n") break;
			if (ch === "(") depth++;
			else if (ch === ")") {
				if (depth === 0) break;
				depth--;
			}
		}
		destEnd = i;
	}
	while (text[i] === " " || text[i] === "\t") i++;
	const quote = text[i];
	if (quote === '"' || quote === "'" || quote === "(") {
		const closeChar = quote === "(" ? ")" : quote;
		const close = text.indexOf(closeChar, i + 1);
		if (close === -1) return null;
		i = close + 1;
		while (text[i] === " " || text[i] === "\t") i++;
	}
	if (text[i] !== ")") return null;
	return { end: i + 1, destStart, destEnd, angle };
}

/** Parses text that is exactly one inline Markdown link or image, such as `![Fig. 2](my%20photo.png)`. */
export function parseMarkdownLink(text: string): ParsedMarkdownLink | null {
	const embed = text.startsWith("!");
	const open = embed ? 1 : 0;
	if (text[open] !== "[") return null;
	const close = findClosingBracket(text, open);
	if (close === -1 || text[close] !== "(") return null;
	const dest = scanInlineDestination(text, close);
	if (!dest || dest.end !== text.length) return null;
	const raw = text.slice(dest.destStart, dest.destEnd);
	if (raw === "") return null;
	return {
		embed,
		text: text.slice(open + 1, close - 1),
		...splitDestination(raw, dest.destStart, dest.angle),
	};
}

export interface ParsedReferenceDefinition extends ParsedDestination {
	label: string;
}

const DEFINITION = /^( {0,3})\[((?:[^\]\\\n]|\\.)+)\]:[ \t]*(<[^<>\n]*>|\S+)(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?[ \t]*$/;

/** Parses one line that is a reference-style definition, such as `[fig1]: assets/fig-1.png "Caption"`. */
export function parseReferenceDefinition(line: string): ParsedReferenceDefinition | null {
	const match = DEFINITION.exec(line);
	if (!match) return null;
	const indent = match[1] ?? "";
	const label = match[2] ?? "";
	const dest = match[3] ?? "";
	const destOffset = line.indexOf("]:", indent.length + 1) + 2;
	const at = line.indexOf(dest, destOffset);
	const angle = dest.startsWith("<");
	const raw = angle ? dest.slice(1, -1) : dest;
	if (raw === "") return null;
	return { label, ...splitDestination(raw, angle ? at + 1 : at, angle) };
}

/** Normalizes a reference label the way CommonMark matches them. */
export function normalizeLabel(label: string): string {
	return label.trim().replace(/\s+/g, " ").toLowerCase();
}

const WIKILINK_FORBIDDEN = /[[\]|#\n]/;

/** Path text for a wikilink, or null when the path can't be written inside one. */
export function renderWikilinkPath(path: string): string | null {
	return WIKILINK_FORBIDDEN.test(path) ? null : path;
}

const MARKDOWN_ENCODE = new Set([..." %()<>#?[]\\^`{}|\"'"]);

/**
 * Path text for a Markdown destination, keeping the original's style: angle brackets stay, and
 * non-ASCII characters are percent-encoded only if the original encoded them.
 * Returns null when the path can't be written in that style.
 */
export function renderMarkdownPath(path: string, style: { angle: boolean; encodesUnicode: boolean }): string | null {
	if (path.includes("\n")) return null;
	if (style.angle) {
		if (/[<>#]/.test(path)) return null;
		return path;
	}
	let out = "";
	for (const ch of path) {
		const code = ch.codePointAt(0) ?? 0;
		if (code < 0x80) {
			// encodeURIComponent leaves ( ) ' alone, so ASCII is encoded by hand.
			out += MARKDOWN_ENCODE.has(ch) || code < 0x20 || code === 0x7f ? `%${code.toString(16).toUpperCase().padStart(2, "0")}` : ch;
		} else {
			out += style.encodesUnicode ? encodeURIComponent(ch) : ch;
		}
	}
	return out;
}

/** Splits Obsidian linktext into path and subpath at the first "#", like Obsidian's parseLinktext. */
export function splitLinktext(linktext: string): { path: string; subpath: string } {
	const hash = linktext.indexOf("#");
	return hash === -1 ? { path: linktext, subpath: "" } : { path: linktext.slice(0, hash), subpath: linktext.slice(hash) };
}
