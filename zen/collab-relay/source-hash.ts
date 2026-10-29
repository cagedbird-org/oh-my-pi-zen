import * as path from "node:path";

// Bun.build writes path comments relative to cwd; pin cwd to the repo root so the hash is invocation-independent.
process.chdir(path.join(import.meta.dir, "../.."));
const build = await Bun.build({
	entrypoints: ["zen/collab-relay/main.ts"],
	target: "bun",
	minify: false,
});
if (!build.success) throw new AggregateError(build.logs, "Relay bundle failed");
const hash = new Bun.CryptoHasher("sha256");
hash.update(await build.outputs[0]!.text());
hash.update(Bun.version);
console.log(hash.digest("hex"));
