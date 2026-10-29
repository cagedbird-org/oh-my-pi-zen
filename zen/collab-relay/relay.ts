import { ENVELOPE_HEADER_LENGTH } from "../../packages/wire/src/index";
import { hostAllowList, normalizeIP, type RelayOptions } from "./config";
import { QUEUE_ENTRY_OVERHEAD, type Outgoing, SendQueue } from "./queue";

export type { RelayOptions } from "./config";

type RelaySocket = Bun.ServerWebSocket<Peer>;
interface Room {
	id: string;
	host: RelaySocket;
	guests: Map<number, RelaySocket>;
	nextPeerID: number;
}
interface Peer {
	roomID: string;
	role: "host" | "guest";
	id: number;
	ip: string;
	room?: Room;
	queue: SendQueue;
	writeTimer?: Timer;
	closeAfterDrain?: { code: number; reason: string };
	released: boolean;
}
export interface Relay {
	url: string;
	port: number;
	/** Seal admission and close rooms, keeping HTTP available until stop(). */
	shutdown(timeout?: number): Promise<void>;
	stop(): Promise<void>;
}

export function startRelay(options: RelayOptions = {}): Relay {
	const cfg = {
		port: 0,
		hostname: "127.0.0.1",
		hostCIDRs: "",
		trustXff: true,
		maxRooms: 64,
		maxGuestsPerRoom: 32,
		maxConnsPerIP: 32,
		maxFrameBytes: 16 << 20,
		maxQueueBytes: 32 << 20,
		idleTimeout: 20,
		writeTimeout: 30_000,
		log: (level: string, message: string, fields: Record<string, unknown>): void => {
			console.log(JSON.stringify({ time: new Date().toISOString(), level, msg: message, ...fields }));
		},
		...options,
	};
	const allowed = hostAllowList(cfg.hostCIDRs);
	const rooms = new Map<string, Room>();
	const connsByIP = new Map<string, number>();
	const peers = new Set<RelaySocket>();
	let closing = false;
	let shutdownPromise: Promise<void> | undefined;
	let finishShutdown: (() => void) | undefined;

	function armWriteTimeout(ws: RelaySocket): void {
		if (ws.data.writeTimer || !ws.getBufferedAmount()) return;
		ws.data.writeTimer = setTimeout(() => ws.terminate(), cfg.writeTimeout);
	}
	function flush(ws: RelaySocket): void {
		const p = ws.data;
		while (!p.released && ws.getBufferedAmount() === 0) {
			const message = p.queue.shift();
			if (message === undefined) break;
			if (ws.send(message, false) === 0) {
				ws.terminate();
				return;
			}
		}
		if (ws.getBufferedAmount()) armWriteTimeout(ws);
		else if (p.closeAfterDrain) ws.close(p.closeAfterDrain.code, p.closeAfterDrain.reason);
	}
	function send(ws: RelaySocket, data: Outgoing): void {
		const p = ws.data;
		if (p.released || p.queue.sealed) return;
		// A single Bun send may be buffered; retain later messages in our bounded queue.
		const buffered = ws.getBufferedAmount();
		if (!p.queue.push(data, cfg.maxQueueBytes, buffered ? buffered + QUEUE_ENTRY_OVERHEAD : 0)) {
			p.queue.clear();
			cfg.log("WARN", "对端读取过慢，断开", { role: p.role, peer: p.id, ip: p.ip, room: p.roomID.slice(0, 6) });
			ws.terminate();
			return;
		}
		flush(ws);
	}
	function closeAfterDrain(ws: RelaySocket, code: number, reason: string): void {
		if (ws.data.queue.sealed) return;
		ws.data.queue.sealed = true;
		ws.data.closeAfterDrain = { code, reason };
		flush(ws);
	}
	function closeGuests(room: Room): void {
		for (const [id, guest] of room.guests) {
			room.guests.delete(id);
			send(guest, '{"t":"room-closed"}');
			closeAfterDrain(guest, 4001, "room closed");
		}
	}
	function release(ws: RelaySocket): void {
		const p = ws.data;
		if (p.released) return;
		p.released = true;
		clearTimeout(p.writeTimer);
		p.queue.clear();
		peers.delete(ws);
		const count = (connsByIP.get(p.ip) ?? 1) - 1;
		if (count) connsByIP.set(p.ip, count);
		else connsByIP.delete(p.ip);
		const room = p.room;
		if (room) {
			if (p.role === "host" && room.host === ws) {
				if (rooms.get(room.id) === room) rooms.delete(room.id);
				closeGuests(room);
				cfg.log("INFO", "房间关闭", { room: room.id.slice(0, 6) });
			} else if (room.guests.get(p.id) === ws) {
				room.guests.delete(p.id);
				send(room.host, `{"t":"peer-left","peer":${p.id}}`);
				cfg.log("INFO", "访客离开", { room: room.id.slice(0, 6), peer: p.id, guests: room.guests.size });
			}
		}
		if (closing && peers.size === 0) finishShutdown?.();
	}

	const server = Bun.serve<Peer>({
		port: cfg.port,
		hostname: cfg.hostname,
		idleTimeout: 10,
		fetch(req, srv): Response | undefined {
			const url = new URL(req.url);
			if (url.pathname === "/healthz")
				return new Response(`ok rooms=${rooms.size}\n`, {
					headers: { "Content-Type": "text/plain; charset=utf-8" },
				});
			const match = /^\/r\/([A-Za-z0-9_-]{10,64})$/.exec(url.pathname);
			const roles = url.searchParams.getAll("role");
			const role = roles[0];
			if (!match || roles.length !== 1 || (role !== "host" && role !== "guest"))
				return new Response("not found\n", { status: 404 });
			if (
				!req.headers
					.get("upgrade")
					?.split(",")
					.some(token => token.trim().toLowerCase() === "websocket")
			)
				return new Response("websocket upgrade required\n", { status: 426 });
			const roomID = match[1]!;
			let ip = normalizeIP(srv.requestIP(req)?.address ?? "");
			if (cfg.trustXff && (ip === "::1" || ip.startsWith("127."))) {
				const hops = req.headers.get("x-forwarded-for")?.split(",");
				const forwarded = normalizeIP(hops?.at(-1)?.trim() ?? "");
				if (forwarded) ip = forwarded;
			}
			if (role === "host" && allowed && !allowed.check(ip, ip.includes(":") ? "ipv6" : "ipv4")) {
				cfg.log("WARN", "拒绝非授权来源开房", { ip, room: roomID.slice(0, 6) });
				return new Response("forbidden\n", { status: 403 });
			}
			const count = connsByIP.get(ip) ?? 0;
			const status = closing
				? 503
				: count >= cfg.maxConnsPerIP
					? 429
					: role === "host" && !rooms.has(roomID) && rooms.size >= cfg.maxRooms
						? 503
						: 0;
			if (status) {
				cfg.log("WARN", "拒绝连接", { ip, role, room: roomID.slice(0, 6), status });
				return new Response(status === 503 ? "Service Unavailable\n" : "Too Many Requests\n", { status });
			}
			connsByIP.set(ip, count + 1);
			const data: Peer = { roomID, role, id: 0, ip, queue: new SendQueue(), released: false };
			if (srv.upgrade(req, { data })) return undefined;
			if (count) connsByIP.set(ip, count);
			else connsByIP.delete(ip);
			return new Response("websocket upgrade required\n", { status: 426 });
		},
		websocket: {
			// uWS observes partial inbound bytes, unlike message(). It pings after
			// 20s idle (Go: every 15s), then closes after another idle interval.
			// Manual pings would reset uWS's idle timer and hide silent peers.
			perMessageDeflate: false,
			idleTimeout: cfg.idleTimeout,
			sendPings: true,
			maxPayloadLength: cfg.maxFrameBytes,
			backpressureLimit: cfg.maxQueueBytes,
			closeOnBackpressureLimit: false,
			open(ws): void {
				peers.add(ws);
				const p = ws.data;
				if (closing) {
					ws.close(1001, "relay shutting down");
					return;
				}
				let room = rooms.get(p.roomID);
				if (p.role === "host") {
					if (room) {
						ws.close(4009, "a host is already connected for this room");
						return;
					}
					if (rooms.size >= cfg.maxRooms) {
						ws.close(1013, "too many rooms");
						return;
					}
					room = { id: p.roomID, host: ws, guests: new Map(), nextPeerID: 1 };
					rooms.set(p.roomID, room);
					p.room = room;
					cfg.log("INFO", "房间创建", { room: p.roomID.slice(0, 6), ip: p.ip });
					return;
				}
				if (!room) {
					ws.close(4004, "no such room");
					return;
				}
				if (room.guests.size >= cfg.maxGuestsPerRoom) {
					ws.close(4029, "room is full");
					return;
				}
				p.id = room.nextPeerID;
				room.nextPeerID = (room.nextPeerID + 1) >>> 0;
				p.room = room;
				room.guests.set(p.id, ws);
				send(room.host, `{"t":"peer-joined","peer":${p.id}}`);
				cfg.log("INFO", "访客加入", { room: p.roomID.slice(0, 6), peer: p.id, ip: p.ip, guests: room.guests.size });
			},
			message(ws, message): void {
				const p = ws.data;
				if (typeof message === "string" || message.byteLength < ENVELOPE_HEADER_LENGTH) return;
				const room = p.room;
				if (!room) return;
				if (p.role === "host") {
					if (room.host !== ws) return;
					const target = message.readUInt32BE(0);
					if (target === 0) for (const guest of room.guests.values()) send(guest, message);
					else {
						const guest = room.guests.get(target);
						if (guest) send(guest, message);
					}
				} else if (room.guests.get(p.id) === ws) {
					message.writeUInt32BE(p.id, 0);
					send(room.host, message);
				}
			},
			drain(ws): void {
				clearTimeout(ws.data.writeTimer);
				ws.data.writeTimer = undefined;
				flush(ws);
			},
			close(ws, code, reason): void {
				if (code === 1006 && reason === "WebSocket timed out from inactivity") {
					const p = ws.data;
					cfg.log("INFO", "心跳超时，断开", { role: p.role, peer: p.id, ip: p.ip });
				}
				release(ws);
			},
		},
	});

	function shutdown(timeout = 8_000): Promise<void> {
		if (shutdownPromise) return shutdownPromise;
		closing = true;
		const { promise, resolve } = Promise.withResolvers<void>();
		shutdownPromise = promise;
		const timer = setTimeout(() => {
			for (const ws of peers) ws.terminate();
			resolve();
		}, timeout);
		finishShutdown = (): void => {
			clearTimeout(timer);
			resolve();
		};
		for (const room of rooms.values()) {
			closeGuests(room);
			closeAfterDrain(room.host, 1001, "relay shutting down");
		}
		rooms.clear();
		if (!peers.size) finishShutdown();
		return shutdownPromise;
	}
	return {
		url: `ws://${cfg.hostname.includes(":") ? `[${cfg.hostname}]` : cfg.hostname}:${server.port}`,
		port: server.port!,
		shutdown,
		async stop(): Promise<void> {
			await shutdown();
			await server.stop(true);
		},
	};
}
