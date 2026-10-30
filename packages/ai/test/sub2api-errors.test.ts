import { describe, expect, it } from "bun:test";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import type { AssistantMessage, Context, FetchImpl } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

type WirePath = "completions-error" | "responses-error" | "responses-failed";
interface GatewayError {
	type: string;
	code?: string;
	message: string;
}
interface TransientCase extends GatewayError {
	status?: number;
}

const paths: WirePath[] = ["completions-error", "responses-error", "responses-failed"];
const context: Context = { messages: [{ role: "user", content: "Hello", timestamp: 0 }] };
const modelOptions = {
	provider: "openai",
	id: "gateway-test",
	name: "Gateway Test",
	baseUrl: "https://gateway.invalid/v1",
	contextWindow: 8192,
	maxTokens: 2048,
	input: ["text" as const],
	reasoning: false,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const completionsModel = buildModel({ ...modelOptions, api: "openai-completions" });
const responsesModel = buildModel({ ...modelOptions, api: "openai-responses" });

// sub2api handler/stream_error_event.go maps errType to response.error.code.
function responseCode(error: GatewayError): string {
	if (error.code) return error.code;
	if (error.type === "rate_limit_error") return "rate_limit_exceeded";
	if (error.type === "invalid_request_error") return "invalid_request";
	if (error.type === "api_error") return "server_error";
	return error.type;
}

function sseBody(path: WirePath, error: GatewayError): string {
	const event = path === "responses-failed" ? "response.failed" : "error";
	const payload =
		path === "responses-failed"
			? {
					type: event,
					sequence_number: 0,
					response: {
						id: "resp_gateway",
						object: "response",
						created_at: 0,
						status: "failed",
						output: [],
						error: { code: responseCode(error), message: error.message },
					},
				}
			: { error };
	return `: ping\n\nevent: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

async function streamError(path: WirePath, error: GatewayError, httpStatus = 200) {
	let requests = 0;
	const fetch: FetchImpl = async () => {
		requests++;
		return new Response(httpStatus === 200 ? sseBody(path, error) : JSON.stringify({ error }), {
			status: httpStatus,
			headers: { "content-type": httpStatus === 200 ? "text/event-stream" : "application/json" },
		});
	};
	const options = { apiKey: "test-key", fetch, providerRetryWait: async () => {} };
	const stream =
		path === "completions-error"
			? streamOpenAICompletions(completionsModel, context, options)
			: streamOpenAIResponses(responsesModel, context, options);
	return { result: await stream.result(), requests };
}

function providerError(result: AssistantMessage): Error {
	return Object.assign(new Error(result.errorMessage), { status: result.errorStatus });
}

// Sanitized client messages from sub2api's stream-read, concurrency, silent-refusal,
// failover and upstream-status handlers. All wire responses here are HTTP 200.
const transients: TransientCase[] = [
	{ type: "upstream_error", code: "upstream_http2_stream_error", message: "Upstream HTTP/2 stream failed" },
	{ type: "upstream_error", code: "upstream_stream_read_error", message: "Upstream response stream was interrupted" },
	{ type: "upstream_error", code: "upstream_stream_truncated", message: "Upstream response stream ended before completion" },
	{ type: "upstream_error", code: "upstream_ws_failover_exhausted", message: "upstream websocket proxy failed" },
	{ type: "rate_limit_error", code: "gateway_queue_full", message: "Too many pending requests, please retry later" },
	{
		type: "rate_limit_error",
		code: "gateway_concurrency_limit",
		message: "Concurrency limit exceeded for account, please retry later",
	},
	{
		type: "upstream_error",
		code: "openai_silent_refusal",
		message: "Upstream returned an empty completion without usage; no fallback account was available",
	},
	// The exhausted-failover handler can omit the silent-refusal code.
	{
		type: "upstream_error",
		message: "Upstream returned an empty completion without usage; no fallback account was available",
	},
	{ type: "server_error", message: "All available accounts exhausted" },
	{ type: "api_error", message: "No available accounts" },
	{ type: "api_error", message: "Service temporarily unavailable" },
	{ type: "overloaded_error", message: "Overloaded", status: 503 },
	{ type: "server_error", message: "Upstream service overloaded, please retry later" },
	{
		type: "rate_limit_error",
		message: "All available accounts are currently rate-limited. Please retry later.",
		status: 429,
	},
	{ type: "rate_limit_error", message: "Upstream rate limit exceeded, please retry later", status: 429 },
];

for (const path of paths) {
	describe(`sub2api SSE errors: ${path}`, () => {
		for (const testCase of transients) {
			it(`retries ${testCase.code ?? testCase.type}: ${testCase.message}`, async () => {
				const { type, code, message, status } = testCase;
				const { result } = await streamError(path, { type, code, message });
				expect(result.stopReason).toBe("error");
				expect(result.errorStatus).toBe(status);
				expect(result.errorMessage).toContain(message);
				expect(AIError.isProviderRetryableError(providerError(result))).toBe(true);
				// Reclassify the persisted text without relying on an attached errorId.
				const id = AIError.classifyMessage({ errorMessage: result.errorMessage, errorStatus: result.errorStatus });
				expect(AIError.retriable(id)).toBe(true);
				expect(AIError.is(id, AIError.Flag.UsageLimit)).toBe(false);
			});
		}

		it.each([
			"upstream_http2_stream_error",
			"upstream_stream_read_error",
			"upstream_stream_truncated",
			"upstream_ws_failover_exhausted",
			"gateway_queue_full",
			"gateway_concurrency_limit",
			"openai_silent_refusal",
		])("preserves and classifies code %s without its usual message", async code => {
			const { result } = await streamError(path, { type: "upstream_error", code, message: "Transport failure" });
			expect(result.errorMessage).toContain(code);
			expect(result.errorStatus).toBeUndefined();
			expect(AIError.isProviderRetryableError(providerError(result))).toBe(true);
			expect(AIError.retriable(AIError.classifyMessage({ errorMessage: result.errorMessage }))).toBe(true);
		});

		it.each(["api key 5小时限额已用完", "api key 日限额已用完", "api key 7天限额已用完"])(
			"routes API-key quota to usage-limit rather than provider backoff: %s",
			async message => {
				const { result, requests } = await streamError(path, { type: "rate_limit_exceeded", message });
				expect(result.stopReason).toBe("error");
				expect(requests).toBe(1);
				expect(AIError.isProviderRetryableError(providerError(result))).toBe(false);
				const id = AIError.classifyMessage({ errorMessage: result.errorMessage, errorStatus: result.errorStatus });
				expect(AIError.is(id, AIError.Flag.UsageLimit)).toBe(true);
				expect(AIError.retriable(id)).toBe(true);
			},
		);

		it("keeps image balance exhaustion in the existing usage-limit lane", async () => {
			const { result, requests } = await streamError(path, {
				type: "upstream_error",
				code: "insufficient_balance",
				message: "Upstream image account has insufficient balance",
			});
			expect(requests).toBe(1);
			expect(AIError.isProviderRetryableError(providerError(result))).toBe(false);
			const id = AIError.classifyMessage({ errorMessage: result.errorMessage });
			expect(AIError.is(id, AIError.Flag.UsageLimit)).toBe(true);
			expect(AIError.retriable(id)).toBe(true);
		});

		it.each([
			"Upstream authentication failed, please contact administrator",
			"Upstream access forbidden, please contact administrator",
		])("does not replay an operator-action credential failure: %s", async message => {
			const { result, requests } = await streamError(path, { type: "upstream_error", message });
			expect(result.stopReason).toBe("error");
			expect(requests).toBe(1);
			expect(AIError.isProviderRetryableError(providerError(result))).toBe(false);
			expect(AIError.retriable(AIError.classifyMessage(result))).toBe(false);
		});

		it("keeps the actual stream-field validation error terminal without an HTTP status", async () => {
			const { result, requests } = await streamError(path, {
				type: "invalid_request_error",
				message: "invalid stream field type",
			});
			expect(result.stopReason).toBe("error");
			expect(requests).toBe(1);
			expect(result.errorStatus).toBeUndefined();
			expect(AIError.isProviderRetryableError(providerError(result))).toBe(false);
			expect(AIError.retriable(AIError.classifyMessage(result))).toBe(false);
		});

		it.each([
			{ type: "invalid_request_error", code: "not_upstream_ws_failover_exhausted", message: "invalid stream option" },
			{ type: "invalid_request_error", message: "HTTP/2 stream option is unsupported" },
			{ type: "compact_not_supported", message: "No available accounts support /responses/compact" },
		])("does not broaden a request rejection into a transport retry: $message", async error => {
			const { result } = await streamError(path, error);
			expect(AIError.isProviderRetryableError(providerError(result))).toBe(false);
			expect(AIError.retriable(AIError.classifyMessage(result))).toBe(false);
		});
	});
}

for (const path of ["completions-error", "responses-failed"] as const) {
	describe(`sub2api HTTP errors: ${path}`, () => {
		it.each([
			"Upstream authentication failed, please contact administrator",
			"Upstream access forbidden, please contact administrator",
		])("does not retry a credential failure hidden behind HTTP 502: %s", async message => {
			const { result, requests } = await streamError(path, { type: "upstream_error", message }, 502);
			expect(result.stopReason).toBe("error");
			expect(result.errorStatus).toBe(502);
			expect(requests).toBe(1);
			expect(AIError.isProviderRetryableError(providerError(result))).toBe(false);
			expect(AIError.retriable(AIError.classifyMessage(result))).toBe(false);
			expect(AIError.retriable(AIError.classifyMessage({ errorStatus: 502, errorMessage: result.errorMessage }))).toBe(
				false,
			);
			expect(
				AIError.retriable(
					AIError.classifyMessage({
						errorId: AIError.create(AIError.Flag.Transient),
						errorMessage: result.errorMessage,
					}),
				),
			).toBe(false);
		});

		it.each([400, 422])("keeps HTTP %s stream parameter errors terminal", async status => {
			const { result, requests } = await streamError(
				path,
				{ type: "invalid_request_error", message: "invalid stream field type" },
				status,
			);
			expect(requests).toBe(1);
			expect(AIError.isProviderRetryableError(providerError(result))).toBe(false);
			expect(AIError.retriable(AIError.classifyMessage(result))).toBe(false);
		});
	});
}
