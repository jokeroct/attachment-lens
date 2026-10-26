// Finds links in raw Markdown, for places Obsidian's metadata cache doesn't cover: Canvas text
// cards and reference-style definitions. Code blocks, code spans and %% comments are skipped.
import {
	findClosingBracket,
	normalizeLabel,
	parseMarkdownLink,
	parseReferenceDefinition,
	parseWikilink,
	scanInlineDestination,
} from "./links";

export interface Fence {
	/** Start of the opening fence line */
	start: number;
	/** End of the closing fence line, or of the text when unclosed */
	end: number;
	/** Info string after the opening fence, trimmed, such as "base" */
	info: string;
	contentStart: number;
	contentEnd: number;
	closed: boolean;
}

export interface Line {
	start: number;
	/** End of the line's content, before "\r\n" or "\n" */
	end: number;
	text: string;
}

export function splitLines(text: string): Line[] {
	const lines: Line[] = [];
	let start = 0;
	while (start <= text.length) {
		const nl = text.indexOf("\n", start);
		const rawEnd = nl === -1 ? text.length : nl;
		const end = rawEnd > start && text[rawEnd - 1] === "\r" ? rawEnd - 1 : rawEnd;
		lines.push({ start, end, text: text.slice(start, end) });
		if (nl === -1) break;
		start = nl + 1;
	}
	return lines;
}

const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

/** Fenced code blocks at any indentation of up to three spaces. */
export function findFences(text: string): Fence[] {
	const fences: Fence[] = [];
	const lines = splitLines(text);
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] as Line;
		const open = FENCE_OPEN.exec(line.text);
		if (!open) continue;
		const marker = open[2] as string;
		const info = (open[3] ?? "").trim();
		if (marker[0] === "`" && info.includes("`")) continue;
		const contentStart = i + 1 < lines.length ? (lines[i + 1] as Line).start : text.length;
		let j = i + 1;
		let closed = false;
		for (; j < lines.length; j++) {
			const close = FENCE_CLOSE.exec((lines[j] as Line).text);
			if (close && (close[1] as string)[0] === marker[0] && (close[1] as string).length >= marker.length) {
				closed = true;
				break;
			}
		}
		const closeLine = lines[j];
		fences.push({
			start: line.start,
			end: closed && closeLine ? closeLine.end : text.length,
			info,
			contentStart,
			contentEnd: closed && closeLine ? closeLine.start : text.length,
			closed,
		});
		i = j;
	}
	return fences;
}

/** End of a "---" frontmatter block at the very start of the text, or 0 when there is none. */
export function frontmatterEnd(text: string): number {
	const lines = splitLines(text);
	if (lines[0]?.text !== "---") return 0;
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i] as Line;
		if (line.text === "---" || line.text === "...") return line.end;
	}
	return 0;
}

export type MarkdownForm = "wikilink" | "markdown" | "refdef";

export interface MarkdownOccurrence {
	form: MarkdownForm;
	embed: boolean;
	/** Whole occurrence, such as `![[a.png|400]]` or the definition line */
	start: number;
	end: number;
	original: string;
	/** The path text to replace when repairing */
	pathStart: number;
	pathEnd: number;
	linkpath: string;
	subpath: string;
	/** Reference definitions only: label and number of uses in the text */
	label?: string;
	usages?: number;
}

export interface ReferenceUse {
	label: string;
	embed: boolean;
	start: number;
	end: number;
}

export interface MarkdownScan {
	links: MarkdownOccurrence[];
	definitions: MarkdownOccurrence[];
	uses: ReferenceUse[];
	fences: Fence[];
}

/** Matching close for a code span opened by a run of `n` backticks at `i`, or -1. */
function closeCodeSpan(text: string, i: number, n: number): number {
	let j = i + n;
	while (j < text.length) {
		const next = text.indexOf("`", j);
		if (next === -1) return -1;
		const paragraphBreak = text.indexOf("\n\n", j);
		if (paragraphBreak !== -1 && paragraphBreak < next) return -1;
		let run = 0;
		while (text[next + run] === "`") run++;
		if (run === n) return next + run;
		j = next + run;
	}
	return -1;
}

export interface ScanOptions {
	/** Skip a leading YAML frontmatter block. Notes need this; Canvas text cards don't. */
	skipFrontmatter?: boolean;
}

