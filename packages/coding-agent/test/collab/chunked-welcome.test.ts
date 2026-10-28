/**
 * Contract: a large session snapshot is delivered as a small `welcome` frame
 * plus a train of `snapshot-chunk` frames, so the guest can clear its 30s
 * first-welcome timeout long before the full transcript arrives — the fix for
 * [#3144](https://github.com/can1357/oh-my-pi/issues/3144) where a multi-MB
 * single-frame welcome timed out on the default relay.
 *
 * The test drives the production `CollabHost` (real sealing, real envelopes)
 * through an in-process relay + fake WebSocket, mirroring the relay's
 * forwarding contract exactly; only the TUI context and the network transport
 * are stubbed.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { importRoomKey, seal } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabGuestLink } from "@oh-my-pi/pi-coding-agent/collab/guest";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import {
	COLLAB_PROTO,
	type CollabFrame,
	packEnvelope,
	parseCollabLink,
	unpackEnvelope,
} from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";

// In-memory transport: shared FakeWebSocket + InMemoryRelay harness (see
// ./helpers/in-memory-relay), mirroring the relay's forwarding contract.

// ── Host harness with a configurable transcript ────────────────────────────

interface SizedSnapshot {
	header: { type: "session"; id: string; timestamp: string; cwd: string };
	entries: SessionEntry[];
}

/**
 * Build a synthetic transcript whose total serialized size comfortably
 * exceeds the host's `SNAPSHOT_CHUNK_BYTES` (512 KB), forcing several
 * chunks. Each entry is ~16 KB of repeated text, so 96 entries → ~1.5 MB,
 * cleanly above three chunks without making the test slow.
 */
function makeLargeSnapshot(): SizedSnapshot {
	const body = "x".repeat(16 * 1024);
	const entries: SessionEntry[] = [];
	for (let i = 0; i < 96; i++) {
		entries.push({
			type: "message",
			id: `e${i}`,
			parentId: null,
			timestamp: "2026-06-20T00:00:00Z",
			message: { role: "user", content: body, timestamp: 0 },
		});
	}
	return {
		header: { type: "session", id: "sess-large", timestamp: "2026-06-20T00:00:00Z", cwd: "/tmp" },
		entries,
	};
}

function makeHostContext(snapshot: SizedSnapshot): InteractiveModeContext {
	const ctx = {
		settings: Settings.isolated(),
		sessionManager: {
			getSessionId: () => snapshot.header.id,
			getCwd: () => snapshot.header.cwd,
			snapshotForReplication: () => snapshot,
			onEntryAppended: undefined,
		},
		session: {
			isStreaming: false,
			queuedMessageCount: 0,
			sessionName: "large",
			model: undefined,
			thinkingLevel: undefined,
			subscribe: () => () => {},
			emitNotice: () => {},
			promptCustomMessage: () => Promise.resolve(),
			abort: () => Promise.resolve(),
		},
		eventBus: undefined,
		statusLine: {
			setCollabStatus: () => {},
			invalidate: () => {},
			getCachedContextBreakdown: () => ({ usedTokens: 0, contextWindow: 0 }),
		},
		ui: { requestRender: () => {} },
		showStatus: () => {},
		collabHost: undefined,
	};
	return ctx as unknown as InteractiveModeContext;
}

