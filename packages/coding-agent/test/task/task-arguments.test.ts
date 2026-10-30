import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { validateAgentToolArguments } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { convertTools } from "@oh-my-pi/pi-ai/providers/openai-responses";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import { loadBundledAgents } from "@oh-my-pi/pi-coding-agent/task/agents";
import { omitUnusedTaskArgs } from "@oh-my-pi/pi-coding-agent/task/arguments";
import * as discovery from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executor from "@oh-my-pi/pi-coding-agent/task/executor";
import * as seance from "@oh-my-pi/pi-coding-agent/task/seance";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { SingleResult, TaskParams } from "@oh-my-pi/pi-tui/tools/task";
import { isRecord } from "@oh-my-pi/pi-utils";

let sessionIndex = 0;

async function makeTool(batch: boolean, file = false): Promise<TaskTool> {
	vi.spyOn(discovery, "discoverAgents").mockResolvedValue({ agents: loadBundledAgents(), projectAgentsDir: null });
	return TaskTool.create({
		cwd: `/tmp/task-placeholder-${sessionIndex++}`,
		hasUI: false,
		settings: Settings.isolated({
			"async.enabled": false,
			"task.batch": batch,
			"task.file": file,
			"task.isolation.enabled": true,
			"task.structured": false,
		}),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
	} as unknown as ToolSession);
}

function nativeArgs(tool: TaskTool, args: Record<string, unknown>): TaskParams {
	return validateAgentToolArguments(
		{
			name: tool.name,
			label: tool.label,
			description: tool.description,
			parameters: tool.parameters,
			lenientArgValidation: tool.lenientArgValidation,
			execute: tool.execute.bind(tool),
		},
		{
			type: "toolCall",
			id: "native-task",
			name: "task",
			arguments: args,
		},
	);
}

function mockExecutor() {
	return vi.spyOn(executor, "runSubprocess").mockImplementation(async options => {
		const result: SingleResult = {
			index: 0,
			id: options.id ?? "child",
			agent: options.agent.name,
			agentSource: "bundled",
			task: "read only",
			assignment: "read only",
			exitCode: 0,
			output: "completed",
			stderr: "",
			truncated: false,
			durationMs: 1,
			tokens: 0,
			requests: 1,
		};
		return result;
	});
}

beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
});

afterEach(() => {
	vi.restoreAllMocks();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
});

