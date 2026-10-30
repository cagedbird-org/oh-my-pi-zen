import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { type GeneratedImage, generateImage, type ImageGenerationRequest, type ImageGenerationResult, isImageGenerationApi, type Model } from "@oh-my-pi/pi-ai";
import { getEffectiveTokenCost } from "@oh-my-pi/pi-catalog/models";
import { isEnoent, parseImageMetadata, prompt, ptree, untilAborted } from "@oh-my-pi/pi-utils";
import { resolveRoleChain } from "../../config/model-resolver";
import { roleCandidatePool } from "../../config/model-roles";
import { isAuthenticated, type ModelRegistry } from "../../config/model-registry";
import { settings } from "../../config/settings";
import type { CustomTool } from "../../extensibility/custom-tools/types";
import imageGenDescription from "../../prompts/tools/image-gen.md" with { type: "text" };
import { resolveReadPath, specialFileKind } from "../path-utils";

const MAX_IMAGE_SIZE = 35 * 1024 * 1024;
export const imageGenSchema = type({
	prompt: type("string > 0").describe("Natural-language description of the finished image, or precise editing instructions"),
	"input?": type({ path: type("string > 0").describe("Local reference image path, numbered in array order") }).array(),
	"background?": type('"transparent" | "opaque" | "auto"').describe("Use transparent for cutouts, sprites, icons and game assets"),
	"count?": type("1 | 2 | 3 | 4").describe("Number of images; default 1"),
	"size?": type("string").narrow((value, ctx) => /^(square|landscape|portrait|[1-9][0-9]*x[1-9][0-9]*)$/.test(value) || ctx.mustBe("square, landscape, portrait, or WIDTHxHEIGHT")).describe("square (1024x1024), landscape (1536x1024), portrait (1024x1536), or WIDTHxHEIGHT"),
	"quality?": type('"low" | "medium" | "high"').describe("Requested quality; default high. Actual returned quality is reported separately"),
});
export type ImageGenParams = typeof imageGenSchema.infer;
interface ImageGenToolDetails {
	provider: string;
	model: string;
	imageCount: number;
	imagePaths: string[];
	images: GeneratedImage[];
	failures: Array<{ model: string; reason: string }>;
	responseText?: string;
	usage: ImageGenerationResult["usage"];
}

async function loadImage(imagePath: string, cwd: string): Promise<{ data: string; mimeType: string }> {
	const resolved = resolveReadPath(imagePath, cwd);
	try {
		const stat = await fs.stat(resolved);
		const kind = specialFileKind(stat);
		if (kind) throw new Error(`Cannot load '${imagePath}': it is a ${kind}, not a regular file or directory.`);
		if (stat.size > MAX_IMAGE_SIZE) throw new Error(`Image file too large: ${imagePath}`);
		const bytes = await Bun.file(resolved).bytes();
		if (bytes.length > MAX_IMAGE_SIZE) throw new Error(`Image file too large: ${imagePath}`);
		const metadata = parseImageMetadata(bytes);
		if (!metadata) throw new Error(`Unsupported image type: ${imagePath}`);
		return { data: bytes.toBase64(), mimeType: metadata.mimeType };
	} catch (error) {
		if (isEnoent(error)) throw new Error(`Image file not found: ${imagePath}`);
		throw error;
	}
}

function hostedCarrier(registry: ModelRegistry, selected: Model, active?: Model): Model | undefined {
	if (selected.hostedImage) return selected;
	if (active?.provider === selected.provider && active.hostedImage) return active;
	let carrier: Model | undefined;
	for (const model of registry.getAvailable()) {
		if (model.provider !== selected.provider || !model.hostedImage) continue;
		if (!carrier || getEffectiveTokenCost(model.cost).input < getEffectiveTokenCost(carrier.cost).input) carrier = model;
	}
	return carrier;
}

