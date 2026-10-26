import { MarkdownView, Notice, Plugin, TFile, TFolder, type TAbstractFile } from "obsidian";
import type { FilterId } from "./core/index";
import { isSourcePath } from "./core/paths";
import { parseRecoveryRecord, type RecoveryRecord } from "./core/repair/recovery";
import type { Reference } from "./core/types";
import { LensController, type Scheduler } from "./obsidian/controller";
import { ObsidianHost } from "./obsidian/obsidianHost";
import { RepairService, type ApplyResult, type RecoveryNotice, type RepairPlan } from "./obsidian/repairService";
import { AttachmentLensSettingTab, DEFAULT_SETTINGS, excludedFolders, parseSettings, type Settings } from "./settings";
import { ReviewModal } from "./ui/reviewModal";
import { UndoConflictModal } from "./ui/undoModal";
import { AttachmentLensView, VIEW_TYPE } from "./ui/view";
import { opensInObsidian } from "./core/fileTypes";

interface StoredData {
	settings: Settings;
	recovery: RecoveryRecord | null;
}

export default class AttachmentLensPlugin extends Plugin {
	override settings: Settings = { ...DEFAULT_SETTINGS };
	recovery: RecoveryRecord | null = null;
	recoveryNotice: RecoveryNotice | null = null;
	lastRepair: { record: RecoveryRecord; warning: string | null } | null = null;
	controller!: LensController;
	repairs!: RepairService;
	private readonly uiListeners = new Set<() => void>();

