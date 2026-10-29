#!/usr/bin/env bun
/** Isolated npm staging: source checkout and its manifests are never modified. */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import { buildExportViewer } from "../../packages/collab-web/scripts/build-export-viewer";
import { packages, prepareNativeCorePackage, rewriteManifest, stageLegalPayloads } from "../ci-release-publish";
import { fixEmitExtensions } from "../fix-emit-extensions";
import { generateNpmPackages } from "../../packages/natives/scripts/gen-npm-packages";
import { stageCollabRelay } from "./collab-relay";
import { stageCollabWeb } from "./collab-web";
import {
	dependencyFields,
	nativeTags,
	packedFilename,
	publishOrder,
	releaseNames,
	rewriteZenText,
	transformManifest,
	walkFiles,
	workspacePackages,
	zenVersion,
	type Manifest,
	type ReleasePackage,
	type ReleasePlan,
} from "./release";

const repoRoot = path.resolve(import.meta.dir, "../..");
const textExtension = /\.(?:[cm]?[jt]sx?|json|jsonc|md|txt|html|css|ya?ml|kdl)$/;
interface WorkspaceRoot {
	workspaces: { packages: string[]; catalog: Record<string, string> };
}
function argument(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	return index < 0 ? undefined : process.argv[index + 1];
}

async function transformTree(root: string, version: string): Promise<void> {
	const rootFile = path.join(root, "package.json");
	const rootManifest = JSON.parse(rewriteZenText(await Bun.file(rootFile).text())) as WorkspaceRoot;
	const catalog = rootManifest.workspaces.catalog;
	for (const name of Object.keys(catalog)) if (releaseNames.has(name)) catalog[name] = version;
	await Bun.write(rootFile, `${JSON.stringify(rootManifest, null, "\t")}\n`);
	for await (const file of walkFiles(root)) {
		if (file === rootFile || !textExtension.test(file)) continue;
		const original = await Bun.file(file).text();
		const rewritten =
			path.basename(file) === "package.json"
				? `${JSON.stringify(transformManifest(JSON.parse(original) as Manifest, version, catalog), null, "\t")}\n`
				: rewriteZenText(original);
		if (rewritten !== original) await Bun.write(file, rewritten);
	}
}

async function buildStage(version: string): Promise<void> {
	// Imports above resolve the upstream helpers relative to this staging copy.
	// Renaming and the isolated install can change the viewer's exact build inputs.
	await buildExportViewer();
	for (const pkg of packages) {
		const dir = path.join(repoRoot, pkg.dir);
		if (pkg.kind === "native") continue;
		for (const argv of pkg.preBuild ?? []) await $`${argv}`.cwd(dir);
		await $`bun x tsgo -p tsconfig.publish.json`.cwd(dir);
		for (const config of pkg.extraTypeConfigs ?? []) await $`bun x tsgo -p ${config}`.cwd(dir);
		if (pkg.publishJs) await $`bun x tsgo -p tsconfig.publish.js.json`.cwd(dir);
		await fixEmitExtensions(path.join(dir, "dist/types"), ".d.ts");
		if (pkg.publishJs) await fixEmitExtensions(path.join(dir, "dist/js"), ".js");
		const manifest = await rewriteManifest(pkg, true);
		await stageLegalPayloads(dir, manifest.license, true);
	}
	for (const pkg of packages) {
		const dir = path.join(repoRoot, pkg.dir);
		const manifest = (await Bun.file(path.join(dir, "package.json")).json()) as Manifest;
		if (manifest.scripts?.prepack) await $`bun run prepack`.cwd(dir);
	}
	const nativeDir = path.join(repoRoot, "packages/natives");
	await prepareNativeCorePackage(nativeDir, true);
	const leaves = await generateNpmPackages({ packageDir: nativeDir, version, tags: nativeTags });
	// The upstream native helpers construct the original scope dynamically.
	await transformTree(repoRoot, version);
	const webDir = await stageCollabWeb(repoRoot, version);
	const relayDir = await stageCollabRelay(repoRoot, version);
	const entries: ReleasePackage[] = [
		...leaves.map(leaf => ({
			name: rewriteZenText(leaf.manifest.name),
			version,
			dir: path.relative(repoRoot, leaf.dir),
		})),
		...packages.map(pkg => ({ name: "", version, dir: pkg.dir })),
		{ name: "", version, dir: path.relative(repoRoot, webDir) },
		{ name: "", version, dir: path.relative(repoRoot, relayDir) },
	];
	const manifests = new Map<string, Manifest>();
	for (const entry of entries) {
		const manifest = (await Bun.file(path.join(repoRoot, entry.dir, "package.json")).json()) as Manifest;
		entry.name = manifest.name;
		if (!releaseNames.has(entry.name) || manifest.version !== version)
			throw new Error(`Unexpected package ${entry.name}@${manifest.version}`);
		for (const field of dependencyFields)
			for (const [name, range] of Object.entries(manifest[field] ?? {})) {
				if (name.startsWith("@oh-my-pi/") || (name.startsWith("@oh-my-pi-zen/") && range !== version))
					throw new Error(`Unresolved ${name}@${range} in ${entry.name}`);
			}
		manifests.set(entry.name, manifest);
	}
	if (manifests.size !== releaseNames.size || entries.length !== releaseNames.size)
		throw new Error("Incomplete release package set");
	const ordered = publishOrder(entries, manifests);
	await fs.mkdir(path.join(repoRoot, "tarballs"));
	for (const entry of ordered) {
		const packed = await $`npm pack --ignore-scripts --json --pack-destination ${path.join(repoRoot, "tarballs")}`
			.cwd(path.join(repoRoot, entry.dir))
			.quiet();
		entry.tarball = path.join("tarballs", packedFilename(packed.text()));
		console.log(`Packed ${entry.name}@${version}: ${entry.tarball}`);
	}
	const plan: ReleasePlan = { version, packages: ordered };
	await Bun.write(path.join(repoRoot, "release-plan.json"), `${JSON.stringify(plan, null, "\t")}\n`);
}