export const imageGenTool: CustomTool<typeof imageGenSchema, ImageGenToolDetails> = {
	name: "generate_image",
	label: "GenerateImage",
	strict: false,
	approval: "write",
	description: prompt.render(imageGenDescription),
	parameters: imageGenSchema,
	async execute(_toolCallId, params, _onUpdate, ctx, signal) {
		return untilAborted(signal, async () => {
			const effectiveSettings = ctx.settings ?? settings;
			const pool = roleCandidatePool("image", effectiveSettings, ctx.modelRegistry);
			const candidates = resolveRoleChain("image", effectiveSettings, pool);
			const inputImages = await Promise.all((params.input ?? []).map(image => loadImage(image.path, ctx.sessionManager.getCwd())));
			const presets: Record<string, string> = { square: "1024x1024", landscape: "1536x1024", portrait: "1024x1536" };
			const size = presets[params.size ?? "square"] ?? params.size;
			const request: ImageGenerationRequest = { prompt: params.prompt, inputImages, imageSize: size, background: params.background ?? "auto", quality: params.quality ?? "high", count: params.count ?? 1 };
			const failures: ImageGenToolDetails["failures"] = [];
			const errors: unknown[] = [];
			const sessionId = ctx.sessionManager.getSessionId();
			for (const candidate of candidates) {
				const model = candidate.model;
				if (candidate.replaces) failures.push({ model: candidate.replaces, reason: "Configured model unavailable" });
				const modelName = `${model.provider}/${model.id}`;
				const requestSignal = ptree.combineSignals(signal, 3 * 60 * 1000);
				let generated: ImageGenerationResult;
				try {
					if (!isImageGenerationApi(model.api)) throw new Error(`Unsupported image API: ${model.api}`);
					if (params.background === "transparent" && model.api !== "openai-images" && model.api !== "openai-responses" && model.api !== "openai-codex-responses") throw new Error(`Image API ${model.api} cannot guarantee transparent backgrounds`);
					const carrier = model.api === "openai-responses" || model.api === "openai-codex-responses" ? hostedCarrier(ctx.modelRegistry, model, ctx.model) : undefined;
					if ((model.api === "openai-responses" || model.api === "openai-codex-responses") && !carrier) throw new Error("Hosted chat carrier unavailable");
					const credentialModel = carrier ?? model;
					if (!isAuthenticated(await ctx.modelRegistry.getApiKey(credentialModel, sessionId, { signal: requestSignal }))) throw new Error("Credentials unavailable");
					const resolved = { ...model, resolveHeaders: (headerSignal?: AbortSignal) => ctx.modelRegistry.resolveModelHeaders(model, headerSignal) };
					const resolvedCarrier = carrier ? { ...carrier, resolveHeaders: (headerSignal?: AbortSignal) => ctx.modelRegistry.resolveModelHeaders(carrier, headerSignal) } : undefined;
					generated = await generateImage(resolved, request, { apiKey: ctx.modelRegistry.resolver(credentialModel, sessionId), fetch: ctx.fetch ?? fetch, signal: requestSignal, carrier: resolvedCarrier, sessionId });
					if (generated.images.length !== request.count) throw new Error(`Expected ${request.count} image(s); received ${generated.images.length}`);
				} catch (error) {
					if (signal?.aborted) throw error;
					errors.push(error);
					failures.push({ model: modelName, reason: error instanceof Error ? error.message : String(error) });
					continue;
				}
				const images = generated.images;
				const imagePaths = await Promise.all(images.map(async image => {
					const bytes = Buffer.from(image.data, "base64");
					const metadata = parseImageMetadata(bytes);
					if (metadata) image.mimeType = metadata.mimeType;
					if (metadata?.width && metadata.height) image.size = `${metadata.width}x${metadata.height}`;
					const extensions: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
					const filepath = path.join(os.tmpdir(), `omp-image-${crypto.randomUUID()}.${extensions[image.mimeType] ?? "png"}`);
					await fs.writeFile(filepath, bytes, { flag: "wx" });
					return filepath;
				}));
				const usage = generated.usage;
				const ranModel = generated.model ?? model.id;
				const lines = [
					`Provider: ${model.provider}`,
					`Model: ${ranModel}`,
					`Generated ${images.length} image(s):`,
					...imagePaths.map((filepath, index) => `${filepath} (${images[index]!.size ?? "size unreported"}, quality ${images[index]!.quality ?? "unreported"})`),
				];
				if (failures.length) lines.push(`Completed by ${modelName} after ${failures.map(failure => `${failure.model} failed: ${failure.reason}`).join("; ")}`);
				const text = generated.text;
				if (text) lines.push(text);
				const result: AgentToolResult<ImageGenToolDetails, ImageGenParams> = {
					content: [{ type: "text", text: lines.join("\n") }],
					details: { provider: model.provider, model: ranModel, imageCount: images.length, imagePaths, images, failures, usage, responseText: text || undefined },
				};
				return result;
			}
			throw new AggregateError(errors, `Image generation exhausted the resolved image chain. ${failures.map(failure => `${failure.model}: ${failure.reason}`).join("; ")}`);
		});
	},
};

export async function getImageGenTools(_modelRegistry?: ModelRegistry, _activeModel?: Model): Promise<Array<CustomTool<typeof imageGenSchema, ImageGenToolDetails>>> {
	return [imageGenTool];
}
export async function getImageGenToolsWithRegistry(_modelRegistry: ModelRegistry, _activeModel?: Model): Promise<Array<CustomTool<typeof imageGenSchema, ImageGenToolDetails>>> {
	return [imageGenTool];
}
