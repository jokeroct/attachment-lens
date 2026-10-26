// Owns the index and the scan state. Starts full scans on request and, once a scan has finished,
// keeps results current from vault events, debounced and per file.
import { ReferenceIndex } from "../core/index";
import { isAttachmentReference } from "../core/extract";
import { basename, isSourcePath } from "../core/paths";
import type { Reference } from "../core/types";
import type { Host } from "./host";
import { attachmentInfo, CancelToken, extractSource, isExcluded, resolveTarget, runChunked, runFullScan, ScanCancelled, toEntry, type ScanProgress, type Timing } from "./scanner";

export type ScanState =
	| { status: "idle" }
	| { status: "scanning"; progress: ScanProgress }
	| { status: "cancelled" }
	| { status: "error"; message: string; detail: string }
	| { status: "ready"; scannedAt: number; updating: boolean };

export interface Scheduler extends Timing {
	setTimeout(fn: () => void, ms: number): number;
	clearTimeout(id: number): void;
}

type Change = { type: "changed"; path: string } | { type: "deleted"; path: string } | { type: "renamed"; path: string; oldPath: string };

export const DEBOUNCE_MS = 400;
const INDEX_WAIT_MS = 20_000;

export class LensController {
	readonly index = new ReferenceIndex();
	state: ScanState = { status: "idle" };
	private readonly listeners = new Set<() => void>();
	private token: CancelToken | null = null;
	private queue: Change[] = [];
	private timer: number | null = null;
	private flushing: Promise<void> | null = null;

	constructor(
		private readonly host: Host,
		private readonly excluded: () => readonly string[],
		private readonly scheduler: Scheduler,
		private readonly indexWaitMs = INDEX_WAIT_MS,
	) {}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emit(): void {
		for (const listener of this.listeners) listener();
	}

	private setState(state: ScanState): void {
		this.state = state;
		this.emit();
	}

	get hasResults(): boolean {
		return this.state.status === "ready";
	}

	/** Starts a full scan. Resolves when it finishes, is cancelled or fails. */
	async scan(): Promise<void> {
		if (this.state.status === "scanning") return;
		const token = new CancelToken();
		this.token = token;
		if (this.timer !== null) this.scheduler.clearTimeout(this.timer);
		this.timer = null;
		this.queue = [];
		const progress = (p: ScanProgress) => {
			if (this.token === token) this.setState({ status: "scanning", progress: p });
		};
		try {
			await this.waitForIndex(token, progress);
			const result = await runFullScan(this.host, this.excluded(), token, this.scheduler, progress);
			token.check();
			this.index.clear();
			for (const info of result.attachments) this.index.setAttachment(info);
			for (const [path, entry] of result.sources) this.index.setSource(path, entry);
			this.token = null;
			this.setState({ status: "ready", scannedAt: Date.now(), updating: false });
			// Changes that arrived during the scan
			if (this.queue.length > 0) this.scheduleFlush();
		} catch (error) {
			if (this.token !== token) return;
			this.token = null;
			this.queue = [];
			if (error instanceof ScanCancelled) {
				this.setState({ status: "cancelled" });
			} else {
				const message = error instanceof Error ? error.message : String(error);
				const detail = error instanceof Error && error.stack ? error.stack : message;
				this.setState({ status: "error", message, detail });
			}
		}
	}

	cancel(): void {
		this.token?.cancel();
	}

	/** Waits, briefly, for Obsidian to finish indexing notes after startup. */
	private async waitForIndex(token: CancelToken, progress: (p: ScanProgress) => void): Promise<void> {
		const start = this.scheduler.now();
		for (;;) {
			const { indexed, total } = this.host.indexedNotes();
			progress({ phase: "waiting", done: indexed, total, refs: 0, broken: 0 });
			if (indexed >= total || this.scheduler.now() - start > this.indexWaitMs) return;
			await this.host.waitForResolved(500);
			token.check();
		}
	}

	// Vault events. They're ignored until a first scan has run; during a scan they're queued.

	onChanged(path: string): void {
		this.enqueue({ type: "changed", path });
	}

	onDeleted(path: string): void {
		this.enqueue({ type: "deleted", path });
	}

	onRenamed(path: string, oldPath: string): void {
		this.enqueue({ type: "renamed", path, oldPath });
	}

