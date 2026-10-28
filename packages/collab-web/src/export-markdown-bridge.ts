/** The export viewer resolves its canonical Marked import to its embedded dependency. */
import type { Marked as MarkedConstructor } from "@oh-my-pi/pi-utils/marked";

declare global {
	var ompMarkdown: { Marked: typeof MarkedConstructor };
}

export const Marked = globalThis.ompMarkdown.Marked;
