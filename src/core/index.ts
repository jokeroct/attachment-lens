// The in-memory index of attachments and the references to them. It's rebuilt by a full scan and
// kept current per file afterwards.
import { CATEGORY_ORDER, categoryOfPath, type Category } from "./fileTypes";
import { basename, dirname, foldName, joinPath } from "./paths";
import type { AttachmentInfo, CoverageIssue, Reference, SourceKind } from "./types";

export type FilterId = "all" | "broken" | "unreferenced" | "uncertain";
export type SortId = "name" | "folder" | "size" | "modified" | "references";

export interface AttachmentItem {
	kind: "attachment";
	id: string;
	path: string;
	name: string;
	folder: string;
	info: AttachmentInfo;
	refs: Reference[];
	uncertain: number;
}

export interface MissingItem {
	kind: "missing";
	id: string;
	name: string;
	/** The missing path, as most references write it */
	target: string;
	category: Category;
	refs: Reference[];
	uncertain: number;
}

export type ListItem = AttachmentItem | MissingItem;

export interface Counts {
	attachments: number;
	/** Broken references, and the missing files they point to */
	broken: number;
	missing: number;
	unreferenced: number;
	uncertain: number;
	byCategory: Record<Category, number>;
}

export interface SourceEntry {
	kind: SourceKind;
	refs: Reference[];
	issues: CoverageIssue[];
	external: number;
}

/** Groups broken references that point at the same missing file. */
export function missingKey(ref: Pick<Reference, "linkpath" | "sourcePath">): string {
	let path = ref.linkpath;
	if (path.startsWith("./") || path.startsWith("../")) path = joinPath(dirname(ref.sourcePath), path) ?? path;
	return foldName(path.replace(/^\/+/, ""));
}