function makeFailingGuestContext(failure: Error): InteractiveModeContext {
	const ctx = {
		settings: Settings.isolated(),
		sessionManager: {
			getSessionFile: () => null,
			switchSession: () => Promise.reject(failure),
		},
		session: {
			newSession: () => Promise.resolve(),
			messages: [],
		},
		statusContainer: { clear: () => {} },
		pendingMessagesContainer: { clear: () => {} },
		compactionQueuedMessages: [],
		streamingComponent: undefined,
		streamingMessage: undefined,
		transcriptMessageComponents: new WeakMap(),
		pendingTools: new Map(),
		eventController: {
			handleEvent: () => Promise.resolve(),
			takeDisplaceableComponents: () => [],
			resetTranscriptAnchors: () => {},
		},
		loadingAnimation: undefined,
		statusLine: {
			setCollabStatus: () => {},
			invalidate: () => {},
			resetActiveTime: () => {},
		},
		ui: { requestRender: () => {} },
		chatContainer: { clear: () => {}, disposeChildren: () => {} },
		resetObserverRegistry: () => {},
		renderInitialMessages: () => {},
		reloadTodos: () => Promise.resolve(),
		syncRunningSubagentBadge: () => {},
		showStatus: () => {},
		updateEditorTopBorder: () => {},
		updateEditorBorderColor: () => {},
		collabGuest: undefined,
	} as unknown as InteractiveModeContext;
	return ctx;
}
function makeCancelledSwitchGuestContext(
	switchSession: () => Promise<boolean>,
	events: string[],
): InteractiveModeContext {
	return {
		settings: Settings.isolated(),
		sessionManager: {
			getSessionFile: () => null,
			getSessionName: () => undefined,
			getCwd: () => process.cwd(),
		},
		session: {
			switchSession,
			newSession: () => Promise.resolve(),
			messages: [],
			agent: {
				state: { model: undefined },
				setModel: () => events.push("host-model"),
				setThinkingLevel: () => events.push("host-thinking"),
				setDisableReasoning: () => events.push("host-reasoning"),
			},
		},
		statusContainer: { clear: () => events.push("clear-transient-ui") },
		pendingMessagesContainer: { clear: () => {} },
		compactionQueuedMessages: [],
		streamingComponent: undefined,
		streamingMessage: undefined,
		transcriptMessageComponents: new WeakMap(),
		pendingTools: new Map(),
		eventController: {
			handleEvent: () => Promise.resolve(),
			takeDisplaceableComponents: () => [],
			resetTranscriptAnchors: () => {},
		},
		loadingAnimation: undefined,
		statusLine: {
			setCollabStatus: () => {},
			invalidate: () => {},
			resetActiveTime: () => {},
			markActivityEnd: () => events.push("host-activity"),
		},
		ui: { requestRender: () => {} },
		chatContainer: { clear: () => {}, disposeChildren: () => {} },
		resetObserverRegistry: () => {},
		renderInitialMessages: () => {},
		syncRunningSubagentBadge: () => {},
		reloadTodos: () => Promise.resolve(),
		showStatus: (status: string) => events.push(`status:${status}`),
		updateEditorTopBorder: () => {},
		updateEditorBorderColor: () => {},
		collabGuest: undefined,
	} as unknown as InteractiveModeContext;
}

// ── Shared host/relay ───────────────────────────────────────────────────────

const snapshot = makeLargeSnapshot();
let host: CollabHost;

beforeAll(async () => {
	installInMemoryRelay();
	host = new CollabHost(makeHostContext(snapshot));
	await host.start("ws://localhost:8788");
});

afterAll(async () => {
	uninstallInMemoryRelay();
	await host.stop("test done");
});

const guestCleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of guestCleanups.splice(0).reverse()) cleanup();
});

