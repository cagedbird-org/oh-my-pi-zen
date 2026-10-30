import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { generateOpenAIImage } from "../src/images/openai-images";
import type { FetchImpl } from "../src/types";

const IMAGE_DATA = Buffer.from("image bytes").toString("base64");
const INPUT_IMAGE = { data: IMAGE_DATA, mimeType: "image/png" };

function imageModel(provider: string, id: string) {
	return buildModel({
		id,
		name: id,
		api: "openai-images",
		provider,
		baseUrl: `https://${provider}.example/v1`,
		kind: "image",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
	} satisfies ModelSpec<"openai-images">);
}

function imageResponse(status = 200): Response {
	const body =
		status === 200
			? { data: [{ b64_json: IMAGE_DATA }] }
			: { error: { message: "UnsupportedParamsError: response_format is not supported" } };
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("OpenAI-compatible image response_format", () => {
	test("GPT Image generation of a dated snapshot succeeds through a strict gateway", async () => {
		const model = imageModel("gateway", "gpt-image-2.5-2026-08-01");
		let body: Record<string, unknown> | undefined;
		const fetch: FetchImpl = async (_input, init) => {
			const requestBody: Record<string, unknown> = JSON.parse(String(init?.body));
			body = requestBody;
			const valid = !("response_format" in requestBody) && requestBody.background === "transparent" && requestBody.output_format === "png" && requestBody.quality === "high";
			return imageResponse(valid ? 200 : 400);
		};

		const result = await generateOpenAIImage(model, { prompt: "a cat", background: "transparent" }, { apiKey: "test", fetch });

		expect(body?.model).toBe("gpt-image-2.5-2026-08-01");
		expect(body).not.toHaveProperty("response_format");
		expect(body).toMatchObject({ background: "transparent", quality: "high", output_format: "png" });
		expect(result.images[0]?.data).toBe(IMAGE_DATA);
	});

	test("ChatGPT Image JSON edits omit the unsupported parameter", async () => {
		const model = imageModel("gateway", "chatgpt-image-latest");
		let body: Record<string, unknown> | undefined;
		const fetch: FetchImpl = async (_input, init) => {
			const requestBody: Record<string, unknown> = JSON.parse(String(init?.body));
			body = requestBody;
			return imageResponse("response_format" in requestBody ? 400 : 200);
		};

		const result = await generateOpenAIImage(
			model,
			{ prompt: "paint this", inputImages: [INPUT_IMAGE] },
			{ apiKey: "test", fetch },
		);

		expect(body?.images).toEqual([{ image_url: `data:image/png;base64,${IMAGE_DATA}` }]);
		expect(body).not.toHaveProperty("response_format");
		expect(result.images[0]?.data).toBe(IMAGE_DATA);
	});

	test("OpenAI GPT Image multipart edits omit the unsupported form field", async () => {
		const model = imageModel("openai", "gpt-image-1");
		let form: FormData | undefined;
		const fetch: FetchImpl = async (_input, init) => {
			if (!(init?.body instanceof FormData)) throw new Error("Expected multipart image edit");
			form = init.body;
			return imageResponse(form.has("response_format") ? 400 : 200);
		};

		const result = await generateOpenAIImage(
			model,
			{ prompt: "paint this", inputImages: [INPUT_IMAGE] },
			{ apiKey: "test", fetch },
		);

		expect(form?.get("model")).toBe("gpt-image-1");
		expect(form?.get("image")).toBeInstanceOf(File);
		expect(form?.has("response_format")).toBe(false);
		expect(result.images[0]?.data).toBe(IMAGE_DATA);
	});

	test("non-GPT image generation and JSON edits retain response_format", async () => {
		const model = imageModel("gateway", "flux-1");
		const bodies: Array<Record<string, unknown>> = [];
		const fetch: FetchImpl = async (_input, init) => {
			bodies.push(JSON.parse(String(init?.body)));
			return imageResponse();
		};

		await generateOpenAIImage(model, { prompt: "a cat" }, { apiKey: "test", fetch });
		await generateOpenAIImage(model, { prompt: "paint", inputImages: [INPUT_IMAGE] }, { apiKey: "test", fetch });

		expect(bodies[0]?.response_format).toBe("b64_json");
		expect(bodies[1]?.response_format).toBe("b64_json");
	});

	test("xAI image generation retains response_format", async () => {
		const model = imageModel("xai", "grok-imagine-image");
		let body: Record<string, unknown> | undefined;
		const fetch: FetchImpl = async (_input, init) => {
			body = JSON.parse(String(init?.body));
			return imageResponse();
		};

		await generateOpenAIImage(model, { prompt: "a cat" }, { apiKey: "test", fetch });

		expect(body?.response_format).toBe("b64_json");
		expect(body?.resolution).toBe("1k");
	});

	test("DALL-E multipart edits omit unsupported rendering fields", async () => {
		const model = imageModel("openai", "dall-e-2");
		let form: FormData | undefined;
		const fetch: FetchImpl = async (_input, init) => {
			if (!(init?.body instanceof FormData)) throw new Error("Expected multipart image edit");
			form = init.body;
			const allowed: Record<string, true> = { model: true, prompt: true, response_format: true, size: true, image: true };
			const valid = [...form.keys()].every(key => Object.hasOwn(allowed, key));
			return imageResponse(valid ? 200 : 400);
		};

		await generateOpenAIImage(model, { prompt: "paint", inputImages: [INPUT_IMAGE], quality: "high", background: "opaque" }, { apiKey: "test", fetch });

		expect(form?.get("response_format")).toBe("b64_json");
		expect(form?.has("quality")).toBe(false);
		expect(form?.has("background")).toBe(false);
		expect(form?.has("output_format")).toBe(false);
	});
	for (const id of ["dall-e-2", "dall-e-3"]) {
		test(`${id} generation defaults omit unsupported rendering fields`, async () => {
			const model = imageModel("gateway", id);
			let body: Record<string, unknown> | undefined;
			const fetch: FetchImpl = async (_input, init) => {
				body = JSON.parse(String(init?.body));
				const allowed: Record<string, true> = { model: true, prompt: true, response_format: true, size: true };
				return imageResponse(Object.keys(body!).every(key => Object.hasOwn(allowed, key)) ? 200 : 400);
			};
			await generateOpenAIImage(model, { prompt: "a cat" }, { apiKey: "test", fetch });
			expect(body).not.toHaveProperty("background");
			expect(body).not.toHaveProperty("output_format");
			expect(body).not.toHaveProperty("quality");
		});
	}
	for (const provider of ["gateway", "openai"]) {
		for (const [quality, expected] of [["low", "standard"], ["medium", "standard"], ["high", "hd"]] as const) {
			test(`${provider} DALL-E 3 maps ${quality} quality to ${expected}`, async () => {
				const model = imageModel(provider, "dall-e-3");
				let body: Record<string, unknown> | undefined;
				const fetch: FetchImpl = async (_input, init) => {
					body = JSON.parse(String(init?.body));
					return imageResponse(body?.quality === expected && !("background" in body!) && !("output_format" in body!) ? 200 : 400);
				};
				await generateOpenAIImage(model, { prompt: "a cat", quality, background: "opaque" }, { apiKey: "test", fetch });
				expect(body?.quality).toBe(expected);
			});
		}
	}
});
