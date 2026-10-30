#!/usr/bin/env bun
import * as fs from "node:fs/promises";
import * as path from "node:path";

export const workspacePackages = [
	"pi-utils",
	"pi-wire",
	"omptype",
	"pi-catalog",
	"pi-ai",
	"pi-natives",
	"pi-tui",
	"pi-mnemopi",
	"snapcompact",
	"omp-stats",
	"pi-agent-core",
	"pi-coding-agent",
] as const;
export const nativeTags = ["linux-x64", "darwin-arm64", "linux-arm64", "android-arm64"] as const;
export const collabWebName = "@oh-my-pi-zen/collab-web";
export const collabRelayName = "@oh-my-pi-zen/collab-relay-linux-x64";
export const releaseNames = new Set<string>([
	...workspacePackages.map(name => `@oh-my-pi-zen/${name}`),
	...nativeTags.map(tag => `@oh-my-pi-zen/pi-natives-${tag}`),
	collabWebName,
	collabRelayName,
]);
export interface Manifest {
	name: string;
	version: string;
	private?: boolean;
	license?: string;
	scripts?: Record<string, string>;
	omp?: { rename?: unknown; [key: string]: unknown };
	repository?: string | { type?: string; url?: string; directory?: string };
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	[key: string]: unknown;
}
export interface ReleasePackage {
	name: string;
	version: string;
	dir: string;
	tarball?: string;
}
export interface ReleasePlan {
	version: string;
	packages: ReleasePackage[];
}
export const dependencyFields = [
	"dependencies",
	"devDependencies",
	"optionalDependencies",
	"peerDependencies",
] as const;

/** The slash boundary deliberately leaves the already-renamed scope untouched. */
export function rewriteZenText(text: string): string {
	return text.replaceAll("@oh-my-pi/", "@oh-my-pi-zen/");
}

export function transformManifest(manifest: Manifest, version: string, catalog: Record<string, string>): Manifest {
	const result = JSON.parse(rewriteZenText(JSON.stringify(manifest))) as Manifest;
	if (releaseNames.has(result.name)) {
		result.version = version;
		result.repository = {
			...(typeof result.repository === "object" ? result.repository : { type: "git" }),
			url: "git+https://github.com/cagedbird-org/oh-my-pi-zen.git",
		};
	}
	if (result.omp) delete result.omp.rename;
	for (const field of dependencyFields) {
		const dependencies = result[field];
		if (!dependencies) continue;
		for (const [name, range] of Object.entries(dependencies)) {
			if (
				result.name === "@oh-my-pi-zen/pi-natives" &&
				name.startsWith("@oh-my-pi-zen/pi-natives-") &&
				!releaseNames.has(name)
			) {
				delete dependencies[name];
			} else if (releaseNames.has(name)) {
				dependencies[name] = version;
			} else if (range === "catalog:") {
				const resolved = catalog[name];
				if (!resolved) throw new Error(`Missing catalog dependency ${name}`);
				dependencies[name] = resolved;
			} else if (name.startsWith("@oh-my-pi-zen/") && !result.private) {
				throw new Error(`Unapproved internal dependency ${name} in ${result.name}`);
			}
		}
	}
	return result;
}

export function zenVersion(upstream: string, number: string, latest?: string): string {
	if (!/^\d+\.\d+\.\d+$/.test(upstream)) throw new Error(`Expected stable upstream version, got ${upstream}`);
	const previous = latest?.match(/^(\d+\.\d+\.\d+)-zen\.([1-9]\d*)$/);
	const next = number || String(previous?.[1] === upstream ? Number(previous[2]) + 1 : 1);
	if (!/^[1-9]\d*$/.test(next) || !Number.isSafeInteger(Number(next)))
		throw new Error(`Invalid zen release number: ${next}`);
	return `${upstream}-zen.${next}`;
}

export async function registryManifest(name: string, version: string): Promise<{ version: string } | undefined> {
	const response = await fetch(
		`https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`,
	);
	if (response.status === 404) return undefined;
	if (!response.ok) throw new Error(`npm lookup ${name}@${version}: HTTP ${response.status}`);
	return (await response.json()) as { version: string };
}

export async function* walkFiles(dir: string): AsyncGenerator<string> {
	for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
		if (["node_modules", ".git", "zen"].includes(entry.name)) continue;
		const file = path.join(dir, entry.name);
		if (entry.isDirectory()) yield* walkFiles(file);
		else if (entry.isFile()) yield file;
	}
}

export function publishOrder(packages: ReleasePackage[], manifests: Map<string, Manifest>): ReleasePackage[] {
	const pending = new Map(packages.map(pkg => [pkg.name, pkg]));
	const result: ReleasePackage[] = [];
	while (pending.size) {
		const next = [...pending.values()].find(pkg => {
			if (pkg.name.endsWith("/pi-coding-agent") && pending.size > 1) return false;
			const manifest = manifests.get(pkg.name)!;
			return ["dependencies", "optionalDependencies", "peerDependencies"].every(field =>
				Object.keys((manifest[field] as Record<string, string>) ?? {}).every(name => !pending.has(name)),
			);
		});
		if (!next) throw new Error(`Cyclic release dependencies: ${[...pending.keys()].join(", ")}`);
		pending.delete(next.name);
		result.push(next);
	}
	return result;
}

/** npm 11 returns an array; npm 12 keys pack results by package name. */
export function packedFilename(json: string): string {
	const parsed = JSON.parse(json) as { filename: string }[] | Record<string, { filename: string }>;
	const entries = Array.isArray(parsed) ? parsed : Object.values(parsed);
	if (entries.length !== 1 || typeof entries[0]?.filename !== "string")
		throw new Error("Expected one npm pack result");
	return entries[0].filename;
}

/** Mirror sync is advisory: npm publication remains successful if it is unavailable. */
export async function syncPublishedPackages(names: Iterable<string>): Promise<void> {
	for (const name of names) {
		try {
			const response = await fetch(`https://registry.npmmirror.com/-/package/${name}/syncs`, {
				method: "PUT",
				signal: AbortSignal.timeout(10_000),
			});
			const result = response.ok ? ((await response.json()) as { ok?: boolean }) : null;
			if (!result?.ok) throw new Error(`HTTP ${response.status}`);
			console.log(`Requested npmmirror sync: ${name}`);
		} catch (error) {
			console.warn(`npmmirror sync skipped for ${name}: ${error}`);
		}
	}
}
