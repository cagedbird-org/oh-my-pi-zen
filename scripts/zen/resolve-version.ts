#!/usr/bin/env bun
/** Resolve the release number without invoking upstream's stable/canary tag policy. */
import * as path from "node:path";
import { registryManifest, zenVersion } from "./release";

const upstream = (await Bun.file(path.resolve(import.meta.dir, "../../packages/natives/package.json")).json())
	.version as string;
const number = process.argv[2] ?? "";
const latest = number ? undefined : await registryManifest("@oh-my-pi-zen/pi-coding-agent", "latest");
const version = zenVersion(upstream, number, latest?.version);
console.log(`upstream_version=${upstream}\nversion=${version}`);
