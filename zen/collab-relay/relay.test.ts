import { afterEach, expect, test } from "bun:test";
import { connect, type Socket } from "node:net";
import { hostAllowList, normalizeIP, parseCLI, type RelayOptions } from "./config";
import { QUEUE_ENTRY_OVERHEAD, SendQueue } from "./queue";
import { type Relay, startRelay } from "./relay";

const ROOM = "Room_0123456789";
const relays: Relay[] = [];
const clients: RawPeer[] = [];
// These integration tests use real time: uWS socket-level idle and kernel
// backpressure cannot be driven by JavaScript fake timers.
interface Frame {
	opcode: number;
	data: Buffer;
}

/** Raw RFC6455 client: controls pongs, partial uploads and TCP receive backpressure. */
class RawPeer {
	socket: Socket;
	ready = Promise.withResolvers<number>();
	closed = Promise.withResolvers<void>();
	pongReceived = Promise.withResolvers<Buffer>();
	frames: Frame[] = [];
	waiters: Array<{ resolve: (frame: Frame) => void; reject: (error: Error) => void }> = [];
	header = Buffer.alloc(0);
	handshake = false;
	current?: Frame;
	offset = 0;
	status = 0;
	autoPong = true;

	constructor(port: number, path: string, xff = "") {
		this.socket = connect(port, "127.0.0.1");
		this.socket.on("connect", () =>
			this.socket.write(
				`GET ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n${xff ? `X-Forwarded-For: ${xff}\r\n` : ""}\r\n`,
			),
		);
		this.socket.on("error", error => this.ready.reject(error));
		this.socket.on("close", () => {
			this.closed.resolve();
			for (const waiter of this.waiters.splice(0)) waiter.reject(new Error("TCP closed before frame"));
		});
		this.socket.on("data", chunk => this.receive(typeof chunk === "string" ? Buffer.from(chunk) : chunk));
		clients.push(this);
	}

	receive(chunk: Buffer): void {
		if (!this.handshake) {
			this.header = Buffer.concat([this.header, chunk]);
			const end = this.header.indexOf("\r\n\r\n");
			if (end < 0) return;
			this.status = Number(this.header.toString().split(" ")[1]);
			this.handshake = true;
			chunk = this.header.subarray(end + 4);
			this.header = Buffer.alloc(0);
			this.ready.resolve(this.status);
			if (this.status !== 101) return;
		}
		while (chunk.length) {
			if (!this.current) {
				// Read only the small frame header before allocating the payload once.
				this.header = Buffer.concat([this.header, chunk.subarray(0, 1)]);
				chunk = chunk.subarray(1);
				if (this.header.length < 2) continue;
				const marker = this.header[1]! & 127;
				const size = marker === 127 ? 10 : marker === 126 ? 4 : 2;
				if (this.header.length < size) continue;
				const length =
					marker === 127
						? Number(this.header.readBigUInt64BE(2))
						: marker === 126
							? this.header.readUInt16BE(2)
							: marker;
				this.current = { opcode: this.header[0]! & 15, data: Buffer.alloc(length) };
				this.header = Buffer.alloc(0);
				this.offset = 0;
			}
			const frame = this.current;
			const count = Math.min(chunk.length, frame.data.length - this.offset);
			chunk.copy(frame.data, this.offset, 0, count);
			this.offset += count;
			chunk = chunk.subarray(count);
			if (this.offset !== frame.data.length) continue;
			this.current = undefined;
			if (frame.opcode === 9) {
				if (this.autoPong) this.send(10, frame.data);
				continue;
			}
			if (frame.opcode === 10) {
				this.pongReceived.resolve(frame.data);
				continue;
			}
			const waiter = this.waiters.shift();
			if (waiter) waiter.resolve(frame);
			else this.frames.push(frame);
			if (frame.opcode === 8) this.socket.end(this.encode(8, frame.data));
		}
	}

