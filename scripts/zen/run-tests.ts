#!/usr/bin/env bun
/** Run every zen test listed in scripts/zen/tests.txt in one `bun test` invocation. */
import * as path from "node:path";

const root = path.resolve(import.meta.dir, "../..");
const text = await Bun.file(path.join(import.meta.dir, "tests.txt")).text();
const paths = text
	.split("\n")
	.map(line => line.trim())
	.filter(line => line && !line.startsWith("#"));
if (paths.length === 0) throw new Error("scripts/zen/tests.txt lists no tests");

const proc = Bun.spawn(["bun", "test", ...paths.map(p => (p.startsWith("./") ? p : `./${p}`))], {
	cwd: root,
	stdio: ["inherit", "inherit", "inherit"],
});
process.exit(await proc.exited);
