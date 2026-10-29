import { spawn, execFile, execFileSync, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Application, DesktopWindow, SessionBusBridge } from "@oh-my-pi/pi-natives";
import { startSessionBusBridge } from "@oh-my-pi/pi-natives/desktop";
import { logger } from "@oh-my-pi/pi-utils";
import watchdogSource from "./agent-desktop-watchdog.py" with { type: "text" };

const exec = promisify(execFile);
const commandOptions = { timeout: 5000, maxBuffer: 16 * 1024 * 1024 };

/** Host session-bus names intentionally visible inside the nested desktop. */
export const agentDesktopForwardedBusNames = [
	"org.freedesktop.secrets",
	"org.kde.kwalletd6",
	"org.kde.kwalletd5",
	"org.kde.kwalletd",
	"org.freedesktop.Notifications",
] as const;
let sequence = crypto.getRandomValues(new Uint32Array(1))[0]!;

export type AgentDesktopState = "stopped" | "hidden" | "visible";
export interface AgentDesktopAddress {
	kwinBusAddress: string;
	waylandDisplay: string;
}
export interface AgentDesktopProcess {
	pid: number;
	startTime: string;
	groupId: number;
	group?: boolean;
}
export interface AgentDesktopResources {
	processes: AgentDesktopProcess[];
	watchdog?: AgentDesktopProcess;
	socket?: string;
	directory?: string;
	busAddress?: string;
	scriptName?: string;
}
export type AgentDesktopFactory = (
	changed: (resources: AgentDesktopResources) => void,
	closed: () => void,
) => AgentDesktop;

/** No system service directories: wallets must only be reachable through the bridge. */
export async function prepareAgentDesktopBus(directory: string): Promise<string> {
	const services = path.join(directory, "dbus-services");
	await fs.mkdir(services);
	const configuration = path.join(directory, "dbus.conf");
	await fs.writeFile(
		configuration,
		`<busconfig>
  <type>session</type>
  <listen>unix:tmpdir=${directory.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</listen>
  <auth>EXTERNAL</auth>
  <servicedir>${services.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</servicedir>
  <policy context="default">
    <allow own="*"/>
    <allow send_destination="*"/>
    <allow receive_sender="*"/>
  </policy>
</busconfig>`,
	);
	return configuration;
}

/** Redirect audio clients without sharing the host's display, bus or accessibility runtime. */
export function agentDesktopAudioEnvironment(host: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const runtime = host.XDG_RUNTIME_DIR;
	if (!runtime) return {};
	const socket = (value: string): boolean => {
		try {
			return statSync(value, { throwIfNoEntry: false })?.isSocket() ?? false;
		} catch {
			return false;
		}
	};
	const audio: NodeJS.ProcessEnv = {};
	if (!host.PULSE_SERVER && socket(path.join(runtime, "pulse/native")))
		audio.PULSE_SERVER = `unix:${path.join(runtime, "pulse/native")}`;
	const remote = host.PIPEWIRE_REMOTE ?? "pipewire-0";
	const pipewireRuntime = host.PIPEWIRE_RUNTIME_DIR ?? runtime;
	if (socket(path.isAbsolute(remote) ? remote : path.join(pipewireRuntime, remote)))
		audio.PIPEWIRE_RUNTIME_DIR = pipewireRuntime;
	return audio;
}

/** Linux starttime survives exec and distinguishes a reused PID from the process we own. */
export function agentDesktopProcess(pid: number): AgentDesktopProcess | undefined {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		if (fields[0] === "Z") return undefined;
		return { pid, startTime: fields[19]!, groupId: Number(fields[2]) };
	} catch (error) {
		if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return undefined;
		throw error;
	}
}

export function publishAgentDesktopResources(resources: AgentDesktopResources): void {
	if (!resources.directory || !resources.watchdog) return;
	const destination = path.join(resources.directory, "resources.json");
	writeFileSync(`${destination}.tmp`, JSON.stringify(resources));
	renameSync(`${destination}.tmp`, destination);
}

