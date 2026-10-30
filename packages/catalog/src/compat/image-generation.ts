import type { Model } from "../types";
import { isRecord } from "../utils";
import { resolveCatalogPolicy } from "./catalog-policy";

/** Wire differences authored in KDL, independent of a deployment's name. */
export function imageGenerationPolicy(model: Model): {
	responseFormat: boolean;
	editEncoding: "json" | "multipart" | "xai";
	geometry: "size" | "resolution";
	maxReferences?: number;
	promptShape: boolean;
	supportsBackground: boolean;
	outputFormat?: string;
	quality: Partial<Record<"low" | "medium" | "high", string>>;
	defaultQuality?: string;
} {
	const value = resolveCatalogPolicy(model).imageGeneration;
	const policy = isRecord(value) ? value : {};
	return {
		responseFormat: policy.responseFormat !== false,
		editEncoding: policy.editEncoding === "multipart" || policy.editEncoding === "xai" ? policy.editEncoding : "json",
		geometry: policy.geometry === "resolution" ? "resolution" : "size",
		maxReferences: typeof policy.maxReferences === "number" ? policy.maxReferences : undefined,
		promptShape: policy.promptShape === true,
		supportsBackground: policy.supportsBackground === true,
		outputFormat: typeof policy.outputFormat === "string" ? policy.outputFormat : undefined,
		quality: policy.supportsQuality === true ? {
			...(typeof policy.qualityLow === "string" ? { low: policy.qualityLow } : {}),
			...(typeof policy.qualityMedium === "string" ? { medium: policy.qualityMedium } : {}),
			...(typeof policy.qualityHigh === "string" ? { high: policy.qualityHigh } : {}),
		} : {},
		defaultQuality: policy.supportsQuality === true && typeof policy.defaultQuality === "string" ? policy.defaultQuality : undefined,
	};
}