	private enqueue(change: Change): void {
		if (this.state.status !== "ready" && this.state.status !== "scanning") return;
		this.queue.push(change);
		if (this.state.status === "ready") this.scheduleFlush();
	}

	private scheduleFlush(): void {
		if (this.timer !== null) this.scheduler.clearTimeout(this.timer);
		this.timer = this.scheduler.setTimeout(() => {
			this.timer = null;
			void this.flush();
		}, DEBOUNCE_MS);
	}

	/** Applies queued changes now. Safe to call repeatedly; runs one batch at a time. */
	async flush(): Promise<void> {
		while (this.flushing) await this.flushing;
		if (this.queue.length === 0 || this.state.status !== "ready") return;
		const changes = this.queue;
		this.queue = [];
		this.flushing = this.apply(changes);
		try {
			await this.flushing;
		} finally {
			this.flushing = null;
		}
	}

	private async apply(changes: Change[]): Promise<void> {
		const state = this.state;
		if (state.status !== "ready") return;
		this.setState({ ...state, updating: true });
		const excluded = this.excluded();
		const deleted = new Set<string>();
		const changed = new Set<string>();
		for (const change of changes) {
			if (change.type === "deleted") {
				deleted.add(change.path);
				changed.delete(change.path);
			} else if (change.type === "renamed") {
				this.expandRename(change.oldPath, change.path, deleted, changed);
			} else {
				changed.add(change.path);
				deleted.delete(change.path);
			}
		}

		const reresolve = new Set<Reference>();
		const names = new Set<string>();
		for (const path of deleted) {
			if (this.index.getSource(path)) this.index.deleteSource(path);
			if (this.index.getAttachment(path)) {
				this.index.deleteAttachment(path);
				for (const ref of this.index.refsTo(path)) reresolve.add(ref);
				names.add(basename(path));
			}
		}
		const token = new CancelToken();
		await runChunked(
			[...changed],
			async (path) => {
				const file = this.host.getFile(path);
				if (!file || isExcluded(path, this.host.configDir, excluded)) {
					if (this.index.getSource(path)) this.index.deleteSource(path);
					if (this.index.getAttachment(path)) {
						this.index.deleteAttachment(path);
						for (const ref of this.index.refsTo(path)) reresolve.add(ref);
					}
					return;
				}
				if (isSourcePath(path)) {
					await this.refreshSource(path, false);
				} else {
					const isNew = !this.index.getAttachment(path);
					this.index.setAttachment(attachmentInfo(file));
					if (isNew) names.add(file.name);
				}
			},
			token,
			this.scheduler,
		);
		// A new or removed file can change what other links open, through names they share.
		for (const name of names) for (const ref of this.index.refsNamed(name)) reresolve.add(ref);
		for (const ref of reresolve) {
			if (changed.has(ref.sourcePath) || deleted.has(ref.sourcePath)) continue;
			const resolved = resolveTarget(this.host, ref.sourcePath, ref);
			this.index.resolve(ref, resolved, isAttachmentReference(ref.linkpath, resolved));
		}
		const now = this.state;
		if (now.status === "ready") this.setState({ ...now, updating: false });
	}

	/** A folder rename moves everything indexed under it. */
	private expandRename(oldPath: string, path: string, deleted: Set<string>, changed: Set<string>): void {
		const under = (p: string) => p.startsWith(`${oldPath}/`);
		const moved = [...this.index.sourcePaths().filter(under), ...this.index.attachmentList().map((a) => a.path).filter(under)];
		if (moved.length === 0 && !this.host.getFile(path)) return;
		for (const old of moved) {
			deleted.add(old);
			const next = path + old.slice(oldPath.length);
			changed.add(next);
			deleted.delete(next);
		}
		if (this.host.getFile(path)) {
			deleted.add(oldPath);
			changed.add(path);
		}
	}

	/** Reads one source again right away, for example after a repair wrote to it. */
	async refreshSource(path: string, notify = true): Promise<void> {
		if (this.state.status !== "ready") return;
		const extracted = await extractSource(this.host, path);
		if (!extracted || !this.host.getFile(path)) this.index.deleteSource(path);
		else this.index.setSource(path, toEntry(this.host, path, extracted));
		if (notify) this.emit();
	}

	dispose(): void {
		this.cancel();
		if (this.timer !== null) this.scheduler.clearTimeout(this.timer);
		this.timer = null;
		this.listeners.clear();
	}
}