	encode(opcode: number, payload: Buffer): Buffer {
		const size = payload.length < 126 ? 2 : payload.length <= 65535 ? 4 : 10;
		const out = Buffer.alloc(size + 4 + payload.length);
		out[0] = 128 | opcode;
		out[1] = 128 | (size === 2 ? payload.length : size === 4 ? 126 : 127);
		if (size === 4) out.writeUInt16BE(payload.length, 2);
		if (size === 10) out.writeBigUInt64BE(BigInt(payload.length), 2);
		payload.copy(out, size + 4); // all-zero mask, still a masked client frame
		return out;
	}

	send(opcode: number, payload: Buffer): void {
		this.socket.write(this.encode(opcode, payload));
	}

	async next(timeout = 3_000): Promise<Frame> {
		const queued = this.frames.shift();
		if (queued) return queued;
		const { promise, resolve, reject } = Promise.withResolvers<Frame>();
		const waiter = { resolve, reject };
		this.waiters.push(waiter);
		const timer = setTimeout(() => {
			const index = this.waiters.indexOf(waiter);
			if (index !== -1) this.waiters.splice(index, 1);
			reject(new Error("frame timeout"));
		}, timeout);
		try {
			return await promise;
		} finally {
			clearTimeout(timer);
		}
	}
}

function relay(options: RelayOptions = {}): Relay {
	const result = startRelay({ log: () => {}, ...options, port: 0 });
	relays.push(result);
	return result;
}
async function dial(server: Relay, role: string, room = ROOM, xff = ""): Promise<RawPeer> {
	const client = new RawPeer(server.port, `/r/${room}?role=${role}`, xff);
	expect(await client.ready.promise).toBe(101);
	return client;
}
function envelope(peer: number, payload: string): Buffer {
	const data = Buffer.alloc(4 + Buffer.byteLength(payload));
	data.writeUInt32BE(peer);
	data.write(payload, 4);
	return data;
}
async function text(peer: RawPeer, expected: string, timeout?: number): Promise<void> {
	const frame = await peer.next(timeout);
	expect(frame.opcode).toBe(1);
	expect(frame.data.toString()).toBe(expected);
}
async function binary(peer: RawPeer, expected: Buffer): Promise<void> {
	const frame = await peer.next();
	expect(frame.opcode).toBe(2);
	expect(frame.data.equals(expected)).toBe(true);
}
async function closeCode(peer: RawPeer, code: number): Promise<void> {
	const frame = await peer.next();
	expect(frame.opcode).toBe(8);
	expect(frame.data.readUInt16BE()).toBe(code);
}
async function rejected(server: Relay, path: string, status: number, xff = ""): Promise<void> {
	const peer = new RawPeer(server.port, path, xff);
	expect(await peer.ready.promise).toBe(status);
}

afterEach(async () => {
	for (const peer of clients.splice(0)) peer.socket.destroy();
	await Promise.all(relays.splice(0).map(server => server.stop()));
});

test("routing: rewritten guests, broadcast, targeted and nonexistent destinations", async () => {
	const server = relay();
	const host = await dial(server, "host");
	const g1 = await dial(server, "guest");
	await text(host, '{"t":"peer-joined","peer":1}');
	const g2 = await dial(server, "guest");
	await text(host, '{"t":"peer-joined","peer":2}');
	g1.send(2, envelope(999, "from-g1"));
	await binary(host, envelope(1, "from-g1"));
	g2.send(2, envelope(0, "from-g2"));
	await binary(host, envelope(2, "from-g2"));
	host.send(2, envelope(0, "all"));
	await binary(g1, envelope(0, "all"));
	await binary(g2, envelope(0, "all"));
	host.send(2, envelope(2, "only-g2"));
	host.send(2, envelope(7, "nobody"));
	host.send(2, envelope(0, "again"));
	await binary(g2, envelope(2, "only-g2"));
	await binary(g2, envelope(0, "again"));
	await binary(g1, envelope(0, "again"));
});

