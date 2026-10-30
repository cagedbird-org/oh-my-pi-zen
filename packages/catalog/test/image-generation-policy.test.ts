import { describe, expect, it } from "bun:test";
import { buildModel } from "../src/build";
import { imageGenerationPolicy } from "../src/compat/image-generation";
import type { Api } from "../src/types";

function policy(provider: string, id: string, api: Api = "openai-images") {
	return imageGenerationPolicy(buildModel({ provider, id, name: id, api, kind: "image", baseUrl: "https://images.example/v1", reasoning: false, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 }));
}

describe("image generation KDL policies", () => {
	it("uses JSON edits without response_format for GPT Image on arbitrary relays", () => {
		expect(policy("unknown-relay", "gpt-image-2.5-2026-08-01")).toMatchObject({ editEncoding: "json", responseFormat: false, geometry: "size" });
	});
	it("selects multipart for the official OpenAI endpoint", () => {
		expect(policy("openai", "gpt-image-2")).toMatchObject({ editEncoding: "multipart", responseFormat: false });
		expect(policy("openai", "dall-e-2")).toMatchObject({ editEncoding: "multipart", responseFormat: true });
	});
	it("keeps generic Images API base64 responses", () => {
		expect(policy("unknown-relay", "flux-1")).toMatchObject({ editEncoding: "json", responseFormat: true });
	});
	it("declares xAI geometry and edit limits in the catalog", () => {
		expect(policy("xai", "grok-imagine-image")).toMatchObject({ editEncoding: "xai", geometry: "resolution", maxReferences: 3 });
	});
	it("declares model-specific rendering fields and quality mappings", () => {
		expect(policy("gateway", "gpt-image-2")).toMatchObject({ supportsBackground: true, outputFormat: "png", quality: { low: "low", medium: "medium", high: "high" }, defaultQuality: "high" });
		expect(policy("gateway", "dall-e-2")).toMatchObject({ supportsBackground: false, outputFormat: undefined, quality: {}, defaultQuality: undefined });
		expect(policy("gateway", "dall-e-3")).toMatchObject({ supportsBackground: false, outputFormat: undefined, quality: { low: "standard", medium: "standard", high: "hd" }, defaultQuality: undefined });
	});
	it("adds a prompt shape directive only for the Codex wire protocol", () => {
		expect(policy("custom", "gpt-image-2", "openai-codex-responses").promptShape).toBe(true);
		expect(policy("custom", "gpt-image-2", "openai-responses").promptShape).toBe(false);
	});
});
