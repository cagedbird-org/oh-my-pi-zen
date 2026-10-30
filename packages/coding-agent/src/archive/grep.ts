import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { getSessionsDir } from "@oh-my-pi/pi-utils";
import { isEnoent } from "@oh-my-pi/pi-utils/fs-error";
import { sessionDirForCwd } from "../session/session-paths";
import type { ArchiveView } from "./archive";

export interface ArchiveGrepOptions {
	regex?: boolean;
	caseSensitive?: boolean;
	since?: string;
	until?: string;
	limit?: number;
	context?: number;
	includeSubagents?: boolean;
}

export interface ArchiveGrepMessage {
	line: number;
	at: string;
	role: "user" | "assistant" | "toolResult";
	text: string;
}

export interface ArchiveGrepTurn {
	/** One-based user turn; 0 holds messages before the first user. */
	turn: number;
	messages: ArchiveGrepMessage[];
}

export interface ArchiveGrepHit {
	session: string;
	file: string;
	project: string;
	at: string;
	role: ArchiveGrepMessage["role"];
	line: number;
	turn: number;
	snippet: string;
	context: ArchiveGrepTurn[];
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Only provider-visible prose, never thinking, tool arguments, or image payloads. */
function body(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(block): block is Record<string, unknown> =>
				record(block) && block.type === "text" && typeof block.text === "string",
		)
		.map(block => block.text)
		.join("\n");
}

function timestamp(value: unknown): string | undefined {
	if (typeof value !== "number" && typeof value !== "string") return undefined;
	const date = new Date(value);
	return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function bound(value: string | undefined, end: boolean, now: number): number | undefined {
	if (value === undefined) return undefined;
	const relative = /^(\d+)(m|h|d|w)$/.exec(value);
	if (relative) {
		const units: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
		return now - Number(relative[1]) * units[relative[2]];
	}
	const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
	const time = Date.parse(dateOnly ? `${value}T00:00:00.000Z` : value);
	if (!Number.isFinite(time)) throw new ToolError(`archive.grep received invalid time: ${value}`);
	return time + (dateOnly && end ? 86_400_000 - 1 : 0);
}

function clip(text: string, length: number, start = 0): string {
	return `${start > 0 ? "…" : ""}${text.slice(start, start + length)}${text.length > start + length ? "…" : ""}`;
}

interface TranscriptMessage extends ArchiveGrepMessage {
	session: string;
	project: string;
	turn: number;
}

/** Malformed/in-flight JSONL rows are ignored; all other I/O failures surface. */
async function* messages(file: string): AsyncGenerator<TranscriptMessage> {
	const input = createReadStream(file, { encoding: "utf8" });
	const lines = createInterface({ input, crlfDelay: Infinity });
	let session = "";
	let project = "";
	let created = "";
	let turn = 0;
	let line = 0;
	try {
		for await (const raw of lines) {
			line++;
			let entry: unknown;
			try {
				entry = JSON.parse(raw);
			} catch {
				continue;
			}
			if (!record(entry)) continue;
			if (entry.type === "session") {
				session = typeof entry.id === "string" ? entry.id : "";
				project = typeof entry.cwd === "string" ? entry.cwd : "";
				created = timestamp(entry.timestamp) ?? "";
				continue;
			}
			if (!session || entry.type !== "message" || !record(entry.message)) continue;
			const message = entry.message;
			const role = message.role;
			if (role !== "user" && role !== "assistant" && role !== "toolResult") continue;
			if (role === "user") turn++;
			const text = body(message.content);
			if (!text) continue;
			yield {
				session,
				project,
				line,
				turn,
				role,
				text,
				at: timestamp(entry.timestamp) ?? timestamp(message.timestamp) ?? created,
			};
		}
	} finally {
		lines.close();
		input.destroy();
	}
}

async function sessionFiles(cwd: string | undefined, subagents: boolean): Promise<string[]> {
	const root = cwd ? sessionDirForCwd(cwd) : getSessionsDir();
	const pattern = cwd ? (subagents ? "**/*.jsonl" : "*.jsonl") : subagents ? "*/**/*.jsonl" : "*/*.jsonl";
	const files: Array<{ file: string; modified: number }> = [];
	try {
		for await (const relative of new Bun.Glob(pattern).scan({ cwd: root, onlyFiles: true })) {
			const file = path.join(root, relative);
			try {
				files.push({ file, modified: (await stat(file)).mtimeMs });
			} catch (error) {
				if (!isEnoent(error)) throw error;
			}
		}
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
	return files.sort((a, b) => b.modified - a.modified || a.file.localeCompare(b.file)).map(entry => entry.file);
}

/** Stream transcripts without an index; retain only bounded snippets and requested context. */
export async function archiveGrep(
	query: string,
	cwd: string | undefined,
	options: ArchiveGrepOptions = {},
): Promise<ArchiveView<ArchiveGrepHit[]>> {
	const limit = options.limit ?? 20;
	const context = options.context ?? 1;
	const now = Date.now();
	const since = bound(options.since, false, now);
	const until = bound(options.until, true, now);
	if (since !== undefined && until !== undefined && since > until)
		throw new ToolError("since must not be later than until");
	let expression: RegExp;
	try {
		expression = new RegExp(
			options.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
			options.caseSensitive ? "u" : "iu",
		);
	} catch (error) {
		throw new ToolError(
			`archive.grep received invalid regex: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const records: ArchiveGrepHit[] = [];
	for (const file of await sessionFiles(cwd, options.includeSubagents ?? false)) {
		const hits: ArchiveGrepHit[] = [];
		try {
			for await (const message of messages(file)) {
				const time = Date.parse(message.at);
				if ((since !== undefined && !(time >= since)) || (until !== undefined && !(time <= until))) continue;
				const match = expression.exec(message.text);
				if (!match) continue;
				hits.push({
					session: message.session,
					file,
					project: message.project,
					at: message.at,
					role: message.role,
					line: message.line,
					turn: message.turn,
					snippet: clip(message.text, 500, Math.max(0, match.index - 160)),
					context: [],
				});
				if (records.length + hits.length >= limit) break;
			}
			if (hits.length && context > 0) {
				const turns = new Map<number, ArchiveGrepTurn>();
				const lastTurn = hits[hits.length - 1].turn + context;
				for await (const message of messages(file)) {
					if (message.turn > lastTurn) break;
					if (!hits.some(hit => Math.abs(hit.turn - message.turn) <= context)) continue;
					let turn = turns.get(message.turn);
					if (!turn) {
						turn = { turn: message.turn, messages: [] };
						turns.set(message.turn, turn);
					}
					turn.messages.push({
						line: message.line,
						at: message.at,
						role: message.role,
						text: clip(message.text, 1600),
					});
				}
				for (const hit of hits)
					hit.context = [...turns.values()].filter(turn => Math.abs(hit.turn - turn.turn) <= context);
			}
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
		records.push(...hits);
		if (records.length >= limit) break;
	}
	return {
		records,
		text: records.length
			? records
					.map(hit => `${hit.session} · ${hit.at} · ${hit.role} · ${hit.file}:${hit.line}\n${hit.snippet}`)
					.join("\n\n")
			: "No transcript matches.",
	};
}