test("HTTP rejections and health", async () => {
	const server = relay();
	for (const path of [
		"/r/short?role=host",
		"/r/Room.0123456789?role=host",
		"/r/Room%5F0123456789?role=host",
		`/r/${ROOM}`,
		`/r/${ROOM}?role=admin`,
		`/r/${ROOM}?role=guest&role=host`,
		`/r/${ROOM}/x?role=host`,
		`/x/${ROOM}?role=host`,
	])
		await rejected(server, path, 404);
	const base = server.url.replace("ws:", "http:");
	expect((await fetch(`${base}/r/${ROOM}?role=host`)).status).toBe(426);
	expect(await (await fetch(`${base}/healthz`)).text()).toBe("ok rooms=0\n");
	await dial(server, "host");
	expect(await (await fetch(`${base}/healthz`)).text()).toBe("ok rooms=1\n");
});

test("duplicate host and missing room do not destroy an existing room", async () => {
	const server = relay();
	await closeCode(await dial(server, "guest"), 4004);
	const host = await dial(server, "host");
	await closeCode(await dial(server, "host"), 4009);
	const guest = await dial(server, "guest");
	await text(host, '{"t":"peer-joined","peer":1}');
	guest.send(2, envelope(0, "still-alive"));
	await binary(host, envelope(1, "still-alive"));
});

test("host leave closes room; recreated room starts IDs at one", async () => {
	const server = relay();
	const host = await dial(server, "host");
	const guest = await dial(server, "guest");
	await text(host, '{"t":"peer-joined","peer":1}');
	await dial(server, "guest");
	await text(host, '{"t":"peer-joined","peer":2}');
	host.socket.destroy();
	await text(guest, '{"t":"room-closed"}');
	await closeCode(guest, 4001);
	const next = await dial(server, "host");
	await dial(server, "guest");
	await text(next, '{"t":"peer-joined","peer":1}');
});

test("guest departure notifies host", async () => {
	const server = relay();
	const host = await dial(server, "host");
	const guest = await dial(server, "guest");
	await text(host, '{"t":"peer-joined","peer":1}');
	guest.send(8, Buffer.from([3, 232]));
	await text(host, '{"t":"peer-left","peer":1}');
});

test("stale guest close cannot remove fresh guest in a recreated room", async () => {
	const server = relay();
	const host = await dial(server, "host");
	const old = await dial(server, "guest");
	await text(host, '{"t":"peer-joined","peer":1}');
	old.socket.pause();
	host.socket.destroy();
	// The HTTP health read is a barrier after the host close callback.
	while ((await (await fetch(`${server.url.replace("ws:", "http:")}/healthz`)).text()) !== "ok rooms=0\n")
		await Bun.sleep(1);
	const next = await dial(server, "host");
	const fresh = await dial(server, "guest");
	await text(next, '{"t":"peer-joined","peer":1}');
	old.socket.resume();
	await text(old, '{"t":"room-closed"}');
	await closeCode(old, 4001);
	old.socket.destroy();
	await Bun.sleep(20);
	fresh.send(2, envelope(0, "from-fresh"));
	await binary(next, envelope(1, "from-fresh"));
	next.send(2, envelope(1, "to-fresh"));
	await binary(fresh, envelope(1, "to-fresh"));
});

test("ignores text and headerless binary frames", async () => {
	const server = relay();
	const host = await dial(server, "host");
	const guest = await dial(server, "guest");
	await text(host, '{"t":"peer-joined","peer":1}');
	for (const peer of [host, guest]) {
		peer.send(1, Buffer.from("hello"));
		peer.send(2, Buffer.from([1, 2, 3]));
	}
	guest.send(2, envelope(0, "real"));
	await binary(host, envelope(1, "real"));
	host.send(2, envelope(0, "real"));
	await binary(guest, envelope(0, "real"));
});

test("CIDR restriction and last-hop XFF; guests unrestricted", async () => {
	const server = relay({ hostCIDRs: "100.64.0.0/10,fd7a:115c:a1e0::/48" });
	for (const xff of ["", "1.2.3.4", "100.64.0.1, 1.2.3.4", "invalid"])
		await rejected(server, `/r/${ROOM}?role=host`, 403, xff);
	const host = await dial(server, "host", ROOM, "1.2.3.4, 100.64.0.1");
	const guest = await dial(server, "guest", ROOM, "1.2.3.4");
	await text(host, '{"t":"peer-joined","peer":1}');
	guest.send(2, envelope(0, "ok"));
	await binary(host, envelope(1, "ok"));
	await dial(server, "host", "IPv6_0123456789", "fd7a:115c:a1e0::12");
	const untrusted = relay({ hostCIDRs: "100.64.0.0/10", trustXff: false });
	await rejected(untrusted, `/r/${ROOM}?role=host`, 403, "100.64.0.1");
	expect(normalizeIP("::ffff:127.0.0.1")).toBe("127.0.0.1");
	expect(() => hostAllowList("not-cidr")).toThrow();
});