describe("native task optional placeholders", () => {
	it.each([false, true])("native provider schema keeps seance fields optional (batch=%s)", async batch => {
		const tool = await makeTool(batch);
		const model = getBundledModel("openai", "gpt-5-mini") as Model<"openai-responses">;
		const [wire] = convertTools([tool], true, model);
		if (wire?.type !== "function" || !isRecord(wire.parameters))
			throw new Error("Expected object function parameters");
		expect(wire.strict).toBe(false);
		const properties = wire.parameters.properties;
		if (!isRecord(properties)) throw new Error("Expected object properties");
		const tasks = properties.tasks;
		const item = batch && isRecord(tasks) ? tasks.items : wire.parameters;
		if (!isRecord(item) || !isRecord(item.properties)) throw new Error("Expected task item properties");
		expect(item.required).not.toContain("sourceSession");
		expect(item.required).not.toContain("model");
		expect(item.properties.sourceSession).toEqual({ type: "string" });
	});

	it.each([false, true])("strict wire adaptation requires nullable optional fields (batch=%s)", async batch => {
		const tool = await makeTool(batch);
		const model = getBundledModel("openai", "gpt-5-mini") as Model<"openai-responses">;
		const [wire] = convertTools(
			[{ name: tool.name, description: tool.description, parameters: tool.parameters, strict: true }],
			true,
			model,
		);
		if (wire?.type !== "function") throw new Error("Expected a function tool payload");
		expect(wire.strict).toBe(true);
		if (!isRecord(wire.parameters)) throw new Error("Expected object parameters");
		const properties = wire.parameters.properties;
		if (!isRecord(properties)) throw new Error("Expected object properties");
		const tasks = properties.tasks;
		const item = batch && isRecord(tasks) ? tasks.items : wire.parameters;
		if (!isRecord(item) || !isRecord(item.properties)) throw new Error("Expected task item properties");
		expect(item.required).toContain("sourceSession");
		expect(item.required).toContain("model");
		expect(JSON.stringify(item.properties.sourceSession)).toContain('"type":"null"');
		expect(JSON.stringify(item.properties.model)).toContain('"type":"null"');
	});

	it.each([{ model: "" }, { model: [] }, { model: null }])(
		"ordinary native calls omit optional placeholders ($model)",
		async ({ model }) => {
			const tool = await makeTool(false);
			const run = mockExecutor();
			const result = await tool.execute(
				"native-task",
				nativeArgs(tool, {
					agent: "task",
					task: "Read only.",
					solutionSpace: "one observation",
					sourceSession: "",
					model,
					tools: [],
					isolated: false,
				}),
			);
			expect(result.isError).not.toBe(true);
			expect(run).toHaveBeenCalledTimes(1);
			expect(run.mock.calls[0]?.[0].modelOverride).toEqual([]);
			expect(result.details?.results[0]?.output).toBe("completed");
		},
	);

	it.each([{ model: "" }, { model: [] }, { model: null }])(
		"seance native calls inherit their source model ($model)",
		async ({ model }) => {
			const tool = await makeTool(false);
			mockExecutor();
			const prepare = vi.spyOn(seance, "prepareSeance").mockResolvedValue({
				modelPatterns: ["openai/gpt-4o"],
				session: { fork: { sourceFile: "/source.jsonl" }, promptSuffix: () => "" },
			});
			const result = await tool.execute(
				"native-task",
				nativeArgs(tool, {
					agent: "seance",
					task: "Read history.",
					solutionSpace: "one observation",
					sourceSession: "historical-source",
					model,
					tools: [],
					isolated: false,
				}),
			);
			expect(result.isError).not.toBe(true);
			expect(prepare).toHaveBeenCalled();
			expect(prepare.mock.calls[0]?.[0]).toMatchObject({ sourceSession: "historical-source", model: undefined });
		},
	);

	it("normalizes every item of a mixed native batch before semantic validation", async () => {
		const tool = await makeTool(true);
		const run = mockExecutor();
		vi.spyOn(seance, "prepareSeance").mockResolvedValue({
			modelPatterns: ["openai/gpt-4o"],
			session: { fork: { sourceFile: "/source.jsonl" }, promptSuffix: () => "" },
		});
		const result = await tool.execute(
			"native-task",
			nativeArgs(tool, {
				context: "Read-only checks.",
				tasks: [
					{
						agent: "task",
						task: "Read.",
						solutionSpace: "one fact",
						sourceSession: "",
						model: "",
						tools: [],
						isolated: false,
					},
					{
						agent: "seance",
						task: "Recall.",
						solutionSpace: "one fact",
						sourceSession: "historical-source",
						model: [],
						tools: [],
						isolated: false,
					},
				],
			}),
		);
		expect(result.isError).not.toBe(true);
		expect(run).toHaveBeenCalledTimes(2);
	});

	it.each([false, true])("non-empty seance fields on ordinary agents remain errors (batch=%s)", async batch => {
		const tool = await makeTool(batch);
		const run = mockExecutor();
		for (const extra of [
			{ sourceSession: "real-source" },
			{ model: "openai/gpt-4o" },
			{ model: ["openai/gpt-4o"] },
		]) {
			const item = { agent: "task", task: "Read.", solutionSpace: "one fact", ...extra };
			const result = await tool.execute(
				"native-task",
				nativeArgs(tool, batch ? { context: "Read.", tasks: [item] } : item),
			);
			expect(result.isError).toBe(true);
			expect(result.content).toContainEqual(
				expect.objectContaining({ text: expect.stringContaining("only accepted for the `seance` agent") }),
			);
		}
		expect(run).not.toHaveBeenCalled();
	});

	it.each([false, true])("seance still requires a non-empty source (batch=%s)", async batch => {
		const tool = await makeTool(batch);
		const item = { agent: "seance", task: "Recall.", solutionSpace: "one fact", sourceSession: "", model: "" };
		const result = await tool.execute(
			"native-task",
			nativeArgs(tool, batch ? { context: "Recall.", tasks: [item] } : item),
		);
		expect(result.isError).toBe(true);
		expect(result.content).toContainEqual(
			expect.objectContaining({ text: expect.stringContaining("requires a non-empty `sourceSession`") }),
		);
	});

	it("normalizes placeholders even when lenient schema validation falls back to raw arguments", async () => {
		const tool = await makeTool(true);
		const run = mockExecutor();
		const args = nativeArgs(tool, {
			agent: "",
			context: "Read only.",
			tasks: [
				{ task: "Read.", solutionSpace: "one fact", sourceSession: "", model: [], tools: [], isolated: false },
			],
		});
		// The batch schema rejects any root agent before undeclared-key deletion;
		// lenient native dispatch therefore delivers the original placeholders.
		expect(args.agent).toBe("");
		const result = await tool.execute("native-task", args);
		expect(result.isError).not.toBe(true);
		expect(run).toHaveBeenCalledTimes(1);
	});

	it("ignores an empty optional taskFile alongside inline instructions", async () => {
		const tool = await makeTool(false, true);
		const run = mockExecutor();
		const result = await tool.execute(
			"native-task",
			nativeArgs(tool, {
				agent: "task",
				task: "Read.",
				taskFile: "",
				solutionSpace: "one fact",
			}),
		);
		expect(result.isError).not.toBe(true);
		expect(run).toHaveBeenCalledTimes(1);
	});

	it.each([
		{ extra: { model: [""] }, error: "invalid `model` selector" },
		{ extra: { tools: ["custom"] }, error: "cannot pass custom tools" },
		{ extra: { isolated: true }, error: "does not support plan mode, isolated execution, or custom tools" },
	])("rejects non-placeholder seance controls ($error)", async ({ extra, error }) => {
		const tool = await makeTool(false);
		const result = await tool.execute(
			"native-task",
			nativeArgs(tool, {
				agent: "seance",
				task: "Recall.",
				solutionSpace: "one fact",
				sourceSession: "historical-source",
				...extra,
			}),
		);
		expect(result.isError).toBe(true);
		expect(result.content).toContainEqual(expect.objectContaining({ text: expect.stringContaining(error) }));
	});

	it("still rejects empty required instructions through native dispatch", async () => {
		const tool = await makeTool(false);
		const result = await tool.execute(
			"native-task",
			nativeArgs(tool, {
				agent: "task",
				task: "",
				solutionSpace: "one fact",
				sourceSession: "",
				model: [],
			}),
		);
		expect(result.isError).toBe(true);
		expect(result.content).toContainEqual(
			expect.objectContaining({ text: expect.stringContaining("Missing `task`") }),
		);
	});

	it("preserves explicit isolation opt-out and valid output schemas without mutating input", () => {
		const input = { task: "Read.", sourceSession: "", model: [], tools: [], isolated: false, outputSchema: {} };
		const cleaned = omitUnusedTaskArgs(input, false);
		expect(cleaned).toEqual({ task: "Read.", isolated: false, outputSchema: {} });
		expect(input).toHaveProperty("sourceSession", "");
		expect(omitUnusedTaskArgs({ task: "Read.", outputSchema: false }, false).outputSchema).toBe(false);
	});

	it("does not erase invalid non-empty selectors or required task values", () => {
		const input = { task: "", sourceSession: "source", model: [""] };
		expect(omitUnusedTaskArgs(input, false)).toBe(input);
		expect(
			seance.validateSeanceParams({
				params: { ...input, agent: "seance" },
				batchEnabled: false,
				defaultAgent: "task",
				seanceAdvertised: true,
			}),
		).toContain("invalid `model` selector");
	});
});
