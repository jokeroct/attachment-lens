// What Attachment Lens needs from Obsidian, as a narrow interface. The plugin passes an
// implementation backed by the app; tests pass an in-memory one.
import type { CachedMetadata } from "obsidian";

export interface HostFile {
	path: string;
	name: string;
	extension: string;
	size: number;
	mtime: number;
}

export interface Host {
	/** The vault's configuration folder, usually ".obsidian" */
	readonly configDir: string;
	listFiles(): HostFile[];
	getFile(path: string): HostFile | null;
	/** Reads through Obsidian's cache; used for scanning */
	cachedRead(path: string): Promise<string>;
	/** Reads the file on disk; used before and after a repair */
	read(path: string): Promise<string>;
	getCache(path: string): CachedMetadata | null;
	/** Vault path a link opens from `sourcePath`, using Obsidian's link resolution */
	resolveLink(linkpath: string, sourcePath: string): string | null;
	/** Atomic read-modify-write. Throwing from `fn` cancels the write. */
	process(path: string, fn: (data: string) => string): Promise<string>;
	/** Text of every editor that has the note open */
	openEditorTexts(path: string): string[];
	/** True when a Canvas, Bases or other non-editor view has the file open */
	isOpenInFileView(path: string): boolean;
	/** Resolves with the note's cache after Obsidian next indexes it, or after the timeout */
	waitForCache(path: string, timeoutMs: number): Promise<CachedMetadata | null>;
	/** How many notes Obsidian has indexed so far */
	indexedNotes(): { indexed: number; total: number };
	/** Resolves when Obsidian reports that link resolution is up to date, or after the timeout */
	waitForResolved(timeoutMs: number): Promise<void>;
}

/** Lets the event loop run so Obsidian can paint and handle input between batches. */
export type Yield = () => Promise<void>;
