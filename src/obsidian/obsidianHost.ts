import { FileView, MarkdownView, type App, type CachedMetadata, type TFile } from "obsidian";
import type { Host, HostFile } from "./host";

function toHostFile(file: TFile): HostFile {
	return { path: file.path, name: file.name, extension: file.extension, size: file.stat.size, mtime: file.stat.mtime };
}

/** The Host interface backed by Obsidian's public Vault, MetadataCache and Workspace APIs. */
export class ObsidianHost implements Host {
	constructor(private readonly app: App) {}

	get configDir(): string {
		return this.app.vault.configDir;
	}

	private file(path: string): TFile {
		const file = this.app.vault.getFileByPath(path);
		if (!file) throw new Error(`${path} doesn't exist`);
		return file;
	}

	listFiles(): HostFile[] {
		return this.app.vault.getFiles().map(toHostFile);
	}

	getFile(path: string): HostFile | null {
		const file = this.app.vault.getFileByPath(path);
		return file ? toHostFile(file) : null;
	}

	cachedRead(path: string): Promise<string> {
		return this.app.vault.cachedRead(this.file(path));
	}

	read(path: string): Promise<string> {
		return this.app.vault.read(this.file(path));
	}

	getCache(path: string): CachedMetadata | null {
		return this.app.metadataCache.getCache(path);
	}

	resolveLink(linkpath: string, sourcePath: string): string | null {
		return this.app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath)?.path ?? null;
	}

	process(path: string, fn: (data: string) => string): Promise<string> {
		return this.app.vault.process(this.file(path), fn);
	}

	openEditorTexts(path: string): string[] {
		const texts: string[] = [];
		this.app.workspace.iterateAllLeaves((leaf) => {
			const view = leaf.view;
			if (view instanceof MarkdownView && view.file?.path === path) texts.push(view.getViewData());
		});
		return texts;
	}

	isOpenInFileView(path: string): boolean {
		let open = false;
		this.app.workspace.iterateAllLeaves((leaf) => {
			const view = leaf.view;
			if (view instanceof FileView && !(view instanceof MarkdownView) && view.file?.path === path) open = true;
		});
		return open;
	}

	waitForCache(path: string, timeoutMs: number): Promise<CachedMetadata | null> {
		const cache = this.app.metadataCache;
		return new Promise((resolve) => {
			let done = false;
			const finish = (value: CachedMetadata | null) => {
				if (done) return;
				done = true;
				cache.offref(ref);
				window.clearTimeout(timer);
				resolve(value);
			};
			const ref = cache.on("changed", (file, _data, fresh) => {
				if (file.path === path) finish(fresh);
			});
			const timer = window.setTimeout(() => finish(cache.getCache(path)), timeoutMs);
		});
	}

	indexedNotes(): { indexed: number; total: number } {
		const notes = this.app.vault.getMarkdownFiles();
		let indexed = 0;
		for (const note of notes) if (this.app.metadataCache.getFileCache(note)) indexed++;
		return { indexed, total: notes.length };
	}

	waitForResolved(timeoutMs: number): Promise<void> {
		const cache = this.app.metadataCache;
		return new Promise((resolve) => {
			const finish = () => {
				cache.offref(ref);
				window.clearTimeout(timer);
				resolve();
			};
			const ref = cache.on("resolved", finish);
			const timer = window.setTimeout(finish, timeoutMs);
		});
	}
}
