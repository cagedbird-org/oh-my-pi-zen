import { isIP, BlockList } from "node:net";

export interface RelayOptions {
	port?: number;
	hostname?: string;
	hostCIDRs?: string;
	trustXff?: boolean;
	maxRooms?: number;
	maxGuestsPerRoom?: number;
	maxConnsPerIP?: number;
	maxFrameBytes?: number;
	maxQueueBytes?: number;
	/** uWS idle interval in seconds; 4-second granularity. */
	idleTimeout?: number;
	writeTimeout?: number;
	log?: (level: string, message: string, fields: Record<string, unknown>) => void;
}

export function normalizeIP(ip: string): string {
	if (isIP(ip) === 4) return ip;
	if (isIP(ip) !== 6) return "";
	const canonical = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
	const mapped = /^::ffff:([a-f0-9]+):([a-f0-9]+)$/.exec(canonical);
	if (!mapped) return canonical;
	const hi = Number.parseInt(mapped[1]!, 16);
	const lo = Number.parseInt(mapped[2]!, 16);
	return `${hi >>> 8}.${hi & 255}.${lo >>> 8}.${lo & 255}`;
}

export function hostAllowList(cidrs: string): BlockList | undefined {
	const list = new BlockList();
	let count = 0;
	for (const part of cidrs.split(",")) {
		const cidr = part.trim();
		if (!cidr) continue;
		const [address, bits, extra] = cidr.split("/");
		const family = isIP(address ?? "");
		const prefix = Number(bits);
		if (
			!family ||
			bits === undefined ||
			!/^\d+$/.test(bits) ||
			extra !== undefined ||
			prefix > (family === 4 ? 32 : 128)
		) {
			throw new Error(`invalid CIDR: ${cidr}`);
		}
		list.addSubnet(address!, prefix, family === 4 ? "ipv4" : "ipv6");
		count++;
	}
	return count ? list : undefined;
}

export interface CLIConfig {
	listen: string;
	hostCIDRs: string;
	trustXff: boolean;
	maxRooms: number;
	maxGuestsPerRoom: number;
	maxConnsPerIP: number;
	version: boolean;
}

export function parseCLI(argv: readonly string[], env: Record<string, string | undefined> = process.env): CLIConfig {
	const values: Record<string, string> = {
		listen: "127.0.0.1:7466",
		"host-cidrs": "",
		"trust-xff": "true",
		"max-rooms": "64",
		"max-guests": "32",
		"max-conns-per-ip": "32",
		version: "false",
	};
	const set = (name: string, value: string): void => {
		if (!(name in values)) throw new Error(`unknown flag: ${name}`);
		if (["trust-xff", "version"].includes(name)) {
			if (!["1", "t", "T", "TRUE", "true", "True", "0", "f", "F", "FALSE", "false", "False"].includes(value))
				throw new Error(`invalid boolean: ${value}`);
		} else if (name.startsWith("max-") && !/^[+-]?\d+$/.test(value)) throw new Error(`invalid integer: ${value}`);
		values[name] = value;
	};
	for (const name of Object.keys(values)) {
		if (name === "version") continue;
		const value = env[`COLLAB_RELAY_${name.toUpperCase().replaceAll("-", "_")}`];
		if (value !== undefined) set(name, value);
	}
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === "--") break;
		if (!arg.startsWith("-")) break;
		const [name, ...parts] = arg.replace(/^--?/, "").split("=");
		const value = parts.length ? parts.join("=") : ["version", "trust-xff"].includes(name!) ? "true" : argv[++i];
		if (value === undefined) throw new Error(`missing value: ${name}`);
		set(name!, value);
	}
	const bool = (value: string | undefined): boolean => ["1", "t", "T", "TRUE", "true", "True"].includes(value ?? "");
	return {
		listen: values.listen!,
		hostCIDRs: values["host-cidrs"]!,
		trustXff: bool(values["trust-xff"]),
		maxRooms: Number(values["max-rooms"]),
		maxGuestsPerRoom: Number(values["max-guests"]),
		maxConnsPerIP: Number(values["max-conns-per-ip"]),
		version: bool(values.version),
	};
}
