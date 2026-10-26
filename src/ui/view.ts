import { DropdownComponent, ItemView, Menu, Notice, Scope, SearchComponent, setIcon, setTooltip, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import { canPreview, CATEGORY_LABELS, CATEGORY_ORDER, categoryOfPath, describeType, opensInObsidian, type Category } from "../core/fileTypes";
import type { AttachmentItem, FilterId, ListItem, MissingItem, SortId } from "../core/index";
import { basename, isSourcePath } from "../core/paths";
import { rankCandidates, searchPaths, type Candidate } from "../core/suggest";
import type { Reference } from "../core/types";
import { formLabel, placeLabel } from "../obsidian/labels";
import type { ScanPhase } from "../obsidian/scanner";
import type AttachmentLensPlugin from "../main";
import { banner, button, code, copyText, iconButton, pill } from "./dom";
import { categoryIcon, formatAgo, formatBytes, formatDate, formatSize, icon, plural } from "./format";
import { VirtualList } from "./virtualList";

export const VIEW_TYPE = "attachment-lens";

const ROW_HEIGHT = 44;
const NARROW_WIDTH = 600;
const FILTERS: { id: FilterId; label: string; short: string }[] = [
	{ id: "all", label: "All attachments", short: "All" },
	{ id: "broken", label: "Broken references", short: "Broken" },
	{ id: "unreferenced", label: "No references detected", short: "No refs" },
	{ id: "uncertain", label: "Uncertain references", short: "Uncertain" },
];
const SORTS: Record<SortId, string> = { name: "Name", folder: "Folder", size: "Size", modified: "Modified", references: "Reference count" };
const PHASES: { id: ScanPhase; label: string }[] = [
	{ id: "waiting", label: "Waiting for Obsidian to finish indexing" },
	{ id: "listing", label: "Listing files" },
	{ id: "reading", label: "Reading sources" },
	{ id: "resolving", label: "Resolving references" },
];
const NEVER_COVERED = "HTML tags such as <img src>, Dataview and Templater code, CSS snippets, plugin file formats such as compressed Excalidraw drawings, nested property objects, and base blocks inside Canvas text cards or callouts.";

interface LensViewState {
	filter: FilterId;
	category: Category | "all";
	sort: SortId;
	search: string;
	selected: string | null;
}

interface PickerState {
	refId: string;
	target: string | null;
	query: string;
}

function isFilter(v: unknown): v is FilterId {
	return FILTERS.some((f) => f.id === v);
}

export class AttachmentLensView extends ItemView {
	private viewState: LensViewState = { filter: "all", category: "all", sort: "name", search: "", selected: null };
	private unsubscribers: (() => void)[] = [];
	private narrow = false;
	private detailsOpen = false;
	private picker: PickerState | null = null;
	private showCoverage = false;
	private frame: number | null = null;
	private lastVersion = -1;
	private lastStatus = "";
	private resize: ResizeObserver | null = null;
	private candidates = new Map<string, Candidate[]>();
	private context = new Map<string, string>();

	private toolbarEl!: HTMLElement;
	private bannersEl!: HTMLElement;
	private bodyEl!: HTMLElement;
	private filtersEl: HTMLElement | null = null;
	private statusEl: HTMLElement | null = null;
	private listPane: HTMLElement | null = null;
	private detailsPane: HTMLElement | null = null;
	private list: VirtualList<ListItem> | null = null;
	private searchBox: SearchComponent | null = null;
	private rescanButton!: HTMLButtonElement;
	private undoButton!: HTMLButtonElement;
	private searchTimer: number | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		private readonly plugin: AttachmentLensPlugin,
	) {
		super(leaf);
		this.scope = new Scope(this.app.scope);
		this.scope.register(["Mod"], "f", () => {
			this.searchBox?.inputEl.focus();
			this.searchBox?.inputEl.select();
			return false;
		});
	}

	override getViewType(): string {
		return VIEW_TYPE;
	}

	override getDisplayText(): string {
		return "Attachment Lens";
	}

	override getIcon(): string {
		return "paperclip";
	}

	override getState(): Record<string, unknown> {
		return { ...this.viewState };
	}

	override async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const s = (typeof state === "object" && state !== null ? state : {}) as Record<string, unknown>;
		this.viewState = {
			filter: isFilter(s.filter) ? s.filter : this.viewState.filter,
			category: typeof s.category === "string" && (s.category === "all" || (CATEGORY_ORDER as readonly string[]).includes(s.category)) ? (s.category as Category | "all") : this.viewState.category,
			sort: typeof s.sort === "string" && s.sort in SORTS ? (s.sort as SortId) : this.viewState.sort,
			search: typeof s.search === "string" ? s.search : this.viewState.search,
			selected: typeof s.selected === "string" ? s.selected : this.viewState.selected,
		};
		this.searchBox?.setValue(this.viewState.search);
		this.render(true);
		await super.setState(state, result);
	}

	override async onOpen(): Promise<void> {
		const el = this.contentEl;
		el.empty();
		el.addClass("al-view");
		this.buildToolbar(el);
		this.bannersEl = el.createDiv({ cls: "al-banners" });
		this.bodyEl = el.createDiv({ cls: "al-body" });
		this.resize = new ResizeObserver(() => this.updateNarrow());
		this.resize.observe(el);
		this.registerDomEvent(el, "keydown", (evt) => {
			if (evt.key === "Escape" && this.plugin.controller.state.status === "scanning") {
				evt.preventDefault();
				this.plugin.controller.cancel();
			}
		});
		this.unsubscribers.push(this.plugin.controller.subscribe(() => this.schedule()));
		this.unsubscribers.push(this.plugin.subscribeUi(() => this.render(true)));
		if (this.plugin.settings.scanOnOpen && this.plugin.controller.state.status === "idle") void this.plugin.controller.scan();
		this.render(true);
	}

	override async onClose(): Promise<void> {
		for (const unsubscribe of this.unsubscribers) unsubscribe();
		this.unsubscribers = [];
		this.resize?.disconnect();
		if (this.frame !== null) window.cancelAnimationFrame(this.frame);
		if (this.frameTimer !== null) window.clearTimeout(this.frameTimer);
		if (this.searchTimer !== null) window.clearTimeout(this.searchTimer);
		this.list?.destroy();
		this.list = null;
	}

	// Public entry points for the plugin

	/** Shows one filter, from the command palette. */
	showFilter(filter: FilterId): void {
		this.viewState = { ...this.viewState, filter, category: "all", search: "", selected: null };
		this.searchBox?.setValue("");
		this.render(true);
		this.list?.focus();
	}

	/** Selects an attachment, from the file menu. */
	reveal(path: string): void {
		this.viewState = { ...this.viewState, filter: "all", category: "all", search: "", selected: path };
		this.searchBox?.setValue("");
		this.picker = null;
		this.showCoverage = false;
		this.detailsOpen = true;
		this.render(true);
		if (this.plugin.controller.hasResults && !this.plugin.controller.index.getAttachment(path)) {
			new Notice(`${basename(path)} isn't in the results. It may be in an excluded folder.`);
		}
	}

	// Layout

	private buildToolbar(parent: HTMLElement): void {
		this.toolbarEl = parent.createDiv({ cls: "al-toolbar" });
		const search = new SearchComponent(this.toolbarEl);
		this.searchBox = search;
		search.setPlaceholder("Search name or path");
		search.inputEl.setAttribute("aria-label", "Search attachments by name or path");
		search.setValue(this.viewState.search);
		search.onChange((value) => {
			if (this.searchTimer !== null) window.clearTimeout(this.searchTimer);
			this.searchTimer = window.setTimeout(() => {
				this.searchTimer = null;
				this.viewState.search = value;
				this.refreshList(true);
			}, 150);
		});
		search.inputEl.addEventListener("keydown", (evt) => {
			if (evt.key === "ArrowDown" || evt.key === "Enter") {
				evt.preventDefault();
				this.list?.focus();
				if (this.list && !this.list.selectedItem) this.list.select(0, true);
			}
		});
		this.rescanButton = button(this.toolbarEl, "Rescan", { icon: icon("refresh-cw") });
		this.rescanButton.addEventListener("click", () => void this.plugin.controller.scan());
		this.undoButton = button(this.toolbarEl, "Undo last repair", { icon: icon("undo-2", "undo") });
		this.undoButton.addEventListener("click", () => void this.plugin.runUndo());
		const more = iconButton(this.toolbarEl, icon("ellipsis", "more-horizontal"), "More options");
		more.addEventListener("click", (evt) => {
			const menu = new Menu();
			menu.addItem((item) =>
				item
					.setTitle("Copy scan summary")
					.setIcon("copy")
					.setDisabled(!this.plugin.controller.hasResults)
					.onClick(() => void copyText(this.summaryText()).then((ok) => new Notice(ok ? "Scan summary copied." : "Couldn't copy the summary."))),
			);
			menu.addItem((item) =>
				item
					.setTitle("Show coverage details")
					.setIcon(icon("list-checks", "list"))
					.setDisabled(!this.plugin.controller.hasResults)
					.onClick(() => this.openCoverage()),
			);
			menu.showAtMouseEvent(evt);
		});
	}

	private updateNarrow(): void {
		const narrow = this.contentEl.clientWidth > 0 && this.contentEl.clientWidth < NARROW_WIDTH;
		if (narrow === this.narrow) return;
		this.narrow = narrow;
		this.contentEl.toggleClass("al-narrow", narrow);
		this.applyNarrow();
	}

	private applyNarrow(): void {
		this.bodyEl.toggleClass("al-show-details", this.narrow && this.detailsOpen);
		this.filtersEl?.querySelectorAll<HTMLElement>("[data-short]").forEach((chip) => {
			const label = chip.querySelector(".al-chip-label");
			if (label) label.setText(this.narrow ? (chip.dataset.short ?? "") : (chip.dataset.long ?? ""));
		});
	}

	/** Redraws on the next frame, or after a short timeout when the window is hidden and frames don't run. */
	private schedule(): void {
		if (this.frame !== null) return;
		const run = () => {
			if (this.frame === null) return;
			window.cancelAnimationFrame(this.frame);
			if (this.frameTimer !== null) window.clearTimeout(this.frameTimer);
			this.frame = null;
			this.frameTimer = null;
			this.render(false);
		};
		this.frame = window.requestAnimationFrame(run);
		this.frameTimer = window.setTimeout(run, 100);
	}

	private frameTimer: number | null = null;

	private render(force: boolean): void {
		if (!this.bodyEl) return;
		const controller = this.plugin.controller;
		const status = controller.state.status;
		this.rescanButton.disabled = status === "scanning";
		this.rescanButton.querySelector("span:last-child")?.setText(status === "ready" ? "Rescan" : "Scan vault");
		const record = this.plugin.recovery;
		this.undoButton.disabled = !this.plugin.repairs.canUndo();
		setTooltip(this.undoButton, record && record.state === "applied" ? `Undo: ${record.summary.place}` : "No repair to undo");
		if (this.searchBox) this.searchBox.inputEl.disabled = status !== "ready";
		this.renderBanners();

		if (status !== "ready") {
			if (force || status !== this.lastStatus || status === "scanning") this.renderNotReady();
			this.lastStatus = status;
			return;
		}
		if (this.lastStatus !== "ready" || !this.listPane) {
			this.buildResults();
			force = true;
		}
		this.lastStatus = status;
		this.renderFilters();
		this.renderStatus();
		if (force || controller.index.version !== this.lastVersion) {
			this.candidates.clear();
			this.context.clear();
			this.refreshList(false);
		}
	}

	private renderNotReady(): void {
		this.list?.destroy();
		this.list = null;
		this.listPane = null;
		this.detailsPane = null;
		this.filtersEl = null;
		this.statusEl = null;
		this.bodyEl.empty();
		this.bodyEl.removeClass("al-show-details");
		const state = this.plugin.controller.state;
		const box = this.bodyEl.createDiv({ cls: "al-empty" });
		if (state.status === "idle") this.renderIntro(box);
		else if (state.status === "scanning") this.renderScanning(box, state.progress);
		else if (state.status === "cancelled") {
			setIcon(box.createDiv({ cls: "al-empty-icon" }), icon("circle-x", "x-circle"));
			box.createEl("h3", { text: "Scan cancelled" });
			box.createEl("p", { text: "No results were kept and no files were changed." });
			button(box, "Scan vault", { icon: icon("scan-search", "search"), cta: true }).addEventListener("click", () => void this.plugin.controller.scan());
		} else if (state.status === "error") {
			const b = banner(box, "error", icon("triangle-alert", "alert-triangle"), "Scan stopped because of an unexpected error", `No files were changed. Error: ${state.message}`);
			b.el.addClass("al-banner-standalone");
			const actions = box.createDiv({ cls: "al-actions" });
			button(actions, "Try again", { icon: icon("refresh-cw"), cta: true }).addEventListener("click", () => void this.plugin.controller.scan());
			button(actions, "Copy error details", { icon: "copy" }).addEventListener("click", () => void copyText(state.detail).then((ok) => new Notice(ok ? "Error details copied." : "Couldn't copy the details.")));
		}
	}

	private renderIntro(box: HTMLElement): void {
		setIcon(box.createDiv({ cls: "al-empty-icon" }), icon("scan-search", "search"));
		box.createEl("h3", { text: "Scan this vault to see where attachments are used" });
		box.createEl("p", { text: "Attachment Lens reads notes, properties, Canvas boards and bases to find attachment references. Scanning doesn't change any files." });
		const files = this.app.vault.getFiles();
		const configDir = this.app.vault.configDir;
		let notes = 0;
		let canvases = 0;
		let bases = 0;
		let attachments = 0;
		for (const file of files) {
			if (file.path.startsWith(".trash/")) continue;
			if (file.extension === "md") notes++;
			else if (file.extension === "canvas") canvases++;
			else if (file.extension === "base") bases++;
			else attachments++;
		}
		const facts = box.createEl("dl", { cls: "al-facts al-facts-compact" });
		facts.createEl("dt", { text: "Sources to read" });
		facts.createEl("dd", { text: `${plural(notes, "note")} · ${plural(canvases, "Canvas board")} · ${plural(bases, "base")}` });
		facts.createEl("dt", { text: "Attachments" });
		facts.createEl("dd", { text: plural(attachments, "file") });
		facts.createEl("dt", { text: "Skipped" });
		const extra = this.plugin.excludedFolders();
		facts.createEl("dd", { text: [`${configDir} (configuration)`, ".trash", ...extra].join(" · ") });
		const actions = box.createDiv({ cls: "al-actions" });
		const scan = button(actions, "Scan vault", { icon: icon("scan-search", "search"), cta: true });
		scan.addEventListener("click", () => void this.plugin.controller.scan());
		box.createEl("p", { cls: "al-muted", text: "You can keep working while the scan runs. Excluded folders can be changed in this plugin's settings." });
		window.setTimeout(() => {
			if (this.contentEl.contains(activeDocument.activeElement) || activeDocument.activeElement === activeDocument.body) scan.focus();
		}, 0);
	}

	private renderScanning(box: HTMLElement, progress: { phase: ScanPhase; done: number; total: number; refs: number; broken: number }): void {
		box.createEl("h3", { text: "Scanning vault" });
		const current = PHASES.findIndex((p) => p.id === progress.phase);
		const steps = box.createEl("ol", { cls: "al-steps" });
		PHASES.forEach((phase, i) => {
			const li = steps.createEl("li", { cls: i < current ? "is-done" : i === current ? "is-current" : "is-pending" });
			setIcon(li.createSpan({ cls: "al-step-icon" }), i < current ? icon("circle-check", "check-circle") : i === current ? icon("loader-circle", "loader", "refresh-cw") : icon("circle"));
			let text = phase.label;
			if (i === current && progress.total > 0) text += `: ${progress.done.toLocaleString()} of ${progress.total.toLocaleString()}`;
			li.createSpan({ text });
		});
		const bar = box.createEl("progress", { cls: "al-progress", attr: { max: String(Math.max(progress.total, 1)), value: String(progress.done), "aria-label": "Scan progress" } });
		bar.value = progress.done;
		if (progress.phase === "reading" || progress.phase === "resolving") {
			box.createEl("p", { cls: "al-muted", text: `Found so far: ${plural(progress.refs, "reference")}${progress.phase === "resolving" ? `, ${progress.broken.toLocaleString()} broken` : ""}` });
		}
		const actions = box.createDiv({ cls: "al-actions" });
		const cancel = button(actions, "Cancel scan", { icon: icon("x") });
		cancel.addEventListener("click", () => this.plugin.controller.cancel());
		if (!this.contentEl.contains(activeDocument.activeElement)) window.setTimeout(() => cancel.focus(), 0);
	}

	private buildResults(): void {
		this.bodyEl.empty();
		this.filtersEl = this.bodyEl.createDiv({ cls: "al-filters", attr: { role: "toolbar", "aria-label": "Filters" } });
		this.statusEl = this.bodyEl.createDiv({ cls: "al-status", attr: { "aria-live": "polite" } });
		const split = this.bodyEl.createDiv({ cls: "al-split" });
		this.listPane = split.createDiv({ cls: "al-list-pane" });
		this.detailsPane = split.createDiv({ cls: "al-details", attr: { tabindex: "-1" } });
		this.detailsPane.addEventListener("keydown", (evt) => {
			if (evt.key !== "Escape" || evt.defaultPrevented) return;
			evt.preventDefault();
			if (this.picker) {
				const refId = this.picker.refId;
				this.picker = null;
				this.renderDetails();
				this.detailsPane?.querySelector<HTMLElement>(`[data-repair="${CSS.escape(refId)}"]`)?.focus();
				return;
			}
			this.closeDetails();
		});
		this.list = new VirtualList<ListItem>(this.listPane, {
			rowHeight: ROW_HEIGHT,
			id: (item) => item.id,
			label: (item) => (item.kind === "attachment" ? `${item.name}, ${item.folder || "vault root"}, ${plural(item.refs.length, "reference")}` : `${item.name}, missing, ${plural(item.refs.length, "reference")}`),
			render: (item, row) => this.renderRow(item, row),
			onSelect: (item) => {
				this.viewState.selected = item.id;
				this.picker = null;
				this.showCoverage = false;
				this.renderDetails();
				this.app.workspace.requestSaveLayout();
			},
			onActivate: () => this.openDetails(),
		});
		this.listPane.createDiv({ cls: "al-list-foot" });
		this.applyNarrow();
	}

	private openDetails(): void {
		this.detailsOpen = true;
		this.applyNarrow();
		window.setTimeout(() => {
			const target = this.detailsPane?.querySelector<HTMLElement>("button, a, input, [tabindex='0']") ?? this.detailsPane;
			target?.focus();
		}, 0);
	}

	private closeDetails(): void {
		this.detailsOpen = false;
		this.applyNarrow();
		this.list?.focus();
	}

	private openCoverage(): void {
		this.showCoverage = true;
		this.picker = null;
		this.renderDetails();
		this.openDetails();
	}

	private renderFilters(): void {
		const el = this.filtersEl;
		if (!el) return;
		const counts = this.plugin.controller.index.counts();
		const issues = this.plugin.controller.index.issues().length;
		el.empty();
		const group = el.createDiv({ cls: "al-filter-group", attr: { role: "group", "aria-label": "Show" } });
		const values: Record<FilterId, number> = { all: counts.attachments, broken: counts.broken, unreferenced: counts.unreferenced, uncertain: counts.uncertain };
		for (const filter of FILTERS) {
			const active = this.viewState.filter === filter.id;
			const chip = group.createEl("button", { cls: ["al-chip", ...(active ? ["is-active"] : [])], attr: { "aria-pressed": String(active), "data-short": filter.short, "data-long": filter.label } });
			chip.createSpan({ cls: "al-chip-label", text: this.narrow ? filter.short : filter.label });
			chip.createSpan({ cls: "al-chip-count", text: values[filter.id].toLocaleString() });
			if (filter.id === "unreferenced" && issues > 0) {
				setIcon(chip.createSpan({ cls: "al-chip-warn" }), icon("triangle-alert", "alert-triangle"));
				setTooltip(chip, `May include attachments used in ${plural(issues, "source")} that weren't fully read`);
			}
			chip.addEventListener("click", () => {
				this.viewState.filter = filter.id;
				this.picker = null;
				this.showCoverage = false;
				this.refreshList(true);
				this.renderFilters();
			});
		}
		el.createDiv({ cls: "al-spacer" });
		const type = new DropdownComponent(el);
		type.addOption("all", "All types");
		for (const category of CATEGORY_ORDER) type.addOption(category, `${CATEGORY_LABELS[category]} (${counts.byCategory[category].toLocaleString()})`);
		type.setValue(this.viewState.category);
		type.selectEl.setAttribute("aria-label", "File type");
		type.onChange((value) => {
			this.viewState.category = value as Category | "all";
			this.refreshList(true);
		});
		const sort = new DropdownComponent(el);
		for (const [id, label] of Object.entries(SORTS)) sort.addOption(id, `Sort: ${label.toLowerCase()}`);
		sort.setValue(this.viewState.sort);
		sort.selectEl.setAttribute("aria-label", "Sort by");
		sort.onChange((value) => {
			this.viewState.sort = value as SortId;
			this.refreshList(true);
		});
	}

	private renderStatus(): void {
		const el = this.statusEl;
		const state = this.plugin.controller.state;
		if (!el || state.status !== "ready") return;
		el.empty();
		const parts = [state.updating ? "Updating…" : `Scanned ${formatAgo(state.scannedAt)}`, "Updates automatically when files change"];
		el.setText(parts.join(" · "));
	}

	/** Re-queries the index and redraws the list, keeping the selection when it still exists. */
	private refreshList(userChange: boolean): void {
		if (!this.list) return;
		const index = this.plugin.controller.index;
		const { filter, category, search, sort } = this.viewState;
		const items = index.query(filter, category, search, sort);
		const previous = this.viewState.selected;
		let selected = previous !== null && items.some((item) => item.id === previous) ? previous : null;
		if (selected === null && items.length > 0 && (userChange || previous !== null)) {
			const at = this.list.length > 0 && previous !== null ? Math.min(this.lastSelectedIndex, items.length - 1) : 0;
			selected = items[Math.max(0, at)]?.id ?? null;
		}
		this.viewState.selected = selected;
		this.list.setItems(items, selected);
		this.lastSelectedIndex = Math.max(0, items.findIndex((item) => item.id === selected));
		if (selected !== null) this.list.scrollIntoView(this.lastSelectedIndex, true);
		this.lastVersion = index.version;
		const foot = this.listPane?.querySelector(".al-list-foot");
		if (foot) {
			if (filter === "broken") {
				const refs = items.reduce((n, item) => n + item.refs.length, 0);
				foot.setText(`${plural(items.length, "missing file")} · ${plural(refs, "reference")}`);
			} else {
				foot.setText(items.length === 0 ? "" : plural(items.length, filter === "uncertain" ? "item" : "attachment"));
			}
		}
		if (!this.picker || !this.viewState.selected || !index.getRef(this.picker.refId)) this.picker = null;
		this.renderDetails();
	}

	private lastSelectedIndex = 0;

	private renderRow(item: ListItem, row: HTMLElement): void {
		row.empty();
		const iconEl = row.createSpan({ cls: "al-row-icon" });
		if (item.kind === "missing") {
			iconEl.addClass("is-missing");
			setIcon(iconEl, icon("unlink"));
		} else {
			setIcon(iconEl, categoryIcon(item.info.category));
		}
		const main = row.createDiv({ cls: "al-row-main" });
		const name = main.createDiv({ cls: "al-row-name" });
		name.createSpan({ cls: "al-row-title", text: item.name });
		if (item.uncertain > 0 && item.uncertain === item.refs.length) pill(name, "uncertain", "warning");
		if (item.kind === "attachment") {
			main.createDiv({ cls: "al-row-path", text: item.folder || "Vault root" });
			row.createSpan({ cls: "al-row-size", text: formatSize(item.info.size) });
		} else {
			const sources = new Set(item.refs.map((r) => r.sourcePath)).size;
			main.createDiv({ cls: "al-row-path", text: item.target.includes("/") ? `Missing · ${item.target}` : `Missing · linked from ${plural(sources, "source")}` });
			row.createSpan({ cls: "al-row-size", text: categoryOfPath(item.target) === "other" ? "" : categoryOfPath(item.target) });
		}
		row.createSpan({ cls: ["al-row-count", ...(item.refs.length === 0 ? ["is-zero"] : [])], text: String(item.refs.length) });
	}

	// Banners

	private renderBanners(): void {
		const el = this.bannersEl;
		el.empty();
		const notice = this.plugin.recoveryNotice;
		if (notice) {
			const file = notice.record.sourcePath;
			const dismiss = () => void this.plugin.dismissRecovery();
			if (notice.status === "unapplied") {
				const b = banner(el, "success", icon("circle-check", "check-circle"), "The last repair didn't finish", `${file} is unchanged, so there's nothing to undo.`);
				button(b.actions, "Dismiss").addEventListener("click", dismiss);
			} else if (notice.status === "applied") {
				const b = banner(el, "success", icon("circle-check", "check-circle"), "The last repair was written before Obsidian closed", `${file} contains the repaired link. Undo is available.`);
				button(b.actions, "Undo repair", { icon: icon("undo-2", "undo") }).addEventListener("click", () => void this.plugin.runUndo());
				button(b.actions, "Dismiss").addEventListener("click", dismiss);
			} else if (notice.status === "conflict") {
				const b = banner(el, "warning", icon("triangle-alert", "alert-triangle"), "The last repair didn't finish, and the file has changed since", `${file} matches neither the original nor the repaired text. Attachment Lens won't change it.`);
				button(b.actions, "Open file").addEventListener("click", () => void this.plugin.openSourceAt(file, null));
				button(b.actions, "Copy original line", { icon: "copy" }).addEventListener("click", () => void copyText(notice.record.summary.lineBefore).then((ok) => new Notice(ok ? "Original line copied." : "Couldn't copy the line.")));
				button(b.actions, "Dismiss").addEventListener("click", dismiss);
			} else {
				const b = banner(el, "warning", icon("triangle-alert", "alert-triangle"), "The last repair didn't finish", `${file} no longer exists, so there's nothing to check or undo.`);
				button(b.actions, "Dismiss").addEventListener("click", dismiss);
			}
		}
		const last = this.plugin.lastRepair;
		// The banner belongs to the current undo point; once that's undone or replaced it's stale.
		if (last && this.plugin.recovery?.createdAt === last.record.createdAt) {
			const { record, warning } = last;
			const title = `Repaired 1 reference in ${record.sourcePath}`;
			const b = warning
				? banner(el, "warning", icon("triangle-alert", "alert-triangle"), title, warning)
				: banner(el, "success", icon("circle-check", "check-circle"), title, `Checked after writing: ${record.summary.place.replace(` in ${record.sourcePath}`, "")} now links to ${record.summary.newTarget}.`);
			if (this.plugin.repairs.canUndo()) {
				button(b.actions, "Undo repair", { icon: icon("undo-2", "undo") }).addEventListener("click", () => void this.plugin.runUndo());
			}
			button(b.actions, "Open file").addEventListener("click", () => void this.plugin.openSourceAt(record.sourcePath, null));
			iconButton(b.actions, icon("x"), "Dismiss").addEventListener("click", () => {
				this.plugin.lastRepair = null;
				this.render(true);
			});
		}
		if (this.plugin.controller.hasResults) {
			const issues = this.plugin.controller.index.issues();
			const sources = new Set(issues.map((i) => i.sourcePath)).size;
			if (sources > 0) {
				const b = banner(el, "warning", icon("triangle-alert", "alert-triangle"), `Coverage is incomplete: ${plural(sources, "source")} ${sources === 1 ? "wasn't" : "weren't"} fully read`, "Attachments may be used in places this scan couldn't see.");
				button(b.actions, "Show details").addEventListener("click", () => this.openCoverage());
			}
		}
	}

	// Details

	private renderDetails(): void {
		const pane = this.detailsPane;
		if (!pane) return;
		pane.empty();
		if (this.narrow) {
			const back = button(pane.createDiv({ cls: "al-back" }), "Back to list", { icon: icon("chevron-left") });
			back.addEventListener("click", () => this.closeDetails());
		}
		if (this.showCoverage) {
			this.renderCoverage(pane);
			return;
		}
		const selected = this.viewState.selected;
		const item = selected ? this.plugin.controller.index.getItem(selected) : null;
		if (!item) {
			this.renderEmptyList(pane);
			return;
		}
		if (item.kind === "attachment") this.renderAttachment(pane, item);
		else this.renderMissing(pane, item);
	}

	private renderEmptyList(pane: HTMLElement): void {
		const index = this.plugin.controller.index;
		const box = pane.createDiv({ cls: "al-empty al-empty-details" });
		const { filter, search, category } = this.viewState;
		if (this.list && this.list.length > 0) {
			box.createEl("p", { cls: "al-muted", text: "Select an attachment to see its details." });
			return;
		}
		const coverageNote = index.issues().length > 0 ? " Some sources weren't fully read; see the coverage details." : "";
		if (search.trim() !== "") {
			setIcon(box.createDiv({ cls: "al-empty-icon" }), icon("search"));
			box.createEl("h3", { text: `No ${filter === "broken" ? "missing files" : "attachments"} match “${search.trim()}”` });
			box.createEl("p", { text: `Search looks at file names and vault paths in ${FILTERS.find((f) => f.id === filter)?.label ?? ""}, ${category === "all" ? "all types" : CATEGORY_LABELS[category]}.` });
			button(box, "Clear search").addEventListener("click", () => {
				this.searchBox?.setValue("");
				this.viewState.search = "";
				this.refreshList(true);
			});
			return;
		}
		if (index.counts().attachments === 0 && filter !== "broken") {
			setIcon(box.createDiv({ cls: "al-empty-icon" }), "paperclip");
			box.createEl("h3", { text: "This vault has no attachments yet" });
			box.createEl("p", { text: "Notes, Canvas boards and bases are read as sources, so they aren't listed here." });
			return;
		}
		setIcon(box.createDiv({ cls: "al-empty-icon is-success" }), icon("circle-check", "check-circle"));
		if (filter === "broken") {
			box.createEl("h3", { text: "No broken attachment references found in supported sources" });
			box.createEl("p", { text: `All ${plural(index.sourcePaths().length, "source")} were scanned. Links to notes are handled by Obsidian and aren't listed here.${coverageNote}` });
		} else if (filter === "unreferenced") {
			box.createEl("h3", { text: "Every attachment has at least one detected reference" });
			box.createEl("p", { text: `Attachments without any appear here as “No references detected in supported sources”.${coverageNote}` });
		} else if (filter === "uncertain") {
			box.createEl("h3", { text: "No uncertain references" });
			box.createEl("p", { text: "Plain-text values that look like file names would appear here." });
		} else {
			box.createEl("h3", { text: `No ${category === "all" ? "" : `${CATEGORY_LABELS[category].toLowerCase()} `}attachments` });
		}
	}

	private renderAttachment(pane: HTMLElement, item: AttachmentItem): void {
		const file = this.app.vault.getFileByPath(item.path);
		if (file && canPreview(item.path)) {
			const frame = pane.createDiv({ cls: "al-preview" });
			const img = frame.createEl("img", { attr: { alt: `Preview of ${item.name}`, src: this.app.vault.getResourcePath(file), draggable: "false", loading: "lazy" } });
			img.addEventListener("error", () => {
				frame.empty();
				setIcon(frame.createDiv({ cls: "al-preview-icon" }), categoryIcon(item.info.category));
			});
		}
		pane.createEl("h3", { cls: "al-details-title", text: item.name });
		const facts = pane.createEl("dl", { cls: "al-facts" });
		facts.createEl("dt", { text: "Path" });
		const pathDd = facts.createEl("dd");
		code(pathDd, item.path);
		iconButton(pathDd, "copy", "Copy path", "al-inline-button").addEventListener("click", () => void copyText(item.path).then((ok) => new Notice(ok ? "Path copied." : "Couldn't copy the path.")));
		facts.createEl("dt", { text: "Type" });
		facts.createEl("dd", { text: describeType(item.path) });
		facts.createEl("dt", { text: "Size" });
		facts.createEl("dd", { text: formatBytes(item.info.size) });
		facts.createEl("dt", { text: "Modified" });
		facts.createEl("dd", { text: formatDate(item.info.mtime) });

		const actions = pane.createDiv({ cls: "al-actions" });
		if (opensInObsidian(item.path)) {
			button(actions, "Open in Obsidian", { icon: icon("external-link", "square-arrow-out-up-right") }).addEventListener("click", () => void this.plugin.openAttachment(item.path));
		} else {
			pane.createEl("p", { cls: "al-muted", text: `Obsidian has no built-in viewer for ${describeType(item.path).replace(/ file$/, "")} files. Attachment Lens doesn't open files outside Obsidian.` });
		}

		const heading = pane.createDiv({ cls: "al-section-title" });
		if (item.refs.length === 0) {
			heading.setText("No references detected in supported sources");
			const issues = this.plugin.controller.index.issues().length;
			pane.createEl("p", {
				cls: "al-muted",
				text: `That doesn't prove the file is unused. ${issues > 0 ? "Some sources weren't fully read, and some" : "Some"} places aren't scanned at all, such as HTML tags and plugin code.`,
			});
		} else {
			heading.setText(`References · ${item.refs.length.toLocaleString()} found in supported sources`);
			const sorted = [...item.refs].sort((a, b) => (a.sourcePath < b.sourcePath ? -1 : a.sourcePath > b.sourcePath ? 1 : 0));
			for (const ref of sorted) this.renderRef(pane, ref, false);
		}
	}

	private renderMissing(pane: HTMLElement, item: MissingItem): void {
		const title = pane.createEl("h3", { cls: "al-details-title", text: item.name });
		pill(title, "Missing", "error");
		pane.createEl("p", { cls: "al-muted", text: `Linked as ${item.target}. No file with this name or path exists in the vault, resolving from the source that links to it.` });
		pane.createDiv({ cls: "al-section-title", text: `References · ${item.refs.length.toLocaleString()}` });
		for (const ref of item.refs) {
			this.renderRef(pane, ref, true);
			if (this.picker?.refId === ref.id) this.renderPicker(pane, ref);
		}
	}

	private renderRef(parent: HTMLElement, ref: Reference, repairable: boolean): void {
		const card = parent.createDiv({ cls: ["al-ref", ...(this.picker?.refId === ref.id ? ["is-active"] : [])] });
		const top = card.createDiv({ cls: "al-ref-top" });
		setIcon(top.createSpan({ cls: "al-ref-icon" }), ref.sourceKind === "canvas" ? icon("layout-dashboard", "layout-grid") : ref.sourceKind === "base" ? icon("table") : icon("file-text"));
		top.createSpan({ cls: "al-ref-source", text: ref.sourcePath });
		top.createSpan({ cls: "al-ref-place", text: `${placeLabel(ref)} · ${formLabel(ref)}` });
		if (ref.confidence === "uncertain") pill(top, "uncertain", "warning");
		code(card, ref.original);
		if (ref.confidence === "uncertain") {
			card.createDiv({ cls: "al-ref-note", text: ref.place.type === "property" ? "Plain text that looks like a file name. Obsidian doesn't treat it as a link." : "Text that looks like a link inside a Bases expression, not passed to a file function." });
		}
		if (ref.form === "refdef") card.createDiv({ cls: "al-ref-note", text: `Used ${plural(ref.usages ?? 0, "time")} in this note.` });
		if (ref.place.type === "body" && ref.form !== "refdef") this.renderContext(card, ref);
		if (ref.blocked) card.createDiv({ cls: "al-ref-note is-warning", text: ref.blocked });
		const actions = card.createDiv({ cls: "al-actions" });
		if (repairable && !ref.blocked && this.picker?.refId !== ref.id) {
			const repair = button(actions, "Repair…", { icon: icon("wrench") });
			repair.dataset.repair = ref.id;
			repair.addEventListener("click", () => {
				this.picker = { refId: ref.id, target: null, query: "" };
				this.renderDetails();
				window.setTimeout(() => this.detailsPane?.querySelector<HTMLElement>(".al-candidate[tabindex='0'], .al-picker input")?.focus(), 0);
			});
		}
		button(actions, "Open source", { icon: icon("external-link") }).addEventListener("click", () => void this.plugin.openSourceAt(ref.sourcePath, ref));
	}

	/** Shows the line around a body reference, read lazily from Obsidian's cache. */
	private renderContext(card: HTMLElement, ref: Reference): void {
		if (!ref.span) return;
		const key = ref.id;
		const el = card.createDiv({ cls: "al-ref-context" });
		const cached = this.context.get(key);
		if (cached !== undefined) {
			el.setText(cached);
			return;
		}
		const file = this.app.vault.getFileByPath(ref.sourcePath);
		if (!file) return;
		const span = ref.span;
		void this.app.vault.cachedRead(file).then((text) => {
			if (text.slice(span.start, span.end) !== ref.original) return;
			const lineStart = text.lastIndexOf("\n", span.start - 1) + 1;
			let lineEnd = text.indexOf("\n", span.end);
			if (lineEnd === -1) lineEnd = text.length;
			let line = (text.slice(lineStart, span.start) + text.slice(span.end, lineEnd)).replace(/\s+/g, " ").trim();
			if (line === "") {
				const next = text.indexOf("\n", lineEnd + 1);
				line = text.slice(lineEnd + 1, next === -1 ? text.length : next).trim();
			}
			const shown = line.length > 120 ? `…${line.slice(0, 118)}…` : line;
			this.context.set(key, shown);
			el.setText(shown);
		});
	}

	private renderPicker(parent: HTMLElement, ref: Reference): void {
		const state = this.picker as PickerState;
		const index = this.plugin.controller.index;
		const box = parent.createDiv({ cls: "al-picker" });
		box.createDiv({ cls: "al-stepper", text: "Repair this reference · Step 1 of 2: Choose a replacement" });
		box.createEl("p", { cls: "al-muted", text: "Possible replacements, ranked by name and path similarity. A similar name doesn't prove it's the same file. Check the preview before choosing." });
		let ranked = this.candidates.get(ref.id);
		if (!ranked) {
			const inputs = index.attachmentList().map((a) => ({ path: a.path, refCount: index.refsTo(a.path).length }));
			ranked = rankCandidates(ref.linkpath, ref.sourcePath, inputs, this.plugin.settings.suggestionCount);
			this.candidates.set(ref.id, ranked);
		}
		const group = box.createDiv({ cls: "al-candidates", attr: { role: "radiogroup", "aria-label": "Possible replacements" } });
		type Option = { path: string; el: HTMLElement };
		const suggested: Option[] = [];
		let found: Option[] = [];
		const all = () => [...suggested, ...found];
		const choose = (path: string, focus: boolean) => {
			state.target = path;
			for (const option of all()) {
				const on = option.path === path;
				option.el.toggleClass("is-selected", on);
				option.el.setAttribute("aria-checked", String(on));
				option.el.setAttribute("tabindex", on ? "0" : "-1");
				if (on && focus) option.el.focus();
			}
			this.renderSelection(selection, path);
			review.disabled = false;
		};
		const addOption = (container: HTMLElement, path: string, reasons: Candidate["reasons"], bucket: Option[]) => {
			const el = container.createDiv({ cls: "al-candidate", attr: { role: "radio", "aria-checked": "false", tabindex: "-1" } });
			el.createSpan({ cls: "al-radio" });
			const thumb = el.createDiv({ cls: "al-candidate-thumb" });
			const file = this.app.vault.getFileByPath(path);
			if (file && canPreview(path)) thumb.createEl("img", { attr: { alt: "", src: this.app.vault.getResourcePath(file), loading: "lazy", draggable: "false" } });
			else setIcon(thumb, categoryIcon(categoryOfPath(path)));
			const text = el.createDiv({ cls: "al-candidate-text" });
			text.createDiv({ cls: "al-candidate-name", text: basename(path) });
			text.createDiv({ cls: "al-candidate-path", text: path });
			if (reasons.length > 0) {
				const chips = text.createDiv({ cls: "al-reasons" });
				for (const reason of reasons) chips.createSpan({ cls: ["al-reason", ...(reason.warn ? ["is-warning"] : [])], text: reason.text });
			}
			el.addEventListener("click", () => choose(path, true));
			el.addEventListener("keydown", (evt) => {
				const options = all();
				const at = options.findIndex((o) => o.el === el);
				if (evt.key === "ArrowDown" || evt.key === "ArrowRight") {
					evt.preventDefault();
					const next = options[Math.min(options.length - 1, at + 1)];
					if (next) choose(next.path, true);
				} else if (evt.key === "ArrowUp" || evt.key === "ArrowLeft") {
					evt.preventDefault();
					const prev = options[Math.max(0, at - 1)];
					if (prev) choose(prev.path, true);
				} else if (evt.key === " " || evt.key === "Enter") {
					evt.preventDefault();
					choose(path, true);
				}
			});
			bucket.push({ path, el });
		};
		if (ranked.length === 0) group.createEl("p", { cls: "al-muted", text: "No similar attachments found. Search all attachments below." });
		for (const candidate of ranked) addOption(group, candidate.path, candidate.reasons, suggested);

		const searchWrap = box.createDiv({ cls: "al-picker-search" });
		const label = searchWrap.createEl("label", { cls: "al-muted", text: `Choose another: search all ${plural(index.counts().attachments, "attachment")}`, attr: { for: `al-picker-search-${ref.id.length}` } });
		const input = searchWrap.createEl("input", { type: "search", attr: { id: label.getAttribute("for") ?? "", placeholder: "File name or path", spellcheck: "false" } });
		input.value = state.query;
		const results = searchWrap.createDiv({ cls: "al-candidates", attr: { role: "radiogroup", "aria-label": "Search results" } });
		const drawResults = () => {
			results.empty();
			found = [];
			if (state.query.trim() === "") return;
			const hits = searchPaths(state.query, index.attachmentList().map((a) => a.path), 20).filter((p) => !ranked?.some((c) => c.path === p));
			if (hits.length === 0) results.createEl("p", { cls: "al-muted", text: "No attachments match." });
			for (const path of hits) addOption(results, path, [], found);
			if (state.target) choose(state.target, false);
		};
		input.addEventListener("input", () => {
			state.query = input.value;
			drawResults();
		});
		input.addEventListener("keydown", (evt) => {
			if (evt.key === "ArrowDown") {
				evt.preventDefault();
				const first = results.querySelector<HTMLElement>(".al-candidate");
				if (first) first.click();
			}
		});

		const selection = box.createDiv({ cls: "al-selection", attr: { "aria-live": "polite" } });
		const foot = box.createDiv({ cls: "al-picker-foot" });
		foot.createSpan({ cls: "al-hint", text: "Escape to cancel" });
		button(foot, "Cancel").addEventListener("click", () => {
			this.picker = null;
			this.renderDetails();
			this.detailsPane?.querySelector<HTMLElement>(`[data-repair="${CSS.escape(ref.id)}"]`)?.focus();
		});
		const review = button(foot, "Review change", { cta: true, disabled: true });
		review.addEventListener("click", () => {
			if (state.target) void this.review(ref.id, state.target);
		});
		drawResults();
		if (state.target) choose(state.target, false);
		else {
			const first = all()[0];
			if (first) first.el.setAttribute("tabindex", "0");
		}
	}

	private renderSelection(el: HTMLElement, path: string): void {
		el.empty();
		const file = this.app.vault.getFileByPath(path);
		const info = this.plugin.controller.index.getAttachment(path);
		el.addClass("al-box");
		if (file && canPreview(path)) el.createDiv({ cls: "al-selection-preview" }).createEl("img", { attr: { alt: `Preview of ${basename(path)}`, src: this.app.vault.getResourcePath(file), draggable: "false" } });
		const text = el.createDiv({ cls: "al-selection-text" });
		text.createDiv({ text: `Selected: ${path}` });
		if (info) text.createDiv({ cls: "al-muted", text: `${describeType(path)} · ${formatSize(info.size)} · modified ${formatDate(info.mtime)}` });
		if (opensInObsidian(path)) {
			button(text, "Open in Obsidian", { icon: icon("external-link"), cls: "al-link-button" }).addEventListener("click", () => void this.plugin.openAttachment(path));
		}
	}

	private async review(refId: string, target: string): Promise<void> {
		const selectedIndex = this.lastSelectedIndex;
		const outcome = await this.plugin.startReview(refId, target, (chooseAnother) => {
			if (chooseAnother) {
				this.picker = this.picker ? { ...this.picker, target: null } : null;
				this.candidates.delete(refId);
			}
			this.renderDetails();
		});
		if (outcome === "applied") {
			this.picker = null;
			this.lastSelectedIndex = selectedIndex;
			this.render(true);
			this.list?.focus();
		}
	}

	private renderCoverage(pane: HTMLElement): void {
		pane.createEl("h3", { cls: "al-details-title", text: "Coverage details" });
		const issues = this.plugin.controller.index.issues();
		if (issues.length === 0) pane.createEl("p", { cls: "al-muted", text: "Every supported source was read completely." });
		const list = pane.createDiv({ cls: "al-coverage" });
		for (const issue of issues) {
			const row = list.createDiv({ cls: "al-coverage-item" });
			setIcon(row.createSpan({ cls: "al-coverage-icon" }), icon("triangle-alert", "alert-triangle"));
			const text = row.createDiv({ cls: "al-coverage-text" });
			text.createDiv({ cls: "al-coverage-title", text: issue.sourcePath });
			text.createDiv({ cls: "al-muted", text: issue.message });
			if (issue.detail) code(text, issue.detail);
			if (!isSourcePath(issue.sourcePath) || this.app.vault.getFileByPath(issue.sourcePath)) {
				button(row, "Open file").addEventListener("click", () => void this.plugin.openSourceAt(issue.sourcePath, null));
			}
		}
		const never = list.createDiv({ cls: "al-coverage-item is-muted" });
		setIcon(never.createSpan({ cls: "al-coverage-icon" }), icon("circle-help", "help-circle"));
		const text = never.createDiv({ cls: "al-coverage-text" });
		text.createDiv({ cls: "al-coverage-title", text: "Never covered" });
		text.createDiv({ cls: "al-muted", text: NEVER_COVERED });
		text.createDiv({ cls: "al-muted", text: "Links to websites and to files outside the vault aren't checked." });
		button(pane.createDiv({ cls: "al-actions" }), "Back to the list", { icon: icon("chevron-left") }).addEventListener("click", () => {
			this.showCoverage = false;
			this.renderDetails();
			this.closeDetails();
		});
	}

	private summaryText(): string {
		const index = this.plugin.controller.index;
		const counts = index.counts();
		const lines = [
			`Attachment Lens scan summary`,
			`Attachments: ${counts.attachments}`,
			`Broken references: ${counts.broken} (to ${counts.missing} missing files)`,
			`No references detected in supported sources: ${counts.unreferenced}`,
			`Uncertain references: ${counts.uncertain}`,
			`Sources read: ${index.sourcePaths().length}`,
		];
		const issues = index.issues();
		if (issues.length > 0) {
			lines.push("", "Coverage gaps:");
			for (const issue of issues) lines.push(`- ${issue.sourcePath}: ${issue.message}`);
		}
		return lines.join("\n");
	}
}
