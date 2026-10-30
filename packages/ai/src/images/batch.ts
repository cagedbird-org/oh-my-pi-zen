import type { ImageGenerationResult } from "./types";

/** Settle parallel single-image requests before exposing a batch or starting failover. */
export async function generateImageBatch(count: number, generate: () => Promise<ImageGenerationResult>): Promise<ImageGenerationResult> {
	const settled = await Promise.allSettled(Array.from({ length: count }, generate));
	const results: ImageGenerationResult[] = [];
	for (const result of settled) {
		if (result.status === "rejected") throw result.reason;
		results.push(result.value);
	}
	const first = results[0]!;
	const usage = { ...first.usage, cost: { ...first.usage.cost } };
	for (const result of results.slice(1)) {
		usage.input += result.usage.input;
		usage.output += result.usage.output;
		usage.cacheRead += result.usage.cacheRead;
		usage.cacheWrite += result.usage.cacheWrite;
		usage.totalTokens += result.usage.totalTokens;
		usage.cost.input += result.usage.cost.input;
		usage.cost.output += result.usage.cost.output;
		usage.cost.cacheRead += result.usage.cost.cacheRead;
		usage.cost.cacheWrite += result.usage.cost.cacheWrite;
		usage.cost.total += result.usage.cost.total;
	}
	return { images: results.flatMap(result => result.images), usage, model: first.model, text: results.map(result => result.text).filter(Boolean).join("\n") || undefined };
}