test("capacity: guests 4029, per-IP 429, rooms 503", async () => {
	const server = relay({ maxGuestsPerRoom: 1, maxRooms: 1, maxConnsPerIP: 1 });
	const host = await dial(server, "host", ROOM, "100.64.0.1");
	await dial(server, "guest", ROOM, "1.2.3.4");
	await text(host, '{"t":"peer-joined","peer":1}');
	await closeCode(await dial(server, "guest", ROOM, "1.2.3.5"), 4029);
	await rejected(server, `/r/${ROOM}?role=guest`, 429, "1.2.3.4");
	await rejected(server, "/r/Other_0123456789?role=host", 503, "2.3.4.5");
});

test("heartbeat drops a silent peer but keeps a reading host", async () => {
	const events: Array<{ level: string; message: string; fields: Record<string, unknown> }> = [];
	const server = relay({
		idleTimeout: 4,
		log: (level, message, fields) => {
			events.push({ level, message, fields });
		},
	});
	const host = await dial(server, "host");
	const guest = await dial(server, "guest");
	guest.autoPong = false;
	await text(host, '{"t":"peer-joined","peer":1}');
	await text(host, '{"t":"peer-left","peer":1}', 10_000);
	expect(events.find(event => event.message === "心跳超时，断开")).toEqual({
		level: "INFO",
		message: "心跳超时，断开",
		fields: { role: "guest", peer: 1, ip: "127.0.0.1" },
	});
}, 12_000);

test("heartbeat keeps a host trickling a single large frame with no pongs", async () => {
	const server = relay({ idleTimeout: 4 });
	const host = await dial(server, "host");
	host.autoPong = false;
	const guest = await dial(server, "guest");
	await text(host, '{"t":"peer-joined","peer":1}');
	const big = envelope(0, "z".repeat(400 << 10));
	const encoded = host.encode(2, big);
	for (let offset = 0; offset < encoded.length; offset += 4096) {
		expect(host.socket.destroyed).toBe(false);
		host.socket.write(encoded.subarray(offset, offset + 4096));
		await Bun.sleep(60);
	}
	await binary(guest, big);
	for (let i = 0; i < 10; i++) {
		const data = envelope(0, String(i));
		host.send(2, data);
		await binary(guest, data);
		await Bun.sleep(80);
	}
	await text(guest, '{"t":"room-closed"}', 10_000);
}, 20_000);

test("16MiB slow outbound transfer keeps a peer that is still sending data", async () => {
	const server = relay({ idleTimeout: 4, writeTimeout: 15_000 });
	const host = await dial(server, "host");
	const guest = await dial(server, "guest");
	guest.autoPong = false;
	await text(host, '{"t":"peer-joined","peer":1}');
	guest.socket.pause();
	const big = Buffer.alloc(16 << 20, 121);
	big.writeUInt32BE(0);
	host.send(2, big);
	const started = Date.now();
	while (Date.now() - started < 5_000) {
		guest.send(2, envelope(900, "active"));
		await binary(host, envelope(1, "active"));
		await Bun.sleep(100);
	}
	guest.socket.resume();
	await binary(guest, big);
	guest.send(2, envelope(0, "after-transfer"));
	await binary(host, envelope(1, "after-transfer"));
}, 15_000);

