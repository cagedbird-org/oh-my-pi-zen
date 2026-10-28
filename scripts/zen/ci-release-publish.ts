#!/usr/bin/env bun
/** Publish only an already-prepared release plan. npm performs the OIDC exchange. */
import * as path from "node:path";
import { $ } from "bun";
import { registryManifest, releaseNames, type ReleasePlan } from "./release";

const root = path.resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("Usage: bun scripts/zen/ci-release-publish.ts <staging-directory>");
if (
	process.env.NODE_AUTH_TOKEN ||
	process.env.NPM_TOKEN ||
	process.env.npm_config_token ||
	process.env.NPM_CONFIG_TOKEN
) {
	throw new Error("Zen publishing requires OIDC, not a token environment variable");
}
const npmVersion = (await $`npm --version`.quiet()).text().trim().split(".").map(Number);
if (npmVersion[0] < 11 || (npmVersion[0] === 11 && npmVersion[1] < 5))
	throw new Error("npm >= 11.5 is required for trusted publishing");
const plan = (await Bun.file(path.join(root, "release-plan.json")).json()) as ReleasePlan;
if (
	plan.packages.length !== releaseNames.size ||
	new Set(plan.packages.map(pkg => pkg.name)).size !== releaseNames.size
)
	throw new Error("Incomplete release plan");
for (const pkg of plan.packages) {
	if (!releaseNames.has(pkg.name) || pkg.version !== plan.version || !pkg.tarball)
		throw new Error(`Invalid release entry ${pkg.name}`);
	if (await registryManifest(pkg.name, pkg.version)) {
		console.log(`Skipping ${pkg.name}@${pkg.version}: already published`);
		continue;
	}
	await $`npm publish ${path.join(root, pkg.tarball)} --ignore-scripts --tag latest --access public`.cwd(root);
}
