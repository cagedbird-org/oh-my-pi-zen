import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runInNewContext } from "node:vm";
import type { ArchiveGrepHit } from "@oh-my-pi/pi-coding-agent/archive/grep";
import { createArchivePrelude } from "@oh-my-pi/pi-coding-agent/archive/prelude-definition";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { executePython } from "@oh-my-pi/pi-coding-agent/eval/py/executor";
import { sessionDirForCwd } from "@oh-my-pi/pi-coding-agent/session/session-paths";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { getConfigRootDir, removeSyncWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
let root: string;
let app: string;
let other: string;

function session(cwd = app): ToolSession {
	const value: ToolSession = {
		cwd,
		hasUI: false,
		settings: Settings.isolated({ "archive.enabled": true }),
		getSessionFile: () => null,
		getSessionSpawns: () => null,
	};
	const definition = createArchivePrelude(value);
	value.getEvalPreludes = () => [definition];
	return value;
}

async function grep(query: string, options: Record<string, unknown> = {}): Promise<ArchiveGrepHit[]> {
	const toolSession = session();
	const result = await createArchivePrelude(toolSession).invoke(
		{ action: "grep", query, ...options },
		{ session: toolSession, toolCallId: "grep-test" },
	);
	return result.details as ArchiveGrepHit[];
}

function writeSession(cwd: string, id: string, messages: unknown[], nested = false): string {
	const directory = nested ? path.join(sessionDirForCwd(cwd), "main") : sessionDirForCwd(cwd);
	fs.mkdirSync(directory, { recursive: true });
	const file = path.join(directory, `${id}.jsonl`);
	const rows = [
		{ type: "session", id, cwd, timestamp: "2024-01-01T00:00:00Z" },
		...messages.map(message => ({ type: "message", message })),
	];
	fs.writeFileSync(file, `${rows.map(row => JSON.stringify(row)).join("\n")}\n`);
	return file;
}

function message(role: string, content: unknown, timestamp = "2024-01-02T12:00:00Z"): unknown {
	return { role, content, timestamp };
}

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-archive-grep-"));
	app = path.join(root, "app");
	other = path.join(root, "other");
	setAgentDir(path.join(root, "agent"));
});

afterEach(() => {
	setAgentDir(originalAgentDir ?? path.join(getConfigRootDir(), "agent"));
	if (!originalAgentDir) delete process.env.PI_CODING_AGENT_DIR;
	removeSyncWithRetries(root);
});

