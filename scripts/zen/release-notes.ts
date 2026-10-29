#!/usr/bin/env bun
import * as path from "node:path";

/** Render one release body without its version heading; missing first releases follow upstream. */
export function releaseNotes(version: string, changelog: string): string {
	const match = version.match(/^(\d+\.\d+\.\d+)-zen\.([1-9]\d*)$/);
	if (!match) throw new Error(`Invalid zen version: ${version}; expected X.Y.Z-zen.N`);
	const [, upstream, number] = match;
	const sections = changelog.split(/^## /m).slice(1);
	const section = sections.find(section => section.split("\n", 1)[0].match(/^\[([^\]]+)\](?:\s|$)/)?.[1] === version);
	let body: string;
	if (section !== undefined) {
		body = section.split("\n").slice(1).join("\n").trim();
	} else if (number === "1") {
		body = `无 zen 功能变化，跟进上游 ${upstream}。 / No zen changes; follows upstream ${upstream}.`;
	} else {
		throw new Error(
			`Missing zen/CHANGELOG.md section for ${version}; refusing to publish zen.N > 1 without release notes`,
		);
	}
	const link = `[oh-my-pi ${upstream}](https://github.com/can1357/oh-my-pi/releases/tag/v${upstream})`;
	return `${body}\n\n基于上游 ${link} / Based on upstream ${link}\n`;
}

if (import.meta.main) {
	try {
		const version = process.argv[2];
		if (!version) throw new Error("Usage: bun scripts/zen/release-notes.ts <X.Y.Z-zen.N>");
		process.stdout.write(
			releaseNotes(version, await Bun.file(path.join(import.meta.dir, "../../zen/CHANGELOG.md")).text()),
		);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
