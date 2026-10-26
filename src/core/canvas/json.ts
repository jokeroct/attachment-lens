// A strict JSON parser that keeps the exact source position of every value, so a repair can
// replace one string without re-serializing the rest of a Canvas file.

interface Positioned {
	/** Absolute offsets; for strings the span includes the quotes */
	start: number;
	end: number;
}

export interface JsonObject extends Positioned {
	type: "object";
	entries: { key: string; value: JsonNode }[];
}
export interface JsonArray extends Positioned {
	type: "array";
	items: JsonNode[];
}
export interface JsonString extends Positioned {
	type: "string";
	value: string;
}
export interface JsonOther extends Positioned {
	type: "number" | "boolean" | "null";
}
export type JsonNode = JsonObject | JsonArray | JsonString | JsonOther;

export class JsonParseError extends Error {
	constructor(
		message: string,
		readonly offset: number,
		readonly line: number,
		readonly column: number,
	) {
		super(message);
	}
}

const ESCAPES: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };

export function parseJsonWithPositions(text: string): JsonNode {
	let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;

	const fail = (message: string, at = i): never => {
		let line = 1;
		let lineStart = 0;
		for (let k = 0; k < at && k < text.length; k++) {
			if (text[k] === "\n") {
				line++;
				lineStart = k + 1;
			}
		}
		throw new JsonParseError(`${message} at line ${line}, column ${at - lineStart + 1}`, at, line, at - lineStart + 1);
	};
	const space = () => {
		while (i < text.length && (text[i] === " " || text[i] === "\t" || text[i] === "\n" || text[i] === "\r")) i++;
	};
	const string = (): JsonString => {
		const start = i;
		i++;
		let value = "";
		while (i < text.length) {
			const ch = text[i] as string;
			if (ch === '"') {
				i++;
				return { type: "string", start, end: i, value };
			}
			if (ch === "\\") {
				const code = text[i + 1] ?? "";
				if (code === "u") {
					const hex = text.slice(i + 2, i + 6);
					if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail("Invalid \\u escape");
					value += String.fromCharCode(parseInt(hex, 16));
					i += 6;
					continue;
				}
				const simple = ESCAPES[code];
				if (simple === undefined) fail("Invalid escape");
				value += simple;
				i += 2;
				continue;
			}
			if (ch.charCodeAt(0) < 0x20) fail("Unescaped control character in string");
			value += ch;
			i++;
		}
		return fail("Unterminated string", start);
	};
	const value = (): JsonNode => {
		space();
		const start = i;
		const ch = text[i];
		if (ch === "{") {
			i++;
			const entries: { key: string; value: JsonNode }[] = [];
			space();
			if (text[i] === "}") {
				i++;
				return { type: "object", start, end: i, entries };
			}
			for (;;) {
				space();
				if (text[i] !== '"') fail("Expected a property name");
				const key = string();
				space();
				if (text[i] !== ":") fail("Expected ':'");
				i++;
				entries.push({ key: key.value, value: value() });
				space();
				if (text[i] === ",") {
					i++;
					continue;
				}
				if (text[i] === "}") {
					i++;
					return { type: "object", start, end: i, entries };
				}
				fail("Expected ',' or '}'");
			}
		}
		if (ch === "[") {
			i++;
			const items: JsonNode[] = [];
			space();
			if (text[i] === "]") {
				i++;
				return { type: "array", start, end: i, items };
			}
			for (;;) {
				items.push(value());
				space();
				if (text[i] === ",") {
					i++;
					continue;
				}
				if (text[i] === "]") {
					i++;
					return { type: "array", start, end: i, items };
				}
				fail("Expected ',' or ']'");
			}
		}
		if (ch === '"') return string();
		for (const [word, type] of [["true", "boolean"], ["false", "boolean"], ["null", "null"]] as const) {
			if (text.startsWith(word, i)) {
				i += word.length;
				return { type, start, end: i };
			}
		}
		const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i, i + 64));
		if (number) {
			i += number[0].length;
			return { type: "number", start, end: i };
		}
		return fail(i >= text.length ? "Unexpected end of file" : "Unexpected character");
	};

	const root = value();
	space();
	if (i < text.length) fail("Unexpected content after the end");
	return root;
}

/**
 * Decodes a JSON string token (with quotes) and maps every decoded UTF-16 unit back to the offset
 * of the source character that produced it. map[value.length] is the closing quote's offset.
 */
export function mapJsonString(text: string, node: JsonString): number[] {
	const map: number[] = [];
	for (let i = node.start + 1; i < node.end - 1; ) {
		if (text[i] === "\\") {
			map.push(i);
			i += text[i + 1] === "u" ? 6 : 2;
		} else {
			map.push(i);
			i++;
		}
	}
	map.push(node.end - 1);
	return map;
}

/** Escapes text for insertion inside a JSON string. */
export function escapeJsonText(value: string): string {
	return JSON.stringify(value).slice(1, -1);
}

export function getProperty(node: JsonObject, key: string): JsonNode | undefined {
	return node.entries.find((entry) => entry.key === key)?.value;
}
