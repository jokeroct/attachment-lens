// Finds a scanned reference again in a source's current text, with the exact characters to edit.
import { readBase, readEmbeddedBases } from "../bases/bases";
import { readCanvas } from "../canvas/canvas";
import { parseMarkdownLink, parseReferenceDefinition, parseWikilink } from "../markdown/links";
import type { Occurrence, Reference } from "../types";
import { locateProperty } from "../yaml/frontmatter";

export type LocateResult = { ok: true; occurrence: Occurrence } | { ok: false; reason: string; changed: boolean };

const CHANGED = "The file changed after it was scanned. The list has been refreshed; select the reference again.";

type RefLike = Pick<Reference, "key" | "form" | "embed" | "confidence" | "linkpath" | "subpath" | "original" | "place" | "span" | "usages" | "blocked">;

function base(ref: RefLike): Omit<Occurrence, "inner" | "layers" | "start" | "end" | "pathStart" | "pathEnd"> {
	return {
		key: ref.key,
		form: ref.form,
		embed: ref.embed,
		confidence: ref.confidence,
		original: ref.original,
		linkpath: ref.linkpath,
		subpath: ref.subpath,
		place: ref.place,
		...(ref.usages !== undefined ? { usages: ref.usages } : {}),
		...(ref.blocked ? { blocked: ref.blocked } : {}),
	};
}

function locateBody(text: string, ref: RefLike): LocateResult {
	const span = ref.span;
	if (!span || text.slice(span.start, span.end) !== ref.original) return { ok: false, reason: CHANGED, changed: true };
	const at = span.start;
	if (ref.form === "wikilink") {
		const wiki = parseWikilink(ref.original);
		if (!wiki) return { ok: false, reason: "This link's syntax can't be edited safely.", changed: false };
		return { ok: true, occurrence: { ...base(ref), inner: { kind: "wikilink" }, layers: [], start: span.start, end: span.end, pathStart: at + wiki.pathStart, pathEnd: at + wiki.pathEnd } };
	}
	const parsed = ref.form === "refdef" ? parseReferenceDefinition(ref.original) : parseMarkdownLink(ref.original);
	if (!parsed) return { ok: false, reason: "This link's syntax can't be edited safely.", changed: false };
	return {
		ok: true,
		occurrence: {
			...base(ref),
			inner: { kind: "markdown", angle: parsed.angle, encodesUnicode: parsed.encodesUnicode },
			layers: [],
			start: span.start,
			end: span.end,
			pathStart: at + parsed.pathStart,
			pathEnd: at + parsed.pathEnd,
		},
	};
}

function locatePropertyRef(text: string, ref: RefLike): LocateResult {
	if (ref.place.type !== "property") return { ok: false, reason: CHANGED, changed: true };
	const found = locateProperty(text, ref.place.key, ref.place.index);
	if (!found.ok) return { ok: false, reason: found.reason, changed: true };
	const { scalar, flow } = found;
	if (scalar.value !== ref.original) return { ok: false, reason: CHANGED, changed: true };
	const lead = scalar.value.length - scalar.value.trimStart().length;
	const trimmed = scalar.value.trim();
	let from: number;
	let to: number;
	if (ref.form === "wikilink") {
		const wiki = parseWikilink(trimmed);
		if (!wiki) return { ok: false, reason: CHANGED, changed: true };
		from = lead + wiki.pathStart;
		to = lead + wiki.pathEnd;
	} else {
		from = lead;
		to = lead + ref.linkpath.length;
	}
	return {
		ok: true,
		occurrence: {
			...base(ref),
			inner: ref.form === "wikilink" ? { kind: "wikilink" } : { kind: "path" },
			layers: [{ kind: "yaml", style: scalar.style, flow }],
			start: scalar.rawStart,
			end: scalar.rawEnd,
			pathStart: scalar.map[from] as number,
			pathEnd: scalar.map[to] as number,
		},
	};
}

/**
 * Locates `ref` in `text`. `codeStarts` are Obsidian's code block offsets for the note, used for
 * base blocks; null accepts every fence.
 */
export function locateReference(text: string, ref: RefLike, codeStarts: ReadonlySet<number> | null): LocateResult {
	const place = ref.place;
	let candidates: Occurrence[];
	if (place.type === "body") return locateBody(text, ref);
	if (place.type === "property") return locatePropertyRef(text, ref);
	if (place.type === "canvas") candidates = readCanvas(text).occurrences;
	else if (place.embedded) candidates = readEmbeddedBases(text, codeStarts).occurrences;
	else candidates = readBase(text, { offset: 0, keyPrefix: "", embedded: false, fileText: text }).occurrences;
	const occurrence = candidates.find((o) => o.key === ref.key && o.original === ref.original && o.linkpath === ref.linkpath);
	if (!occurrence) return { ok: false, reason: CHANGED, changed: true };
	return { ok: true, occurrence };
}
