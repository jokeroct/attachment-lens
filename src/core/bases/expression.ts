// Finds static file references in Bases expressions without evaluating them.
// https://obsidian.md/help/bases/syntax and https://obsidian.md/help/bases/functions
import { parseWikilink } from "../markdown/links";

export interface ExprToken {
	type: "string" | "ident" | "number" | "punct" | "op";
	start: number;
	end: number;
	value: string;
	quote?: '"' | "'";
	/** Strings: true when the literal contains backslash escapes */
	escaped?: boolean;
}

const IDENT = /^[\p{L}_$][\p{L}\p{N}_$]*/u;
const NUMBER = /^\d+(?:\.\d+)?/;
const PUNCT = new Set([".", ",", "(", ")", "[", "]", "{", "}"]);

/** Tokens of an expression, or null when a string literal is never closed. */
export function tokenizeExpression(expr: string): ExprToken[] | null {
	const tokens: ExprToken[] = [];
	let i = 0;
	while (i < expr.length) {
		const ch = expr[i] as string;
		if (/\s/.test(ch)) {
			i++;
			continue;
		}
		if (ch === '"' || ch === "'") {
			const start = i;
			let value = "";
			let escaped = false;
			i++;
			while (i < expr.length && expr[i] !== ch) {
				if (expr[i] === "\\") {
					escaped = true;
					i++;
				}
				value += expr[i] ?? "";
				i++;
			}
			if (i >= expr.length) return null;
			i++;
			tokens.push({ type: "string", start, end: i, value, quote: ch, escaped });
			continue;
		}
		const rest = expr.slice(i);
		const ident = IDENT.exec(rest);
		if (ident) {
			tokens.push({ type: "ident", start: i, end: i + ident[0].length, value: ident[0] });
			i += ident[0].length;
			continue;
		}
		const number = NUMBER.exec(rest);
		if (number) {
			tokens.push({ type: "number", start: i, end: i + number[0].length, value: number[0] });
			i += number[0].length;
			continue;
		}
		tokens.push({ type: PUNCT.has(ch) ? "punct" : "op", start: i, end: i + 1, value: ch });
		i++;
	}
	return tokens;
}

export type FileFunction = "link" | "file" | "image" | "hasLink";

export interface ExprLiteral {
	/** The function the literal is passed to, or null for a bare string that looks like a wikilink */
	fn: FileFunction | null;
	token: ExprToken;
	/** Span of the whole call, for display */
	callStart: number;
	callEnd: number;
}

export interface ExprScan {
	literals: ExprLiteral[];
	/** Calls whose path is computed at runtime */
	dynamic: { fn: FileFunction; start: number; end: number }[];
	/** The expression couldn't be tokenized */
	malformed: boolean;
}

const GLOBAL_FUNCTIONS = new Set(["link", "file", "image"]);
/** Arguments to hasLink() that refer to notes, not attachments. */
const NOTE_ARGUMENTS = new Set(["this", "file"]);

function closingParen(tokens: ExprToken[], open: number): number {
	let depth = 0;
	for (let k = open; k < tokens.length; k++) {
		const v = (tokens[k] as ExprToken).value;
		if ((tokens[k] as ExprToken).type !== "punct") continue;
		if (v === "(") depth++;
		else if (v === ")") {
			depth--;
			if (depth === 0) return k;
		}
	}
	return tokens.length - 1;
}

export function scanExpression(expr: string): ExprScan {
	const tokens = tokenizeExpression(expr);
	if (!tokens) return { literals: [], dynamic: [], malformed: true };
	const literals: ExprLiteral[] = [];
	const dynamic: ExprScan["dynamic"] = [];
	const used = new Set<ExprToken>();
	for (let k = 0; k < tokens.length; k++) {
		const tok = tokens[k] as ExprToken;
		if (tok.type !== "ident" || tokens[k + 1]?.value !== "(") continue;
		const prev = tokens[k - 1];
		const isMethod = prev?.type === "punct" && prev.value === ".";
		let fn: FileFunction | null = null;
		if (!isMethod && GLOBAL_FUNCTIONS.has(tok.value)) fn = tok.value as FileFunction;
		else if (isMethod && tok.value === "hasLink") fn = "hasLink";
		if (!fn) continue;
		const close = closingParen(tokens, k + 1);
		const callStart = isMethod && prev ? prev.start : tok.start;
		const callEnd = (tokens[close] as ExprToken).end;
		const arg = tokens[k + 2];
		const after = tokens[k + 3];
		if (arg?.type === "string" && (after?.value === ")" || after?.value === ",")) {
			literals.push({ fn, token: arg, callStart, callEnd });
			used.add(arg);
			continue;
		}
		// file(link("[[a.png]]")): the inner call is read on its own.
		if (arg?.type === "ident" && GLOBAL_FUNCTIONS.has(arg.value) && after?.value === "(") continue;
		if (fn === "hasLink" && arg?.type === "ident" && NOTE_ARGUMENTS.has(arg.value)) continue;
		dynamic.push({ fn, start: callStart, end: callEnd });
	}
	for (const tok of tokens) {
		if (tok.type === "string" && !used.has(tok) && parseWikilink(tok.value)) {
			literals.push({ fn: null, token: tok, callStart: tok.start, callEnd: tok.end });
		}
	}
	literals.sort((a, b) => a.token.start - b.token.start);
	return { literals, dynamic, malformed: false };
}