/** The watchdog creates and owns the runtime before any detached desktop process can start. */
export async function startAgentDesktopWatchdog(
	runtimeDirectory: string,
): Promise<{ child: ChildProcess; resources: AgentDesktopResources }> {
	const python = Bun.which("python3", { PATH: process.env.PATH });
	if (!python) throw new Error("Agent desktop requires python3 for its independent cleanup watchdog");
	const owner = agentDesktopProcess(process.pid)!;
	const child = spawn(python, ["-u", "-c", watchdogSource, String(owner.pid), owner.startTime, runtimeDirectory], {
		detached: true,
		stdio: ["pipe", "pipe", "ignore"],
	});
	const identity = child.pid === undefined ? undefined : agentDesktopProcess(child.pid);
	const ready = Promise.withResolvers<string>();
	let text = "";
	const timer = setTimeout(() => ready.reject(new Error("Timed out starting agent desktop cleanup watchdog")), 5000);
	child.once("error", ready.reject);
	child.once("exit", code => ready.reject(new Error(`Agent desktop cleanup watchdog exited ${code}`)));
	child.stdout!.on("data", chunk => {
		text += chunk;
		if (text.includes("\n")) ready.resolve(text.split("\n")[0]!);
	});
	try {
		const { directory } = JSON.parse(await ready.promise) as { directory: string };
		if (!identity) throw new Error("Agent desktop cleanup watchdog exited before readiness");
		return { child, resources: { processes: [], directory, watchdog: identity } };
	} catch (error) {
		child.stdin?.destroy();
		if (identity && agentDesktopProcess(identity.pid)?.startTime === identity.startTime)
			process.kill(identity.pid, "SIGTERM");
		throw error;
	} finally {
		clearTimeout(timer);
	}
}

export function supportsAgentDesktop(): boolean {
	return (
		process.platform === "linux" &&
		process.arch === "x64" &&
		(process.env.XDG_CURRENT_DESKTOP ?? "").split(":").some(part => part.toUpperCase().includes("KDE")) &&
		(process.env.XDG_SESSION_TYPE === "wayland" || !!process.env.WAYLAND_DISPLAY) &&
		!!Bun.which("kwin_wayland")
	);
}

/** Kill whole child groups, including D-Bus-activated applications, after worker failure. */
export function killAgentDesktopResources(resources: AgentDesktopResources, signal: NodeJS.Signals): void {
	const groups = new Set(
		resources.processes
			.filter(owned => owned.group && agentDesktopProcess(owned.pid)?.startTime === owned.startTime)
			.map(owned => owned.pid),
	);
	// Keep identities for descendants too: the group leader can exit during the TERM grace period.
	if (groups.size) {
		const known = new Set(resources.processes.map(owned => `${owned.pid}:${owned.startTime}`));
		for (const entry of readdirSync("/proc")) {
			if (!/^\d+$/.test(entry)) continue;
			const member = agentDesktopProcess(Number(entry));
			if (member && groups.has(member.groupId) && !known.has(`${member.pid}:${member.startTime}`))
				resources.processes.push(member);
		}
	}
	for (const owned of resources.processes) {
		if (agentDesktopProcess(owned.pid)?.startTime !== owned.startTime) continue;
		try {
			process.kill(owned.group ? -owned.pid : owned.pid, signal);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
		}
	}
}

/** Normal close and worker-crash cleanup ask the same independent owner to perform teardown. */
export async function stopAgentDesktopResources(resources: AgentDesktopResources): Promise<void> {
	const watchdog = resources.watchdog;
	if (watchdog && agentDesktopProcess(watchdog.pid)?.startTime === watchdog.startTime) {
		try {
			process.kill(watchdog.pid, "SIGTERM");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
		}
		const deadline = Date.now() + 5000;
		while (agentDesktopProcess(watchdog.pid)?.startTime === watchdog.startTime) {
			if (Date.now() > deadline) throw new Error("Agent desktop cleanup watchdog did not finish");
			await delay(20);
		}
		if (resources.directory && existsSync(resources.directory))
			throw new Error("Agent desktop watchdog left its private runtime behind");
		return;
	}
	killAgentDesktopResources(resources, "SIGTERM");
	if (resources.processes.length) await delay(550);
	killAgentDesktopResources(resources, "SIGKILL");
	removeAgentDesktopRuntime(resources);
}

