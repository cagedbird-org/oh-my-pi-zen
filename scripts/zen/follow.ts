#!/usr/bin/env bun
/**
 * Upstream tag following for zen/main.
 *
 *   bun scripts/zen/follow.ts select [--ref zen/main] [--upstream <url>]
 *
 * Prints `base=<tag>` and, when a newer upstream tag exists, `next=<tag>` (one
 * tag per run, in semver order). Only plain `vX.Y.Z` tags count.
 */
import { $ } from "bun";

const PLAIN_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

function key(tag: string): [number, number, number] {
	const match = PLAIN_TAG.exec(tag);
	if (!match) throw new Error(`Not a plain release tag: ${tag}`);
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareTags(a: string, b: string): number {
	const ka = key(a);
	const kb = key(b);
	return ka[0] - kb[0] || ka[1] - kb[1] || ka[2] - kb[2];
}

export function plainTags(tags: readonly string[]): string[] {
	return tags.filter(tag => PLAIN_TAG.test(tag)).sort(compareTags);
}

/** Newest plain tag among `ancestors` (tags reachable from the zen branch). */
export function baseTag(ancestors: readonly string[]): string {
	const tags = plainTags(ancestors);
	const base = tags.at(-1);
	if (!base) throw new Error("No plain vX.Y.Z upstream tag is an ancestor of the zen branch");
	return base;
}

/** The first plain tag strictly newer than `base`, or undefined. */
export function nextTag(upstream: readonly string[], base: string): string | undefined {
	return plainTags(upstream).find(tag => compareTags(tag, base) > 0);
}

async function lines(cmd: Promise<{ text(): string }>): Promise<string[]> {
	return (await cmd)
		.text()
		.split("\n")
		.map(l => l.trim())
		.filter(Boolean);
}

if (import.meta.main) {
	const [command, ...rest] = process.argv.slice(2);
	if (command !== "select") throw new Error("usage: follow.ts select [--ref <branch>] [--upstream <url>]");
	const arg = (name: string, fallback: string) => {
		const i = rest.indexOf(name);
		return i === -1 ? fallback : (rest[i + 1] ?? fallback);
	};
	const ref = arg("--ref", "zen/main");
	const upstreamUrl = arg("--upstream", "https://github.com/can1357/oh-my-pi.git");
	const ancestors = await lines($`git tag --merged ${ref}`.quiet());
	const base = baseTag(ancestors);
	const remote = await lines($`git ls-remote --tags --refs ${upstreamUrl} ${"refs/tags/v*"}`.quiet());
	const upstream = remote.map(line => line.split("\t")[1]?.replace("refs/tags/", "") ?? "");
	const next = nextTag(upstream, base);
	console.log(`base=${base}`);
	if (next) console.log(`next=${next}`);
}
