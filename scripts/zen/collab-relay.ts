import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $ } from "bun";
import { collabRelayName, type Manifest } from "./release";

/** Compile the standalone relay into a dependency-free Linux x64 npm leaf. */
export async function stageCollabRelay(
	root: string,
	version: string,
	destination = path.join(root, "npm/collab-relay-linux-x64"),
): Promise<string> {
	const manifest = (await Bun.file(path.join(root, "package.json")).json()) as Manifest;
	const hash = (await $`bun zen/collab-relay/source-hash.ts`.cwd(root).quiet()).text().trim();
	if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid collab-relay source hash");
	await fs.mkdir(destination, { recursive: true });
	// The -baseline target always downloads Bun's official, statically linked runtime; distro-built bun links system ICU.
	await $`bun build --compile --target=bun-linux-x64-baseline zen/collab-relay/main.ts --outfile ${path.join(destination, "collab-relay")} --define ${`COLLAB_RELAY_VERSION=${JSON.stringify(version)}`}`.cwd(
		root,
	);
	await fs.chmod(path.join(destination, "collab-relay"), 0o755);
	await Bun.write(path.join(destination, "source-hash"), `${hash}\n`);
	await fs.copyFile(path.join(root, "LICENSE"), path.join(destination, "LICENSE"));
	await Bun.write(
		path.join(destination, "package.json"),
		`${JSON.stringify(
			{
				name: collabRelayName,
				version,
				description: "Standalone collab relay for Linux x64",
				license: manifest.license ?? "MIT",
				repository: {
					type: "git",
					url: "git+https://github.com/cagedbird-org/oh-my-pi-zen.git",
					directory: "zen/collab-relay",
				},
				os: ["linux"],
				cpu: ["x64"],
				files: ["collab-relay", "source-hash", "LICENSE"],
			},
			null,
			"\t",
		)}\n`,
	);
	return destination;
}
