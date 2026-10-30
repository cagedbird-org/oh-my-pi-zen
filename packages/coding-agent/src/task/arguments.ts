import type { TaskParams } from "@oh-my-pi/pi-tui/tools/task";
import { isRecord } from "@oh-my-pi/pi-utils";
import { seanceTaskSchemaFields } from "./seance";
import { getTaskSchema } from "./types";

const optionalFields = new Map<boolean, Map<string, unknown>>();

function taskOptionalFields(fileEnabled: boolean): Map<string, unknown> {
	const cached = optionalFields.get(fileEnabled);
	if (cached) return cached;
	// Include gated fields so stale/internal calls get the same cleanup without
	// losing non-empty values that the runtime must still reject.
	const schema = getTaskSchema({
		batchEnabled: false,
		isolationEnabled: true,
		effortEnabled: true,
		file: fileEnabled,
		seanceFields: seanceTaskSchemaFields,
	}).toJsonSchema();
	const required = new Set(Array.isArray(schema.required) ? schema.required : []);
	const fields = new Map<string, unknown>();
	if (isRecord(schema.properties)) {
		for (const [key, property] of Object.entries(schema.properties)) {
			if (!required.has(key)) fields.set(key, property);
		}
	}
	optionalFields.set(fileEnabled, fields);
	return fields;
}

function acceptsArray(schema: unknown): boolean {
	if (!isRecord(schema)) return false;
	if (schema.type === "array") return true;
	return Array.isArray(schema.anyOf) && schema.anyOf.some(acceptsArray);
}

function omitPlaceholders(value: unknown, fields: Map<string, unknown>): unknown {
	if (!isRecord(value)) return value;
	let cleaned: Record<string, unknown> | undefined;
	for (const [key, schema] of fields) {
		if (!Object.hasOwn(value, key)) continue;
		const item = value[key];
		if (
			item === undefined ||
			item === null ||
			(typeof item === "string" && item.trim() === "") ||
			(Array.isArray(item) && item.length === 0 && acceptsArray(schema))
		) {
			cleaned ??= { ...value };
			delete cleaned[key];
		}
	}
	return cleaned ?? value;
}

/**
 * Restore omitted optional arguments before task's semantic checks, including
 * lenient-validation fallbacks and streamed batch items. Required fields and
 * non-empty invalid values are never erased. False booleans and empty objects
 * remain explicit values (e.g. isolation opt-out and the valid {} output schema).
 */
export function omitUnusedTaskArgs(params: TaskParams, fileEnabled: boolean): TaskParams {
	const fields = taskOptionalFields(fileEnabled);
	const cleaned = omitPlaceholders(params, fields) as TaskParams;
	if (!isRecord(cleaned) || !Array.isArray(cleaned.tasks)) return cleaned;
	let tasks: TaskParams["tasks"];
	for (let index = 0; index < cleaned.tasks.length; index++) {
		const item = cleaned.tasks[index];
		const next = omitPlaceholders(item, fields);
		if (next === item) continue;
		tasks ??= cleaned.tasks.slice();
		tasks[index] = next as typeof item;
	}
	return tasks ? { ...cleaned, tasks } : cleaned;
}
