import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { Api, AuthStorage, FetchImpl, Model } from "@oh-my-pi/pi-ai";
import { roleDefaultModels } from "@oh-my-pi/pi-catalog/compat/behavior";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgRetryFallbackChains } from "@oh-my-pi/pi-coding-agent/session/settings";
import { runSearchQuery } from "@oh-my-pi/pi-coding-agent/web/search";
import { getSearchProvider } from "@oh-my-pi/pi-coding-agent/web/search/provider";
import { AnySearchProvider, searchAnySearch } from "@oh-my-pi/pi-coding-agent/web/search/providers/anysearch";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const originalKey = process.env.ANYSEARCH_API_KEY;
let authStorage: AuthStorage;
let modelRegistry: ModelRegistry;
let model: Model<Api>;

function successResponse() {
	return Response.json({
		code: 0,
		request_id: "request-test",
		data: {
			results: [
				{ title: "Bun docs", url: "https://bun.sh/docs", content: "Bun documentation" },
				{ url: "https://bun.sh/blog", snippet: "Bun blog" },
			],
		},
	});
}

function params() {
	return { query: "Bun documentation", authStorage, modelRegistry, model, systemPrompt: "Search test" };
}

beforeEach(() => {
	delete process.env.ANYSEARCH_API_KEY;
	authStorage = createInMemoryAuthStorage();
	modelRegistry = new ModelRegistry(authStorage);
	const bundled = modelRegistry.find("web", "anysearch");
	if (!bundled) throw new Error("Expected bundled web/anysearch model");
	model = bundled;
});

afterEach(() => {
	vi.restoreAllMocks();
	authStorage.close();
	resetSettingsForTest();
	if (originalKey === undefined) delete process.env.ANYSEARCH_API_KEY;
	else process.env.ANYSEARCH_API_KEY = originalKey;
});

describe("AnySearch HTTP search", () => {
	it("uses broker credentials as bearer authentication and maps HTTP results", async () => {
		authStorage.keys.setRuntime("anysearch", "test-anysearch-key");
		const fetchMock: FetchImpl = async (input, init) => {
			expect(String(input)).toBe("https://api.anysearch.com/v1/search");
			expect(init?.method).toBe("POST");
			expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-anysearch-key");
			expect(JSON.parse(String(init?.body))).toEqual({ query: "Bun documentation", max_results: 2 });
			return successResponse();
		};

		const response = await searchAnySearch({ ...params(), numSearchResults: 2, fetch: fetchMock });

		expect(response).toMatchObject({
			provider: "anysearch",
			authMode: "api_key",
			requestId: "request-test",
			sources: [
				{ title: "Bun docs", url: "https://bun.sh/docs", snippet: "Bun documentation" },
				{ title: "https://bun.sh/blog", url: "https://bun.sh/blog", snippet: "Bun blog" },
			],
		});
		expect(response.warnings).toBeUndefined();
	});

	it("requests without authentication and attaches separate user and model warnings", async () => {
		let calls = 0;
		const fetchMock: FetchImpl = async (_input, init) => {
			calls++;
			expect(new Headers(init?.headers).has("Authorization")).toBe(false);
			return successResponse();
		};

		const response = await searchAnySearch({ ...params(), fetch: fetchMock });

		expect(calls).toBe(1);
		expect(response.authMode).toBe("anonymous");
		expect(response.sources).toHaveLength(2);
		expect(response.warnings?.[0]?.message).toContain("/login anysearch");
		expect(response.warnings?.[0]?.message).toContain("rate-limited");
		expect(response.warnings?.[0]?.modelMessage).toContain("Tell the user");
		expect(response.warnings?.[0]?.modelMessage).toContain("`/login anysearch`");
	});

	it("keeps anonymous search explicit while admitting authenticated automatic fallback", async () => {
		const provider = new AnySearchProvider();
		expect(await getSearchProvider("anysearch")).toBeInstanceOf(AnySearchProvider);
		expect(provider.isAvailable(authStorage)).toBe(false);
		expect(provider.isExplicitlyAvailable(authStorage)).toBe(true);
		authStorage.keys.setRuntime("anysearch", "test-anysearch-key");
		expect(provider.isAvailable(authStorage)).toBe(true);
		const defaults = roleDefaultModels().web ?? [];
		expect(defaults).toContain("web/anysearch");
		expect(defaults.indexOf("web/anysearch")).toBeLessThan(defaults.indexOf("web/duckduckgo"));
	});

	it("honors the result limit without coupling recency to the query or request body", async () => {
		const fetchMock: FetchImpl = async (_input, init) => {
			expect(JSON.parse(String(init?.body))).toEqual({ query: "Bun documentation", max_results: 1 });
			return successResponse();
		};
		const response = await searchAnySearch({ ...params(), limit: 1, recency: "week", fetch: fetchMock });
		expect(response.sources).toHaveLength(1);
	});

	it.each([
		["invalid JSON", () => new Response("not json"), "invalid JSON"],
		["API failure", () => Response.json({ code: 1, message: "search unavailable" }), "search unavailable"],
		["missing data", () => Response.json({ code: 0 }), "has no data"],
		["rate limit", () => new Response("rate limited", { status: 429 }), "429"],
	] as const)("surfaces %s as a provider failure", async (_name, response, message) => {
		await expect(searchAnySearch({ ...params(), fetch: async () => response() })).rejects.toThrow(message);
	});

	it("propagates caller cancellation into the HTTP transport", async () => {
		const controller = new AbortController();
		const reason = new Error("cancelled by user");
		const fetchMock: FetchImpl = async (_input, init) => {
			controller.abort(reason);
			init?.signal?.throwIfAborted();
			throw new Error("Expected aborted signal");
		};
		await expect(searchAnySearch({ ...params(), signal: controller.signal, fetch: fetchMock })).rejects.toBe(reason);
	});
});

