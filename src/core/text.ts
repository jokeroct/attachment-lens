import { splitLines, type Line } from "./markdown/scanner";

/** 1-based line and column of an offset. */
export function lineColAt(text: string, offset: number): { line: number; col: number } {
	let line = 1;
	let lineStart = 0;
	for (let i = 0; i < offset && i < text.length; i++) {
		if (text[i] === "\n") {
			line++;
			lineStart = i + 1;
		}
	}
	return { line, col: offset - lineStart + 1 };
}

export interface ContextLine {
	/** 1-based line number */
	no: number;
	text: string;
	/** Part of the change */
	changed: boolean;
}

const MAX_LINE = 200;

/** Shortens a long line (minified JSON, long paragraphs) around the span [from, to). */
function clip(line: string, from: number, to: number): string {
	if (line.length <= MAX_LINE) return line;
	const room = Math.max(0, MAX_LINE - (to - from));
	const start = Math.max(0, from - Math.floor(room / 2));
	const end = Math.min(line.length, start + Math.max(MAX_LINE, to - from));
	return `${start > 0 ? "…" : ""}${line.slice(start, end)}${end < line.length ? "…" : ""}`;
}

/** Lines around the span [start, end) of text, with `around` lines of context on each side. */
export function contextLines(text: string, start: number, end: number, around = 2): ContextLine[] {
	const lines = splitLines(text);
	const first = lines.findIndex((l) => start <= l.end);
	let last = lines.findIndex((l) => end <= l.end);
	if (last === -1) last = lines.length - 1;
	const from = Math.max(0, first - around);
	const to = Math.min(lines.length - 1, last + around);
	const out: ContextLine[] = [];
	for (let i = from; i <= to; i++) {
		const line = lines[i] as Line;
		const changed = i >= first && i <= last;
		const spanFrom = changed ? Math.max(0, start - line.start) : 0;
		const spanTo = changed ? Math.min(line.text.length, end - line.start) : 0;
		out.push({ no: i + 1, text: changed ? clip(line.text, spanFrom, spanTo) : clip(line.text, 0, 0), changed });
	}
	return out;
}

/** The full line (or lines) containing [start, end), without the line break. */
export function linesAround(text: string, start: number, end: number): string {
	const lineStart = text.lastIndexOf("\n", start - 1) + 1;
	let lineEnd = text.indexOf("\n", end);
	if (lineEnd === -1) lineEnd = text.length;
	return text.slice(lineStart, lineEnd).replace(/\r$/, "");
}

/** Splits two strings into common prefix, differing middle and common suffix. */
export function diffParts(before: string, after: string): { prefix: string; removed: string; added: string; suffix: string } {
	let p = 0;
	while (p < before.length && p < after.length && before[p] === after[p]) p++;
	let s = 0;
	while (s < before.length - p && s < after.length - p && before[before.length - 1 - s] === after[after.length - 1 - s]) s++;
	return {
		prefix: before.slice(0, p),
		removed: before.slice(p, before.length - s),
		added: after.slice(p, after.length - s),
		suffix: before.slice(before.length - s),
	};
}
