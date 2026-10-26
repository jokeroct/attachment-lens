// The guarded repair: preview one change, re-check everything at the moment of writing, save the
// undo point first, write atomically, then read the file back and confirm the link opens the file.
import { codeBlockStarts } from "../core/extract";
import { categoryOfPath, describeType } from "../core/fileTypes";
import { fingerprint } from "../core/hash";
import { splitLinktext } from "../core/markdown/links";
import { basename, extname } from "../core/paths";
import { chooseLinkText, type WriteMode } from "../core/repair/linktext";
import { locateReference } from "../core/repair/locate";
import { applyEdit, buildDiff, makeEdit, renderTarget, verifyResult, type DiffLine, type Edit } from "../core/repair/plan";
import { classifyRecovery, computeUndo, type RecoveryRecord, type RecoveryStatus } from "../core/repair/recovery";
import { linesAround } from "../core/text";
import type { Occurrence, Reference } from "../core/types";
import type { LensController } from "./controller";
import type { Host } from "./host";
import { placeLabel } from "./labels";

export interface RecoveryStore {
	get(): RecoveryRecord | null;
	set(record: RecoveryRecord | null): Promise<void>;
}

export interface RepairPlan {
	ref: Reference;
	sourcePath: string;
	targetPath: string;
	snapshot: string;
	result: string;
	occurrence: Occurrence;
	edit: Edit;
	writtenAs: string;
	writtenNote: string;
	mode: WriteMode;
	diff: DiffLine[];
	place: string;
	/** Shown as a warning when the file type changes, such as PDF to image */
	typeChange: string | null;
	/** Why Apply is unavailable right now, such as an open Canvas tab */
	blocked: string | null;
	/** The undo point this repair would replace */
	replaces: RecoveryRecord | null;
}

export type PreviewResult = { ok: true; plan: RepairPlan } | { ok: false; reason: string; changed: boolean };

export type ApplyFailure =
	| "stale"
	| "replacement-missing"
	| "resolution"
	| "blocked"
	| "unconfirmed-uncertain"
	| "write-failed"
	| "unverified";

export type ApplyResult = { ok: true; record: RecoveryRecord; warning: string | null } | { ok: false; kind: ApplyFailure; message: string };

export type UndoResult =
	| { ok: true; record: RecoveryRecord }
	| { ok: false; kind: "none" | "missing" | "conflict" | "blocked" | "write-failed" | "unverified"; message: string; currentLine?: string; record?: RecoveryRecord };

export interface RecoveryNotice {
	status: RecoveryStatus;
	record: RecoveryRecord;
	currentLine: string | null;
}

class StaleSourceError extends Error {}

const UNSAVED = "This note has edits that haven't been saved yet. Try again in a moment.";

function writeMode(ref: Reference): WriteMode {
	if (ref.place.type === "canvas" && ref.form === "path") return "exact";
	if (ref.place.type === "base" && (ref.place.fn === "file" || ref.place.fn === "image") && ref.form === "path") return "exact";
	return "link";
}

function describeTypeChange(originalLinkpath: string, targetPath: string): string | null {
	const from = categoryOfPath(originalLinkpath);
	const to = categoryOfPath(targetPath);
	const fromExt = extname(originalLinkpath);
	const toExt = extname(targetPath);
	if (fromExt === toExt || (from === to && from === "image" && ["jpg", "jpeg"].includes(fromExt) && ["jpg", "jpeg"].includes(toExt))) return null;
	if (from === to) return `The file type changes from ${describeType(originalLinkpath)} to ${describeType(targetPath)}.`;
	return `The file type changes from ${describeType(originalLinkpath)} to ${describeType(targetPath)}. An embed of it will display differently.`;
}

export class RepairService {
	constructor(
		private readonly host: Host,
		private readonly controller: LensController,
		private readonly store: RecoveryStore,
		private readonly now: () => number = () => Date.now(),
	) {}

