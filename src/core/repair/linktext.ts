// Chooses how the new target is written, keeping the original link's style.
import { basename, dirname, relativePath } from "../paths";

export type PathStyle = "name" | "vault" | "rooted" | "relative";

export function classifyPathStyle(linkpath: string): PathStyle {
	if (linkpath.startsWith("./") || linkpath.startsWith("../")) return "relative";
	if (linkpath.startsWith("/")) return "rooted";
	if (linkpath.includes("/")) return "vault";
	return "name";
}

/** "exact" is for Canvas paths and Bases file()/image(), which take a vault path. */
export type WriteMode = "link" | "exact";

interface Candidate {
	text: string;
	note: string;
}

function candidates(style: PathStyle, mode: WriteMode, target: string, sourcePath: string): Candidate[] {
	const full: Candidate = { text: target, note: mode === "exact" ? "Full vault path, which this field requires" : "Full vault path, matching the original style" };
	if (mode === "exact") return [full];
	switch (style) {
		case "name":
			return [{ text: basename(target), note: "Shortest name that opens this file from this source, matching the original style" }, full];
		case "rooted":
			return [{ text: `/${target}`, note: "Full vault path starting with “/”, matching the original style" }, full];
		case "relative": {
			let rel = relativePath(dirname(sourcePath), target);
			if (!rel.startsWith("../")) rel = `./${rel}`;
			return [{ text: rel, note: "Relative path from this source, matching the original style" }, full];
		}
		case "vault":
			return [full];
	}
}

export type LinkTextChoice = { ok: true; text: string; note: string } | { ok: false; reason: string };

/**
 * Picks the first candidate that `resolve` confirms opens `target` from `sourcePath`.
 * `resolve` returns the vault path a link text opens, or null.
 */
export function chooseLinkText(
	originalLinkpath: string,
	mode: WriteMode,
	target: string,
	sourcePath: string,
	resolve: (linktext: string) => string | null,
): LinkTextChoice {
	const style = classifyPathStyle(originalLinkpath);
	const options = candidates(style, mode, target, sourcePath);
	let rejected: { text: string; opens: string | null } | null = null;
	for (const option of options) {
		const opens = resolve(option.text);
		if (opens === target) {
			if (rejected && option.text === target) {
				const why = rejected.opens ? `“${rejected.text}” would open ${rejected.opens} from this source` : `“${rejected.text}” wouldn't open anything from this source`;
				return { ok: true, text: option.text, note: `Full vault path, because ${why}` };
			}
			return { ok: true, text: option.text, note: option.note };
		}
		rejected ??= { text: option.text, opens };
	}
	return { ok: false, reason: `No way of writing this link opens ${target} from this source.` };
}