/** Portals can mount document FUSE filesystems here: never recursively delete through one. */
export function removeAgentDesktopRuntime(resources: AgentDesktopResources): void {
	if (resources.directory && process.platform === "linux") {
		const prefix = `${resources.directory}/`;
		const mounts = readFileSync("/proc/self/mountinfo", "utf8")
			.split("\n")
			.map(line =>
				(line.split(" ")[4] ?? "").replace(/\\([0-7]{3})/g, (_, octal: string) =>
					String.fromCharCode(Number.parseInt(octal, 8)),
				),
			)
			.filter(mount => mount === resources.directory || mount.startsWith(prefix))
			.sort((left, right) => right.length - left.length);
		for (const mount of mounts) {
			const unmount = Bun.which("fusermount3") ?? Bun.which("fusermount");
			if (!unmount)
				throw new Error(
					`Cannot remove agent desktop runtime: ${mount} is still mounted and fusermount is unavailable`,
				);
			execFileSync(unmount, ["-u", "-z", mount], { timeout: 1000, stdio: "ignore" });
		}
	}
	if (resources.socket) {
		rmSync(resources.socket, { force: true });
		rmSync(`${resources.socket}.lock`, { force: true });
	}
	if (resources.directory) rmSync(resources.directory, { recursive: true, force: true });
}