export function nameKey(linkpath: string): string {
	return foldName(basename(linkpath));
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export class ReferenceIndex {
	private readonly attachments = new Map<string, AttachmentInfo>();
	private readonly sources = new Map<string, SourceEntry>();
	private readonly byTarget = new Map<string, Set<Reference>>();
	private readonly byName = new Map<string, Set<Reference>>();
	private readonly broken = new Set<Reference>();
	/** Increases on every change, so views can tell when to redraw */
	version = 0;

	clear(): void {
		this.attachments.clear();
		this.sources.clear();
		this.byTarget.clear();
		this.byName.clear();
		this.broken.clear();
		this.version++;
	}

	setAttachment(info: AttachmentInfo): void {
		this.attachments.set(info.path, info);
		this.version++;
	}

	deleteAttachment(path: string): void {
		this.attachments.delete(path);
		this.version++;
	}

	getAttachment(path: string): AttachmentInfo | undefined {
		return this.attachments.get(path);
	}

	attachmentList(): AttachmentInfo[] {
		return [...this.attachments.values()];
	}

	private link(ref: Reference): void {
		const name = nameKey(ref.linkpath);
		let named = this.byName.get(name);
		if (!named) this.byName.set(name, (named = new Set()));
		named.add(ref);
		if (ref.resolvedPath === null) this.broken.add(ref);
		else {
			let set = this.byTarget.get(ref.resolvedPath);
			if (!set) this.byTarget.set(ref.resolvedPath, (set = new Set()));
			set.add(ref);
		}
	}

	private unlink(ref: Reference): void {
		this.byName.get(nameKey(ref.linkpath))?.delete(ref);
		this.broken.delete(ref);
		if (ref.resolvedPath !== null) this.byTarget.get(ref.resolvedPath)?.delete(ref);
	}

	setSource(path: string, entry: SourceEntry): void {
		this.deleteSource(path);
		this.sources.set(path, entry);
		for (const ref of entry.refs) this.link(ref);
		this.version++;
	}

	deleteSource(path: string): void {
		const old = this.sources.get(path);
		if (!old) return;
		for (const ref of old.refs) this.unlink(ref);
		this.sources.delete(path);
		this.version++;
	}

	getSource(path: string): SourceEntry | undefined {
		return this.sources.get(path);
	}

	sourcePaths(): string[] {
		return [...this.sources.keys()];
	}

	getRef(id: string): Reference | undefined {
		const source = id.slice(0, id.indexOf("\u0000"));
		return this.sources.get(source)?.refs.find((ref) => ref.id === id);
	}

	/** References whose target file name matches, broken or not. */
	refsNamed(linkpathOrName: string): Reference[] {
		return [...(this.byName.get(nameKey(linkpathOrName)) ?? [])];
	}

	refsTo(path: string): Reference[] {
		return [...(this.byTarget.get(path) ?? [])];
	}

	/** Moves a reference to a new resolution, or drops it when it no longer concerns an attachment. */
	resolve(ref: Reference, resolvedPath: string | null, keep: boolean): void {
		const entry = this.sources.get(ref.sourcePath);
		if (!entry || !entry.refs.includes(ref)) return;
		this.unlink(ref);
		if (!keep) {
			entry.refs = entry.refs.filter((r) => r !== ref);
		} else {
			ref.resolvedPath = resolvedPath;
			this.link(ref);
		}
		this.version++;
	}

	issues(): CoverageIssue[] {
		return [...this.sources.values()].flatMap((entry) => entry.issues);
	}

	externalCount(): number {
		let n = 0;
		for (const entry of this.sources.values()) n += entry.external;
		return n;
	}

	referenceCount(): number {
		let n = 0;
		for (const entry of this.sources.values()) n += entry.refs.length;
		return n;
	}

	brokenRefs(): Reference[] {
		return [...this.broken];
	}

	counts(): Counts {
		const byCategory = Object.fromEntries(CATEGORY_ORDER.map((c) => [c, 0])) as Record<Category, number>;
		let unreferenced = 0;
		for (const info of this.attachments.values()) {
			byCategory[info.category]++;
			if ((this.byTarget.get(info.path)?.size ?? 0) === 0) unreferenced++;
		}
		let uncertain = 0;
		for (const entry of this.sources.values()) for (const ref of entry.refs) if (ref.confidence === "uncertain") uncertain++;
		const missing = new Set([...this.broken].map(missingKey));
		return { attachments: this.attachments.size, broken: this.broken.size, missing: missing.size, unreferenced, uncertain, byCategory };
	}

	private attachmentItem(info: AttachmentInfo): AttachmentItem {
		const refs = [...(this.byTarget.get(info.path) ?? [])];
		return {
			kind: "attachment",
			id: info.path,
			path: info.path,
			name: info.name,
			folder: dirname(info.path),
			info,
			refs,
			uncertain: refs.filter((r) => r.confidence === "uncertain").length,
		};
	}

	private missingItems(): MissingItem[] {
		const groups = new Map<string, Reference[]>();
		for (const ref of this.broken) {
			const key = missingKey(ref);
			let list = groups.get(key);
			if (!list) groups.set(key, (list = []));
			list.push(ref);
		}
		const items: MissingItem[] = [];
		for (const [key, refs] of groups) {
			refs.sort((a, b) => compare(a.sourcePath, b.sourcePath) || compare(a.key, b.key));
			const first = refs[0] as Reference;
			items.push({
				kind: "missing",
				id: `missing:${key}`,
				name: basename(first.linkpath),
				target: first.linkpath,
				category: categoryOfPath(first.linkpath),
				refs,
				uncertain: refs.filter((r) => r.confidence === "uncertain").length,
			});
		}
		return items;
	}

	getItem(id: string): ListItem | null {
		if (id.startsWith("missing:")) return this.missingItems().find((item) => item.id === id) ?? null;
		const info = this.attachments.get(id);
		return info ? this.attachmentItem(info) : null;
	}

	query(filter: FilterId, category: Category | "all", search: string, sort: SortId): ListItem[] {
		let items: ListItem[];
		if (filter === "broken") items = this.missingItems();
		else if (filter === "uncertain") {
			const withUncertain = [...this.attachments.values()].map((info) => this.attachmentItem(info)).filter((item) => item.uncertain > 0);
			items = [...withUncertain, ...this.missingItems().filter((item) => item.uncertain > 0)];
		} else {
			items = [];
			for (const info of this.attachments.values()) {
				if (filter === "unreferenced" && (this.byTarget.get(info.path)?.size ?? 0) > 0) continue;
				items.push(this.attachmentItem(info));
			}
		}
		if (category !== "all") items = items.filter((item) => (item.kind === "attachment" ? item.info.category : item.category) === category);
		const words = foldName(search).split(/\s+/).filter(Boolean);
		if (words.length > 0) {
			items = items.filter((item) => {
				const haystack = foldName(item.kind === "attachment" ? item.path : `${item.target} ${item.refs.map((r) => r.sourcePath).join(" ")}`);
				return words.every((word) => haystack.includes(word));
			});
		}
		const name = (item: ListItem) => foldName(item.name);
		const folder = (item: ListItem) => (item.kind === "attachment" ? foldName(item.folder) : foldName(dirname(item.target)));
		const sorters: Record<SortId, (a: ListItem, b: ListItem) => number> = {
			name: (a, b) => compare(name(a), name(b)) || compare(a.id, b.id),
			folder: (a, b) => compare(folder(a), folder(b)) || compare(name(a), name(b)) || compare(a.id, b.id),
			size: (a, b) => (b.kind === "attachment" ? b.info.size : -1) - (a.kind === "attachment" ? a.info.size : -1) || compare(a.id, b.id),
			modified: (a, b) => (b.kind === "attachment" ? b.info.mtime : -1) - (a.kind === "attachment" ? a.info.mtime : -1) || compare(a.id, b.id),
			references: (a, b) => b.refs.length - a.refs.length || compare(name(a), name(b)) || compare(a.id, b.id),
		};
		return items.sort(sorters[sort]);
	}
}
