import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import type { ToolSession } from "../../src/tools";
import {
	AgentDesktop,
	agentDesktopProcess,
	killAgentDesktopResources,
	stopAgentDesktopResources,
	type AgentDesktopProcess,
	type AgentDesktopResources,
	type AgentDesktopState,
} from "../../src/tools/computer/agent-desktop";
import {
	ComputerSupervisor,
	controlAgentDesktopForOwner,
	registerComputerController,
	takeAgentDesktopClosedNotice,
	type ComputerWorkerHandle,
} from "../../src/tools/computer/supervisor";
import type {
	ComputerSessionSnapshot,
	ComputerWorkerInbound,
	ComputerWorkerOutbound,
	ComputerWorkerTransport,
} from "../../src/tools/computer/protocol";
import { ComputerWorkerCore, type NativeDesktopSession } from "../../src/tools/computer/worker";

interface EvalFacadeFixture {
	agentDesktop(): Promise<EvalFacadeFixture>;
	ref(ref: string): { press(): Promise<void> };
	window(selector: string): Promise<{ ref(ref: string): { press(): Promise<void> } }>;
}

// Real OS processes and the independent Python watchdog do not share Bun's fake clock.
async function waitUntil(predicate: () => boolean | Promise<boolean>) {
	const deadline = Date.now() + 4000;
	while (!(await predicate())) {
		if (Date.now() > deadline) throw new Error("Timed out waiting for lifetime contract");
		await delay(20);
	}
}

class CoreTransport implements ComputerWorkerTransport {
	messages: ComputerWorkerOutbound[] = [];
	listeners = new Set<(message: ComputerWorkerOutbound) => void>();
	send(message: ComputerWorkerOutbound) {
		this.messages.push(message);
		for (const listener of this.listeners) listener(message);
	}
	onMessage(_handler: (message: ComputerWorkerInbound) => void) {
		return () => {};
	}
	close() {}
	async receive(predicate: (message: ComputerWorkerOutbound) => boolean): Promise<ComputerWorkerOutbound> {
		const existing = this.messages.find(predicate);
		if (existing) return existing;
		const pending = Promise.withResolvers<ComputerWorkerOutbound>();
		const listener = (message: ComputerWorkerOutbound) => {
			if (predicate(message)) pending.resolve(message);
		};
		this.listeners.add(listener);
		try {
			return await pending.promise;
		} finally {
			this.listeners.delete(listener);
		}
	}
}

class ControlledDesktop extends AgentDesktop {
	constructor(readonly closeFromUser: () => void) {
		super(() => {}, closeFromUser);
	}
	override async start() {
		return { kwinBusAddress: "test-bus", waylandDisplay: "test-display" };
	}
	override async stop() {}
}

function nativeFixture() {
	return {
		capabilities: { backend: "fake", takeover: true, screenLocked: false, displayAsleep: false },
		screenState: { screenLocked: false, displayAsleep: false },
		escapeStops: 0,
		setRunDeadline() {},
		controlState() {
			return { active: false };
		},
		retire() {},
		cancel() {},
		async close() {},
	} as unknown as NativeDesktopSession;
}

/** A worker transport that implements the lifecycle protocol, without starting any desktop. */
class DesktopWorker implements ComputerWorkerHandle {
	state: AgentDesktopState = "stopped";
	listener?: (message: ComputerWorkerOutbound) => void;
	failure?: (error: Error) => void;
	onMessage(listener: (message: ComputerWorkerOutbound) => void) {
		this.listener = listener;
		queueMicrotask(() => listener({ type: "ready" }));
		return () => {
			this.listener = undefined;
		};
	}
	onError(handler: (error: Error) => void) {
		this.failure = handler;
		return () => {
			this.failure = undefined;
		};
	}
	async terminate() {}
	send(message: Parameters<ComputerWorkerHandle["send"]>[0]) {
		if (message.type === "close") this.listener?.({ type: "closed" });
		if (message.type !== "agent-desktop") return;
		this.state =
			message.command === "stop"
				? "stopped"
				: message.command === "start"
					? "hidden"
					: this.state === "visible"
						? "hidden"
						: "visible";
		this.listener?.({ type: "agent-desktop-state", state: this.state });
		this.listener?.({ type: "agent-desktop", id: message.id, ok: true, state: this.state });
	}
}

