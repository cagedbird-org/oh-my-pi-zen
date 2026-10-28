import { type ReplicatedEntry, serializeReplicatedEntry } from "./replication-shrink";

/** Enough rows for the existing browser's 100-row visible window. */
export const COLLAB_HISTORY_ENTRIES = 100;
export const COLLAB_HISTORY_BYTES = 256 * 1024;

export interface TranscriptPage {
	start: number;
	before: number;
	json: string[];
	bytes: number[];
}

/** A backward, exclusive page. Never scans or serializes the unrequested prefix.
 * Prefer a user-turn boundary inside the budget; a huge turn cannot expand it.
 * One entry is always returned to ensure progress, bounded by the existing
 * replication ceiling (1 MiB), even if that entry exceeds the page byte budget.
 */
export function selectTranscriptPage(entries: readonly ReplicatedEntry[], before = entries.length): TranscriptPage {
	if (!Number.isSafeInteger(before) || before < 0 || before > entries.length) {
		throw new Error("invalid transcript history boundary");
	}
	const json: string[] = [];
	const bytes: number[] = [];
	let start = before;
	let total = 0;
	let turnStart = before;
	while (start > 0 && json.length < COLLAB_HISTORY_ENTRIES) {
		const entry = entries[start - 1]!;
		const text = serializeReplicatedEntry(entry).json;
		const size = Buffer.byteLength(text, "utf8");
		if (json.length > 0 && total + size > COLLAB_HISTORY_BYTES) break;
		start--;
		json.push(text);
		bytes.push(size);
		total += size;
		if (
			(entry.type === "message" && entry.message.role === "user") ||
			(entry.type === "custom_message" && entry.customType === "collab-prompt")
		)
			turnStart = start;
	}
	if (turnStart < before && start > 0) {
		const keep = before - turnStart;
		json.length = keep;
		bytes.length = keep;
		start = turnStart;
	}
	json.reverse();
	bytes.reverse();
	return { start, before, json, bytes };
}
