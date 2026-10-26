// Builds and checks the single edit a repair makes: the path characters of one reference.
import { readBase, readEmbeddedBases } from "../bases/bases";
import { readCanvas } from "../canvas/canvas";
import { escapeJsonText } from "../canvas/json";
import { parseMarkdownLink, parseReferenceDefinition, parseWikilink, renderMarkdownPath, renderWikilinkPath } from "../markdown/links";
import { contextLines, diffParts } from "../text";
import type { Occurrence } from "../types";
import { locateProperty } from "../yaml/frontmatter";
import { escapeForScalar } from "../yaml/scalars";

export type Rendered = { ok: true; text: string } | { ok: false; reason: string };

/** The characters to write in place of the old path, escaped for every layer around it. */
export function renderTarget(path: string, occurrence: Occurrence): Rendered {
	if (path.includes("\n") || path.includes("\r")) return { ok: false, reason: "The path contains a line break." };
	let text: string | null;
	const inner = occurrence.inner;
	if (inner.kind === "wikilink") {
		text = renderWikilinkPath(path);
		if (text === null) return { ok: false, reason: "The file's path contains [ ] | or #, which a wikilink can't hold." };
	} else if (inner.kind === "markdown") {
		text = renderMarkdownPath(path, inner);
		if (text === null) return { ok: false, reason: "The file's path can't be written in this link's style." };
	} else {
		if (occurrence.place.type !== "canvas" && path.includes("#")) return { ok: false, reason: "The file's path contains #, which would be read as a heading or page." };
		text = path;
	}
	for (const layer of occurrence.layers) {
		if (layer.kind === "json-string") text = escapeJsonText(text);
		else if (layer.kind === "yaml") text = escapeForScalar(text, layer.style);
		else if (text.includes(layer.quote) || text.includes("\\")) {
			return { ok: false, reason: "The path contains a quote or backslash, which this expression can't hold without new escaping." };
		}
	}
	return { ok: true, text };
}

export interface Edit {
	start: number;
	end: number;
	before: string;
	after: string;
}

export function makeEdit(text: string, occurrence: Occurrence, rendered: string): Edit {
	return { start: occurrence.pathStart, end: occurrence.pathEnd, before: text.slice(occurrence.pathStart, occurrence.pathEnd), after: rendered };
}

export class EditMismatchError extends Error {}

/** Applies an edit, checking the characters being replaced are still the expected ones. */
export function applyEdit(text: string, edit: Edit): string {
	if (text.slice(edit.start, edit.end) !== edit.before) throw new EditMismatchError("The text at the edit position isn't what was previewed.");
	return text.slice(0, edit.start) + edit.after + text.slice(edit.end);
}

export type Verified = { ok: true } | { ok: false; reason: string };

const fail = (reason: string): Verified => ({ ok: false, reason });

/**
 * Checks a result: everything outside the edit is unchanged, the file still parses, and the same
 * reference now reads as `expectedPath` with its subpath, alias and form intact.
 */
export function verifyResult(before: string, after: string, edit: Edit, occurrence: Occurrence, expectedPath: string, codeStarts: ReadonlySet<number> | null): Verified {
	const delta = edit.after.length - edit.before.length;
	if (after.length !== before.length + delta) return fail("The result has an unexpected length.");
	if (after.slice(0, edit.start) !== before.slice(0, edit.start)) return fail("Text before the reference changed.");
	if (after.slice(edit.start + edit.after.length) !== before.slice(edit.end)) return fail("Text after the reference changed.");

	const place = occurrence.place;
	if (place.type === "body") {
		const oldText = before.slice(occurrence.start, occurrence.end);
		const newText = after.slice(occurrence.start, occurrence.end + delta);
		if (occurrence.form === "wikilink") {
			const a = parseWikilink(oldText);
			const b = parseWikilink(newText);
			if (!a || !b) return fail("The link no longer parses.");
			if (b.path !== expectedPath || b.subpath !== a.subpath || b.alias !== a.alias || b.embed !== a.embed) return fail("The link doesn't read as expected after the change.");
			return { ok: true };
		}
		const a = occurrence.form === "refdef" ? parseReferenceDefinition(oldText) : parseMarkdownLink(oldText);
		const b = occurrence.form === "refdef" ? parseReferenceDefinition(newText) : parseMarkdownLink(newText);
		if (!a || !b) return fail("The link no longer parses.");
		if (b.path !== expectedPath || b.subpath !== a.subpath || b.angle !== a.angle) return fail("The link doesn't read as expected after the change.");
		return { ok: true };
	}
	if (place.type === "property") {
		const found = locateProperty(after, place.key, place.index);
		if (!found.ok) return fail(`The properties block doesn't read correctly after the change: ${found.reason}`);
		const value = found.scalar.value.trim();
		if (occurrence.form === "wikilink") {
			const wiki = parseWikilink(value);
			const old = parseWikilink(occurrence.original.trim());
			if (!wiki || !old || wiki.path !== expectedPath || wiki.subpath !== old.subpath || wiki.alias !== old.alias) return fail("The property doesn't read as expected after the change.");
		} else if (value !== expectedPath + occurrence.subpath) {
			return fail("The property doesn't read as expected after the change. Its quoting may not allow this path.");
		}
		return { ok: true };
	}
	const read =
		place.type === "canvas"
			? readCanvas(after)
			: place.embedded
				? readEmbeddedBases(after, codeStarts)
				: readBase(after, { offset: 0, keyPrefix: "", embedded: false, fileText: after });
	if (read.issues.some((issue) => issue.kind === "parse-error")) return fail("The file doesn't parse after the change.");
	const again = read.occurrences.find((o) => o.key === occurrence.key);
	if (!again || again.linkpath !== expectedPath || again.subpath !== occurrence.subpath) return fail("The reference doesn't read as expected after the change.");
	return { ok: true };
}

export interface DiffLine {
	sign: " " | "-" | "+";
	no: number;
	text: string;
	/** Changed characters within the line, as [start, end) */
	mark?: [number, number];
}

export function buildDiff(before: string, after: string, edit: Edit): DiffLine[] {
	const oldLines = contextLines(before, edit.start, edit.end);
	const newLines = contextLines(after, edit.start, edit.start + edit.after.length);
	const removed = oldLines.filter((l) => l.changed);
	const added = newLines.filter((l) => l.changed);
	const out: DiffLine[] = [];
	for (const line of oldLines) if (!line.changed && line.no < (removed[0]?.no ?? Infinity)) out.push({ sign: " ", no: line.no, text: line.text });
	removed.forEach((line, i) => {
		const other = added[i]?.text ?? "";
		const parts = diffParts(line.text, other);
		out.push({ sign: "-", no: line.no, text: line.text, mark: [parts.prefix.length, parts.prefix.length + parts.removed.length] });
	});
	added.forEach((line, i) => {
		const other = removed[i]?.text ?? "";
		const parts = diffParts(other, line.text);
		out.push({ sign: "+", no: line.no, text: line.text, mark: [parts.prefix.length, parts.prefix.length + parts.added.length] });
	});
	const lastRemoved = removed[removed.length - 1]?.no ?? -Infinity;
	for (const line of oldLines) if (!line.changed && line.no > lastRemoved) out.push({ sign: " ", no: line.no, text: line.text });
	return out;
}
