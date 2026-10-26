// Full scans in small batches, plus the per-file extraction that incremental updates reuse.
import { extractBaseFile, extractCanvas, extractMarkdown, isAttachmentReference, markdownNeedsText, type Extraction, type FoundRef } from "../core/extract";
import { categoryOf } from "../core/fileTypes";
import type { SourceEntry } from "../core/index";
import { extname, isSourcePath } from "../core/paths";
import type { AttachmentInfo, CoverageIssue, Reference, SourceKind } from "../core/types";
import type { Host, HostFile, Yield } from "./host";

export class ScanCancelled extends Error {
	constructor() {
		super("Scan cancelled");
	}
}

export class CancelToken {
	cancelled = false;
	cancel(): void {
		this.cancelled = true;
	}
	check(): void {
		if (this.cancelled) throw new ScanCancelled();
	}
}

export type ScanPhase = "waiting" | "listing" | "reading" | "resolving";

export interface ScanProgress {
	phase: ScanPhase;
	done: number;
	total: number;
	refs: number;
	broken: number;
}

export interface Timing {
	now(): number;
	yieldToUi: Yield;
	/** Longest stretch of work between yields, in milliseconds */
	budgetMs: number;
}

/** Folders whose files are never listed or read: the config folder, the vault trash and user exclusions. */
export function isExcluded(path: string, configDir: string, extra: readonly string[]): boolean {
	if (path.startsWith(`${configDir}/`) || path.startsWith(".trash/")) return true;
	return extra.some((folder) => path === folder || path.startsWith(`${folder}/`));
}

export function sourceKindOf(path: string): SourceKind | null {
	const ext = extname(path);
	if (ext === "md") return "markdown";
	if (ext === "canvas") return "canvas";
	if (ext === "base") return "base";
	return null;
}

export function attachmentInfo(file: HostFile): AttachmentInfo {
	return { path: file.path, name: file.name, ext: file.extension.toLowerCase(), category: categoryOf(file.extension), size: file.size, mtime: file.mtime };
}

/** Runs `fn` over `items`, yielding to the UI whenever the time budget is used up. */
export async function runChunked<T>(items: readonly T[], fn: (item: T, index: number) => void | Promise<void>, token: CancelToken, timing: Timing, onBatch?: (done: number) => void): Promise<void> {
	let sliceStart = timing.now();
	for (let i = 0; i < items.length; i++) {
		token.check();
		await fn(items[i] as T, i);
		if (timing.now() - sliceStart >= timing.budgetMs) {
			onBatch?.(i + 1);
			await timing.yieldToUi();
			token.check();
			sliceStart = timing.now();
		}
	}
	onBatch?.(items.length);
}

export interface Extracted {
	kind: SourceKind;
	found: FoundRef[];
	issues: Omit<CoverageIssue, "sourcePath">[];
	external: number;
}

export async function extractSource(host: Host, path: string): Promise<Extracted | null> {
	const kind = sourceKindOf(path);
	if (!kind) return null;
	try {
		let extraction: Extraction;
		if (kind === "markdown") {
			const cache = host.getCache(path);
			const text = cache && markdownNeedsText(cache) ? await host.cachedRead(path) : null;
			extraction = extractMarkdown(cache, text);
		} else {
			const text = await host.cachedRead(path);
			extraction = kind === "canvas" ? extractCanvas(text) : extractBaseFile(text);
		}
		return { kind, found: extraction.refs, issues: extraction.issues, external: extraction.external };
	} catch (error) {
		return { kind, found: [], issues: [{ kind: "read-error", message: `The file couldn't be read: ${error instanceof Error ? error.message : String(error)}` }], external: 0 };
	}
}

/** Vault path a found reference opens. Canvas paths are exact; everything else uses Obsidian's resolution. */
export function resolveTarget(host: Host, sourcePath: string, ref: Pick<FoundRef, "place" | "form" | "linkpath">): string | null {
	if (ref.place.type === "canvas" && ref.form === "path") return host.getFile(ref.linkpath)?.path ?? null;
	if (ref.linkpath.trim() === "") return null;
	return host.resolveLink(ref.linkpath, sourcePath);
}

/** Resolves found references and keeps the ones that concern attachments. */
export function toEntry(host: Host, path: string, extracted: Extracted): SourceEntry {
	const refs: Reference[] = [];
	const seen = new Set<string>();
	for (const found of extracted.found) {
		const resolvedPath = resolveTarget(host, path, found);
		if (!isAttachmentReference(found.linkpath, resolvedPath)) continue;
		let key = found.key;
		for (let n = 2; seen.has(key); n++) key = `${found.key}#${n}`;
		seen.add(key);
		refs.push({ ...found, key, id: `${path}\u0000${key}`, sourcePath: path, sourceKind: extracted.kind, resolvedPath });
	}
	return { kind: extracted.kind, refs, issues: extracted.issues.map((issue) => ({ ...issue, sourcePath: path })), external: extracted.external };
}

export interface ScanResult {
	attachments: AttachmentInfo[];
	sources: Map<string, SourceEntry>;
}

/** Reads every source and lists every attachment. Doesn't touch the index until it's done. */
export async function runFullScan(host: Host, excluded: readonly string[], token: CancelToken, timing: Timing, onProgress: (p: ScanProgress) => void): Promise<ScanResult> {
	onProgress({ phase: "listing", done: 0, total: 0, refs: 0, broken: 0 });
	const files = host.listFiles().filter((file) => !isExcluded(file.path, host.configDir, excluded));
	const sourceFiles = files.filter((file) => isSourcePath(file.path));
	const attachments = files.filter((file) => !isSourcePath(file.path)).map(attachmentInfo);
	await timing.yieldToUi();
	token.check();

	const extracted = new Map<string, Extracted>();
	let refs = 0;
	await runChunked(
		sourceFiles,
		async (file) => {
			const result = await extractSource(host, file.path);
			if (result) {
				extracted.set(file.path, result);
				refs += result.found.length;
			}
		},
		token,
		timing,
		(done) => onProgress({ phase: "reading", done, total: sourceFiles.length, refs, broken: 0 }),
	);

	const sources = new Map<string, SourceEntry>();
	const paths = [...extracted.keys()];
	let kept = 0;
	let broken = 0;
	await runChunked(
		paths,
		(path) => {
			const entry = toEntry(host, path, extracted.get(path) as Extracted);
			kept += entry.refs.length;
			broken += entry.refs.filter((r) => r.resolvedPath === null).length;
			sources.set(path, entry);
		},
		token,
		timing,
		(done) => onProgress({ phase: "resolving", done, total: paths.length, refs: kept, broken }),
	);
	return { attachments, sources };
}