export function scanMarkdown(text: string, options: ScanOptions = {}): MarkdownScan {
	const fences = findFences(text);
	const skip: [number, number][] = fences.map((f) => [f.start, f.end]);
	const bodyStart = options.skipFrontmatter ? frontmatterEnd(text) : 0;
	if (bodyStart > 0) skip.push([0, bodyStart]);

	const insideSkip = (offset: number): boolean => skip.some(([s, e]) => offset >= s && offset < e);

	// Reference definitions start a line and can't interrupt a paragraph.
	const definitions: MarkdownOccurrence[] = [];
	const lines = splitLines(text);
	let previousBlank = true;
	let previousDefinition = false;
	for (const line of lines) {
		if (insideSkip(line.start)) {
			previousBlank = true;
			previousDefinition = false;
			continue;
		}
		const def = parseReferenceDefinition(line.text);
		if (def && (previousBlank || previousDefinition)) {
			definitions.push({
				form: "refdef",
				embed: false,
				start: line.start,
				end: line.end,
				original: line.text,
				pathStart: line.start + def.pathStart,
				pathEnd: line.start + def.pathEnd,
				linkpath: def.path,
				subpath: def.subpath,
				label: def.label,
				usages: 0,
			});
			skip.push([line.start, line.end]);
			previousDefinition = true;
			previousBlank = false;
			continue;
		}
		previousDefinition = false;
		previousBlank = line.text.trim() === "" || /^#{1,6}\s/.test(line.text);
	}

	const links: MarkdownOccurrence[] = [];
	const uses: ReferenceUse[] = [];
	skip.sort((a, b) => a[0] - b[0]);
	let i = bodyStart;
	while (i < text.length) {
		const range = skip.find(([s, e]) => i >= s && i < e);
		if (range) {
			i = range[1];
			continue;
		}
		const ch = text[i];
		if (ch === "\\") {
			i += 2;
			continue;
		}
		if (ch === "`") {
			let n = 0;
			while (text[i + n] === "`") n++;
			const close = closeCodeSpan(text, i, n);
			i = close === -1 ? i + n : close;
			continue;
		}
		if (ch === "%" && text[i + 1] === "%") {
			const close = text.indexOf("%%", i + 2);
			i = close === -1 ? i + 2 : close + 2;
			continue;
		}
		const embed = ch === "!";
		const open = embed ? i + 1 : i;
		if (text.startsWith("[[", open)) {
			const close = text.indexOf("]]", open + 2);
			const newline = text.indexOf("\n", open);
			if (close !== -1 && (newline === -1 || close < newline)) {
				const original = text.slice(i, close + 2);
				const wiki = parseWikilink(original);
				if (wiki && wiki.path.trim() !== "") {
					links.push({
						form: "wikilink",
						embed: wiki.embed,
						start: i,
						end: close + 2,
						original,
						pathStart: i + wiki.pathStart,
						pathEnd: i + wiki.pathEnd,
						linkpath: wiki.path,
						subpath: wiki.subpath,
					});
				}
				i = close + 2;
				continue;
			}
		}
		if (text[open] === "[") {
			const close = findClosingBracket(text, open);
			if (close !== -1) {
				if (text[close] === "(") {
					const dest = scanInlineDestination(text, close);
					if (dest) {
						const original = text.slice(i, dest.end);
						const link = parseMarkdownLink(original);
						if (link) {
							links.push({
								form: "markdown",
								embed: link.embed,
								start: i,
								end: dest.end,
								original,
								pathStart: i + link.pathStart,
								pathEnd: i + link.pathEnd,
								linkpath: link.path,
								subpath: link.subpath,
							});
							// Continue inside the link text, which may hold an image: [![](a.png)](b.png)
							i = open + 1;
							continue;
						}
					}
				} else if (text[close] === "[") {
					const labelClose = text.indexOf("]", close + 1);
					if (labelClose !== -1 && !text.slice(close + 1, labelClose).includes("\n")) {
						const label = text.slice(close + 1, labelClose) || text.slice(open + 1, close - 1);
						uses.push({ label: normalizeLabel(label), embed, start: i, end: labelClose + 1 });
						// Read the link text for nested images, but not the label as a second use.
						skip.push([close, labelClose + 1]);
						i = open + 1;
						continue;
					}
				} else {
					uses.push({ label: normalizeLabel(text.slice(open + 1, close - 1)), embed, start: i, end: close });
					i = open + 1;
					continue;
				}
			}
		}
		i++;
	}

	const byLabel = new Map<string, MarkdownOccurrence>();
	for (const def of definitions) {
		const label = normalizeLabel(def.label ?? "");
		if (!byLabel.has(label)) byLabel.set(label, def);
	}
	const matchedUses = uses.filter((use) => byLabel.has(use.label));
	for (const use of matchedUses) {
		const def = byLabel.get(use.label) as MarkdownOccurrence;
		def.usages = (def.usages ?? 0) + 1;
		if (use.embed) def.embed = true;
	}
	// Only the first definition of a label counts, as in CommonMark.
	const effective = definitions.filter((def) => byLabel.get(normalizeLabel(def.label ?? "")) === def);
	return { links, definitions: effective, uses: matchedUses, fences };
}