	private resolver(mode: WriteMode, sourcePath: string): (text: string) => string | null {
		return mode === "exact" ? (text) => this.host.getFile(text)?.path ?? null : (text) => this.host.resolveLink(text, sourcePath);
	}

	/** Why the source can't be written right now, or null. */
	private writeBlocker(ref: Reference, text: string): string | null {
		if (ref.sourceKind === "markdown") {
			return this.host.openEditorTexts(ref.sourcePath).some((open) => open !== text) ? UNSAVED : null;
		}
		if (this.host.isOpenInFileView(ref.sourcePath)) {
			return `Close ${basename(ref.sourcePath)} before applying. An open ${ref.sourceKind === "canvas" ? "board" : "base"} can save over changes made outside it.`;
		}
		return null;
	}

	async preview(refId: string, targetPath: string): Promise<PreviewResult> {
		const ref = this.controller.index.getRef(refId);
		if (!ref) return { ok: false, reason: "This reference is no longer in the list. It may have been edited or repaired.", changed: true };
		if (!this.host.getFile(targetPath)) return { ok: false, reason: `${targetPath} no longer exists. Choose another replacement.`, changed: false };
		let text: string;
		try {
			text = await this.host.read(ref.sourcePath);
		} catch (error) {
			return { ok: false, reason: `${ref.sourcePath} couldn't be read: ${error instanceof Error ? error.message : String(error)}`, changed: false };
		}
		if (ref.sourceKind === "markdown" && this.host.openEditorTexts(ref.sourcePath).some((open) => open !== text)) {
			return { ok: false, reason: UNSAVED, changed: false };
		}
		const codeStarts = ref.sourceKind === "markdown" ? codeBlockStarts(this.host.getCache(ref.sourcePath)) : null;
		const located = locateReference(text, ref, codeStarts);
		if (!located.ok) {
			if (located.changed) await this.controller.refreshSource(ref.sourcePath);
			return { ok: false, reason: located.reason, changed: located.changed };
		}
		const occurrence = located.occurrence;
		if (occurrence.blocked) return { ok: false, reason: occurrence.blocked, changed: false };
		if (ref.blocked) return { ok: false, reason: ref.blocked, changed: false };

		const mode = writeMode(ref);
		const choice = chooseLinkText(ref.linkpath, mode, targetPath, ref.sourcePath, this.resolver(mode, ref.sourcePath));
		if (!choice.ok) return { ok: false, reason: choice.reason, changed: false };
		const rendered = renderTarget(choice.text, occurrence);
		if (!rendered.ok) return { ok: false, reason: rendered.reason, changed: false };
		const edit = makeEdit(text, occurrence, rendered.text);
		const result = applyEdit(text, edit);
		const verified = verifyResult(text, result, edit, occurrence, choice.text, codeStarts);
		if (!verified.ok) return { ok: false, reason: `This change can't be made safely: ${verified.reason}`, changed: false };

		const current = this.store.get();
		return {
			ok: true,
			plan: {
				ref,
				sourcePath: ref.sourcePath,
				targetPath,
				snapshot: text,
				result,
				occurrence,
				edit,
				writtenAs: choice.text,
				writtenNote: choice.note,
				mode,
				diff: buildDiff(text, result, edit),
				place: placeLabel(ref),
				typeChange: describeTypeChange(ref.linkpath, targetPath),
				blocked: this.writeBlocker(ref, text),
				replaces: current && current.state === "applied" ? current : null,
			},
		};
	}

	/** Re-checks whether the plan's Apply is blocked, for the dialog's Check again button. */
	recheckBlocked(plan: RepairPlan): string | null {
		return this.writeBlocker(plan.ref, plan.snapshot);
	}

