import { parseCLI } from "./config";
import { startRelay } from "./relay";

declare const COLLAB_RELAY_VERSION: string;
const version = typeof COLLAB_RELAY_VERSION === "undefined" ? "dev" : COLLAB_RELAY_VERSION;

if (import.meta.main) {
	try {
		const cfg = parseCLI(Bun.argv.slice(2));
		if (cfg.version) {
			console.log(version);
		} else {
			const match = /^(?:\[([^\]]+)\]|([^:]*)):(\d+)$/.exec(cfg.listen);
			if (!match || Number(match[3]) > 65535) throw new Error(`invalid listen address: ${cfg.listen}`);
			const relay = startRelay({ ...cfg, hostname: match[1] ?? (match[2] || "0.0.0.0"), port: Number(match[3]) });
			console.log(
				JSON.stringify({
					time: new Date().toISOString(),
					level: "INFO",
					msg: "collab-relay 启动",
					version,
					addr: relay.url.slice(5),
					host_cidrs: cfg.hostCIDRs,
				}),
			);
			let stopping = false;
			const shutdown = (signal: string): void => {
				if (stopping) return;
				stopping = true;
				console.log(
					JSON.stringify({
						time: new Date().toISOString(),
						level: "INFO",
						msg: "收到退出信号，关闭所有房间",
						signal,
					}),
				);
				void relay.stop();
			};
			process.once("SIGINT", () => shutdown("interrupt"));
			process.once("SIGTERM", () => shutdown("terminated"));
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 2;
	}
}
