// The repair preview and confirmation dialog. Nothing is written until Apply repair.
import { Modal, setIcon, type App } from "obsidian";
import { parseMarkdownLink, parseReferenceDefinition, parseWikilink } from "../core/markdown/links";
import type { DiffLine } from "../core/repair/plan";
import type { ApplyResult, RepairPlan } from "../obsidian/repairService";
import { formLabel } from "../obsidian/labels";
import { banner, button, code } from "./dom";
import { formatAgo, icon } from "./format";

export interface ReviewHandlers {
	apply(plan: RepairPlan, confirmedUncertain: boolean): Promise<ApplyResult>;
	refresh(plan: RepairPlan): Promise<RepairPlan | string>;
	recheck(plan: RepairPlan): string | null;
	/** Called after a successful repair, and when the user goes back to choose another file */
	done(result: { applied: true; result: Extract<ApplyResult, { ok: true }>; plan: RepairPlan } | { applied: false; chooseAnother: boolean }): void;
}

/** What the change keeps, in words, for the line under the diff. */
function keptParts(plan: RepairPlan): string[] {
	const original = plan.occurrence.original;
	const kept: string[] = [];
	if (plan.occurrence.form === "wikilink") {
		const wiki = parseWikilink(plan.ref.place.type === "property" ? original.trim() : original);
		if (wiki?.embed) kept.push("the embed marker “!”");
		if (wiki?.subpath) kept.push(`the subpath “${wiki.subpath}”`);
		if (wiki?.alias !== null && wiki?.alias !== undefined) kept.push(/^\d+(x\d+)?$/.test(wiki.alias) ? `the size “|${wiki.alias}”` : `the alias “|${wiki.alias}”`);
	} else if (plan.occurrence.form === "markdown" || plan.occurrence.form === "refdef") {
		const md = plan.occurrence.form === "refdef" ? parseReferenceDefinition(original) : parseMarkdownLink(original);
		if (md && "text" in md && md.text) kept.push(`the link text “${md.text}”`);
		if (md?.subpath) kept.push(`the subpath “${md.subpath}”`);
		if (md?.angle) kept.push("the angle brackets");
		if (/\s["'(]/.test(original)) kept.push("the title");
	}
	if (plan.ref.place.type === "property") kept.push("the property's quoting");
	if (plan.ref.place.type === "canvas") kept.push("every other card and field");
	return kept;
}

function renderDiff(parent: HTMLElement, lines: DiffLine[]): void {
	const el = parent.createDiv({ cls: "al-diff", attr: { role: "group", "aria-label": "Exact change" } });
	for (const line of lines) {
		const row = el.createDiv({ cls: ["al-diff-line", line.sign === "-" ? "is-removed" : line.sign === "+" ? "is-added" : "is-context"] });
		row.createSpan({ cls: "al-diff-sign", text: line.sign === " " ? "" : line.sign === "-" ? "−" : "+", attr: { "aria-label": line.sign === "-" ? "Removed" : line.sign === "+" ? "Added" : "" } });
		row.createSpan({ cls: "al-diff-no", text: String(line.no) });
		const text = row.createSpan({ cls: "al-diff-text" });
		if (line.mark && line.mark[1] > line.mark[0]) {
			text.appendText(line.text.slice(0, line.mark[0]));
			text.createEl("mark", { text: line.text.slice(line.mark[0], line.mark[1]) });
			text.appendText(line.text.slice(line.mark[1]));
		} else {
			text.setText(line.text === "" ? " " : line.text);
		}
	}
}

export class ReviewModal extends Modal {
	private confirmed = false;
	private busy = false;
	private finished = false;

	constructor(
		app: App,
		private plan: RepairPlan,
		private readonly handlers: ReviewHandlers,
	) {
		super(app);
	}

	override onOpen(): void {
		this.modalEl.addClass("al-review-modal");
		this.setTitle("Review repair");
		this.render();
	}

	override onClose(): void {
		this.contentEl.empty();
		if (!this.finished) this.handlers.done({ applied: false, chooseAnother: false });
	}

	private render(error?: { title: string; text: string; action?: "refresh" | "choose" }): void {
		const { plan } = this;
		const el = this.contentEl;
		el.empty();
		el.addClass("al-review");

		if (error) {
			const b = banner(el, "warning", icon("triangle-alert", "alert-triangle"), error.title, error.text);
			if (error.action === "refresh") {
				button(b.actions, "Refresh preview", { cta: true }).addEventListener("click", () => void this.refresh());
			} else if (error.action === "choose") {
				button(b.actions, "Choose another", { cta: true }).addEventListener("click", () => {
					this.finished = true;
					this.handlers.done({ applied: false, chooseAnother: true });
					this.close();
				});
			}
			if (error.action) {
				const foot = el.createDiv({ cls: "al-modal-foot" });
				button(foot, "Cancel").addEventListener("click", () => this.close());
				return;
			}
		}

		const facts = el.createEl("dl", { cls: "al-facts" });
		const fact = (term: string, fill: (dd: HTMLElement) => void) => {
			facts.createEl("dt", { text: term });
			fill(facts.createEl("dd"));
		};
		fact("Source", (dd) => dd.setText(`${plan.sourcePath} · ${plan.place}`));
		fact("Reference", (dd) => dd.setText(formLabel(plan.ref)));
		fact("Original target", (dd) => {
			code(dd, plan.ref.linkpath + plan.ref.subpath);
			dd.createSpan({ cls: "al-pill al-pill-error", text: "Missing" });
		});
		fact("New target", (dd) => code(dd, plan.targetPath));
		fact("Written as", (dd) => {
			code(dd, plan.writtenAs);
			dd.createDiv({ cls: "al-muted", text: plan.writtenNote });
		});
		fact("File type", (dd) => dd.setText(plan.typeChange ? "Changes" : "Same type as the original target"));

		if (plan.typeChange) banner(el, "warning", icon("triangle-alert", "alert-triangle"), "Different file type", plan.typeChange);

		renderDiff(el, plan.diff);
		const kept = keptParts(plan);
		el.createDiv({
			cls: "al-muted",
			text: `Only the highlighted characters change.${kept.length > 0 ? ` Kept as is: ${kept.join(", ")}, and everything else in the file.` : " Everything else in the file stays as it is."}`,
		});
		if ((plan.ref.usages ?? 0) > 1) {
			banner(el, "info", icon("info"), `This definition is used ${plan.ref.usages ?? 0} times in this note`, "Every use of it will open the new file.");
		}

		const checks = el.createEl("ul", { cls: "al-checks", attr: { "aria-label": "Checks" } });
		for (const text of [
			"The file matches the text this preview was built from",
			`${plan.targetPath} exists`,
			`The new link opens ${plan.targetPath} from this source`,
		]) {
			const li = checks.createEl("li");
			setIcon(li.createSpan({ cls: "al-check-icon" }), icon("check"));
			li.createSpan({ text });
		}
		el.createDiv({ cls: "al-muted", text: "These are checked again at the moment of writing, and the file is read back afterwards." });

		let confirm: HTMLInputElement | null = null;
		if (plan.ref.confidence === "uncertain") {
			banner(
				el,
				"warning",
				icon("circle-help", "help-circle"),
				"This may not be an attachment reference",
				plan.ref.place.type === "property"
					? "The value is plain text that looks like a file name. Obsidian doesn't treat it as a link, so a theme or plugin may use it, or nothing may."
					: "The text looks like a link, but it isn't passed to a function that opens files. It may be compared with a property or not used as a file at all.",
			);
			const label = el.createEl("label", { cls: "al-confirm" });
			confirm = label.createEl("input", { type: "checkbox", attr: { id: "al-confirm-uncertain" } });
			confirm.checked = this.confirmed;
			label.createSpan({ text: plan.ref.place.type === "property" ? "I confirm this property refers to an attachment" : "I confirm this text refers to an attachment" });
		}

		if (plan.blocked) {
			const b = banner(el, "warning", icon("triangle-alert", "alert-triangle"), "Apply is unavailable", plan.blocked);
			button(b.actions, "Check again").addEventListener("click", () => {
				this.plan = { ...this.plan, blocked: this.handlers.recheck(this.plan) };
				this.render();
			});
		}

		const undo = el.createDiv({ cls: "al-undo-note" });
		setIcon(undo.createSpan({ cls: "al-undo-icon" }), icon("undo-2", "undo"));
		undo.createSpan({
			text: plan.replaces
				? `After this repair, Undo last repair can restore ${plan.place}. It replaces the current undo point: ${plan.replaces.summary.place}, repaired ${formatAgo(plan.replaces.appliedAt ?? plan.replaces.createdAt)}.`
				: `After this repair, Undo last repair can restore ${plan.place}, also after restarting Obsidian.`,
		});

		if (error && !error.action) banner(el, "error", icon("circle-x", "x-circle"), error.title, error.text);

		const foot = el.createDiv({ cls: "al-modal-foot" });
		foot.createSpan({ cls: "al-hint", text: "Escape to go back" });
		button(foot, "Back").addEventListener("click", () => this.close());
		const apply = button(foot, this.busy ? "Applying…" : "Apply repair", { cta: true });
		const update = () => {
			apply.disabled = this.busy || plan.blocked !== null || (confirm !== null && !confirm.checked);
		};
		confirm?.addEventListener("change", () => {
			this.confirmed = confirm?.checked ?? false;
			update();
		});
		update();
		apply.addEventListener("click", () => void this.apply());
		// Start on the dialog itself, not on Apply, so writing always takes a deliberate Tab and Enter.
		// An uncertain reference starts on its confirmation box, which is needed first anyway.
		el.setAttribute("tabindex", "-1");
		window.setTimeout(() => (confirm ?? el).focus(), 0);
	}

	private async refresh(): Promise<void> {
		const next = await this.handlers.refresh(this.plan);
		if (typeof next === "string") this.render({ title: "The preview couldn't be refreshed", text: next, action: "choose" });
		else {
			this.plan = next;
			this.render();
		}
	}

	private async apply(): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		this.render();
		const result = await this.handlers.apply(this.plan, this.confirmed);
		this.busy = false;
		if (result.ok) {
			this.finished = true;
			this.handlers.done({ applied: true, result, plan: this.plan });
			this.close();
			return;
		}
		switch (result.kind) {
			case "stale":
				this.render({ title: "Preview is out of date", text: `${result.message} Refresh the preview to see the current text.`, action: "refresh" });
				break;
			case "replacement-missing":
				this.render({ title: "Replacement not found", text: result.message, action: "choose" });
				break;
			case "blocked":
				this.plan = { ...this.plan, blocked: result.message };
				this.render();
				break;
			default:
				this.render({ title: result.kind === "unverified" ? "Couldn't confirm the repair" : "Repair failed", text: result.message });
		}
	}
}