	override async onload(): Promise<void> {
		await this.loadState();
		const host = new ObsidianHost(this.app);
		const scheduler: Scheduler = {
			now: () => performance.now(),
			yieldToUi: () => new Promise((resolve) => window.setTimeout(resolve, 0)),
			budgetMs: 12,
			setTimeout: (fn, ms) => window.setTimeout(fn, ms),
			clearTimeout: (id) => window.clearTimeout(id),
		};
		this.controller = new LensController(host, () => this.excludedFolders(), scheduler);
		this.repairs = new RepairService(host, this.controller, {
			get: () => this.recovery,
			set: async (record) => {
				this.recovery = record;
				await this.saveState();
				this.notifyUi();
			},
		});

		this.registerView(VIEW_TYPE, (leaf) => new AttachmentLensView(leaf, this));
		this.addRibbonIcon("paperclip", "Open Attachment Lens", () => void this.activateView());
		this.addCommand({ id: "open", name: "Open", callback: () => void this.activateView() });
		this.addCommand({
			id: "scan",
			name: "Scan vault",
			callback: () => {
				void this.activateView();
				void this.controller.scan();
			},
		});
		this.addCommand({ id: "show-broken", name: "Show broken references", callback: () => void this.activateView("broken") });
		this.addCommand({
			id: "undo-last-repair",
			name: "Undo last repair",
			checkCallback: (checking) => {
				if (!this.repairs.canUndo()) return false;
				if (!checking) void this.runUndo();
				return true;
			},
		});
		this.addSettingTab(new AttachmentLensSettingTab(this.app, this));
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (!(file instanceof TFile) || isSourcePath(file.path)) return;
				menu.addItem((item) =>
					item
						.setTitle("Show in Attachment Lens")
						.setIcon("paperclip")
						.onClick(() => void this.revealAttachment(file.path)),
				);
			}),
		);

		this.app.workspace.onLayoutReady(() => {
			// Registered after layout so the "create" events Obsidian sends while loading the vault are skipped.
			this.registerEvent(this.app.vault.on("create", (file) => this.onFileEvent(file, "changed")));
			this.registerEvent(this.app.vault.on("modify", (file) => {
				// Notes are re-read when their metadata is ready, below.
				if (file instanceof TFile && file.extension !== "md") this.controller.onChanged(file.path);
			}));
			this.registerEvent(this.app.vault.on("delete", (file) => this.onFileEvent(file, "deleted")));
			this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.controller.onRenamed(file.path, oldPath)));
			this.registerEvent(this.app.metadataCache.on("changed", (file) => this.controller.onChanged(file.path)));
			void this.repairs.checkRecovery().then((notice) => {
				this.recoveryNotice = notice;
				this.notifyUi();
			});
		});
	}

	override onunload(): void {
		this.controller.dispose();
		this.uiListeners.clear();
	}

	private onFileEvent(file: TAbstractFile, type: "changed" | "deleted"): void {
		if (file instanceof TFolder) return;
		if (type === "deleted") this.controller.onDeleted(file.path);
		else this.controller.onChanged(file.path);
	}

	excludedFolders(): string[] {
		return excludedFolders(this.settings);
	}

	private async loadState(): Promise<void> {
		const data = (await this.loadData()) as Partial<StoredData> | null;
		this.settings = parseSettings(data?.settings);
		this.recovery = parseRecoveryRecord(data?.recovery ?? null);
	}

	async saveState(): Promise<void> {
		const data: StoredData = { settings: this.settings, recovery: this.recovery };
		await this.saveData(data);
	}

	override async onExternalSettingsChange(): Promise<void> {
		await this.loadState();
		this.notifyUi();
	}

	subscribeUi(listener: () => void): () => void {
		this.uiListeners.add(listener);
		return () => this.uiListeners.delete(listener);
	}

	notifyUi(): void {
		for (const listener of this.uiListeners) listener();
	}

	private views(): AttachmentLensView[] {
		return this.app.workspace.getLeavesOfType(VIEW_TYPE).flatMap((leaf) => (leaf.view instanceof AttachmentLensView ? [leaf.view] : []));
	}

	/** Opens the panel, reusing an existing one. */
	async activateView(filter?: FilterId): Promise<AttachmentLensView | null> {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0] ?? null;
		if (!leaf) {
			leaf = workspace.getLeaf("tab");
			await leaf.setViewState({ type: VIEW_TYPE, active: true });
		}
		await workspace.revealLeaf(leaf);
		// A tab Obsidian hasn't shown since startup holds a placeholder until it's loaded.
		await leaf.loadIfDeferred();
		const view = leaf.view instanceof AttachmentLensView ? leaf.view : null;
		if (view && filter) view.showFilter(filter);
		return view;
	}

	async revealAttachment(path: string): Promise<void> {
		const view = await this.activateView();
		view?.reveal(path);
	}

	async openAttachment(path: string): Promise<void> {
		const file = this.app.vault.getFileByPath(path);
		if (!file) {
			new Notice(`${path} no longer exists.`);
			return;
		}
		if (!opensInObsidian(path)) return;
		await this.app.workspace.getLeaf("tab").openFile(file, { active: true });
	}

	/** Opens a source, at the reference's line when it's in a note. */
	async openSourceAt(path: string, ref: Reference | null): Promise<void> {
		const file = this.app.vault.getFileByPath(path);
		if (!file) {
			new Notice(`${path} no longer exists.`);
			return;
		}
		const line = ref?.place.type === "body" || ref?.place.type === "base" ? ref.place.line - 1 : null;
		let leaf = this.app.workspace.getLeavesOfType(file.extension === "md" ? "markdown" : file.extension === "canvas" ? "canvas" : "bases").find((l) => (l.view as { file?: TFile | null }).file?.path === path) ?? null;
		if (!leaf) {
			leaf = this.app.workspace.getLeaf("tab");
			await leaf.openFile(file, { active: true, ...(line !== null ? { eState: { line } } : {}) });
		} else {
			await this.app.workspace.revealLeaf(leaf);
		}
		const view = leaf.view;
		if (line !== null && view instanceof MarkdownView && view.getMode() === "source") {
			const col = ref?.place.type === "body" ? ref.place.col - 1 : 0;
			view.editor.setCursor({ line, ch: col });
			view.editor.scrollIntoView({ from: { line, ch: 0 }, to: { line, ch: 0 } }, true);
			view.editor.focus();
		}
	}

	/** Builds the preview and opens the review dialog. Resolves with what happened. */
	async startReview(refId: string, target: string, onBack: (chooseAnother: boolean) => void): Promise<"applied" | "cancelled" | "failed"> {
		const preview = await this.repairs.preview(refId, target);
		if (!preview.ok) {
			new Notice(preview.reason, 8000);
			return "failed";
		}
		return new Promise((resolve) => {
			new ReviewModal(this.app, preview.plan, {
				apply: (plan, confirmed) => this.applyRepair(plan, confirmed),
				refresh: async (plan: RepairPlan) => {
					const next = await this.repairs.preview(plan.ref.id, plan.targetPath);
					return next.ok ? next.plan : next.reason;
				},
				recheck: (plan) => this.repairs.recheckBlocked(plan),
				done: (outcome) => {
					if (outcome.applied) resolve("applied");
					else {
						onBack(outcome.chooseAnother);
						resolve("cancelled");
					}
				},
			}).open();
		});
	}

	async applyRepair(plan: RepairPlan, confirmedUncertain: boolean): Promise<ApplyResult> {
		const result = await this.repairs.apply(plan, confirmedUncertain);
		if (result.ok) {
			this.lastRepair = { record: result.record, warning: result.warning };
			this.recoveryNotice = null;
			this.notifyUi();
		}
		return result;
	}

	/** Undo with the conflict dialog when the file changed. Used by the toolbar, banner and command. */
	async runUndo(): Promise<void> {
		const result = await this.repairs.undo();
		if (result.ok) {
			this.lastRepair = null;
			this.recoveryNotice = null;
			new Notice(`Undo complete: ${result.record.summary.place} is back to ${result.record.summary.lineBefore.trim()}.`);
			this.notifyUi();
			return;
		}
		if (result.kind === "conflict" && result.record) {
			const record = result.record;
			new UndoConflictModal(this.app, result.message, record, result.currentLine ?? null, {
				openFile: () => void this.openSourceAt(record.sourcePath, null),
				discard: async () => {
					await this.repairs.discardUndo();
					this.lastRepair = null;
					this.notifyUi();
				},
			}).open();
			return;
		}
		new Notice(result.message, 8000);
	}

	async dismissRecovery(): Promise<void> {
		this.recoveryNotice = null;
		await this.repairs.dismissRecovery();
		this.notifyUi();
	}

	/** For the dev harness and tests: current views. Not used by the plugin itself. */
	get openViews(): AttachmentLensView[] {
		return this.views();
	}
}
