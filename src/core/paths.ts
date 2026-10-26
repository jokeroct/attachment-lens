// Path helpers for vault-relative paths. Obsidian paths always use "/" and never start with one.

/** Extensions of files Attachment Lens reads as sources rather than listing as attachments. */
export const SOURCE_EXTENSIONS: ReadonlySet<string> = new Set(["md", "canvas", "base"]);

export function basename(path: string): string {
	const slash = path.lastIndexOf("/");
	return slash === -1 ? path : path.slice(slash + 1);
}

/** The folder part of a path, or "" for files at the vault root. */
export function dirname(path: string): string {
	const slash = path.lastIndexOf("/");
	return slash === -1 ? "" : path.slice(0, slash);
}

/** Lower-case extension without the dot, or "" when there is none. Dotfiles like ".env" have none. */
export function extname(path: string): string {
	const name = basename(path);
	const dot = name.lastIndexOf(".");
	if (dot <= 0 || dot === name.length - 1) return "";
	return name.slice(dot + 1).toLowerCase();
}

/** File name without its extension. */
export function stem(path: string): string {
	const name = basename(path);
	const dot = name.lastIndexOf(".");
	return dot <= 0 ? name : name.slice(0, dot);
}

export function isSourcePath(path: string): boolean {
	return SOURCE_EXTENSIONS.has(extname(path));
}

/**
 * Joins a folder and a relative path, resolving "." and ".." segments.
 * Returns null when the result would leave the vault.
 */
export function joinPath(dir: string, relative: string): string | null {
	const parts = dir === "" ? [] : dir.split("/");
	for (const segment of relative.split("/")) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") {
			if (parts.length === 0) return null;
			parts.pop();
		} else {
			parts.push(segment);
		}
	}
	return parts.join("/");
}

/** Path from folder `fromDir` to `toPath`, using "../" where needed. */
export function relativePath(fromDir: string, toPath: string): string {
	const from = fromDir === "" ? [] : fromDir.split("/");
	const to = toPath.split("/");
	let common = 0;
	while (common < from.length && common < to.length - 1 && from[common] === to[common]) common++;
	const ups = from.length - common;
	return [...Array<string>(ups).fill(".."), ...to.slice(common)].join("/");
}

/**
 * True for link targets that point outside the vault: URLs with a scheme, protocol-relative URLs,
 * Windows drive paths and UNC paths.
 */
export function isExternalTarget(target: string): boolean {
	const t = target.trim();
	if (/^[a-zA-Z]:[\\/]/.test(t)) return true;
	if (t.startsWith("\\\\") || t.startsWith("//")) return true;
	return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(t);
}

/** decodeURIComponent that returns the input unchanged when it isn't valid percent-encoding. */
export function safeDecode(value: string): string {
	if (!value.includes("%")) return value;
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

/** Case- and Unicode-normalized form used to compare names. */
export function foldName(value: string): string {
	return value.normalize("NFC").toLowerCase();
}