/** One nested compositor, owned by the computer worker; the supervisor tracks its resources too. */
export class AgentDesktop {
	#bus?: ChildProcess;
	#kwin?: ChildProcess;
	#registry?: ChildProcess;
	#accessibilityBus?: ChildProcess;
	#busBridge?: SessionBusBridge;
	#atSpiAddress?: string;
	#address?: AgentDesktopAddress;
	#directory?: string;
	#scriptFile?: string;
	#starting?: Promise<AgentDesktopAddress>;
	#state: AgentDesktopState = "stopped";
	#stopping?: Promise<void>;
	#apps = new Set<ChildProcess>();
	#processes = new Map<number, AgentDesktopProcess>();
	#cleaning = false;
	#watchdogIdentity?: AgentDesktopProcess;
	#watchdogChannel?: ChildProcess["stdin"];
	constructor(
		readonly resourcesChanged: (resources: AgentDesktopResources) => void,
		readonly closed: () => void,
	) {}
	get state(): AgentDesktopState {
		return this.#state;
	}
	get address(): AgentDesktopAddress | undefined {
		return this.#address;
	}
	rememberWindows(windows: readonly DesktopWindow[]): void {
		let changed = false;
		for (const window of windows) {
			if (!window.pid || window.pid <= 0) continue;
			const identity = agentDesktopProcess(window.pid);
			if (identity && this.#processes.get(identity.pid)?.startTime !== identity.startTime) {
				this.#processes.set(identity.pid, identity);
				changed = true;
			}
		}
		if (changed) this.#resources();
	}
	#track(child: ChildProcess): void {
		if (child.pid) {
			const identity = agentDesktopProcess(child.pid);
			if (identity) this.#processes.set(child.pid, { ...identity, group: true });
		}
		this.#resources();
	}
	#resources(): AgentDesktopResources {
		const resources = {
			processes: [...this.#processes.values()],
			watchdog: this.#watchdogIdentity,
			socket: this.#address?.waylandDisplay,
			directory: this.#directory,
			busAddress: this.#address?.kwinBusAddress,
			scriptName: this.#scriptFile,
		};
		if (!this.#cleaning) publishAgentDesktopResources(resources);
		this.resourcesChanged(resources);
		return resources;
	}
	async #hostScript(source: string, persistent = false): Promise<void> {
		const file = path.join(this.#directory!, `host-${++sequence}.js`);
		const plugin = `${path.basename(this.#directory!)}-${path.basename(file)}`;
		await fs.writeFile(file, source);
		const { stdout } = await exec(
			"qdbus6",
			["org.kde.KWin", "/Scripting", "org.kde.kwin.Scripting.loadScript", file, plugin],
			commandOptions,
		);
		const id = Number(stdout.trim());
		if (!Number.isInteger(id) || id < 0) throw new Error(`Cannot load agent desktop KWin script: ${stdout}`);
		try {
			await exec("qdbus6", ["org.kde.KWin", `/Scripting/Script${id}`, "org.kde.kwin.Script.run"], commandOptions);
		} catch (error) {
			await exec(
				"qdbus6",
				["org.kde.KWin", "/Scripting", "org.kde.kwin.Scripting.unloadScript", plugin],
				commandOptions,
			).catch(() => {});
			throw error;
		}
		if (persistent) {
			this.#scriptFile = plugin;
			this.#resources();
		} else
			await exec(
				"qdbus6",
				["org.kde.KWin", "/Scripting", "org.kde.kwin.Scripting.unloadScript", plugin],
				commandOptions,
			);
	}
	async start(): Promise<AgentDesktopAddress> {
		if (this.#stopping) await this.#stopping;
		if (this.#address && this.#state !== "stopped") return this.#address;
		if (this.#starting) return this.#starting;
		if (!supportsAgentDesktop())
			throw new Error("Agent desktop requires KDE Plasma Wayland on linux-x64 and kwin_wayland in PATH");
		this.#starting = this.#start();
		try {
			return await this.#starting;
		} finally {
			this.#starting = undefined;
		}
	}
	async #start(): Promise<AgentDesktopAddress> {
		try {
			if (!process.env.XDG_RUNTIME_DIR) throw new Error("Agent desktop requires XDG_RUNTIME_DIR");
			for (const binary of ["dbus-daemon", "gdbus", "qdbus6", "wl-copy", "wl-paste"]) {
				if (!Bun.which(binary)) throw new Error(`Agent desktop requires ${binary} in PATH`);
			}
			const watchdog = await startAgentDesktopWatchdog(process.env.XDG_RUNTIME_DIR);
			this.#watchdogIdentity = watchdog.resources.watchdog;
			this.#watchdogChannel = watchdog.child.stdin;
			this.#directory = watchdog.resources.directory!;
			this.#resources();
			const busEnv: NodeJS.ProcessEnv = { ...process.env, XDG_RUNTIME_DIR: this.#directory };
			delete busEnv.DISPLAY;
			delete busEnv.AT_SPI_BUS_ADDRESS;
			delete busEnv.DBUS_SESSION_BUS_ADDRESS;
			const configuration = await prepareAgentDesktopBus(this.#directory);
			this.#bus = spawn("dbus-daemon", [`--config-file=${configuration}`, "--nofork", "--print-address=1"], {
				env: busEnv,
				detached: true,
				stdio: ["ignore", "pipe", "ignore"],
			});
			this.#track(this.#bus);
			const bus = this.#bus;
			const addressReady = Promise.withResolvers<string>();
			let text = "";
			const timer = setTimeout(() => addressReady.reject(new Error("Timed out starting agent desktop D-Bus")), 5000);
			bus.once("error", addressReady.reject);
			bus.once("exit", () => addressReady.reject(new Error("Agent desktop D-Bus exited during startup")));
			bus.stdout!.on("data", chunk => {
				text += chunk;
				if (text.includes("\n")) addressReady.resolve(text.split("\n")[0]!);
			});
			let kwinBusAddress: string;
			try {
				kwinBusAddress = await addressReady.promise;
			} finally {
				clearTimeout(timer);
			}
			try {
				this.#busBridge = startSessionBusBridge(kwinBusAddress, agentDesktopForwardedBusNames);
			} catch (error) {
				logger.warn("Agent desktop session D-Bus bridge is unavailable", { error: String(error) });
			}
			const socketName = `omp-agent-${process.pid}-${++sequence}`;
			const waylandDisplay = path.join(this.#directory, socketName);
			this.#address = { kwinBusAddress, waylandDisplay };
			this.#resources();
			const hostDisplay = process.env.WAYLAND_DISPLAY ?? "wayland-0";
			const env: NodeJS.ProcessEnv = {
				...process.env,
				DBUS_SESSION_BUS_ADDRESS: kwinBusAddress,
				XDG_SESSION_TYPE: "wayland",
				XDG_RUNTIME_DIR: this.#directory,
				WAYLAND_DISPLAY: path.isAbsolute(hostDisplay)
					? hostDisplay
					: path.join(process.env.XDG_RUNTIME_DIR, hostDisplay),
			};
			delete env.DISPLAY;
			delete env.XDG_ACTIVATION_TOKEN;
			delete env.DESKTOP_STARTUP_ID;
			delete env.AT_SPI_BUS_ADDRESS;
			let accessibilityLauncher = Bun.which("at-spi-bus-launcher");
			for (const candidate of ["/usr/lib/at-spi-bus-launcher", "/usr/libexec/at-spi-bus-launcher"]) {
				if (!accessibilityLauncher && existsSync(candidate)) accessibilityLauncher = candidate;
			}
			if (!accessibilityLauncher) throw new Error("Agent desktop requires at-spi-bus-launcher");
			this.#accessibilityBus = spawn(accessibilityLauncher, [], { env, detached: true, stdio: "ignore" });
			this.#track(this.#accessibilityBus);
			const accessibilityReady = Date.now() + 5000;
			while (
				!(
					await exec(
						"gdbus",
						[
							"call",
							"--address",
							kwinBusAddress,
							"--dest",
							"org.freedesktop.DBus",
							"--object-path",
							"/org/freedesktop/DBus",
							"--method",
							"org.freedesktop.DBus.NameHasOwner",
							"org.a11y.Bus",
						],
						commandOptions,
					)
				).stdout.includes("true")
			) {
				if (this.#accessibilityBus.exitCode !== null || Date.now() > accessibilityReady)
					throw new Error("Private accessibility bus launcher failed to start");
				await delay(20);
			}
			await exec(
				"gdbus",
				[
					"call",
					"--address",
					kwinBusAddress,
					"--dest",
					"org.a11y.Bus",
					"--object-path",
					"/org/a11y/bus",
					"--method",
					"org.freedesktop.DBus.Properties.Set",
					"org.a11y.Status",
					"IsEnabled",
					"<true>",
				],
				{ env, timeout: 5000 },
			);
			const accessibility = await exec(
				"gdbus",
				[
					"call",
					"--address",
					kwinBusAddress,
					"--dest",
					"org.a11y.Bus",
					"--object-path",
					"/org/a11y/bus",
					"--method",
					"org.a11y.Bus.GetAddress",
				],
				{ env, timeout: 5000 },
			);
			this.#atSpiAddress = accessibility.stdout.match(/\('([^']+)',\)/)?.[1];
			if (!this.#atSpiAddress) throw new Error("Private accessibility bus returned no address");
			await exec(
				"gdbus",
				[
					"call",
					"--address",
					kwinBusAddress,
					"--dest",
					"org.freedesktop.DBus",
					"--object-path",
					"/org/freedesktop/DBus",
					"--method",
					"org.freedesktop.DBus.UpdateActivationEnvironment",
					JSON.stringify({
						WAYLAND_DISPLAY: waylandDisplay,
						DISPLAY: "",
						QT_QPA_PLATFORM: "wayland",
						GDK_BACKEND: "wayland",
						XDG_SESSION_TYPE: "wayland",
						AT_SPI_BUS_ADDRESS: this.#atSpiAddress,
					}),
				],
				{ env, timeout: 5000 },
			);
			const registryOwner = [
				"call",
				"--address",
				this.#atSpiAddress,
				"--dest",
				"org.freedesktop.DBus",
				"--object-path",
				"/org/freedesktop/DBus",
				"--method",
				"org.freedesktop.DBus.NameHasOwner",
				"org.a11y.atspi.Registry",
			];
			if (!(await exec("gdbus", registryOwner, commandOptions)).stdout.includes("true")) {
				let registry = Bun.which("at-spi2-registryd");
				for (const candidate of ["/usr/lib/at-spi2-registryd", "/usr/libexec/at-spi2-registryd"]) {
					if (
						!registry &&
						(await fs.stat(candidate).then(
							info => info.isFile(),
							() => false,
						))
					)
						registry = candidate;
				}
				if (!registry)
					throw new Error("Agent desktop requires at-spi2-registryd for its private accessibility bus");
				this.#registry = spawn(registry, [], { env: this.environment(), detached: true, stdio: "ignore" });
				this.#track(this.#registry);
				const launched = Promise.withResolvers<void>();
				this.#registry.once("spawn", launched.resolve);
				this.#registry.once("error", launched.reject);
				await launched.promise;
				const deadline = Date.now() + 5000;
				while (!(await exec("gdbus", registryOwner, commandOptions)).stdout.includes("true")) {
					if (this.#registry.exitCode !== null || Date.now() > deadline)
						throw new Error("Private accessibility registry failed to start");
					await delay(30);
				}
			}
			// The shell cannot exec KWin until its PID-specific host listener is installed.
			this.#kwin = spawn(
				"/bin/sh",
				[
					"-c",
					'read -r ready; exec kwin_wayland "$@"',
					"omp-agent",
					"--socket",
					socketName,
					"--width",
					"1600",
					"--height",
					"1000",
					"--no-lockscreen",
					"--no-global-shortcuts",
					"--no-kactivities",
					"--inputmethod",
					"/bin/true",
				],
				{ env, detached: true, stdio: ["pipe", "ignore", "ignore"] },
			);
			this.#track(this.#kwin);
			await this.#hostScript(
				`workspace.windowAdded.connect(function(w) { if (w.pid === ${this.#kwin.pid}) { w.minimized = true; w.demandsAttention = false; } });`,
				true,
			);
			this.#kwin.stdin!.end("ready\n");
			const socket = waylandDisplay;
			const deadline = Date.now() + 10000;
			while (true) {
				if (this.#kwin.exitCode !== null || this.#bus.exitCode !== null)
					throw new Error("Agent desktop compositor exited during startup");
				try {
					if ((await fs.stat(socket)).isSocket()) break;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
				if (Date.now() > deadline) throw new Error("Timed out waiting for agent desktop Wayland socket");
				await delay(50);
			}
			// The socket can precede the outer window; /desk must not claim visibility before it exists.
			let hostWindowReady = false;
			while (!hostWindowReady) {
				const matches = await exec(
					"qdbus6",
					["--literal", "org.kde.KWin", "/WindowsRunner", "org.kde.krunner1.Match", "Wayland"],
					commandOptions,
				);
				for (const match of matches.stdout.matchAll(/0_(\{[0-9a-f-]+\})/gi)) {
					const info = await exec("qdbus6", ["org.kde.KWin", "/KWin", "getWindowInfo", match[1]!], commandOptions);
					if (info.stdout.split("\n").includes(`pid: ${this.#kwin.pid}`)) {
						hostWindowReady = true;
						break;
					}
				}
				if (!hostWindowReady) {
					if (Date.now() > deadline) throw new Error("Timed out waiting for agent desktop host window");
					await delay(50);
				}
			}
			this.#state = "hidden";
			this.#kwin.once("exit", () => {
				this.#stopBusBridge();
				if (!this.#stopping) this.closed();
			});
			this.#bus.once("exit", () => {
				this.#stopBusBridge();
				if (!this.#stopping) this.closed();
			});
			return this.#address;
		} catch (error) {
			await this.#stop();
			throw error;
		}
	}
	async toggle(): Promise<AgentDesktopState> {
		await this.start();
		const show = this.#state !== "visible";
		await this.#hostScript(
			`for (const w of workspace.windowList()) { if (w.pid === ${this.#kwin!.pid}) { w.minimized = ${!show}; ${show ? "workspace.activeWindow = w;" : ""} } }`,
		);
		this.#state = show ? "visible" : "hidden";
		return this.#state;
	}
	environment(): NodeJS.ProcessEnv {
		if (!this.#address) throw new Error("Agent desktop is not running");
		const env: NodeJS.ProcessEnv = {
			...process.env,
			...agentDesktopAudioEnvironment(process.env),
			DBUS_SESSION_BUS_ADDRESS: this.#address.kwinBusAddress,
			WAYLAND_DISPLAY: this.#address.waylandDisplay,
			XDG_RUNTIME_DIR: this.#directory,
			XDG_SESSION_TYPE: "wayland",
			QT_QPA_PLATFORM: "wayland",
			GDK_BACKEND: "wayland",
			QT_LINUX_ACCESSIBILITY_ALWAYS_ON: "1",
		};
		delete env.DISPLAY;
		delete env.XDG_ACTIVATION_TOKEN;
		delete env.DESKTOP_STARTUP_ID;
		if (this.#atSpiAddress) env.AT_SPI_BUS_ADDRESS = this.#atSpiAddress;
		else delete env.AT_SPI_BUS_ADDRESS;
		return env;
	}
	async clipboardRead(): Promise<string> {
		try {
			const { stdout } = await exec("wl-paste", ["--no-newline"], {
				env: { ...this.environment(), LC_ALL: "C" },
				timeout: 5000,
				maxBuffer: 16 * 1024 * 1024,
			});
			return stdout;
		} catch (error) {
			const failure = error as { code?: string | number; stderr?: string; stdout?: string };
			if (failure.code === 1 && failure.stderr?.trim() === "Nothing is copied" && !failure.stdout) return "";
			throw error;
		}
	}
	async clipboardWrite(text: string): Promise<void> {
		const child = spawn("wl-copy", ["--foreground", "--type", "text/plain;charset=utf-8"], {
			env: this.environment(),
			detached: true,
			stdio: ["pipe", "ignore", "pipe"],
		});
		this.#apps.add(child);
		this.#track(child);
		const started = Promise.withResolvers<void>();
		child.once("error", started.reject);
		child.once("exit", code => {
			this.#apps.delete(child);
			this.#resources();
			if (code !== 0) started.reject(new Error(`Nested wl-copy exited ${code}`));
		});
		child.stdin!.end(text, () => started.resolve());
		await started.promise;
		// A round trip waits for the new owner to offer the exact text, without touching the host selection.
		const deadline = Date.now() + 5000;
		while ((await this.clipboardRead().catch(() => undefined)) !== text) {
			if (Date.now() >= deadline) throw new Error("Timed out setting agent desktop clipboard");
			await delay(20);
		}
	}
	async openApplication(application: Application, executable?: string): Promise<ChildProcess> {
		const child = spawn(executable ?? "gio", executable ? [] : ["launch", application.path], {
			env: this.environment(),
			detached: true,
			stdio: "ignore",
		});
		this.#apps.add(child);
		this.#track(child);
		const launched = Promise.withResolvers<void>();
		child.once("error", launched.reject);
		child.once("spawn", launched.resolve);
		// Keep the group leader in the ledger after exit: launched apps may outlive gio.
		await launched.promise;
		return child;
	}
	async stop(): Promise<void> {
		await this.#starting?.catch(() => {});
		if (this.#stopping) return this.#stopping;
		this.#stopping = this.#stop();
		try {
			await this.#stopping;
		} finally {
			this.#stopping = undefined;
		}
	}
	#stopBusBridge(): void {
		this.#busBridge?.stop();
		this.#busBridge = undefined;
	}
	async #stop(): Promise<void> {
		this.#stopBusBridge();
		const resources = this.#resources();
		this.#cleaning = true;
		await stopAgentDesktopResources(resources);
		this.#address = undefined;
		this.#kwin = undefined;
		this.#bus = undefined;
		this.#registry = undefined;
		this.#accessibilityBus = undefined;
		this.#atSpiAddress = undefined;
		this.#directory = undefined;
		this.#scriptFile = undefined;
		this.#apps.clear();
		this.#processes.clear();
		this.#watchdogIdentity = undefined;
		this.#cleaning = false;
		this.#watchdogChannel?.destroy();
		this.#watchdogChannel = undefined;
		this.#state = "stopped";
		this.#resources();
	}
}
