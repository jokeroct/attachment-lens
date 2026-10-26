// Reads static attachment references from .base files and from ```base blocks in notes.
import { isMap, isScalar, isSeq, parseDocument, type Scalar } from "yaml";
import { parseWikilink, splitLinktext } from "../markdown/links";
import { findFences } from "../markdown/scanner";
import { isExternalTarget } from "../paths";
import { lineColAt } from "../text";
import type { CoverageIssue, Occurrence } from "../types";
import { mapScalar } from "../yaml/scalars";
import { scanExpression } from "./expression";

export interface BaseRead {
	occurrences: Occurrence[];
	issues: Omit<CoverageIssue, "sourcePath">[];
}

export interface BaseReadOptions {
	/** Absolute offset of the YAML text in the file */
	offset: number;
	/** Prefix for occurrence keys, so several blocks in one note stay distinct */
	keyPrefix: string;
	embedded: boolean;
	/** The whole file, for line numbers */
	fileText: string;
}

interface Expression {
	path: string;
	node: Scalar;
}

function collectFilters(node: unknown, path: string, out: Expression[]): void {
	if (isScalar(node) && typeof node.value === "string") out.push({ path, node });
	else if (isSeq(node)) node.items.forEach((item, i) => collectFilters(item, `${path}[${i}]`, out));
	else if (isMap(node)) {
		for (const pair of node.items) {
			const key = isScalar(pair.key) ? String(pair.key.value) : "";
			if (key === "and" || key === "or" || key === "not") collectFilters(pair.value, `${path}.${key}`, out);
		}
	}
}

function collectMapValues(node: unknown, path: string, out: Expression[]): void {
	if (!isMap(node)) return;
	for (const pair of node.items) {
		if (isScalar(pair.key) && isScalar(pair.value) && typeof pair.value.value === "string") {
			out.push({ path: `${path}.${String(pair.key.value)}`, node: pair.value });
		}
	}
}

/** Human-readable name for an expression path, such as "formula thumb" or "filter". */
export function describeExpression(path: string): string {
	const formula = /^formulas\.(.+)$/.exec(path);
	if (formula) return `formula ${formula[1]}`;
	const summary = /^summaries\.(.+)$/.exec(path);
	if (summary) return `summary ${summary[1]}`;
	const view = /^views\[(\d+)\]\.filters/.exec(path);
	if (view) return `filter in view ${Number(view[1]) + 1}`;
	return "filter";
}

