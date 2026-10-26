// Ranks existing attachments as possible replacements for a missing one. Deterministic: the same
// vault always gives the same order. Each signal that applies is shown to the user as a reason.
import { areEquivalentExtensions, categoryOf, formatLabel, type Category } from "./fileTypes";
import { basename, dirname, extname, foldName, joinPath, stem } from "./paths";

export interface CandidateInput {
	path: string;
	refCount: number;
}

export interface Reason {
	text: string;
	/** Shown as a caution, such as a different file type */
	warn?: boolean;
}

export interface Candidate {
	path: string;
	score: number;
	reasons: Reason[];
}

const COPY_SUFFIX = /(?:[\s_-]+\d+|[\s_-]*\(\d+\)|[\s_-]*copy(?:[\s_-]*\d+)?)$/i;

function looseName(name: string): string {
	return foldName(name).replace(COPY_SUFFIX, "").replace(/[\s_.-]+/g, "");
}

function levenshtein(a: string, b: string): number {
	if (a === b) return 0;
	const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		let diagonal = prev[0] as number;
		prev[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const above = prev[j] as number;
			prev[j] = Math.min(above + 1, (prev[j - 1] as number) + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
			diagonal = above;
		}
	}
	return prev[b.length] as number;
}

function differenceText(a: string, b: string): string {
	const [short, long] = a.length <= b.length ? [a, b] : [b, a];
	if (long.startsWith(short)) return `Name differs by “${long.slice(short.length)}”`;
	if (long.endsWith(short)) return `Name differs by “${long.slice(0, long.length - short.length)}”`;
	const d = levenshtein(a, b);
	return `Name differs by ${d} character${d === 1 ? "" : "s"}`;
}

/** Folder the missing link pointed into, as a vault path, or null for bare names. */
function missingFolder(linkpath: string, sourcePath: string): string | null {
	if (!linkpath.includes("/")) return null;
	const full = linkpath.startsWith(".") ? joinPath(dirname(sourcePath), linkpath) : linkpath.replace(/^\/+/, "");
	return full === null ? null : dirname(full);
}

export function rankCandidates(missingLinkpath: string, sourcePath: string, attachments: readonly CandidateInput[], limit: number): Candidate[] {
	const missingName = basename(missingLinkpath);
	const missingStem = foldName(stem(missingName));
	const missingExt = extname(missingName);
	const missingCategory: Category = categoryOf(missingExt);
	const missingLoose = looseName(stem(missingName));
	const folder = missingFolder(missingLinkpath, sourcePath);
	const folderParts = folder ? foldName(folder).split("/").filter(Boolean) : [];
	const sourceDir = dirname(sourcePath);

	const out: Candidate[] = [];
	for (const att of attachments) {
		const name = basename(att.path);
		const candStem = foldName(stem(name));
		const ext = extname(name);
		const category = categoryOf(ext);
		const reasons: Reason[] = [];
		let score = 0;

		if (candStem === missingStem && ext === missingExt) {
			score += 100;
			reasons.push({ text: "Same name, different folder" });
		} else if (candStem === missingStem && areEquivalentExtensions(ext, missingExt)) {
			score += 85;
			reasons.push({ text: `Same name, .${ext} instead of .${missingExt}` });
		} else if (candStem === missingStem) {
			score += 70;
			reasons.push({ text: `Same name, .${ext || "no extension"} instead of .${missingExt || "no extension"}` });
		} else if (missingLoose !== "" && looseName(stem(name)) === missingLoose) {
			score += 60;
			const copy = COPY_SUFFIX.test(stem(name)) || COPY_SUFFIX.test(stem(missingName));
			reasons.push({ text: copy ? "Same name, ignoring a copy number" : "Same name, ignoring spaces and dashes" });
		} else {
			const longest = Math.max(candStem.length, missingStem.length);
			const ratio = longest === 0 ? 0 : 1 - levenshtein(candStem, missingStem) / longest;
			if (ratio < 0.6) continue;
			score += Math.round(40 * ratio);
			reasons.push({ text: differenceText(candStem, missingStem) });
		}

		const candParts = foldName(dirname(att.path)).split("/").filter(Boolean);
		const shared = folderParts.filter((part) => candParts.includes(part));
		if (shared.length > 0) {
			score += 15;
			reasons.push({ text: `Same folder name “${shared.join("/")}”` });
		} else if (dirname(att.path) === sourceDir || (sourceDir !== "" && dirname(att.path).startsWith(`${sourceDir}/`))) {
			score += 5;
			reasons.push({ text: "Near the source" });
		}

		if (category === missingCategory && ext !== missingExt && category !== "other" && !areEquivalentExtensions(ext, missingExt)) {
			reasons.push({ text: `Different format: ${formatLabel(ext)}`, warn: true });
			score -= 5;
		} else if (category === missingCategory && category !== "other") {
			score += 5;
			reasons.push({ text: `Same type: ${category === "pdf" ? "PDF" : category}` });
		} else if (ext === missingExt) {
			score += 5;
			reasons.push({ text: "Same extension" });
		} else {
			score -= 20;
			reasons.push({ text: `Different type: ${formatLabel(ext || "file")}`, warn: true });
		}

		if (att.refCount === 0) {
			score += 5;
			reasons.push({ text: "No references detected" });
		}
		if (score >= 30) out.push({ path: att.path, score, reasons });
	}
	out.sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	return out.slice(0, limit);
}

/** Attachments whose path contains every word of the query, names that start with it first. */
export function searchPaths(query: string, paths: readonly string[], limit: number): string[] {
	const words = foldName(query).split(/\s+/).filter(Boolean);
	if (words.length === 0) return [];
	const first = words[0] as string;
	const hits = paths.filter((path) => {
		const folded = foldName(path);
		return words.every((word) => folded.includes(word));
	});
	hits.sort((a, b) => {
		const an = foldName(basename(a)).startsWith(first) ? 0 : 1;
		const bn = foldName(basename(b)).startsWith(first) ? 0 : 1;
		return an - bn || (a < b ? -1 : a > b ? 1 : 0);
	});
	return hits.slice(0, limit);
}
