import { extname, isSourcePath } from "./paths";

export type Category = "image" | "pdf" | "audio" | "video" | "document" | "archive" | "other";

export const CATEGORY_ORDER: readonly Category[] = ["image", "pdf", "audio", "video", "document", "archive", "other"];

export const CATEGORY_LABELS: Record<Category, string> = {
	image: "Images",
	pdf: "PDFs",
	audio: "Audio",
	video: "Video",
	document: "Documents",
	archive: "Archives",
	other: "Other",
};

const BY_CATEGORY: Record<Exclude<Category, "other">, readonly string[]> = {
	image: ["avif", "bmp", "gif", "jpeg", "jpg", "png", "svg", "webp", "heic", "heif", "tif", "tiff", "ico", "jxl"],
	pdf: ["pdf"],
	audio: ["flac", "m4a", "mp3", "ogg", "oga", "wav", "aac", "opus", "wma", "aif", "aiff"],
	video: ["mkv", "mov", "mp4", "m4v", "ogv", "webm", "3gp", "avi", "wmv"],
	document: [
		"txt", "rtf", "doc", "docx", "odt", "pages", "xls", "xlsx", "ods", "numbers", "csv", "tsv", "ppt", "pptx",
		"odp", "key", "epub", "json", "xml", "html", "htm", "yaml", "yml", "tex", "bib", "log", "ini", "toml",
	],
	archive: ["zip", "7z", "rar", "tar", "gz", "tgz", "bz2", "xz"],
};

const CATEGORY_OF = new Map<string, Category>();
for (const [category, extensions] of Object.entries(BY_CATEGORY) as [Category, readonly string[]][]) {
	for (const ext of extensions) CATEGORY_OF.set(ext, category);
}

/**
 * Extensions that count as attachments when a link to them is broken. A broken link with another
 * extension, such as `[[John.Smith]]`, is treated as a link to a note and left to Obsidian.
 */
const KNOWN_ATTACHMENT_EXTENSIONS: ReadonlySet<string> = new Set([...CATEGORY_OF.keys(), "psd", "ai", "sketch", "fig", "drawio", "dwg", "stl", "obj", "mid", "midi"]);

/** Formats Obsidian opens in its own viewers, from its "Accepted file formats" help page. */
const NATIVE_VIEW_EXTENSIONS: ReadonlySet<string> = new Set([
	"avif", "bmp", "gif", "jpeg", "jpg", "png", "svg", "webp",
	"flac", "m4a", "mp3", "ogg", "wav", "webm", "3gp",
	"mkv", "mov", "mp4", "ogv",
	"pdf",
]);

/** Image formats Obsidian's renderer can show as a preview through an <img> element. */
const PREVIEW_EXTENSIONS: ReadonlySet<string> = new Set(["avif", "bmp", "gif", "jpeg", "jpg", "png", "svg", "webp", "ico"]);

const EQUIVALENT_EXTENSIONS: readonly (readonly string[])[] = [["jpg", "jpeg"], ["tif", "tiff"], ["htm", "html"], ["yml", "yaml"], ["aif", "aiff"], ["mpg", "mpeg"]];

export function categoryOf(ext: string): Category {
	return CATEGORY_OF.get(ext.toLowerCase()) ?? "other";
}

export function categoryOfPath(path: string): Category {
	return categoryOf(extname(path));
}

export function hasKnownAttachmentExtension(path: string): boolean {
	const ext = extname(path);
	return ext !== "" && KNOWN_ATTACHMENT_EXTENSIONS.has(ext);
}

/** Any file that isn't a note, Canvas board or base. */
export function isAttachmentPath(path: string): boolean {
	return !isSourcePath(path);
}

export function opensInObsidian(path: string): boolean {
	return NATIVE_VIEW_EXTENSIONS.has(extname(path));
}

export function canPreview(path: string): boolean {
	return PREVIEW_EXTENSIONS.has(extname(path));
}

export function areEquivalentExtensions(a: string, b: string): boolean {
	if (a === b) return true;
	return EQUIVALENT_EXTENSIONS.some((group) => group.includes(a) && group.includes(b));
}

const TYPE_NAMES: Record<string, string> = {
	jpg: "JPEG image", jpeg: "JPEG image", png: "PNG image", gif: "GIF image", svg: "SVG image", webp: "WebP image",
	avif: "AVIF image", bmp: "BMP image", heic: "HEIC image", heif: "HEIF image", tif: "TIFF image", tiff: "TIFF image",
	ico: "Icon", jxl: "JPEG XL image", pdf: "PDF document", mp3: "MP3 audio", m4a: "M4A audio", wav: "WAV audio",
	flac: "FLAC audio", ogg: "Ogg audio", opus: "Opus audio", aac: "AAC audio", mp4: "MP4 video", mov: "QuickTime video",
	mkv: "Matroska video", webm: "WebM video", ogv: "Ogg video", avi: "AVI video", docx: "Word document",
	doc: "Word document", xlsx: "Excel workbook", xls: "Excel workbook", pptx: "PowerPoint presentation",
	ppt: "PowerPoint presentation", odt: "OpenDocument text", ods: "OpenDocument spreadsheet", txt: "Plain text",
	csv: "CSV table", json: "JSON data", zip: "ZIP archive", "7z": "7-Zip archive", rar: "RAR archive",
	tar: "Tar archive", gz: "Gzip archive", epub: "EPUB book", html: "HTML page", htm: "HTML page",
};

/** A readable type name such as "JPEG image", falling back to "XYZ file". */
export function describeType(path: string): string {
	const ext = extname(path);
	if (ext === "") return "File without extension";
	return TYPE_NAMES[ext] ?? `${ext.toUpperCase()} file`;
}

/** Short format label such as "WebP", used in suggestion reasons. */
export function formatLabel(ext: string): string {
	const name = TYPE_NAMES[ext];
	if (name) return name.split(" ")[0] ?? ext.toUpperCase();
	return ext.toUpperCase();
}
