// Maps YAML scalars back to their exact characters in the source, so a repair can replace a few
// characters inside a value without re-serializing the YAML around it.
import type { Scalar } from "yaml";

export type ScalarStyle = "PLAIN" | "QUOTE_DOUBLE" | "QUOTE_SINGLE";

export interface MappedScalar {
	value: string;
	style: ScalarStyle;
	/** Absolute span of the scalar, including quotes */
	rawStart: number;
	rawEnd: number;
	/**
	 * map[i] is the absolute offset of the source character that produced value[i].
	 * map[value.length] is the offset just past the value (the closing quote for quoted scalars).
	 */
	map: number[];
}

const SIMPLE_ESCAPES: Record<string, string> = {
	"0": "\0", a: "\x07", b: "\b", t: "\t", "\t": "\t", n: "\n", v: "\v", f: "\f", r: "\r", e: "\x1b",
	" ": " ", '"': '"', "/": "/", "\\": "\\", N: "\u0085", _: " ", L: " ", P: " ",
};
const HEX_LENGTH: Record<string, number> = { x: 2, u: 4, U: 8 };

/**
 * Maps a single-line scalar. Returns null for anything else (multi-line or block scalars,
 * non-string values), which makes the value inspect-only.
 * `text` is the YAML document text and `offset` its position in the file.
 */
export function mapScalar(text: string, node: Scalar, offset: number): MappedScalar | null {
	if (typeof node.value !== "string" || !node.range) return null;
	const [start, end] = node.range;
	const raw = text.slice(start, end);
	if (raw.includes("\n") || raw.includes("\r")) return null;
	const style = node.type;
	const map: number[] = [];
	let value = "";
	if (style === "PLAIN") {
		value = raw;
		for (let i = 0; i <= raw.length; i++) map.push(offset + start + i);
	} else if (style === "QUOTE_SINGLE") {
		if (raw.length < 2 || !raw.startsWith("'") || !raw.endsWith("'")) return null;
		for (let i = 1; i < raw.length - 1; i++) {
			map.push(offset + start + i);
			value += raw[i];
			if (raw[i] === "'") {
				if (raw[i + 1] !== "'") return null;
				i++;
			}
		}
		map.push(offset + end - 1);
	} else if (style === "QUOTE_DOUBLE") {
		if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) return null;
		for (let i = 1; i < raw.length - 1; i++) {
			const ch = raw[i] as string;
			if (ch !== "\\") {
				map.push(offset + start + i);
				value += ch;
				continue;
			}
			const code = raw[i + 1] ?? "";
			const simple = SIMPLE_ESCAPES[code];
			if (simple !== undefined) {
				map.push(offset + start + i);
				value += simple;
				i++;
				continue;
			}
			const length = HEX_LENGTH[code];
			if (length === undefined) return null;
			const hex = raw.slice(i + 2, i + 2 + length);
			if (hex.length !== length || !/^[0-9a-fA-F]+$/.test(hex)) return null;
			const decoded = String.fromCodePoint(parseInt(hex, 16));
			for (let k = 0; k < decoded.length; k++) map.push(offset + start + i);
			value += decoded;
			i += 1 + length;
		}
		map.push(offset + end - 1);
	} else {
		return null;
	}
	if (value !== node.value) return null;
	return { value, style, rawStart: offset + start, rawEnd: offset + end, map };
}

/** Escapes text for insertion inside a scalar of the given style. Plain scalars can't escape anything. */
export function escapeForScalar(value: string, style: ScalarStyle): string {
	if (style === "QUOTE_DOUBLE") return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	if (style === "QUOTE_SINGLE") return value.replace(/'/g, "''");
	return value;
}
