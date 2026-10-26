import { setIcon, setTooltip } from "obsidian";

/** A native-looking button with an optional icon. */
export function button(parent: HTMLElement, text: string, options: { icon?: string; cta?: boolean; cls?: string; tooltip?: string; disabled?: boolean } = {}): HTMLButtonElement {
	const el = parent.createEl("button", { cls: ["al-button", ...(options.cls ? [options.cls] : [])] });
	if (options.cta) el.addClass("mod-cta");
	if (options.icon) setIcon(el.createSpan({ cls: "al-button-icon" }), options.icon);
	el.createSpan({ text });
	if (options.tooltip) setTooltip(el, options.tooltip);
	if (options.disabled) el.disabled = true;
	return el;
}

/** A button that shows only an icon, labelled for screen readers and with a tooltip. */
export function iconButton(parent: HTMLElement, icon: string, label: string, cls = ""): HTMLButtonElement {
	const el = parent.createEl("button", { cls: ["al-icon-button", "clickable-icon", ...(cls ? [cls] : [])], attr: { "aria-label": label } });
	setIcon(el, icon);
	return el;
}

let labels = 0;

/**
 * Names an element for screen readers through a hidden label. Obsidian shows every aria-label as a
 * hover tooltip, which is noise where the name only repeats what's already visible.
 */
export function srLabel(el: HTMLElement, text: string): void {
	const id = `al-label-${++labels}`;
	el.before(createSpan({ cls: "al-sr-only", text, attr: { id } }));
	el.setAttribute("aria-labelledby", id);
}

/** Text only screen readers announce. */
export function srText(parent: HTMLElement, text: string): HTMLElement {
	return parent.createSpan({ cls: "al-sr-only", text });
}

export function pill(parent: HTMLElement, text: string, kind: "error" | "warning" | "success" | "muted"): HTMLElement {
	return parent.createSpan({ cls: ["al-pill", `al-pill-${kind}`], text });
}

export function code(parent: HTMLElement, text: string, cls = ""): HTMLElement {
	const max = 300;
	return parent.createEl("code", { cls: ["al-code", ...(cls ? [cls] : [])], text: text.length > max ? `${text.slice(0, max - 1)}…` : text });
}

/** A banner row: icon, title and text, then actions. */
export function banner(parent: HTMLElement, kind: "success" | "warning" | "error" | "info", icon: string, title: string, text: string | null): { el: HTMLElement; actions: HTMLElement } {
	const el = parent.createDiv({ cls: ["al-banner", `al-banner-${kind}`], attr: { role: kind === "error" || kind === "warning" ? "alert" : "status" } });
	setIcon(el.createSpan({ cls: "al-banner-icon" }), icon);
	const msg = el.createDiv({ cls: "al-banner-message" });
	msg.createDiv({ cls: "al-banner-title", text: title });
	if (text) msg.createDiv({ cls: "al-banner-text", text });
	const actions = el.createDiv({ cls: "al-banner-actions" });
	return { el, actions };
}

export async function copyText(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		return false;
	}
}
