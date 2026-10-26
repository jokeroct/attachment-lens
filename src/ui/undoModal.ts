import { Modal, Notice, type App } from "obsidian";
import type { RecoveryRecord } from "../core/repair/recovery";
import { button, code, copyText } from "./dom";

/** Shown when the file changed after a repair, so undoing would overwrite newer edits. */
export class UndoConflictModal extends Modal {
	constructor(
		app: App,
		private readonly message: string,
		private readonly record: RecoveryRecord,
		private readonly currentLine: string | null,
		private readonly actions: { openFile(): void; discard(): Promise<void> },
	) {
		super(app);
	}

	override onOpen(): void {
		this.setTitle("Can't undo automatically");
		const el = this.contentEl;
		el.addClass("al-review");
		el.createEl("p", { text: this.message });
		const facts = el.createEl("dl", { cls: "al-facts" });
		if (this.currentLine !== null) {
			facts.createEl("dt", { text: "Now" });
			code(facts.createEl("dd"), this.currentLine);
		}
		facts.createEl("dt", { text: "Before the repair" });
		code(facts.createEl("dd"), this.record.summary.lineBefore);
		el.createEl("p", { cls: "al-muted", text: "You can restore the original line by hand. The undo point stays until you discard it or make another repair." });
		const foot = el.createDiv({ cls: "al-modal-foot" });
		const discard = button(foot, "Discard undo point", { cls: "mod-warning" });
		discard.addEventListener("click", () => {
			void this.actions.discard().then(() => {
				new Notice("Undo point discarded.");
				this.close();
			});
		});
		button(foot, "Copy original line", { icon: "copy" }).addEventListener("click", () => {
			void copyText(this.record.summary.lineBefore).then((ok) => new Notice(ok ? "Original line copied." : "Couldn't copy. Select the line above instead."));
		});
		const open = button(foot, "Open file", { cta: true });
		open.addEventListener("click", () => {
			this.actions.openFile();
			this.close();
		});
		window.setTimeout(() => open.focus(), 0);
	}

	override onClose(): void {
		this.contentEl.empty();
	}
}
