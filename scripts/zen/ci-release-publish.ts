#!/usr/bin/env bun
/** Publish every zen package through npm trusted publishing (OIDC). */
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
	const env = npmPublishEnvironment(process.env, configDir);
	const npmVersion = (await $`npm --version`.env(env).quiet()).text().trim().split(".").map(Number);
	if (npmVersion[0] < 11 || (npmVersion[0] === 11 && npmVersion[1] < 5))
		throw new Error("npm >= 11.5 is required for trusted publishing");
	// npm does not order publishes by dependency, so all packages go out at once.
	const results = await Promise.allSettled(
		plan.packages.map(async pkg => {
			if (await registryManifest(pkg.name, pkg.version)) {
				console.log(`Skipping ${pkg.name}@${pkg.version}: already published`);
			} else {
				await publishWithRetry(pkg.name, pkg.version, path.join(root, pkg.tarball!), env);
			}
			published.add(pkg.name);
		}),
	);
	const failures = results.flatMap(r => (r.status === "rejected" ? [String(r.reason)] : []));
	if (failures.length > 0) throw new Error(`Publish failed:\n${failures.join("\n")}`);
} finally {
	await fs.rm(configDir, { recursive: true, force: true });
	await syncPublishedPackages(published);
}

/**
 * The registry accepts an upload minutes before the exact-version endpoint serves it, so a rerun can
 * collide with an accepted upload ("previously staged"). That only counts as published once the
 * version becomes visible; a version held for staged-publishing approval never does and fails here.
 * Other failures (e.g. transient Sigstore/Rekor conflicts under concurrent provenance signing) are
 * retried with backoff.
 */
async function publishWithRetry(
	name: string,
	version: string,
	tarball: string,
	env: Record<string, string | undefined>,
) {
	const attempts = 3;
	for (let attempt = 1; ; attempt++) {
		const result =
			await $`npm publish ${tarball} --ignore-scripts --tag latest --access public --registry https://registry.npmjs.org`
				.cwd(configDir)
				.env(env)
				.quiet()
				.nothrow();
		const output = `${result.stdout.toString()}${result.stderr.toString()}`.trim();
		console.log(`::group::${name}@${version} (attempt ${attempt})\n${output}\n::endgroup::`);
		if (result.exitCode === 0) return;
		if (/cannot publish over (?:the )?previously published/i.test(output)) {
			console.log(`Skipping ${name}@${version}: already published`);
			return;
		}
		if (/cannot publish over (?:the )?previously staged/i.test(output)) {
			await waitUntilVisible(name, version);
			return;
		}
		if (attempt === attempts) throw new Error(`npm publish ${name} exited ${result.exitCode}`);
		await Bun.sleep(attempt * 10_000);
	}
}

async function waitUntilVisible(name: string, version: string) {
	const deadline = Date.now() + 15 * 60_000;
	while (!(await registryManifest(name, version))) {
		if (Date.now() > deadline)
			throw new Error(`${name}@${version} was accepted but never became visible; check npm staged publishes`);
		await Bun.sleep(30_000);
	}
	console.log(`Skipping ${name}@${version}: accepted upload is now visible`);
}
