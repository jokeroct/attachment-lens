import { getIconIds } from "obsidian";
import type { Category } from "../core/fileTypes";

export function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KB", "MB", "GB", "TB"];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit] as string}`;
}

export function formatBytes(bytes: number): string {
	return `${formatSize(bytes)}${bytes >= 1024 ? ` (${bytes.toLocaleString()} bytes)` : ""}`;
}

export function formatDate(ms: number): string {
	return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function formatAgo(ms: number, now = Date.now()): string {
	const seconds = Math.round((ms - now) / 1000);
	const format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
	if (Math.abs(seconds) < 60) return format.format(seconds, "second");
	const minutes = Math.round(seconds / 60);
	if (Math.abs(minutes) < 60) return format.format(minutes, "minute");
	const hours = Math.round(minutes / 60);
	if (Math.abs(hours) < 24) return format.format(hours, "hour");
	return format.format(Math.round(hours / 24), "day");
}

export function plural(n: number, one: string, many = `${one}s`): string {
	return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

let iconIds: Set<string> | null = null;

/** The first icon name this Obsidian version has; Lucide renamed several over time. */
export function icon(...names: string[]): string {
	iconIds ??= new Set(getIconIds());
	return names.find((name) => iconIds?.has(name) || iconIds?.has(`lucide-${name}`)) ?? names[0] ?? "file";
}

export function categoryIcon(category: Category): string {
	switch (category) {
		case "image":
			return icon("image", "file-image");
		case "pdf":
			return icon("file-text");
		case "audio":
			return icon("file-music", "music");
		case "video":
			return icon("file-video-camera", "file-video", "film");
		case "document":
			return icon("file-pen-line", "file-text");
		case "archive":
			return icon("file-archive", "archive");
		case "other":
			return icon("file-question-mark", "file-question", "file");
	}
}