	async apply(plan: RepairPlan, confirmedUncertain: boolean): Promise<ApplyResult> {
		const { ref, sourcePath, targetPath } = plan;
		if (ref.confidence === "uncertain" && !confirmedUncertain) {
			return { ok: false, kind: "unconfirmed-uncertain", message: "Confirm that this value refers to an attachment first." };
		}
		let current: string;
		try {
			current = await this.host.read(sourcePath);
		} catch (error) {
			return { ok: false, kind: "write-failed", message: `${sourcePath} couldn't be read: ${error instanceof Error ? error.message : String(error)}` };
		}
		if (current !== plan.snapshot) return { ok: false, kind: "stale", message: `${basename(sourcePath)} changed after this preview was made. Nothing was written.` };
		const blocker = this.writeBlocker(ref, current);
		if (blocker) return { ok: false, kind: "blocked", message: blocker };
		if (!this.host.getFile(targetPath)) return { ok: false, kind: "replacement-missing", message: `${targetPath} no longer exists. Nothing was written.` };
		if (this.resolver(plan.mode, sourcePath)(plan.writtenAs) !== targetPath) {
			return { ok: false, kind: "resolution", message: `“${plan.writtenAs}” no longer opens ${targetPath} from this source. Nothing was written.` };
		}

		const previous = this.store.get();
		const record: RecoveryRecord = {
			version: 1,
			state: "pending",
			sourcePath,
			start: plan.edit.start,
			before: plan.edit.before,
			after: plan.edit.after,
			beforeHash: fingerprint(plan.snapshot),
			afterHash: fingerprint(plan.result),
			createdAt: this.now(),
			appliedAt: null,
			summary: {
				originalTarget: ref.linkpath,
				newTarget: targetPath,
				place: `${plan.place} in ${sourcePath}`,
				lineBefore: linesAround(plan.snapshot, plan.edit.start, plan.edit.end),
				lineAfter: linesAround(plan.result, plan.edit.start, plan.edit.start + plan.edit.after.length),
			},
		};
		await this.store.set(record);

		try {
			await this.host.process(sourcePath, (data) => {
				if (data !== plan.snapshot) throw new StaleSourceError("changed");
				return plan.result;
			});
		} catch (error) {
			if (error instanceof StaleSourceError) {
				// The check inside the atomic write failed, so nothing was written: keep the previous undo point.
				await this.store.set(previous);
				return { ok: false, kind: "stale", message: `${basename(sourcePath)} changed while the repair was being written. Nothing was written.` };
			}
			const now = await this.host.read(sourcePath).catch(() => null);
			if (now === plan.snapshot) {
				await this.store.set(previous);
				return { ok: false, kind: "write-failed", message: `The repair couldn't be written: ${error instanceof Error ? error.message : String(error)}. The file was checked afterwards and is unchanged.` };
			}
			if (now !== plan.result) {
				return { ok: false, kind: "unverified", message: `The file changed while the repair was being written, so the result couldn't be confirmed. Open ${basename(sourcePath)} and check ${plan.place}.` };
			}
			// The write happened even though it reported an error; verify it like any other.
		}

		const written = await this.host.read(sourcePath).catch(() => null);
		if (written !== plan.result) {
			return { ok: false, kind: "unverified", message: `The file was written but doesn't contain the expected text. Open ${basename(sourcePath)} and check ${plan.place}.` };
		}
		const warning = await this.confirmResolution(plan);
		const applied: RecoveryRecord = { ...record, state: "applied", appliedAt: this.now() };
		await this.store.set(applied);
		await this.controller.refreshSource(sourcePath);
		return { ok: true, record: applied, warning };
	}