export function readBase(yamlText: string, options: BaseReadOptions): BaseRead {
	const occurrences: Occurrence[] = [];
	const issues: Omit<CoverageIssue, "sourcePath">[] = [];
	const doc = parseDocument(yamlText);
	if (doc.errors.length > 0) {
		const error = doc.errors[0];
		const at = error?.linePos?.[0];
		const line = at ? lineColAt(options.fileText, options.offset).line + at.line - 1 : null;
		issues.push({ kind: "parse-error", message: `Invalid YAML${line ? ` at line ${line}` : ""}. No references were read from this base.` });
		return { occurrences, issues };
	}
	if (doc.contents === null) return { occurrences, issues };
	if (!isMap(doc.contents)) {
		issues.push({ kind: "parse-error", message: "The base isn't a YAML map. No references were read from it." });
		return { occurrences, issues };
	}

	const expressions: Expression[] = [];
	for (const pair of doc.contents.items) {
		const key = isScalar(pair.key) ? String(pair.key.value) : "";
		if (key === "filters") collectFilters(pair.value, "filters", expressions);
		else if (key === "formulas" || key === "summaries") collectMapValues(pair.value, key, expressions);
		else if (key === "views" && isSeq(pair.value)) {
			pair.value.items.forEach((view, i) => {
				if (!isMap(view)) return;
				for (const viewPair of view.items) {
					if (isScalar(viewPair.key) && viewPair.key.value === "filters") collectFilters(viewPair.value, `views[${i}].filters`, expressions);
				}
			});
		}
	}

	const dynamic: string[] = [];
	for (const { path, node } of expressions) {
		const expr = node.value as string;
		const scan = scanExpression(expr);
		const mapped = mapScalar(yamlText, node, options.offset);
		const nodeStart = options.offset + (node.range?.[0] ?? 0);
		const nodeEnd = options.offset + (node.range?.[1] ?? 0);
		const line = lineColAt(options.fileText, nodeStart).line;
		for (const call of scan.dynamic) dynamic.push(`${describeExpression(path)}: ${expr.slice(call.start, call.end)}`);
		let n = 0;
		for (const literal of scan.literals) {
			const value = literal.token.value;
			if (isExternalTarget(value) || value.trim() === "") continue;
			const wiki = parseWikilink(value);
			const split = splitLinktext(value);
			const linkpath = wiki ? wiki.path : split.path;
			if (linkpath.trim() === "") continue;
			const contentStart = literal.token.start + 1;
			const pathFrom = contentStart + (wiki ? wiki.pathStart : 0);
			const pathTo = pathFrom + linkpath.length;
			let blocked: string | undefined;
			if (!mapped) blocked = "The expression spans several lines or uses escapes, so it can't be edited safely.";
			else if (literal.token.escaped) blocked = "The text uses escape characters, so it can't be edited safely.";
			const at = (i: number) => (mapped ? (mapped.map[i] as number) : nodeStart);
			occurrences.push({
				key: `${options.keyPrefix}b:${path}:${n++}`,
				form: wiki ? "wikilink" : "path",
				inner: wiki ? { kind: "wikilink" } : { kind: "path" },
				layers: [
					{ kind: "expression-string", quote: literal.token.quote ?? '"' },
					{ kind: "yaml", style: mapped?.style ?? "PLAIN", flow: false },
				],
				embed: wiki ? wiki.embed : literal.fn === "image",
				confidence: literal.fn ? "explicit" : "uncertain",
				original: expr.slice(literal.callStart, literal.callEnd),
				start: mapped ? at(literal.token.start) : nodeStart,
				end: mapped ? at(literal.token.end) : nodeEnd,
				pathStart: at(pathFrom),
				pathEnd: at(pathTo),
				linkpath,
				subpath: wiki ? wiki.subpath : split.subpath,
				place: { type: "base", expression: path, fn: literal.fn, line, embedded: options.embedded },
				...(blocked ? { blocked } : {}),
			});
		}
	}
	if (dynamic.length > 0) {
		issues.push({
			kind: "dynamic",
			message: `${dynamic.length} expression${dynamic.length === 1 ? " is" : "s are"} computed at runtime and ${dynamic.length === 1 ? "wasn't" : "weren't"} evaluated.`,
			detail: dynamic[0],
		});
	}
	return { occurrences, issues };
}

/**
 * Reads ```base blocks in a note. `codeStarts` lists where Obsidian found code blocks, so fences
 * nested in other blocks aren't mistaken for live bases; pass null to accept every fence.
 */
export function readEmbeddedBases(noteText: string, codeStarts: ReadonlySet<number> | null): BaseRead {
	const occurrences: Occurrence[] = [];
	const issues: Omit<CoverageIssue, "sourcePath">[] = [];
	let n = 0;
	for (const fence of findFences(noteText)) {
		if ((fence.info.split(/\s+/)[0] ?? "").toLowerCase() !== "base") continue;
		if (codeStarts && !codeStarts.has(fence.start)) continue;
		const read = readBase(noteText.slice(fence.contentStart, fence.contentEnd), {
			offset: fence.contentStart,
			keyPrefix: `e${n++}:`,
			embedded: true,
			fileText: noteText,
		});
		occurrences.push(...read.occurrences);
		issues.push(...read.issues.map((issue) => ({ ...issue, message: issue.message.replace("this base", "a base block") })));
	}
	return { occurrences, issues };
}
