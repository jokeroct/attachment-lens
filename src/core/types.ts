import type { Category } from "./fileTypes";
import type { ScalarStyle } from "./yaml/scalars";

export type SourceKind = "markdown" | "canvas" | "base";

/** Explicit references use documented link syntax; uncertain ones are plain text that looks like a path. */
export type Confidence = "explicit" | "uncertain";

/** How the target is written: inside a wikilink, a Markdown link, a reference definition, or as a bare path. */
export type RefForm = "wikilink" | "markdown" | "refdef" | "path";

/** Escaping that wraps the link text, innermost first: a JSON string, a YAML scalar, a Bases string literal. */
export type Layer =
	| { kind: "json-string" }
	| { kind: "yaml"; style: ScalarStyle; flow: boolean }
	| { kind: "expression-string"; quote: '"' | "'" };

/** Syntax of the path itself. */
export type Inner =
	| { kind: "wikilink" }
	| { kind: "markdown"; angle: boolean; encodesUnicode: boolean }
	| { kind: "path" };

export type RefPlace =
	| { type: "body"; line: number; col: number }
	| { type: "property"; key: string; index: number | null }
	| { type: "canvas"; nodeId: string; nodeType: "file" | "group" | "text"; field: "file" | "background" | "text"; label: string; line: number }
	| { type: "base"; expression: string; fn: string | null; line: number; embedded: boolean };

/** A reference located in a source's current text, with everything needed to change it. */
export interface Occurrence {
	/** Stable key within the source, used to find the same reference again in fresh text */
	key: string;
	form: RefForm;
	inner: Inner;
	layers: Layer[];
	embed: boolean;
	confidence: Confidence;
	/** The reference as written, for display */
	original: string;
	/** Whole occurrence, absolute offsets in the file */
	start: number;
	end: number;
	/** The characters a repair replaces */
	pathStart: number;
	pathEnd: number;
	linkpath: string;
	subpath: string;
	place: RefPlace;
	/** Reference definitions: how many times the label is used */
	usages?: number;
	/** Why this occurrence can be inspected but not repaired */
	blocked?: string;
}

/** A reference as kept in the index. */
export interface Reference {
	id: string;
	key: string;
	sourcePath: string;
	sourceKind: SourceKind;
	form: RefForm;
	embed: boolean;
	confidence: Confidence;
	linkpath: string;
	subpath: string;
	original: string;
	place: RefPlace;
	/** Span of the occurrence when it was scanned, for Markdown notes */
	span: { start: number; end: number } | null;
	usages?: number;
	/** Vault path the link opens, or null when broken */
	resolvedPath: string | null;
	blocked?: string;
}

export type IssueKind = "parse-error" | "dynamic" | "not-indexed" | "read-error";

export interface CoverageIssue {
	sourcePath: string;
	kind: IssueKind;
	message: string;
	/** An example of what wasn't evaluated, such as the expression text */
	detail?: string;
}

export interface AttachmentInfo {
	path: string;
	name: string;
	ext: string;
	category: Category;
	size: number;
	mtime: number;
}
