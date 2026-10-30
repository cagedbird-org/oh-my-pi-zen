import { imageGenerationPolicy } from "@oh-my-pi/pi-catalog/compat/image-generation";
import type { Model } from "@oh-my-pi/pi-catalog/types";
import * as AIError from "../error";
import { resolveXaiBaseUrl } from "../providers/xai-base-url";
import { decodeImageResponse, imageBaseUrl, postJson, postMultipart, resolveOpenAIImageSize, toDataUrl, validateImageInput } from "./shared";
import type { ImageGenerationOptions, ImageGenerationRequest, ImageGenerationResult } from "./types";

export const XAI_MAX_EDIT_IMAGES = 3;

export function resolveXAIResolution(imageSize?: string): "1k" | "2k" {
	return !imageSize || imageSize === "1024x1024" ? "1k" : "2k";
}

export async function generateOpenAIImage(model: Model, request: ImageGenerationRequest, options: ImageGenerationOptions): Promise<ImageGenerationResult> {
	const fetchImpl = options.fetch ?? fetch;
	const policy = imageGenerationPolicy(model);
	if (request.background === "transparent" && !policy.supportsBackground) throw new AIError.ValidationError(`Image model ${model.provider}/${model.id} does not support transparent backgrounds`);
	const size = resolveOpenAIImageSize(request.aspectRatio, request.imageSize);
	const inputImages = request.inputImages ?? [];
	if (policy.maxReferences !== undefined && inputImages.length > policy.maxReferences) {
		throw new AIError.ValidationError(`${model.provider} image edits accept up to ${policy.maxReferences} reference images; got ${inputImages.length}`);
	}
	const baseUrl = imageBaseUrl(model);
	const endpoint = (route: string) => policy.geometry === "resolution"
		? (bearer: string) => `${resolveXaiBaseUrl(model.provider, baseUrl, bearer) ?? baseUrl}${route}`
		: `${baseUrl}${route}`;
	const quality = request.quality ? policy.quality[request.quality] : policy.defaultQuality;
	const body = {
		model: model.requestModelId ?? model.id,
		prompt: request.prompt,
		...(policy.responseFormat ? { response_format: "b64_json" } : {}),
		...(policy.geometry === "resolution"
			? { aspect_ratio: request.aspectRatio ?? "1:1", resolution: resolveXAIResolution(request.imageSize) }
			: { ...(size ? { size } : {}) }),
		...(policy.supportsBackground ? { background: request.background ?? "auto" } : {}),
		...(quality ? { quality } : {}),
		...(policy.outputFormat ? { output_format: policy.outputFormat } : {}),
	};
	let response: unknown;
	if (inputImages.length && policy.editEncoding === "multipart") {
		const form = new FormData();
		for (const [key, value] of Object.entries(body)) form.set(key, String(value));
		for (const image of inputImages) {
			validateImageInput(image);
			form.append("image", new File([Buffer.from(image.data, "base64")], "image", { type: image.mimeType }));
		}
		response = await postMultipart({ model, url: endpoint("/images/edits"), body: form, apiKey: options.apiKey, fetch: fetchImpl, signal: options.signal });
	} else {
		const references = inputImages.map(image => ({ image_url: toDataUrl(image) }));
		const edit = policy.editEncoding === "xai"
			? references.length === 1 ? { image: { type: "image_url", url: references[0]!.image_url } } : { images: references.map(image => ({ type: "image_url", url: image.image_url })) }
			: { images: references };
		response = await postJson({ model, url: endpoint(inputImages.length ? "/images/edits" : "/images/generations"), body: { ...body, ...(inputImages.length ? edit : {}) }, apiKey: options.apiKey, fetch: fetchImpl, signal: options.signal });
	}
	return decodeImageResponse(response, fetchImpl, options.signal);
}
