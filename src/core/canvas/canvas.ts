// Reads attachment references from JSON Canvas 1.0 files: file cards, group backgrounds and links
// inside Markdown text cards. https://jsoncanvas.org/spec/1.0/
import { isExternalTarget } from "../paths";
import { scanMarkdown } from "../markdown/scanner";
import { lineColAt } from "../text";
import type { CoverageIssue, Occurrence } from "../types";
import { getProperty, JsonParseError, mapJsonString, parseJsonWithPositions, type JsonNode, type JsonString } from "./json";

export interface CanvasRead {
	occurrences: Occurrence[];
	issues: Omit<CoverageIssue, "sourcePath">[];
}

function textLabel(text: string): string {
	const first = text.split("\n").find((line) => line.trim() !== "") ?? "";
	const clean = first.replace(/^#+\s*/, "").trim();
	return clean.length > 40 ? `${clean.slice(0, 39)}…` : clean || "Text card";
}

export function readCanvas(text: string): CanvasRead {
	const occurrences: Occurrence[] = [];
	let root: JsonNode;
	try {
		root = parseJsonWithPositions(text);
	} catch (error) {
		const message = error instanceof JsonParseError ? `Invalid JSON ${error.message.replace(/^.* at /, "at ")}.` : "The file couldn't be read as JSON.";
		return { occurrences, issues: [{ kind: "parse-error", message: `${message} No references were read from this board.` }] };
	}
	if (root.type !== "object") return { occurrences, issues: [{ kind: "parse-error", message: "The board isn't a JSON object. No references were read from it." }] };
	const nodes = getProperty(root, "nodes");
	if (nodes === undefined) return { occurrences, issues: [] };
	if (nodes.type !== "array") return { occurrences, issues: [{ kind: "parse-error", message: "The board's “nodes” isn't a list. No references were read from it." }] };

	const issues: Omit<CoverageIssue, "sourcePath">[] = [];
	let skipped = 0;
	for (const node of nodes.items) {
		if (node.type !== "object") {
			skipped++;
			continue;
		}
		const id = getProperty(node, "id");
		const type = getProperty(node, "type");
		if (id?.type !== "string" || type?.type !== "string") {
			skipped++;
			continue;
		}
		const nodeId = id.value;
		const line = lineColAt(text, node.start).line;

		const pathField = (field: "file" | "background", nodeType: "file" | "group", value: JsonString, subpath: string, label: string) => {
			if (value.value.trim() === "" || isExternalTarget(value.value)) return;
			const raw = text.slice(value.start, value.end);
			occurrences.push({
				key: `c:${nodeId}:${field}`,
				form: "path",
				inner: { kind: "path" },
				layers: [{ kind: "json-string" }],
				embed: field === "background" || nodeType === "file",
				confidence: "explicit",
				original: `"${field}": ${raw}`,
				start: value.start,
				end: value.end,
				// The whole string is replaced, so escapes in the old value don't matter.
				pathStart: value.start + 1,
				pathEnd: value.end - 1,
				linkpath: value.value,
				subpath,
				place: { type: "canvas", nodeId, nodeType, field, label, line: lineColAt(text, value.start).line },
			});
		};

		if (type.value === "file") {
			const file = getProperty(node, "file");
			const subpath = getProperty(node, "subpath");
			if (file?.type === "string") {
				const name = file.value.split("/").pop() ?? file.value;
				pathField("file", "file", file, subpath?.type === "string" ? subpath.value : "", name);
			}
		} else if (type.value === "group") {
			const background = getProperty(node, "background");
			const label = getProperty(node, "label");
			if (background?.type === "string") pathField("background", "group", background, "", label?.type === "string" && label.value ? label.value : "Group");
		} else if (type.value === "text") {
			const textNode = getProperty(node, "text");
			if (textNode?.type !== "string") continue;
			const map = mapJsonString(text, textNode);
			const scan = scanMarkdown(textNode.value);
			const label = textLabel(textNode.value);
			let n = 0;
			for (const link of [...scan.links, ...scan.definitions]) {
				if (isExternalTarget(link.linkpath)) continue;
				const rawStart = map[link.start] as number;
				const rawEnd = map[link.end] as number;
				occurrences.push({
					key: `c:${nodeId}:text:${n++}`,
					form: link.form,
					inner:
						link.form === "wikilink"
							? { kind: "wikilink" }
							: { kind: "markdown", angle: textNode.value[link.pathStart - 1] === "<", encodesUnicode: /%[c-fC-F][0-9a-fA-F]/.test(link.original) },
					layers: [{ kind: "json-string" }],
					embed: link.embed,
					confidence: "explicit",
					original: link.original,
					start: rawStart,
					end: rawEnd,
					pathStart: map[link.pathStart] as number,
					pathEnd: map[link.pathEnd] as number,
					linkpath: link.linkpath,
					subpath: link.subpath,
					place: { type: "canvas", nodeId, nodeType: "text", field: "text", label, line },
					...(link.usages !== undefined ? { usages: link.usages } : {}),
				});
			}
			if (scan.fences.some((f) => f.info.split(/\s+/)[0] === "base")) {
				issues.push({ kind: "dynamic", message: `A base block inside the text card “${label}” wasn't read. Base blocks are read in notes only.` });
			}
		}
	}
	if (skipped > 0) issues.push({ kind: "parse-error", message: `${skipped} card${skipped === 1 ? "" : "s"} without an id or type were skipped.` });
	return { occurrences, issues };
}