	/** After writing, checks the new link the way Obsidian reads it. Returns a warning or null. */
	private async confirmResolution(plan: RepairPlan): Promise<string | null> {
		const { ref, sourcePath, targetPath } = plan;
		let opens: string | null;
		if (ref.sourceKind === "markdown" && ref.place.type === "body" && ref.form !== "refdef") {
			const cache = await this.host.waitForCache(sourcePath, 3000);
			const items = [...(cache?.links ?? []), ...(cache?.embeds ?? [])];
			const item = items.find((i) => i.position.start.offset === plan.occurrence.start);
			if (!item) return "The repaired link was written, but Obsidian's index didn't report it yet. Rescan to confirm it.";
			opens = this.host.resolveLink(splitLinktext(item.link).path, sourcePath);
		} else {
			opens = this.resolver(plan.mode, sourcePath)(plan.writtenAs);
		}
		if (opens !== targetPath) return `The repaired link was written, but Obsidian reads it as opening ${opens ?? "nothing"}. Check ${plan.place}.`;
		return null;
	}

	canUndo(): boolean {
		return this.store.get()?.state === "applied";
	}

	async undo(): Promise<UndoResult> {
		const record = this.store.get();
		if (!record || record.state !== "applied") return { ok: false, kind: "none", message: "There's no repair to undo." };
		const current = await this.host.read(record.sourcePath).catch(() => null);
		if (current === null || !this.host.getFile(record.sourcePath)) {
			return { ok: false, kind: "missing", message: `${record.sourcePath} no longer exists, so the repair can't be undone.`, record };
		}
		const undo = computeUndo(record, current);
		if (!undo.ok) {
			const at = Math.min(record.start, current.length);
			return {
				ok: false,
				kind: "conflict",
				message: `${basename(record.sourcePath)} changed after the repair. Undoing now would overwrite those newer edits, so nothing was changed.`,
				currentLine: linesAround(current, at, at),
				record,
			};
		}
		const kind = record.sourcePath.endsWith(".md") ? "markdown" : "other";
		if (kind === "markdown" ? this.host.openEditorTexts(record.sourcePath).some((t) => t !== current) : this.host.isOpenInFileView(record.sourcePath)) {
			return { ok: false, kind: "blocked", message: kind === "markdown" ? UNSAVED : `Close ${basename(record.sourcePath)} before undoing.` };
		}
		try {
			await this.host.process(record.sourcePath, (data) => {
				if (fingerprint(data) !== record.afterHash) throw new StaleSourceError("changed");
				return undo.text;
			});
		} catch (error) {
			if (error instanceof StaleSourceError) return { ok: false, kind: "conflict", message: `${basename(record.sourcePath)} changed while undoing, so nothing was changed.`, record };
			return { ok: false, kind: "write-failed", message: `The undo couldn't be written: ${error instanceof Error ? error.message : String(error)}` };
		}
		const after = await this.host.read(record.sourcePath).catch(() => null);
		if (after !== undo.text) return { ok: false, kind: "unverified", message: `The undo was written but the file doesn't match the original. Open ${basename(record.sourcePath)} and check it.` };
		await this.store.set(null);
		await this.controller.refreshSource(record.sourcePath);
		return { ok: true, record };
	}

	/** Forgets the undo point, for example after an undo conflict the user resolves by hand. */
	async discardUndo(): Promise<void> {
		await this.store.set(null);
	}

	/**
	 * Run when the plugin loads. A pending record means Obsidian closed during a repair; compares
	 * the file against it and reports. Never changes the file.
	 */
	async checkRecovery(): Promise<RecoveryNotice | null> {
		const record = this.store.get();
		if (!record || record.state !== "pending") return null;
		const current = this.host.getFile(record.sourcePath) ? await this.host.read(record.sourcePath).catch(() => null) : null;
		const status = classifyRecovery(record, current);
		if (status === "applied") {
			await this.store.set({ ...record, state: "applied", appliedAt: this.now() });
		} else if (status === "unapplied") {
			await this.store.set(null);
		}
		const at = current === null ? 0 : Math.min(record.start, current.length);
		return { status, record, currentLine: current === null ? null : linesAround(current, at, at) };
	}

	/** Clears a pending record after the user has seen the recovery notice. */
	async dismissRecovery(): Promise<void> {
		const record = this.store.get();
		if (record?.state === "pending") await this.store.set(null);
	}
}
