// The single undo point. It's saved before a repair writes anything, so an interrupted repair can
// be classified on the next start without guessing.
import { fingerprint } from "../hash";

export interface RecoverySummary {
	/** Target as written before the repair */
	originalTarget: string;
	/** Vault path of the chosen replacement */
	newTarget: string;
	/** Where the reference is, such as "line 14" or "property cover" */
	place: string;
	lineBefore: string;
	lineAfter: string;
}

export interface RecoveryRecord {
	version: 1;
	/** "pending" until the result has been written and verified */
	state: "pending" | "applied";
	sourcePath: string;
	/** Offset where `before` was replaced by `after` */
	start: number;
	before: string;
	after: string;
	beforeHash: string;
	afterHash: string;
	createdAt: number;
	appliedAt: number | null;
	summary: RecoverySummary;
}

export type RecoveryStatus = "unapplied" | "applied" | "conflict" | "missing";

/** What the file says about the record: never applied, applied, or changed since. */
export function classifyRecovery(record: RecoveryRecord, current: string | null): RecoveryStatus {
	if (current === null) return "missing";
	const hash = fingerprint(current);
	if (hash === record.afterHash) return "applied";
	if (hash === record.beforeHash) return "unapplied";
	return "conflict";
}

export type UndoText = { ok: true; text: string } | { ok: false; reason: "conflict" | "corrupt" };

/** The original text, if `current` is exactly the repaired version. */
export function computeUndo(record: RecoveryRecord, current: string): UndoText {
	if (fingerprint(current) !== record.afterHash) return { ok: false, reason: "conflict" };
	if (current.slice(record.start, record.start + record.after.length) !== record.after) return { ok: false, reason: "corrupt" };
	const text = current.slice(0, record.start) + record.before + current.slice(record.start + record.after.length);
	if (fingerprint(text) !== record.beforeHash) return { ok: false, reason: "corrupt" };
	return { ok: true, text };
}

const isString = (v: unknown): v is string => typeof v === "string";

/** Validates a record loaded from plugin data. */
export function parseRecoveryRecord(value: unknown): RecoveryRecord | null {
	if (typeof value !== "object" || value === null) return null;
	const r = value as Record<string, unknown>;
	const s = r.summary as Record<string, unknown> | undefined;
	if (r.version !== 1 || (r.state !== "pending" && r.state !== "applied")) return null;
	if (!isString(r.sourcePath) || typeof r.start !== "number" || !isString(r.before) || !isString(r.after)) return null;
	if (!isString(r.beforeHash) || !isString(r.afterHash) || typeof r.createdAt !== "number") return null;
	if (!s || !isString(s.originalTarget) || !isString(s.newTarget) || !isString(s.place) || !isString(s.lineBefore) || !isString(s.lineAfter)) return null;
	return {
		version: 1,
		state: r.state,
		sourcePath: r.sourcePath,
		start: r.start,
		before: r.before,
		after: r.after,
		beforeHash: r.beforeHash,
		afterHash: r.afterHash,
		createdAt: r.createdAt,
		appliedAt: typeof r.appliedAt === "number" ? r.appliedAt : null,
		summary: { originalTarget: s.originalTarget, newTarget: s.newTarget, place: s.place, lineBefore: s.lineBefore, lineAfter: s.lineAfter },
	};
}