test("slow large write accepts client ping during delivery", async () => {
	const server = relay({ idleTimeout: 4 });
	const host = await dial(server, "host");
	const guest = await dial(server, "guest");
	await text(host, '{"t":"peer-joined","peer":1}');
	const big = envelope(0, "y".repeat(10 << 20));
	guest.socket.pause();
	host.send(2, big);
	for (let i = 0; i < 5; i++) {
		guest.send(9, Buffer.from("client-ping"));
		await Bun.sleep(200);
	}
	guest.socket.resume();
	await binary(guest, big);
	expect((await guest.pongReceived.promise).toString()).toBe("client-ping");
}, 10_000);

test("send queue bounds tiny frames and retained backing capacity", () => {
	const limit = 64 << 10;
	const queue = new SendQueue();
	let accepted = 0;
	while (queue.push(Buffer.alloc(4), limit)) accepted++;
	expect(accepted).toBeLessThanOrEqual(limit / QUEUE_ENTRY_OVERHEAD);
	const capacity = new SendQueue();
	expect(capacity.push(Buffer.alloc(limit).subarray(0, 4), limit)).toBe(false);
	queue.sealed = true;
	expect(queue.push(Buffer.alloc(4), limit)).toBe(true);
	queue.clear();
	expect(queue.shift()).toBeUndefined();
});

test("send queue compacts consumed slots during sustained backlog", () => {
	const queue = new SendQueue();
	const limit = 64 << 10;
	queue.push("0", limit);
	queue.push("1", limit);
	let maxStorage = queue.items.length;
	for (let i = 2; i < 10_002; i++) {
		expect(queue.shift()).toBe(String(i - 2));
		expect(queue.push(String(i), limit)).toBe(true);
		maxStorage = Math.max(maxStorage, queue.items.length);
	}
	expect(maxStorage).toBeLessThanOrEqual(1026);
	expect(queue.shift()).toBe("10000");
	expect(queue.shift()).toBe("10001");
	expect(queue.items.length).toBe(0);
	expect(queue.bytes).toBe(0);
});

test("shutdown races admissions without leaving upgraded peers behind", async () => {
	const server = relay();
	await dial(server, "host");
	const pending = Array.from({ length: 40 }, (_, i) => {
		const client = new RawPeer(server.port, `/r/${ROOM}?role=guest`, `10.0.0.${i}`);
		return client.ready.promise;
	});
	await server.shutdown();
	const statuses = await Promise.all(pending);
	expect(statuses.every(status => status === 101 || status === 503)).toBe(true);
	await rejected(server, `/r/${ROOM}?role=host`, 503);
});

test("slow reader is disconnected when bounded send queue overflows", async () => {
	const server = relay({ maxQueueBytes: 256 << 10 });
	const host = await dial(server, "host");
	const guest = await dial(server, "guest");
	await text(host, '{"t":"peer-joined","peer":1}');
	guest.socket.pause();
	const chunk = envelope(0, "x".repeat(64 << 10));
	for (let i = 0; i < 200; i++) host.send(2, chunk);
	await text(host, '{"t":"peer-left","peer":1}');
});

test("shutdown sends ordered room closure, host1001 and rejects new conns503", async () => {
	const server = relay();
	const host = await dial(server, "host");
	const guest = await dial(server, "guest");
	await text(host, '{"t":"peer-joined","peer":1}');
	const shutdown = server.shutdown();
	await text(guest, '{"t":"room-closed"}');
	await closeCode(guest, 4001);
	await closeCode(host, 1001);
	await shutdown;
	await rejected(server, `/r/${ROOM}?role=host`, 503);
});

test("flags override environment and version bypasses version env", () => {
	const cfg = parseCLI(["--listen", "127.0.0.1:0", "-max-rooms=3", "--trust-xff=false", "--version"], {
		COLLAB_RELAY_LISTEN: "127.0.0.1:7467",
		COLLAB_RELAY_MAX_ROOMS: "8",
		COLLAB_RELAY_VERSION: "false",
	});
	expect(cfg.listen).toBe("127.0.0.1:0");
	expect(cfg.maxRooms).toBe(3);
	expect(cfg.trustXff).toBe(false);
	expect(cfg.version).toBe(true);
	expect(() => parseCLI([], { COLLAB_RELAY_MAX_ROOMS: "no" })).toThrow();
	expect(() => parseCLI(["--unknown"], {})).toThrow();
});
