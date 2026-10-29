export type Outgoing = string | Uint8Array;
export const QUEUE_ENTRY_OVERHEAD = 128;

/** Owns only unsent messages; Bun's buffered bytes are accounted separately by the relay. */
export class SendQueue {
	items: Outgoing[] = [];
	bytes = 0;
	head = 0;
	sealed = false;

	push(data: Outgoing, limit: number, bufferedBytes = 0): boolean {
		if (this.sealed) return true;
		const cost = (typeof data === "string" ? Buffer.byteLength(data) : data.buffer.byteLength) + QUEUE_ENTRY_OVERHEAD;
		if (this.bytes + bufferedBytes + cost > limit) return false;
		this.items.push(data);
		this.bytes += cost;
		return true;
	}

	shift(): Outgoing | undefined {
		const data = this.items[this.head];
		if (data === undefined) return undefined;
		this.items[this.head++] = undefined!;
		this.bytes -=
			(typeof data === "string" ? Buffer.byteLength(data) : data.buffer.byteLength) + QUEUE_ENTRY_OVERHEAD;
		if (this.head === this.items.length) {
			this.items = [];
			this.head = 0;
		} else if (this.head > 1024 && this.head * 2 > this.items.length) {
			this.items.splice(0, this.head);
			this.head = 0;
		}
		return data;
	}

	clear(): void {
		this.sealed = true;
		this.items = [];
		this.head = 0;
		this.bytes = 0;
	}
}
