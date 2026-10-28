import { describe, expect, it } from "bun:test";
import type { ReplicatedEntry } from "../../src/collab/replication-shrink";
import {
	COLLAB_HISTORY_BYTES,
	COLLAB_HISTORY_ENTRIES,
	selectTranscriptPage,
} from "../../src/collab/transcript-history";

function entry(index: number, role: "user" | "toolResult" = "user", size = 10): ReplicatedEntry {
	const common = {
		type: "message" as const,
		id: `e${index}`,
		parentId: index ? `e${index - 1}` : null,
		timestamp: "2026-10-29T00:00:00Z",
	};
	return role === "user"
		? { ...common, message: { role, content: "界".repeat(size), timestamp: index } }
		: {
				...common,
				message: {
					role,
					toolCallId: `call${index}`,
					toolName: "bash",
					content: [{ type: "text", text: "x".repeat(size) }],
					isError: false,
					timestamp: index,
				},
			};
}

function ids(page: { json: string[] }): string[] {
	return page.json.map(json => (JSON.parse(json) as ReplicatedEntry).id);
}

describe("bounded transcript history", () => {
	it("delivers empty, exact-limit and preceding pages without gaps or duplicate boundary entries", () => {
		expect(selectTranscriptPage([])).toEqual({ start: 0, before: 0, json: [], bytes: [] });
		const entries = Array.from({ length: COLLAB_HISTORY_ENTRIES * 2 + 1 }, (_, i) => entry(i));
		let before = entries.length;
		let all: string[] = [];
		while (before > 0) {
			const page = selectTranscriptPage(entries, before);
			expect(page.before).toBe(before);
			expect(page.json.length).toBe(Math.min(before, COLLAB_HISTORY_ENTRIES));
			all = [...ids(page), ...all];
			before = page.start;
		}
		expect(all).toEqual(entries.map(e => e.id));
	});

	it("starts at a user turn inside the budget instead of orphaning its tool results", () => {
		const entries = Array.from({ length: 120 }, (_, i) => entry(i, i % 30 === 0 ? "user" : "toolResult"));
		const page = selectTranscriptPage(entries);
		expect(page.start).toBe(30);
		expect(ids(page)[0]).toBe("e30");
		const previous = selectTranscriptPage(entries, page.start);
		expect([...ids(previous), ...ids(page)]).toEqual(entries.map(e => e.id));
	});

	it("bounds a huge single turn and UTF-8 bytes rather than expanding to the start of the session", () => {
		const entries = Array.from({ length: 300 }, (_, i) => entry(i, i === 0 ? "user" : "toolResult", 8192));
		const page = selectTranscriptPage(entries);
		expect(page.start).toBeGreaterThan(0);
		expect(page.bytes.reduce((sum, size) => sum + size, 0)).toBeLessThanOrEqual(COLLAB_HISTORY_BYTES);
		const unicode = selectTranscriptPage(Array.from({ length: 100 }, (_, i) => entry(i, "user", 4096)));
		expect(unicode.bytes.reduce((sum, size) => sum + size, 0)).toBeLessThanOrEqual(COLLAB_HISTORY_BYTES);
		expect(unicode.json.length).toBeLessThan(COLLAB_HISTORY_ENTRIES);
	});

	it("makes progress across an oversized entry and rejects invalid exclusive cursors", () => {
		const entries = [entry(0, "user", 200_000)];
		const page = selectTranscriptPage(entries);
		expect(page.start).toBe(0);
		expect(ids(page)).toEqual(["e0"]);
		for (const before of [-1, 0.5, 2, Number.NaN]) {
			expect(() => selectTranscriptPage(entries, before)).toThrow("invalid transcript history boundary");
		}
	});
});
