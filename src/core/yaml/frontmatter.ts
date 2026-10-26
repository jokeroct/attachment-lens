import { isAlias, isMap, isScalar, isSeq, parseDocument } from "yaml";
import { splitLines } from "../markdown/scanner";
import { mapScalar, type MappedScalar } from "./scalars";

export interface FrontmatterBlock {
	/** Offset of the first line after the opening "---" */
	contentStart: number;
	/** Offset of the closing "---" line */
	contentEnd: number;
	text: string;
}

export function findFrontmatterBlock(text: string): FrontmatterBlock | null {
	const lines = splitLines(text);
	if (lines[0]?.text !== "---" || lines.length < 2) return null;
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i];
		if (line && line.text === "---") {
			const contentStart = (lines[1] as { start: number }).start;
			return { contentStart, contentEnd: line.start, text: text.slice(contentStart, line.start) };
		}
	}
	return null;
}

export type PropertyLocation =
	| { ok: true; scalar: MappedScalar; flow: boolean }
	| { ok: false; reason: string };

/**
 * Finds the exact characters of a top-level property value, or of one item in a list property.
 * Fails when the spot can't be pinned down safely.
 */
export function locateProperty(text: string, key: string, index: number | null): PropertyLocation {
	const block = findFrontmatterBlock(text);
	if (!block) return { ok: false, reason: "The note no longer has a properties block." };
	const doc = parseDocument(block.text);
	if (doc.errors.length > 0) return { ok: false, reason: "The properties block has YAML errors, so its exact layout can't be relied on." };
	if (!isMap(doc.contents)) return { ok: false, reason: "The properties block isn't a list of properties." };
	const pairs = doc.contents.items.filter((pair) => isScalar(pair.key) && String(pair.key.value) === key);
	if (pairs.length === 0) return { ok: false, reason: `The property “${key}” no longer exists.` };
	if (pairs.length > 1) return { ok: false, reason: `The property “${key}” appears more than once.` };
	const value = (pairs[0] as { value: unknown }).value;
	if (isAlias(value) || (isScalar(value) && value.anchor) || (isSeq(value) && value.anchor)) {
		return { ok: false, reason: "The value uses YAML anchors, so changing it could change other values." };
	}
	let flow = false;
	let node: unknown = value;
	if (index !== null) {
		if (!isSeq(value)) return { ok: false, reason: `The property “${key}” is no longer a list.` };
		flow = value.flow === true;
		node = value.items[index];
		if (isAlias(node) || (isScalar(node) && node.anchor)) return { ok: false, reason: "The value uses YAML anchors, so changing it could change other values." };
	}
	if (!isScalar(node)) return { ok: false, reason: "The value is no longer plain text." };
	const scalar = mapScalar(block.text, node, block.contentStart);
	if (!scalar) return { ok: false, reason: "The value spans several lines or uses escapes that can't be edited safely." };
	return { ok: true, scalar, flow };
}

/** Top-level property keys that hold tags, aliases and CSS classes, never attachments. */
export const NON_ATTACHMENT_KEYS: ReadonlySet<string> = new Set(["tags", "tag", "aliases", "alias", "cssclasses", "cssclass", "position"]);

export interface PropertyValue {
	key: string;
	index: number | null;
	value: string;
}

/** String values of top-level properties and of string items in list properties. */
export function propertyValues(frontmatter: Record<string, unknown>): PropertyValue[] {
	const out: PropertyValue[] = [];
	for (const [key, value] of Object.entries(frontmatter)) {
		if (NON_ATTACHMENT_KEYS.has(key.toLowerCase())) continue;
		if (typeof value === "string") out.push({ key, index: null, value });
		else if (Array.isArray(value)) {
			value.forEach((item, index) => {
				if (typeof item === "string") out.push({ key, index, value: item });
			});
		}
	}
	return out;
}
