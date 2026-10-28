/** Negotiated v3 extension: deflate inside the existing AES-GCM seal.
 * JSON starts with `{`; byte 1 identifies a zlib-wrapped deflate stream.
 * No framing, keys, IVs, authentication tags or relay envelopes change.
 */
export const COLLAB_DEFLATE_MARKER = 1;

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

export async function encodeCollabPayload(json: string, deflate = false): Promise<Uint8Array> {
	const plain = TEXT_ENCODER.encode(json);
	if (!deflate || plain.byteLength < 1024) return plain;
	const stream = new Blob([plain]).stream().pipeThrough(new CompressionStream("deflate"));
	const compressed = new Uint8Array(await new Response(stream).arrayBuffer());
	if (compressed.byteLength + 1 >= plain.byteLength) return plain;
	const framed = new Uint8Array(compressed.byteLength + 1);
	framed[0] = COLLAB_DEFLATE_MARKER;
	framed.set(compressed, 1);
	return framed;
}

export async function decodeCollabPayload(plain: Uint8Array): Promise<string> {
	if (plain[0] !== COLLAB_DEFLATE_MARKER) return TEXT_DECODER.decode(plain);
	const bytes = new Uint8Array(plain.subarray(1));
	const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate"));
	return new Response(stream).text();
}
