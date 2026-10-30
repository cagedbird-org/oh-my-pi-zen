import {
	type AuthStorage,
	getEnvApiKey,
	resolveApiKeyOnce,
	seedApiKeyResolver,
	withAuth,
} from "@oh-my-pi/pi-ai";
import { asRecord } from "@oh-my-pi/pi-utils";
import anonymousNotice from "../../../prompts/tools/anysearch-anonymous.md" with { type: "text" };
import type { SearchResponse, SearchSource } from "../types";
import { SearchProviderError } from "../types";
import { clampNumResults } from "../utils";
import { SearchProvider, type SearchParams } from "./base";
import { classifyProviderHttpError, normalizeSearchText, readLimitedText, withHardTimeout } from "./utils";

const ANYSEARCH_API_URL = "https://api.anysearch.com/v1/search";
const DEFAULT_NUM_RESULTS = 5;
const MAX_NUM_RESULTS = 10;
const ANONYMOUS_WARNING = "AnySearch is not logged in. Run /login anysearch; anonymous searches may be rate-limited.";

async function callAnySearch(
	key: string | undefined,
	params: SearchParams,
	numResults: number,
): Promise<SearchResponse> {
	const response = await (params.fetch ?? fetch)(ANYSEARCH_API_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"x-anysearch-client": "oh-my-pi/1",
			...(key ? { Authorization: `Bearer ${key}` } : {}),
		},
		body: JSON.stringify({ query: params.query, max_results: numResults }),
		signal: withHardTimeout(params.signal, params.timeoutMs),
	});
	const text = await readLimitedText(response, "anysearch", 2 * 1024 * 1024);
	if (!response.ok) {
		throw (
			classifyProviderHttpError("anysearch", response.status, text) ??
			new SearchProviderError("anysearch", `AnySearch API error (${response.status}): ${text}`, response.status)
		);
	}
	let envelope: Record<string, unknown> | null;
	try {
		envelope = asRecord(JSON.parse(text));
	} catch {
		throw new SearchProviderError("anysearch", "AnySearch returned invalid JSON", 502);
	}
	if (envelope?.code !== 0) {
		const message = normalizeSearchText(envelope?.message) ?? "Unknown API error";
		throw new SearchProviderError("anysearch", `AnySearch API error: ${message}`, 502);
	}
	const data = asRecord(envelope.data);
	if (!data) throw new SearchProviderError("anysearch", "AnySearch response has no data", 502);

	const sources: SearchSource[] = [];
	for (const item of Array.isArray(data.results) ? data.results : []) {
		const result = asRecord(item);
		const url = normalizeSearchText(result?.url);
		if (!url) continue;
		sources.push({
			title: normalizeSearchText(result?.title) ?? url,
			url,
			snippet: normalizeSearchText(result?.content) ?? normalizeSearchText(result?.snippet),
		});
		if (sources.length >= numResults) break;
	}
	return {
		provider: "anysearch",
		sources,
		requestId: normalizeSearchText(envelope.request_id),
		authMode: key ? "api_key" : "anonymous",
		warnings: key ? undefined : [{ message: ANONYMOUS_WARNING, modelMessage: anonymousNotice.trim() }],
	};
}

/** Search through AnySearch's HTTP API, with optional broker-managed credentials. */
export async function searchAnySearch(params: SearchParams): Promise<SearchResponse> {
	const numResults = Math.floor(
		clampNumResults(params.numSearchResults ?? params.limit, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS),
	);
	const resolver = params.authStorage.keys.resolver("anysearch", { sessionId: params.sessionId });
	const key = await resolveApiKeyOnce(resolver, params.signal);
	if (!key) return callAnySearch(undefined, params, numResults);
	return withAuth(seedApiKeyResolver(key, resolver), resolved => callAnySearch(resolved, params, numResults), {
		signal: params.signal,
	});
}

export class AnySearchProvider extends SearchProvider {
	readonly id = "anysearch";
	readonly label = "AnySearch";

	isAvailable(authStorage: AuthStorage): boolean {
		return authStorage.keys.source("anysearch") !== undefined || !!getEnvApiKey("anysearch");
	}

	override isExplicitlyAvailable(_authStorage: AuthStorage): boolean {
		return true;
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchAnySearch(params);
	}
}