describe("agent desktop lifetime", () => {
	it("notifies the next user dispatch exactly once after the user's stop, not hide or an agent's close", async () => {
		const owner = `desk-notice-${crypto.randomUUID()}`;
		const worker = new DesktopWorker();
		const session = { getEvalKernelOwnerId: () => owner } as ToolSession;
		const controller = new ComputerSupervisor(session, () => worker, undefined, undefined, {
			read: () => 0,
			forget: () => {},
		});
		const unregister = registerComputerController(owner, controller);
		try {
			await controlAgentDesktopForOwner(owner, "start");
			await controlAgentDesktopForOwner(owner, "toggle");
			await controlAgentDesktopForOwner(owner, "toggle");
			expect(takeAgentDesktopClosedNotice(owner)).toBe(false);
			await controlAgentDesktopForOwner(owner, "stop");
			expect(takeAgentDesktopClosedNotice(owner)).toBe(true);
			expect(takeAgentDesktopClosedNotice(owner)).toBe(false);
			await controlAgentDesktopForOwner(owner, "stop");
			expect(takeAgentDesktopClosedNotice(owner)).toBe(false);
			await controller.agentDesktop("start");
			await controller.agentDesktop("stop");
			expect(takeAgentDesktopClosedNotice(owner)).toBe(false);
			worker.listener?.({ type: "agent-desktop-state", state: "stopped", closedByUser: true });
			expect(takeAgentDesktopClosedNotice(owner)).toBe(true);
			expect(takeAgentDesktopClosedNotice(owner)).toBe(false);
		} finally {
			unregister();
			await controller.close();
		}
	});

	it.skipIf(process.platform !== "linux")(
		"cleans a worker's real process group and private runtime after a crash",
		async () => {
			const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-desk-crash-test-"));
			const socket = path.join(directory, "owned-socket");
			await fs.writeFile(socket, "fixture");
			await fs.writeFile(`${socket}.lock`, "fixture");
			const processGroup = spawn("/bin/sleep", ["60"], { detached: true, stdio: "ignore" });
			const started = Promise.withResolvers<void>();
			processGroup.once("spawn", started.resolve);
			processGroup.once("error", started.reject);
			await started.promise;
			const worker = new DesktopWorker();
			const controller = new ComputerSupervisor({} as ToolSession, () => worker, undefined, undefined, {
				read: () => 0,
				forget: () => {},
			});
			try {
				await controller.agentDesktop("start");
				worker.listener?.({
					type: "agent-desktop-resources",
					resources: {
						processes: [{ ...agentDesktopProcess(processGroup.pid!)!, group: true }],
						socket,
						directory,
					},
				});
				worker.failure!(new Error("fixture worker crash"));
				const deadline = Date.now() + 3000;
				while (
					await fs.stat(directory).then(
						() => true,
						() => false,
					)
				) {
					if (Date.now() > deadline) throw new Error("Supervisor left the crashed desktop runtime behind");
					await delay(20);
				}
				expect(() => process.kill(-processGroup.pid!, 0)).toThrow();
				expect(controller.agentDesktopState).toBe("stopped");
			} finally {
				await controller.close();
				try {
					process.kill(-processGroup.pid!, "SIGKILL");
				} catch {
					/* Already reaped. */
				}
				await fs.rm(directory, { recursive: true, force: true });
			}
		},
	);

	it.skipIf(process.platform !== "linux" || !Bun.which("dbus-daemon") || !Bun.which("python3"))(
		"reaps the real private bus and watchdog when startup fails",
		async () => {
			const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-desk-failure-test-"));
			try {
				const bin = path.join(directory, "bin");
				await fs.mkdir(bin);
				await fs.symlink(Bun.which("dbus-daemon")!, path.join(bin, "dbus-daemon"));
				await fs.symlink(Bun.which("python3")!, path.join(bin, "python3"));
				for (const name of ["kwin_wayland", "qdbus6", "wl-copy", "wl-paste"])
					await fs.symlink("/bin/true", path.join(bin, name));
				await fs.writeFile(path.join(bin, "gdbus"), "#!/bin/sh\nexit 42\n", { mode: 0o755 });
				const module = fileURLToPath(new URL("../../src/tools/computer/agent-desktop.ts", import.meta.url));
				const child = Bun.spawn(
					[
						process.execPath,
						"-e",
						`
				import { AgentDesktop } from ${JSON.stringify(module)};
				const pids = new Set(); const watchdogs = new Set(); let scratch; let failure;
				const desktop = new AgentDesktop(resources => { resources.processes.forEach(process => pids.add(process.pid)); if (resources.watchdog) watchdogs.add(resources.watchdog.pid); scratch ??= resources.directory; }, () => {});
				try { await desktop.start(); } catch (error) { failure = error.code; }
				const alive = [...pids, ...watchdogs].filter(pid => { try { process.kill(pid, 0); return true; } catch { return false; } });
				import { stat } from "node:fs/promises";
				console.log(JSON.stringify({ failed: failure === 42, spawned: pids.size, alive, scratchExists: scratch && await stat(scratch).then(() => true, () => false), state: desktop.state }));
			`,
					],
					{
						env: {
							...process.env,
							PATH: bin,
							XDG_CURRENT_DESKTOP: "KDE",
							XDG_SESSION_TYPE: "wayland",
							XDG_RUNTIME_DIR: directory,
						},
						stdout: "pipe",
						stderr: "pipe",
					},
				);
				const result = JSON.parse(await new Response(child.stdout).text());
				expect(await child.exited).toBe(0);
				expect(result).toEqual({ failed: true, spawned: 1, alive: [], scratchExists: false, state: "stopped" });
			} finally {
				await fs.rm(directory, { recursive: true, force: true });
			}
		},
		10000,
	);

	it.skipIf(process.platform !== "linux")(
		"refuses to signal a reused PID or process group with a different starttime",
		async () => {
			const child = spawn("/bin/sleep", ["60"], { detached: true, stdio: "ignore" });
			const started = Promise.withResolvers<void>();
			child.once("spawn", started.resolve);
			child.once("error", started.reject);
			await started.promise;
			const identity = agentDesktopProcess(child.pid!)!;
			try {
				const stale = { ...identity, startTime: String(BigInt(identity.startTime) - 1n) };
				killAgentDesktopResources({ processes: [stale, { ...stale, group: true }] }, "SIGKILL");
				expect(agentDesktopProcess(identity.pid)?.startTime).toBe(identity.startTime);
			} finally {
				killAgentDesktopResources({ processes: [{ ...identity, group: true }] }, "SIGKILL");
			}
		},
	);

	it.skipIf(process.platform !== "linux" || !Bun.which("python3"))(
		"independently cleans real descendants after owner SIGKILL and rejects stale watchdog identities",
		async () => {
			const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-watchdog-kill-test-"));
			const protectedChild = spawn("/bin/sleep", ["60"], { detached: true, stdio: "ignore" });
			const started = Promise.withResolvers<void>();
			protectedChild.once("spawn", started.resolve);
			protectedChild.once("error", started.reject);
			await started.promise;
			const protectedIdentity = agentDesktopProcess(protectedChild.pid!)!;
			const module = fileURLToPath(new URL("../../src/tools/computer/agent-desktop.ts", import.meta.url));
			const owner = Bun.spawn(
				[
					process.execPath,
					"-e",
					`
			import { spawn } from "node:child_process";
			import { agentDesktopProcess, startAgentDesktopWatchdog, publishAgentDesktopResources } from ${JSON.stringify(module)};
			const watchdog = await startAgentDesktopWatchdog(${JSON.stringify(directory)});
			const child = spawn("/bin/sh", ["-c", "sleep 60 & wait"], { detached: true, stdio: "ignore", env: { ...process.env, XDG_RUNTIME_DIR: watchdog.resources.directory } });
			const started = Promise.withResolvers(); child.once("spawn", started.resolve); child.once("error", started.reject); await started.promise;
			const stale = ${JSON.stringify({ ...protectedIdentity, startTime: String(BigInt(protectedIdentity.startTime) - 1n), group: true })};
			const resources = { ...watchdog.resources, processes: [{ ...agentDesktopProcess(child.pid), group: true }, stale] };
			publishAgentDesktopResources(resources);
			console.log(JSON.stringify(resources));
		`,
				],
				{ stdout: "pipe", stderr: "pipe" },
			);
			let resources: AgentDesktopResources | undefined;
			try {
				const reader = owner.stdout.getReader();
				const decoder = new TextDecoder();
				let text = "";
				while (!text.includes("\n")) {
					const chunk = await reader.read();
					if (chunk.done) throw new Error("Watchdog owner exited before readiness");
					text += decoder.decode(chunk.value);
				}
				resources = JSON.parse(text.split("\n")[0]!) as AgentDesktopResources;
				owner.kill("SIGKILL");
				await owner.exited;
				await waitUntil(
					async () =>
						!(await fs.stat(resources!.directory!).then(
							() => true,
							() => false,
						)) && !agentDesktopProcess(resources!.watchdog!.pid),
				);
				expect(agentDesktopProcess(resources.processes[0]!.pid)).toBeUndefined();
				expect(agentDesktopProcess(protectedIdentity.pid)?.startTime).toBe(protectedIdentity.startTime);
				expect(agentDesktopProcess(resources.watchdog!.pid)).toBeUndefined();
			} finally {
				owner.kill("SIGKILL");
				if (resources) await stopAgentDesktopResources(resources);
				killAgentDesktopResources({ processes: [{ ...protectedIdentity, group: true }] }, "SIGKILL");
				await fs.rm(directory, { recursive: true, force: true });
			}
		},
		10000,
	);

	for (const agentTarget of [false, true])
		for (const userClose of [false, true]) {
			it(`${userClose ? "compositor exit" : "/desk stop"} ${agentTarget ? "aborts the agent" : "preserves the host"} run`, async () => {
				const transport = new CoreTransport();
				let desktop: ControlledDesktop | undefined;
				const worker = new ComputerWorkerCore(
					transport,
					() => nativeFixture(),
					(_changed, closed) => (desktop = new ControlledDesktop(closed)),
				);
				const snapshot: ComputerSessionSnapshot = {
					cwd: process.cwd(),
					sessionId: `desk-target-${crypto.randomUUID()}`,
					captureMaxWidth: 100,
					captureMaxHeight: 100,
					display: "active",
					readOnly: true,
					backgroundFallback: "takeover",
				};
				const escape = { key: "target-contract", acknowledged: 0 };
				try {
					worker.handle({
						type: "capabilities",
						id: "init",
						session: { ...snapshot, agentDesktop: true },
						escape,
					});
					const initialized = await transport.receive(
						message => message.type === "capabilities" && message.id === "init",
					);
					expect("ok" in initialized && initialized.ok).toBe(true);
					if (initialized.type !== "capabilities" || !initialized.ok)
						throw new Error("Expected agent capabilities");
					snapshot.agentDesktopGeneration = initialized.capabilities.agentDesktopGeneration;
					worker.handle({
						type: "run",
						id: "active",
						code: "await tool.fixturePause(); return 'completed';",
						timeoutMs: 2000,
						session: { ...snapshot, agentDesktop: agentTarget },
						escape,
					});
					const barrier = await transport.receive(
						message => message.type === "tool-call" && message.runId === "active",
					);
					if (barrier.type !== "tool-call") throw new Error("Expected the active run barrier");
					if (userClose) desktop!.closeFromUser();
					else worker.handle({ type: "agent-desktop", id: "stop", command: "stop" });
					await transport.receive(
						message => message.type === "agent-desktop-state" && message.state === "stopped",
					);
					if (!agentTarget)
						worker.handle({ type: "tool-reply", id: barrier.id, reply: { ok: true, value: null } });
					const result = await transport.receive(message => message.type === "result" && message.id === "active");
					if (result.type !== "result") throw new Error("Unexpected worker result");
					expect(result.ok).toBe(!agentTarget);
					if (result.ok) expect(result.payload.returnValue).toBe("completed");
					else expect(result.error.message).toContain("Agent desktop closed");
				} finally {
					worker.handle({ type: "close" });
					await transport.receive(message => message.type === "closed");
				}
			});
		}

	it("rejects stale requests and retained runtime handles when the new native session reuses e1", async () => {
		const transport = new CoreTransport();
		let presses = 0;
		let epoch = 0;
		const worker = new ComputerWorkerCore(
			transport,
			() => ({
				...nativeFixture(),
				axNode: async () => ({
					ref: "e1",
					role: "button",
					nativeRole: "button",
					title: `epoch ${++epoch}`,
					description: "",
					enabled: true,
					focused: false,
					childCount: 0,
				}),
				axPerform: async () => {
					presses++;
				},
			}),
			(_changed, closed) => new ControlledDesktop(closed),
		);
		const snapshot: ComputerSessionSnapshot = {
			cwd: process.cwd(),
			sessionId: `desk-generation-${crypto.randomUUID()}`,
			captureMaxWidth: 100,
			captureMaxHeight: 100,
			display: "active",
			readOnly: false,
			backgroundFallback: "takeover",
			agentDesktop: true,
		};
		const escape = { key: "generation-contract", acknowledged: 0 };
		const generation = async (id: string) => {
			worker.handle({ type: "capabilities", id, session: snapshot, escape });
			const result = await transport.receive(message => message.type === "capabilities" && message.id === id);
			if (result.type !== "capabilities" || !result.ok || !result.capabilities.agentDesktopGeneration)
				throw new Error("Expected a desktop generation");
			return result.capabilities.agentDesktopGeneration;
		};
		const run = async (id: string, code: string, token: string) => {
			worker.handle({
				type: "run",
				id,
				code,
				timeoutMs: 2000,
				session: { ...snapshot, agentDesktopGeneration: token },
				escape,
			});
			const result = await transport.receive(message => message.type === "result" && message.id === id);
			if (result.type !== "result") throw new Error("Expected a run result");
			return result;
		};
		try {
			const oldGeneration = await generation("first");
			expect(
				(
					await run(
						"save",
						"globalThis.savedElement = await desktop.ref('e1'); return savedElement.ref;",
						oldGeneration,
					)
				).ok,
			).toBe(true);
			worker.handle({ type: "agent-desktop", id: "stop", command: "stop" });
			await transport.receive(message => message.type === "agent-desktop" && message.id === "stop");
			const newGeneration = await generation("second");
			expect(newGeneration).not.toBe(oldGeneration);
			for (const [id, code, token] of [
				["old-request", "await desktop.ref('e1').press();", oldGeneration],
				["saved-handle", "await savedElement.press();", newGeneration],
			]) {
				const result = await run(id!, code!, token!);
				expect(result.ok).toBe(false);
				if (!result.ok) expect(result.error.message).toContain("已失效");
			}
			expect(presses).toBe(0);
			expect((await run("fresh", "await desktop.ref('e1').press();", newGeneration)).ok).toBe(true);
			expect(presses).toBe(1);
		} finally {
			worker.handle({ type: "close" });
			await transport.receive(message => message.type === "closed");
		}
	});

	it("keeps JS element/window handles pinned while refreshing the same agent facade", async () => {
		let generation = "first";
		let presses = 0;
		const invoke = async (
			_name: string,
			parameters: { action: string; agentDesktopGeneration?: string; chain?: { method: string }[] },
		) => {
			if (parameters.action === "agent-desktop") return { details: { generation } };
			if (parameters.agentDesktopGeneration !== generation) throw new Error("Agent desktop handle 已失效");
			const method = parameters.chain?.at(-1)?.method;
			if (method === "press") presses++;
			return {
				details: {
					value:
						method === "window"
							? { id: "same-window", app: "fixture" }
							: method === "ref"
								? { ref: "e1", role: "button" }
								: null,
				},
			};
		};
		const context: { __omp_prelude__: typeof invoke; __omp_log__: () => void; computer?: EvalFacadeFixture } = {
			__omp_prelude__: invoke,
			__omp_log__: () => {},
		};
		runInNewContext(
			await fs.readFile(new URL("../../src/tools/computer/prelude.js", import.meta.url), "utf8"),
			context,
		);
		if (!context.computer) throw new Error("Expected the installed computer facade");
		const desk = await context.computer.agentDesktop();
		const element = desk.ref("e1");
		const window = await desk.window("same-window");
		generation = "second";
		expect(await context.computer.agentDesktop()).toBe(desk);
		await expect(element.press()).rejects.toThrow("已失效");
		await expect(window.ref("e1").press()).rejects.toThrow("已失效");
		expect(presses).toBe(0);
		await desk.ref("e1").press();
		expect(presses).toBe(1);
	});

	it.skipIf(!Bun.which("python3"))("keeps Python AX handles pinned across refresh of the same facade", async () => {
		const prelude = await fs.readFile(new URL("../../src/tools/computer/prelude.py", import.meta.url), "utf8");
		const child = Bun.spawn(
			[
				Bun.which("python3")!,
				"-c",
				`
import asyncio, json
state = {"generation": "first", "presses": 0}
async def _omp_prelude(name, parameters):
    if parameters["action"] == "agent-desktop":
        return {"details": {"generation": state["generation"]}}
    if parameters.get("agentDesktopGeneration") != state["generation"]:
        raise RuntimeError("Agent desktop handle 已失效")
    method = parameters["chain"][-1]["method"]
    if method == "press": state["presses"] += 1
    value = {"id": "same-window", "app": "fixture"} if method == "window" else {"ref": "e1", "role": "button"} if method == "ref" else None
    return {"details": {"value": value}}
${prelude}
async def main():
    desk = await computer.agentDesktop()
    element = desk.ref("e1")
    window = await desk.window("same-window")
    state["generation"] = "second"
    assert await computer.agentDesktop() is desk
    stale = 0
    for handle in (element, window.ref("e1")):
        try: await handle.press()
        except RuntimeError as error:
            assert "已失效" in str(error)
            stale += 1
    assert state["presses"] == 0
    await desk.ref("e1").press()
    print(json.dumps({"stale": stale, "presses": state["presses"]}))
asyncio.run(main())
`,
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		const stdout = await new Response(child.stdout).text();
		expect(await child.exited).toBe(0);
		expect(JSON.parse(stdout)).toEqual({ stale: 2, presses: 1 });
	});

	it.skipIf(process.platform !== "linux" || !Bun.which("python3"))(
		"cleans a watchdog whose worker crashes before readiness is published",
		async () => {
			const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-watchdog-pre-ready-"));
			const bin = path.join(directory, "bin");
			const marker = path.join(directory, "spawned");
			await fs.mkdir(bin);
			await fs.writeFile(
				path.join(bin, "python3"),
				`#!/bin/sh\nprintf '%s\\n' "$$" > ${JSON.stringify(marker)}\nkill -STOP "$$"\nexec ${JSON.stringify(Bun.which("python3"))} "$@"\n`,
				{ mode: 0o755 },
			);
			const entry = path.join(directory, "worker.ts");
			const module = fileURLToPath(new URL("../../src/tools/computer/agent-desktop.ts", import.meta.url));
			await fs.writeFile(
				entry,
				`import {startAgentDesktopWatchdog} from ${JSON.stringify(module)}; await startAgentDesktopWatchdog(${JSON.stringify(directory)});`,
			);
			const worker = new Worker(entry, { type: "module", env: { ...process.env, PATH: bin } });
			let identity: AgentDesktopProcess | undefined;
			try {
				await waitUntil(() =>
					fs.stat(marker).then(
						() => true,
						() => false,
					),
				);
				identity = agentDesktopProcess(Number((await fs.readFile(marker, "utf8")).trim()));
				expect(identity).toBeDefined();
				await waitUntil(async () => {
					const stat = await fs.readFile(`/proc/${identity!.pid}/stat`, "utf8");
					return stat.slice(stat.lastIndexOf(")") + 2).startsWith("T");
				});
				await worker.terminate();
				killAgentDesktopResources({ processes: [identity!] }, "SIGCONT");
				await waitUntil(
					async () =>
						!agentDesktopProcess(identity!.pid) &&
						!(await fs.readdir(directory)).some(name => name.startsWith("omp-agent-desktop-")),
				);
				expect(agentDesktopProcess(identity!.pid)).toBeUndefined();
				expect((await fs.readdir(directory)).filter(name => name.startsWith("omp-agent-desktop-"))).toEqual([]);
			} finally {
				await worker.terminate();
				if (identity) {
					killAgentDesktopResources({ processes: [identity] }, "SIGCONT");
					killAgentDesktopResources({ processes: [identity] }, "SIGTERM");
				}
				await fs.rm(directory, { recursive: true, force: true });
			}
		},
		10000,
	);

	it("treats a delayed generation-bound close as already closed without stopping its replacement", async () => {
		const transport = new CoreTransport();
		let nativeCloses = 0;
		const core = new ComputerWorkerCore(
			transport,
			() => ({
				...nativeFixture(),
				close: async () => {
					nativeCloses++;
				},
			}),
			(_changed, closed) => new ControlledDesktop(closed),
		);
		const handle: ComputerWorkerHandle = {
			send: message => core.handle(message),
			onMessage: listener => {
				transport.listeners.add(listener);
				const ready = transport.messages.find(message => message.type === "ready");
				if (ready) queueMicrotask(() => listener(ready));
				return () => {
					transport.listeners.delete(listener);
				};
			},
			onError: () => () => {},
			async terminate() {},
		};
		const controller = new ComputerSupervisor({} as ToolSession, () => handle, undefined, undefined, {
			read: () => 0,
			forget: () => {},
		});
		const snapshot: ComputerSessionSnapshot = {
			cwd: process.cwd(),
			sessionId: "close-generation-race",
			captureMaxWidth: 100,
			captureMaxHeight: 100,
			display: "active",
			readOnly: true,
			backgroundFallback: "takeover",
			agentDesktop: true,
		};
		try {
			const original = (await controller.capabilities(snapshot))?.agentDesktopGeneration;
			if (!original) throw new Error("Expected the original generation");
			// The old close was prepared before the user's unconditional stop/start replaced the desktop.
			await controller.agentDesktop("stop");
			await controller.agentDesktop("start");
			const replacement = (await controller.capabilities(snapshot))?.agentDesktopGeneration;
			if (!replacement) throw new Error("Expected the replacement generation");
			expect(replacement).not.toBe(original);
			await controller.agentDesktop("stop", original);
			expect(nativeCloses).toBe(1);
			expect(
				(await controller.capabilities({ ...snapshot, agentDesktopGeneration: replacement }))
					?.agentDesktopGeneration,
			).toBe(replacement);
			await controller.agentDesktop("stop", replacement);
			expect(nativeCloses).toBe(2);
			await controller.agentDesktop("stop", replacement);
			expect(nativeCloses).toBe(2);
		} finally {
			await controller.close();
		}
	});
});