describe("AnySearch web role integration", () => {
	async function configureChain(fallbacks: string[] = []) {
		const settings = await Settings.init({ inMemory: true });
		settings.setModelRole("web", "web/anysearch");
		cfgRetryFallbackChains.set(settings, { web: fallbacks });
		modelRegistry = new ModelRegistry(authStorage, undefined, { settings });
		return { authStorage, modelRegistry };
	}

	it("includes the Markdown model instruction in anonymous tool output", async () => {
		const context = await configureChain();
		vi.spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(async () => successResponse(), { preconnect: fetch.preconnect }),
		);

		const result = await runSearchQuery({ query: "Bun documentation" }, context);

		expect(result.details.error).toBeUndefined();
		expect(result.content[0]?.text).toContain("Tell the user to run `/login anysearch`");
		expect(result.content[0]?.text).toContain("anonymous searches may be rate-limited");
		expect(result.details.response.warnings?.[0]?.message).toContain("Run /login anysearch");
	});

	it("advances to the next configured provider after AnySearch fails", async () => {
		const context = await configureChain(["web/firecrawl"]);
		const requested: string[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(async (input: string | URL | Request) => {
				requested.push(String(input));
				if (String(input) === "https://api.anysearch.com/v1/search") {
					return new Response("AnySearch unavailable", { status: 503 });
				}
				return Response.json({ data: { web: [{ title: "Next engine", url: "https://example.com/next" }] } });
			}, { preconnect: fetch.preconnect }),
		);

		const result = await runSearchQuery({ query: "Bun documentation" }, context);

		expect(requested).toHaveLength(2);
		expect(requested[0]).toBe("https://api.anysearch.com/v1/search");
		expect(requested[1]).toContain("firecrawl");
		expect(result.details.error).toBeUndefined();
		expect(result.details.response.provider).toBe("firecrawl");
		expect(result.content[0]?.text).toContain("answered by Firecrawl after AnySearch failed");
	});
});
