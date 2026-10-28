#!/usr/bin/env bun
/** OIDC for the established packages; scoped token auth only for collab-web. */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import { npmPublishEnvironment } from "./publish-auth";
import { registryManifest, releaseNames, syncPublishedPackages, type ReleasePlan } from "./release";

const root = path.resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("Usage: bun scripts/zen/ci-release-publish.ts <staging-directory>");
const plan = (await Bun.file(path.join(root, "release-plan.json")).json()) as ReleasePlan;
if (
	plan.packages.length !== releaseNames.size ||
	new Set(plan.packages.map(pkg => pkg.name)).size !== releaseNames.size
)
	throw new Error("Incomplete release plan");
for (const pkg of plan.packages) {
	if (!releaseNames.has(pkg.name) || pkg.version !== plan.version || !pkg.tarball)
		throw new Error(`Invalid release entry ${pkg.name}`);
}
const configDir = await fs.mkdtemp(path.join(os.tmpdir(), "zen-npm-auth-"));
const published = new Set<string>();
try {
	await Bun.write(path.join(configDir, "global.npmrc"), "");
	await Bun.write(path.join(configDir, "oidc.npmrc"), "");
	await Bun.write(path.join(configDir, "token.npmrc"), `//registry.npmjs.org/:_authToken=\${NODE_AUTH_TOKEN}\n`);
	const npmVersion = (await $`npm --version`.env(npmPublishEnvironment("", process.env, configDir)).quiet())
		.text()
		.trim()
		.split(".")
		.map(Number);
	if (npmVersion[0] < 11 || (npmVersion[0] === 11 && npmVersion[1] < 5))
		throw new Error("npm >= 11.5 is required for trusted publishing");
	for (const pkg of plan.packages) {
		if (await registryManifest(pkg.name, pkg.version)) {
			console.log(`Skipping ${pkg.name}@${pkg.version}: already published`);
		} else {
			const env = npmPublishEnvironment(pkg.name, process.env, configDir);
			await $`npm publish ${path.join(root, pkg.tarball!)} --ignore-scripts --tag latest --access public --registry https://registry.npmjs.org`
				.cwd(configDir)
				.env(env);
		}
		published.add(pkg.name);
	}
} finally {
	await fs.rm(configDir, { recursive: true, force: true });
	await syncPublishedPackages(published);
}