describe("collab chunked welcome (#3144)", () => {
	it("releases join ownership when the transport constructor rejects", async () => {
		const original = globalThis.WebSocket;
		const failure = new Error("transport setup failed");
		globalThis.WebSocket = class {
			constructor() {
				throw failure;
			}
		} as unknown as typeof WebSocket;
		const ctx = makeCancelledSwitchGuestContext(async () => true, []);
		const guest = new CollabGuestLink(ctx);
		try {
			await expect(guest.join(host.link)).rejects.toBe(failure);
			expect(ctx.collabGuest).toBeUndefined();
		} finally {
			globalThis.WebSocket = original;
			await guest.leave("test cleanup").catch(() => {});
		}
	});

	it("delivers a small welcome before chunking the transcript across multiple frames", async () => {
		const parsed = parseCollabLink(host.link);
		if ("error" in parsed) throw new Error(parsed.error);
		const writeToken = parsed.writeToken ? Buffer.from(parsed.writeToken).toString("base64url") : undefined;
		const key = await importRoomKey(parsed.key);
		const socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
		guestCleanups.push(() => socket.close());

		const frames: CollabFrame[] = [];
		const trainDone = Promise.withResolvers<void>();
		socket.onFrame = frame => {
			frames.push(frame);
			if (frame.t === "snapshot-chunk" && frame.final) trainDone.resolve();
		};
		socket.onOpen = () => socket.send({ t: "hello", proto: COLLAB_PROTO, name: "test", writeToken });
		socket.connect();
		await trainDone.promise;

		const welcomeIdx = frames.findIndex(f => f.t === "welcome");
		expect(welcomeIdx).toBeGreaterThanOrEqual(0);
		const welcome = frames[welcomeIdx];
		if (welcome?.t !== "welcome") throw new Error("expected welcome frame");

		expect(welcome.entryCount).toBe(snapshot.entries.length);
		expect(welcome.header.id).toBe(snapshot.header.id);
		// Critical fix: the welcome itself MUST NOT carry the transcript inline —
		// inline bytes were what spent the guest's 30s timeout in #3144.
		const welcomeBytes = JSON.stringify(welcome).length;
		const snapshotBytes = JSON.stringify(snapshot).length;
		expect(welcomeBytes).toBeLessThan(snapshotBytes / 10);

		// The chunk train starts immediately after the welcome and the host
		// queues every chunk synchronously, so no other directed frame may
		// interleave between them.
		const chunks: { entries: SessionEntry[]; final: boolean }[] = [];
		for (let i = welcomeIdx + 1; i < frames.length; i++) {
			const f = frames[i];
			if (f?.t !== "snapshot-chunk") {
				throw new Error(`unexpected ${f?.t ?? "missing"} between welcome and final chunk`);
			}
			chunks.push({ entries: f.entries, final: f.final });
			if (f.final) break;
		}
		// Three+ chunks proves we honor the 512 KB cap with the 1.5 MB transcript;
		// only the last carries `final: true`.
		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks.at(-1)?.final).toBe(true);
		expect(chunks.slice(0, -1).every(c => !c.final)).toBe(true);

		const flattened: SessionEntry[] = [];
		for (const chunk of chunks) flattened.push(...chunk.entries);
		expect(flattened.length).toBe(snapshot.entries.length);
		expect(flattened.map(e => e.id)).toEqual(snapshot.entries.map(e => e.id));
	});

	it("keeps full history as ordinary sealed JSON for a peer that advertises no extensions", async () => {
		const parsed = parseCollabLink(host.link);
		if ("error" in parsed) throw new Error(parsed.error);
		const key = await importRoomKey(parsed.key);
		const ws = new WebSocket(`${parsed.wsUrl}?role=guest`);
		ws.binaryType = "arraybuffer";
		guestCleanups.push(() => ws.close());
		const done = Promise.withResolvers<void>();
		const entries: string[] = [];
		let chain = Promise.resolve();
		ws.onopen = () => {
			void seal(key, { t: "hello", proto: COLLAB_PROTO, name: "old-client" }).then(bytes =>
				ws.send(packEnvelope(0, bytes)),
			);
		};
		ws.onmessage = event => {
			if (typeof event.data === "string") return;
			const envelope = unpackEnvelope(new Uint8Array(event.data as ArrayBuffer));
			if (!envelope) return;
			chain = chain
				.then(async () => {
					const sealed = envelope.payload;
					const plain = await crypto.subtle.decrypt(
						{ name: "AES-GCM", iv: sealed.slice(0, 12) },
						key,
						sealed.slice(12),
					);
					// Exactly the old decoder: no compression marker or decompression support.
					const frame = JSON.parse(new TextDecoder().decode(plain)) as CollabFrame;
					if (frame.t === "welcome") {
						expect(frame.snapshotStart).toBeUndefined();
						expect(frame.compression).toBeUndefined();
						expect(frame.entryCount).toBe(snapshot.entries.length);
					}
					if (frame.t === "snapshot-chunk") {
						entries.push(...frame.entries.map(entry => entry.id));
						if (frame.final) done.resolve();
					}
				})
				.catch(done.reject);
		};
		await done.promise;
		expect(entries).toEqual(snapshot.entries.map(entry => entry.id));
	});

	it("joins with a bounded tail then fetches the exact preceding slices through fetch-transcript", async () => {
		const parsed = parseCollabLink(host.link);
		if ("error" in parsed) throw new Error(parsed.error);
		const socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key: await importRoomKey(parsed.key) });
		guestCleanups.push(() => socket.close());
		const done = Promise.withResolvers<void>();
		let before = 0;
		let reqId = 0;
		let entries: SessionEntry[] = [];
		const fetchPrevious = (): void => {
			if (before === 0) {
				done.resolve();
				return;
			}
			socket.send({
				t: "fetch-transcript",
				reqId: ++reqId,
				agentId: "",
				fromByte: 0,
				history: { before, beforeId: entries[0]!.id },
			});
		};
		socket.onOpen = () =>
			socket.send({
				t: "hello",
				proto: COLLAB_PROTO,
				name: "tail-client",
				capabilities: { tail: true, compression: ["deflate"] },
			});
		socket.onFrame = frame => {
			try {
				if (frame.t === "welcome") {
					expect(frame.entryCount).toBe(snapshot.entries.length);
					expect(frame.snapshotStart).toBeGreaterThan(0);
					expect(frame.compression).toBe("deflate");
					before = frame.snapshotStart!;
				} else if (frame.t === "snapshot-chunk") {
					entries.push(...frame.entries);
					if (frame.final) {
						expect(entries.map(entry => entry.id)).toEqual(snapshot.entries.slice(before).map(entry => entry.id));
						fetchPrevious();
					}
				} else if (frame.t === "transcript") {
					expect(frame.error).toBeUndefined();
					const page = frame.history!;
					expect(page.before).toBe(before);
					expect(page.entries.map(entry => entry.id)).toEqual(
						snapshot.entries.slice(page.start, before).map(entry => entry.id),
					);
					entries = [...(page.entries as SessionEntry[]), ...entries];
					before = page.start;
					fetchPrevious();
				}
			} catch (error) {
				done.reject(error);
			}
		};
		socket.connect();
		await done.promise;
		expect(entries.map(entry => entry.id)).toEqual(snapshot.entries.map(entry => entry.id));
	});

	it("rejects the pending join when snapshot resume fails", async () => {
		const failure = new Error("replica write failed during snapshot resume");
		const writeSpy = spyOn(Bun, "write").mockRejectedValue(failure);
		const guest = new CollabGuestLink(makeFailingGuestContext(failure));
		const joinAttempt = guest.join(host.link);
		try {
			await expect(
				Promise.race([
					joinAttempt,
					Bun.sleep(250).then(() => {
						throw new Error("join did not reject");
					}),
				]),
			).rejects.toThrow("replica write failed during snapshot resume");
		} finally {
			writeSpy.mockRestore();
			await guest.leave("test cleanup").catch(() => {});
		}
	});
	it("does not clear the old guest session when replica activation is cancelled", async () => {
		const events: string[] = [];
		const guest = new CollabGuestLink(makeCancelledSwitchGuestContext(async () => false, events));
		guest.agentRegistry.register({
			id: "local-agent",
			displayName: "local",
			kind: "main",
			parentId: undefined,
			session: null,
			status: "running",
		});

		const joinAttempt = guest.join(host.link);
		try {
			await expect(joinAttempt).rejects.toThrow("Collab replica activation was cancelled");
			expect(guest.agentRegistry.get("local-agent")).toBeDefined();
			expect(events).not.toContain("clear-transient-ui");
			expect(events).not.toContain("status:Joined collab session");
		} finally {
			await guest.leave("test cleanup").catch(() => {});
		}
	});
	it("applies host state only after the replica activates", async () => {
		const events: string[] = [];
		const guest = new CollabGuestLink(
			makeCancelledSwitchGuestContext(async () => {
				events.push("replica-activated");
				return true;
			}, events),
		);

		try {
			await guest.join(host.link);
			expect(events.indexOf("replica-activated")).toBeGreaterThanOrEqual(0);
			expect(events.indexOf("host-thinking")).toBeGreaterThan(events.indexOf("replica-activated"));
			expect(events.findIndex(event => event.startsWith("status:Joined collab session"))).toBeGreaterThan(
				events.indexOf("host-thinking"),
			);
		} finally {
			await guest.leave("test cleanup").catch(() => {});
		}
	});
});
