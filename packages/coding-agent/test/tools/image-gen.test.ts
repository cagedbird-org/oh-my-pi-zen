import * as path from "node:path";
import * as os from "node:os";
import { afterAll, describe, expect, it } from "bun:test";
import { type Api, type FetchImpl, type Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { modelKind } from "@oh-my-pi/pi-catalog/types";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CustomToolContext } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getImageGenTools, getImageGenToolsWithRegistry, imageGenSchema, imageGenTool } from "@oh-my-pi/pi-coding-agent/tools/image-gen";
import { removeWithRetries, TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
const files: string[] = [];
const temp = TempDir.createSync("omp-image-tool-test-");
const reference = path.resolve(temp.path(), "reference.png");
await Bun.write(reference, Buffer.from(PNG, "base64"));
afterAll(async () => { await Promise.all(files.map(file => removeWithRetries(file))); temp.removeSync(); });

function model(provider: string, id = "gpt-image-2", api: Api = "openai-images", kind: "chat" | "image" = "image"): Model {
	return buildModel({ provider, id, name: id, api, kind, baseUrl: `https://${provider}.example/v1`, reasoning: false, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 });
}
function context(models: Model[], fetch: FetchImpl, options: { credentials?: Record<string, string | undefined>; settings?: Settings; active?: Model } = {}): CustomToolContext {
	const auth = createInMemoryAuthStorage();
	for (const item of models) {
		const key = options.credentials && item.provider in options.credentials ? options.credentials[item.provider] : `key-${item.provider}`;
		if (key) auth.keys.setRuntime(item.provider, key);
	}
	const registry = new ModelRegistry(auth);
	registry.getAvailable = (kind = "chat") => kind === "all" ? [...models] : models.filter(item => modelKind(item) === kind);
	registry.getAll = () => [...models];
	registry.find = (provider, id) => models.find(item => item.provider === provider && item.id === id);
	return { fetch, modelRegistry: registry, sessionManager: SessionManager.inMemory(temp.path()), settings: options.settings ?? Settings.isolated({ modelRoles: { image: `${models[0]!.provider}/${models[0]!.id}` }, "retry.fallbackChains": { image: models.slice(1).filter(item => item.kind === "image").map(item => `${item.provider}/${item.id}`) } }), model: options.active, isIdle: () => true, hasQueuedMessages: () => false, abort: () => {} };
}
function response(): Response {
	return Response.json({ size: "900x800", quality: "medium", data: [{ b64_json: PNG }] });
}
async function run(ctx: CustomToolContext, params: typeof imageGenSchema.infer = { prompt: "A gem inventory icon" }) {
	const result = await imageGenTool.execute("image", params, undefined, ctx);
	files.push(...(result.details?.imagePaths ?? []));
	return result;
}

describe("generate_image role contract", () => {
	it("exposes natural prompting and local references without model or output directory", async () => {
		const properties = imageGenSchema.toJsonSchema().properties;
		expect(Object.keys(properties ?? {})).toEqual(["prompt", "input", "background", "count", "size", "quality"]);
		expect(await getImageGenTools()).toEqual([imageGenTool]);
		expect(await getImageGenToolsWithRegistry(context([model("relay")], async () => response()).modelRegistry)).toEqual([imageGenTool]);
		expect(imageGenSchema.allows({ prompt: "icon", count: 5 })).toBe(false);
		expect(imageGenSchema.allows({ prompt: "icon", size: "1200x800" })).toBe(true);
		expect(imageGenSchema.allows({ prompt: "icon", size: "not-a-size" })).toBe(false);
	});
	it("runs count single-image calls concurrently without n and requests transparent PNG at high quality", async () => {
		const bodies: Record<string, unknown>[] = [];
		const { promise: barrier, resolve: release } = Promise.withResolvers<void>();
		const ctx = context([model("relay")], async (_url, init) => {
			bodies.push(JSON.parse(String(init?.body)));
			if (bodies.length === 2) release();
			await barrier;
			return response();
		});
		const result = await run(ctx, { prompt: "A gem inventory icon", background: "transparent", count: 2, size: "landscape" });
		expect(bodies).toHaveLength(2);
		for (const body of bodies) {
			expect(body).not.toHaveProperty("n");
			expect(body).toMatchObject({ prompt: "A gem inventory icon", background: "transparent", output_format: "png", quality: "high", size: "1536x1024" });
		}
		expect(result.details?.imageCount).toBe(2);
	});
	it("reports dimensions from image bytes and quality from the response rather than the request", async () => {
		const result = await run(context([model("relay")], async () => response()), { prompt: "gem", size: "2048x2048", quality: "high" });
		expect(result.details?.images[0]).toMatchObject({ size: "1x1", quality: "medium" });
		expect(result.content[0]).toMatchObject({ text: expect.stringContaining("1x1, quality medium") });
	});
	it("labels quality unreported rather than claiming the requested quality", async () => {
		const result = await run(context([model("relay")], async () => Response.json({ data: [{ b64_json: PNG }] })));
		expect(result.content[0]).toMatchObject({ text: expect.stringContaining("quality unreported") });
	});
	it("writes distinct full paths in the system temporary directory across concurrent calls", async () => {
		const ctx = context([model("relay")], async () => response());
		const results = await Promise.all([run(ctx), run(ctx)]);
		const paths = results.flatMap(result => result.details?.imagePaths ?? []);
		expect(new Set(paths).size).toBe(2);
		for (const file of paths) { expect(path.dirname(file)).toBe(os.tmpdir()); expect(await Bun.file(file).text()).toBe(Buffer.from(PNG, "base64").toString()); }
	});
	it("sends local references as JSON images to edits with transparent PNG parameters", async () => {
		let url: string | undefined;
		let body: unknown;
		await run(context([model("relay")], async (input, init) => { url = input.toString(); body = JSON.parse(String(init?.body)); return response(); }), { prompt: "Only recolor the gem red; preserve its silhouette", input: [{ path: reference }], background: "transparent" });
		expect(url).toBe("https://relay.example/v1/images/edits");
		expect(body).toMatchObject({ images: [{ image_url: `data:image/png;base64,${PNG}` }], background: "transparent", output_format: "png" });
	});
	it("names the successful candidate and earlier failure reason", async () => {
		const result = await run(context([model("first"), model("second")], async input => input.toString().includes("first.example") ? Response.json({ error: { message: "temporarily unavailable" } }, { status: 503 }) : response()));
		expect(result.details?.provider).toBe("second");
		expect(result.content[0]).toMatchObject({ text: expect.stringContaining("Completed by second/gpt-image-2 after first/gpt-image-2 failed:") });
		expect(result.details?.failures[0]?.reason).toContain("temporarily unavailable");
	});
	for (const id of ["dall-e-2", "dall-e-3"]) {
		it(`falls back before contacting ${id} when transparency is required`, async () => {
			const urls: string[] = [];
			const result = await run(context([model("legacy", id), model("relay")], async (input, init) => {
				urls.push(input.toString());
				const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
				expect(body).toMatchObject({ background: "transparent", output_format: "png", quality: "high" });
				return response();
			}), { prompt: "gem", background: "transparent" });
			expect(urls).toEqual(["https://relay.example/v1/images/generations"]);
			expect(result.details?.provider).toBe("relay");
			expect(result.details?.failures).toEqual([{ model: `legacy/${id}`, reason: `Image model legacy/${id} does not support transparent backgrounds` }]);
		});
	}
	it("reports missing credentials when a later candidate completes", async () => {
		const urls: string[] = [];
		const result = await run(context([model("first"), model("second")], async input => { urls.push(input.toString()); return response(); }, { credentials: { first: undefined } }));
		expect(urls).toEqual(["https://second.example/v1/images/generations"]);
		expect(result.details?.failures).toEqual([{ model: "first/gpt-image-2", reason: "Credentials unavailable" }]);
	});
	it("uses only the configured role chain, not the active conversation provider", async () => {
		const configured = model("relay");
		const active = model("openai-codex", "gpt-5.5", "openai-codex-responses", "chat");
		const urls: string[] = [];
		await run(context([configured, active], async input => { urls.push(input.toString()); return response(); }, { active }));
		expect(urls).toEqual(["https://relay.example/v1/images/generations"]);
	});
	for (const reverse of [false, true]) {
		it(`isolates OAuth and relay credentials in a mixed chain (${reverse ? "relay first" : "Codex first"})`, async () => {
			const codex = model("openai-codex", "gpt-image-2", "openai-codex-responses");
			const relay = model("relay");
			const carrier = model("openai-codex", "gpt-5.5", "openai-codex-responses", "chat");
			const seen: Array<{ url: string; key: string | null; body: Record<string, unknown> }> = [];
			const result = await run(context([...(reverse ? [relay, codex] : [codex, relay]), carrier], async (input, init) => {
				seen.push({ url: input.toString(), key: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body)) });
				if (seen.length === 1) return Response.json({ error: { message: "candidate unavailable" } }, { status: 503 });
				if (reverse) return new Response(`data: ${JSON.stringify({ type: "response.completed", response: { output: [{ type: "image_generation_call", result: PNG, quality: "low" }], tools: [{ type: "image_generation", model: "actual-image" }] } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
				return response();
			}, { credentials: { "openai-codex": "oauth-codex", relay: "relay-secret" } }), { prompt: "gem", background: "transparent" });
			for (const item of seen) {
				if (item.url.includes("openai-codex")) {
					expect(item.key).toBe("Bearer oauth-codex");
					expect(item.body.tools).toMatchObject([{ type: "image_generation", background: "transparent", output_format: "png", quality: "high" }]);
				} else expect(item.key).toBe("Bearer relay-secret");
			}
			expect(result.details?.provider).toBe(reverse ? "openai-codex" : "relay");
		});
	}
	it("fails an exhausted chain with candidate reasons", async () => {
		await expect(run(context([model("relay")], async () => Response.json({ error: { message: "no capacity" } }, { status: 503 })))).rejects.toThrow("no capacity");
	});
	it("loads openai-images entries through models.yml and reuses provider key, URL and headers", async () => {
		const configPath = path.resolve(temp.path(), "models.yml");
		await Bun.write(configPath, "providers:\n  gateway:\n    baseUrl: https://gateway.example/v1\n    apiKey: fixture-gateway-key\n    headers:\n      X-Team: artwork\n    models:\n      - id: gpt-image-2\n        api: openai-images\n");
		const registry = new ModelRegistry(createInMemoryAuthStorage(), configPath);
		const loaded = registry.find("gateway", "gpt-image-2");
		expect(loaded?.kind).toBe("image");
		const ctx = context([model("gateway")], async (input, init) => {
			expect(input.toString()).toBe("https://gateway.example/v1/images/generations");
			expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-gateway-key");
			expect(new Headers(init?.headers).get("x-team")).toBe("artwork");
			return response();
		});
		ctx.modelRegistry = registry;
		await run(ctx);
	});
	it("rejects non-file references before any request", async () => {
		let calls = 0;
		const ctx = context([model("relay")], async () => { calls++; return response(); });
		await expect(run(ctx, { prompt: "edit", input: [{ path: temp.path() }] })).rejects.toThrow();
		expect(calls).toBe(0);
	});
});