describe("archive.grep", () => {
	it("searches only user, assistant, and tool-result prose", async () => {
		writeSession(app, "main", [
			message("user", "needle user"),
			message("assistant", [
				{ type: "thinking", thinking: "needle secret" },
				{ type: "toolCall", name: "needle", arguments: { text: "needle" } },
			]),
			message("user", [{ type: "image", data: "needle", mimeType: "image/png" }]),
			message("assistant", [{ type: "text", text: "needle assistant" }]),
			message("toolResult", [
				{ type: "text", text: "needle tool" },
				{ type: "image", data: "needle" },
			]),
			message("system", "needle system"),
		]);
		const hits = await grep("needle");
		expect(hits.map(hit => [hit.role, hit.snippet])).toEqual([
			["user", "needle user"],
			["assistant", "needle assistant"],
			["toolResult", "needle tool"],
		]);
		expect(JSON.stringify(hits)).not.toContain("secret");
	});

	it("matches JSON-decoded escaped Chinese", async () => {
		const file = writeSession(app, "escaped", [message("user", "透明背景")]);
		fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("透明背景", "\\u900f\\u660e\\u80cc\\u666f"));
		expect((await grep("透明背景"))[0].snippet).toBe("透明背景");
	});

	it("defaults to case-insensitive literals and supports case-sensitive regex", async () => {
		writeSession(app, "matching", [message("user", "A.B"), message("assistant", "axb")]);
		expect((await grep("a.b", { context: 0 })).map(hit => hit.snippet)).toEqual(["A.B"]);
		expect((await grep("a.b", { regex: true, caseSensitive: true })).map(hit => hit.snippet)).toEqual(["axb"]);
		await expect(grep("[", { regex: true })).rejects.toThrow("invalid regex");
	});

	it("filters message times inclusively rather than session creation or mtime", async () => {
		writeSession(app, "dated", [
			message("user", "needle old", "2024-01-01T23:59:59Z"),
			message("assistant", "needle today"),
			message("toolResult", "needle tomorrow", "2024-01-03T00:00:00Z"),
		]);
		expect((await grep("needle", { since: "2024-01-02", until: "2024-01-02" })).map(hit => hit.snippet)).toEqual([
			"needle today",
		]);
		await expect(grep("needle", { since: "bad" })).rejects.toThrow("invalid time");
		await expect(grep("needle", { since: "2024-02-01", until: "2024-01-01" })).rejects.toThrow("since must not");
	});

	it("uses the current project unless explicitly widened", async () => {
		writeSession(app, "local", [message("user", "needle")]);
		writeSession(other, "remote", [message("user", "needle")]);
		expect((await grep("needle")).map(hit => hit.project)).toEqual([app]);
		expect((await grep("needle", { project: "*" })).map(hit => hit.project).sort()).toEqual([app, other].sort());
		expect((await grep("needle", { project: "../other" })).map(hit => hit.project)).toEqual([other]);
	});

	it("excludes nested agent sessions by default", async () => {
		writeSession(app, "main", [message("user", "needle main")]);
		writeSession(app, "child", [message("user", "needle child")], true);
		expect((await grep("needle")).map(hit => hit.session)).toEqual(["main"]);
		expect((await grep("needle", { includeSubagents: true })).map(hit => hit.session).sort()).toEqual([
			"child",
			"main",
		]);
	});

	it("returns complete neighboring user turns including tool loops", async () => {
		writeSession(app, "turns", [
			message("user", "before"),
			message("assistant", "before answer"),
			message("user", "needle"),
			message("assistant", "work"),
			message("toolResult", "tool"),
			message("assistant", "answer"),
			message("user", "after"),
			message("assistant", "after answer"),
			message("user", "outside"),
		]);
		const [hit] = await grep("needle");
		expect(hit.context.map(turn => [turn.turn, turn.messages.map(row => row.text)])).toEqual([
			[1, ["before", "before answer"]],
			[2, ["needle", "work", "tool", "answer"]],
			[3, ["after", "after answer"]],
		]);
		expect((await grep("needle", { context: 0 }))[0].context).toEqual([]);
	});

	it("limits matching messages but still supplies following context", async () => {
		writeSession(app, "limits", [
			message("user", "needle one"),
			message("assistant", "needle two"),
			message("user", "after"),
		]);
		const hits = await grep("needle", { limit: 1 });
		expect(hits).toHaveLength(1);
		expect(hits[0].context.at(-1)?.messages[0].text).toBe("after");
	});

	it("finds late large-file hits and skips incomplete JSONL rows", async () => {
		const file = writeSession(app, "large", [
			message("user", "x".repeat(16 * 1024 * 1024)),
			message("assistant", "needle late"),
		]);
		fs.appendFileSync(file, '{"type":"message"');
		const [hit] = await grep("needle", { context: 0 });
		expect(hit.snippet).toBe("needle late");
		expect(hit.line).toBe(3);
	});

	it("bounds returned snippets and context message text", async () => {
		writeSession(app, "bounded", [message("user", `${"x".repeat(2000)}needle${"y".repeat(2000)}`)]);
		const [hit] = await grep("needle");
		expect(hit.snippet).toContain("needle");
		expect(hit.snippet.length).toBeLessThanOrEqual(502);
		expect(hit.context[0].messages[0].text.length).toBeLessThanOrEqual(1601);
	});

	it("exposes structured grep results through the JavaScript facade", async () => {
		writeSession(app, "js", [message("user", "透明背景")]);
		const toolSession = session();
		const definition = createArchivePrelude(toolSession);
		const sandbox = {
			__omp_prelude__: async (_name: string, params: unknown) => {
				const result = await definition.invoke(params, { session: toolSession, toolCallId: "js" });
				return { details: result.details };
			},
		};
		const hits = (await runInNewContext(
			`${definition.javascript}\narchive.grep("透明背景", {silent: true})`,
			sandbox,
		)) as ArchiveGrepHit[];
		expect(hits[0].session).toBe("js");
	});

	it.skipIf(process.env.PI_PYTHON_INTEGRATION !== "1")(
		"exposes structured grep results through the Python Eval bridge",
		async () => {
			writeSession(app, "python", [message("user", "透明背景")]);
			const result = await executePython(
				'hits = await archive.grep("透明背景", silent=True)\nprint(hits[0]["session"])',
				{ cwd: root, toolSession: session(), kernelMode: "per-call" },
			);
			expect(result.output.trim()).toBe("python");
			expect(result.exitCode).toBe(0);
		},
		30_000,
	);
});
