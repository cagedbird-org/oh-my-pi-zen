import { describe, expect, it } from "bun:test";
import { open as browserOpen } from "../../../collab-web/src/lib/codec";
import { generateRoomKey, importRoomKey, open, sealSerialized } from "../../src/collab/crypto";
import type { CollabFrame } from "../../src/collab/protocol";

const decoder = new TextDecoder();

async function plaintext(key: CryptoKey, sealed: Uint8Array): Promise<Uint8Array> {
	return new Uint8Array(
		await crypto.subtle.decrypt({ name: "AES-GCM", iv: sealed.slice(0, 12) }, key, sealed.slice(12)),
	);
}

describe("negotiated collab compression inside AES-GCM", () => {
	it("round trips compressed multilingual payloads through both CLI and browser decoders", async () => {
		const key = await importRoomKey(generateRoomKey());
		const frame: CollabFrame = { t: "transcript", reqId: 1, text: "较大的会话记录\n".repeat(5000), newSize: 5000 };
		const json = JSON.stringify(frame);
		const sealed = await sealSerialized(key, json, true);
		expect(sealed.byteLength).toBeLessThan(Buffer.byteLength(json) / 4);
		expect((await plaintext(key, sealed))[0]).toBe(1);
		expect(await open(key, sealed)).toEqual(frame);
		expect(await browserOpen(key, sealed)).toEqual(frame);
		const tampered = sealed.slice();
		tampered[15] = tampered[15]! ^ 1;
		await expect(browserOpen(key, tampered)).rejects.toThrow();
	});

	it("leaves the entire payload ordinary JSON for a non-advertising legacy decoder", async () => {
		const key = await importRoomKey(generateRoomKey());
		const frame: CollabFrame = { t: "transcript", reqId: 2, text: "legacy".repeat(5000), newSize: 30000 };
		const sealed = await sealSerialized(key, JSON.stringify(frame));
		expect(JSON.parse(decoder.decode(await plaintext(key, sealed)))).toEqual(frame);
	});
});
