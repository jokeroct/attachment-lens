import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { CachedMetadata } from "obsidian";
import type { Scheduler } from "../src/obsidian/controller";
import type { Host, HostFile } from "../src/obsidian/host";
import { basename, dirname, extname, foldName, isSourcePath, joinPath } from "../src/core/paths";
import { fakeCache, VAULT } from "./helpers";

interface Entry {
	text: string | null;
	size: number;
	mtime: number;
}

/** An in-memory vault with Obsidian-like link resolution. */
export class FakeHost implements Host {
	readonly configDir = ".obsidian";
	readonly files = new Map<string, Entry>();
	readonly editors = new Map<string, string[]>();
	readonly openViews = new Set<string>();
	readonly caches = new Map<string, CachedMetadata | null>();
	/** Notes whose cache isn't ready yet */
	readonly unindexed = new Set<string>();
	failNextWrite: Error | null = null;
	/** Runs inside process() before the callback, to simulate an edit racing the write */
	beforeProcess: ((path: string) => void) | null = null;
	writes = 0;

	static fromFixtureVault(): FakeHost {
		const host = new FakeHost();
		const walk = (dir: string) => {
			for (const name of readdirSync(dir)) {
				const full = join(dir, name);
				if (name === ".obsidian") continue;
				if (statSync(full).isDirectory()) walk(full);
				else {
					const path = relative(VAULT, full).split("\\").join("/");
					const text = isSourcePath(path) ? readFileSync(full, "utf8") : null;
					host.files.set(path, { text, size: statSync(full).size, mtime: Math.floor(statSync(full).mtimeMs) });
				}
			}
		};
		walk(VAULT);
		return host;
	}

	setText(path: string, text: string): void {
		this.files.set(path, { text, size: text.length, mtime: Date.now() });
		this.caches.delete(path);
	}

	setBinary(path: string, size = 10): void {
		this.files.set(path, { text: null, size, mtime: Date.now() });
	}

	remove(path: string): void {
		this.files.delete(path);
		this.caches.delete(path);
	}

	private toFile(path: string, entry: Entry): HostFile {
		const name = basename(path);
		return { path, name, extension: extname(path), size: entry.size, mtime: entry.mtime };
	}

	listFiles(): HostFile[] {
		return [...this.files].map(([path, entry]) => this.toFile(path, entry));
	}

	getFile(path: string): HostFile | null {
		const entry = this.files.get(path);
		return entry ? this.toFile(path, entry) : null;
	}

	private text(path: string): string {
		const entry = this.files.get(path);
		if (!entry) throw new Error(`ENOENT: ${path}`);
		if (entry.text === null) throw new Error(`Binary file: ${path}`);
		return entry.text;
	}

	cachedRead(path: string): Promise<string> {
		return Promise.resolve(this.text(path));
	}

	read(path: string): Promise<string> {
		return Promise.resolve(this.text(path));
	}

	getCache(path: string): CachedMetadata | null {
		if (!path.endsWith(".md") || !this.files.has(path) || this.unindexed.has(path)) return null;
		let cache = this.caches.get(path);
		if (cache === undefined) {
			cache = fakeCache(this.text(path));
			this.caches.set(path, cache);
		}
		return cache;
	}

	/** Approximates Obsidian: relative paths, exact paths, then the best match by file name. */
	resolveLink(linkpath: string, sourcePath: string): string | null {
		const lower = new Map([...this.files.keys()].map((p) => [foldName(p), p]));
		if (linkpath.startsWith("./") || linkpath.startsWith("../")) {
			const joined = joinPath(dirname(sourcePath), linkpath);
			return joined === null ? null : (lower.get(foldName(joined)) ?? null);
		}
		const clean = linkpath.replace(/^\/+/, "");
		const candidates = extname(clean) === "" ? [`${clean}.md`, clean] : [clean];
		for (const c of candidates) {
			const exact = lower.get(foldName(c));
			if (exact) return exact;
		}
		for (const c of candidates) {
			const want = foldName(c);
			const matches = [...this.files.keys()].filter((p) => foldName(p).endsWith(`/${want}`));
			if (matches.length === 0) continue;
			matches.sort((a, b) => {
				const sameA = dirname(a) === dirname(sourcePath) ? 0 : 1;
				const sameB = dirname(b) === dirname(sourcePath) ? 0 : 1;
				return sameA - sameB || a.length - b.length || (a < b ? -1 : 1);
			});
			return matches[0] ?? null;
		}
		return null;
	}

	process(path: string, fn: (data: string) => string): Promise<string> {
		this.beforeProcess?.(path);
		const current = this.text(path);
		const next = fn(current);
		if (this.failNextWrite) {
			const error = this.failNextWrite;
			this.failNextWrite = null;
			return Promise.reject(error);
		}
		this.writes++;
		this.setText(path, next);
		return Promise.resolve(next);
	}

	openEditorTexts(path: string): string[] {
		return this.editors.get(path) ?? [];
	}

	isOpenInFileView(path: string): boolean {
		return this.openViews.has(path);
	}

	waitForCache(path: string): Promise<CachedMetadata | null> {
		return Promise.resolve(this.getCache(path));
	}

	indexedNotes(): { indexed: number; total: number } {
		const notes = [...this.files.keys()].filter((p) => p.endsWith(".md"));
		return { indexed: notes.filter((p) => !this.unindexed.has(p)).length, total: notes.length };
	}

	waitForResolved(): Promise<void> {
		return Promise.resolve();
	}
}

/** Timers that run only when the test advances them. */
export class ManualScheduler implements Scheduler {
	budgetMs = 8;
	yields = 0;
	private timers = new Map<number, () => void>();
	private next = 1;
	onYield: (() => void) | null = null;

	now(): number {
		return performance.now();
	}

	yieldToUi = async (): Promise<void> => {
		this.yields++;
		this.onYield?.();
		await Promise.resolve();
	};

	setTimeout(fn: () => void, _ms: number): number {
		const id = this.next++;
		this.timers.set(id, fn);
		return id;
	}

	clearTimeout(id: number): void {
		this.timers.delete(id);
	}

	get pending(): number {
		return this.timers.size;
	}

	runTimers(): void {
		const fns = [...this.timers.values()];
		this.timers.clear();
		for (const fn of fns) fn();
	}
}
