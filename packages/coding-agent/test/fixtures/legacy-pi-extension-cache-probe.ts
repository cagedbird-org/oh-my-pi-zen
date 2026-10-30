import { spyOn } from "bun:test";
import * as parser from "@babel/parser";
import { __rewriteLegacyExtensionSourceForTests } from "../../src/extensibility/plugins/legacy-pi-compat";

const parseSpy = spyOn(parser, "parse");
const realResolveSync = Bun.resolveSync.bind(Bun);
const erasedResolutions: string[] = [];
const resolveSpy = spyOn(Bun, "resolveSync").mockImplementation((specifier, from) => {
	if (specifier.startsWith("@omp-startup-missing/")) {
		erasedResolutions.push(specifier);
		throw new Error(`erased dependency must not be resolved: ${specifier}`);
	}
	return realResolveSync(specifier, from);
});
try {
	const source = process.argv.includes("--type-only")
		? 'import type { Missing } from "@omp-startup-missing/types";\n'
		: 'import value from "./dependency.js";\n';
	// Real loads tag relative imports per process; `--tag=<n>` varies it between runs.
	const tag = process.argv.find(arg => arg.startsWith("--tag="))?.slice("--tag=".length) ?? "7";
	const rewritten = await __rewriteLegacyExtensionSourceForTests(source, "/tmp/extension.ts", tag);
	if (process.argv.includes("--expect-cache-hit") && parseSpy.mock.calls.length !== 0) {
		throw new Error("Warm extension analysis reparsed the source");
	}
	if (erasedResolutions.length !== 0) {
		throw new Error(`Resolved erased dependencies: ${erasedResolutions.join(", ")}`);
	}
	process.stdout.write(rewritten);
} finally {
	parseSpy.mockRestore();
	resolveSpy.mockRestore();
}