async function prepare(): Promise<void> {
	const version = argument("--version");
	const output = argument("--output");
	const addon = argument("--linux-addon");
	if (!version || !output || !addon)
		throw new Error(
			"Usage: bun scripts/zen/prepare-publish-worktree.ts --version X.Y.Z-zen.N --output <new-directory> --linux-addon <pipewire-addon.node>",
		);
	const upstream = (await Bun.file(path.join(repoRoot, "packages/natives/package.json")).json()).version as string;
	if (zenVersion(upstream, version.split("-zen.")[1] ?? "") !== version)
		throw new Error(`Version must be based on ${upstream}`);
	const destination = path.resolve(output);
	if (destination.startsWith(`${repoRoot}${path.sep}`) || destination === repoRoot)
		throw new Error("Staging directory must be outside the checkout");
	const found = new Map<string, string>();
	const workspaceRoot = (await Bun.file(path.join(repoRoot, "package.json")).json()) as WorkspaceRoot;
	const manifests = workspaceRoot.workspaces.packages.flatMap(pattern => [
		...new Bun.Glob(`${pattern}/package.json`).scanSync({ cwd: repoRoot }),
	]);
	for (const relative of manifests) {
		const manifest = (await Bun.file(path.join(repoRoot, relative)).json()) as Manifest;
		if (manifest.private || !manifest.name.startsWith("@oh-my-pi/")) continue;
		if (!releaseNames.has(rewriteZenText(manifest.name)))
			throw new Error(`Unapproved publishable workspace: ${manifest.name} (${relative})`);
		if (manifest.version !== upstream)
			throw new Error(`Workspace version mismatch: ${manifest.name}@${manifest.version}`);
		found.set(manifest.name.slice("@oh-my-pi/".length), relative);
	}
	for (const name of workspacePackages) if (!found.has(name)) throw new Error(`Missing workspace package ${name}`);
	await buildExportViewer({ check: true });
	await fs.mkdir(destination); // Refuse to overwrite a previous staging tree.
	const excluded: Record<string, true> = {
		".git": true,
		node_modules: true,
		target: true,
		dist: true,
		binaries: true,
		npm: true,
		".omp": true,
		".codegraph": true,
		".wt": true,
		runs: true,
		".cache": true,
		"bun.lock": true,
	};
	await fs.cp(repoRoot, destination, {
		recursive: true,
		filter: source => !excluded[path.basename(source)] && !source.endsWith(".node"),
	});
	// npm ignores symlinks: materialize the source asset link inside the isolated package.
	const zenChangelog = path.join(destination, "packages/coding-agent/ZEN_CHANGELOG.md");
	await fs.unlink(zenChangelog);
	await fs.copyFile(path.join(destination, "zen/CHANGELOG.md"), zenChangelog);
	const stagedNative = path.join(destination, "packages/natives/native");
	await fs.copyFile(path.resolve(addon), path.join(stagedNative, "pi_natives.linux-x64-modern.node"));
	const download = await fs.mkdtemp(path.join(os.tmpdir(), "zen-official-addons-"));
	try {
		for (const tag of ["darwin-arm64", "linux-arm64"]) {
			const packed =
				await $`npm pack ${`@oh-my-pi/pi-natives-${tag}@${upstream}`} --ignore-scripts --json --pack-destination ${download}`.quiet();
			await $`tar -xzf ${path.join(download, packedFilename(packed.text()))} -C ${download} ${`package/pi_natives.${tag}.node`}`;
			await fs.copyFile(
				path.join(download, `package/pi_natives.${tag}.node`),
				path.join(stagedNative, `pi_natives.${tag}.node`),
			);
		}
	} finally {
		await fs.rm(download, { recursive: true, force: true });
	}
	await transformTree(destination, version);
	for (const tag of nativeTags) {
		const filename = tag === "linux-x64" ? "pi_natives.linux-x64-modern.node" : `pi_natives.${tag}.node`;
		await $`bun scripts/stamp-native-version.ts ${path.join(stagedNative, filename)} --version ${version}`.cwd(
			destination,
		);
	}
	await $`bun install --ignore-scripts`.cwd(destination);
	await $`bun scripts/zen/prepare-publish-worktree.ts --build --version ${version}`.cwd(destination);
	console.log(`Staged ${releaseNames.size} packages at ${destination}`);
}

if (import.meta.main) {
	if (process.argv.includes("--build")) await buildStage(argument("--version")!);
	else await prepare();
}
