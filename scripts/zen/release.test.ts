import { describe, expect, test } from "bun:test";
import { packedFilename, publishOrder, rewriteZenText, transformManifest, zenVersion, type Manifest } from "./release";

describe("publish-time identity boundary", () => {
	test("rewrites import subpaths and native template lookups without rewriting the zen scope twice", () => {
		const input = `import x from "@oh-my-pi/pi-ai/models"; const leaf = \`@oh-my-pi/pi-natives-\${tag}\`; const update = "@oh-my-pi-zen/pi-coding-agent";`;
		const output = rewriteZenText(input);
		expect(output).toBe(
			`import x from "@oh-my-pi-zen/pi-ai/models"; const leaf = \`@oh-my-pi-zen/pi-natives-\${tag}\`; const update = "@oh-my-pi-zen/pi-coding-agent";`,
		);
		expect(rewriteZenText(output)).toBe(output);
	});

	test("pins all internal dependency protocols and strips unsupported native platforms", () => {
		const manifest: Manifest = {
			name: "@oh-my-pi/pi-natives",
			version: "18.13.3",
			omp: { rename: "@oh-my-pi/pi-coding-agent" },
			repository: { type: "git", url: "git+https://github.com/can1357/oh-my-pi.git", directory: "packages/natives" },
			dependencies: { "@oh-my-pi/pi-utils": "catalog:", react: "catalog:" },
			devDependencies: { "@oh-my-pi/pi-ai": "workspace:*" },
			peerDependencies: { "@oh-my-pi-zen/pi-wire": ">=18.0.0" },
			optionalDependencies: {
				"@oh-my-pi/pi-natives-linux-x64": "^18.13.3",
				"@oh-my-pi/pi-natives-darwin-arm64": "18.13.3",
				"@oh-my-pi/pi-natives-linux-arm64": "18.13.3",
				"@oh-my-pi/pi-natives-darwin-x64": "18.13.3",
				"@oh-my-pi/pi-natives-win32-x64": "18.13.3",
				"@oh-my-pi/pi-natives-win32-arm64": "18.13.3",
			},
		};
		const result = transformManifest(manifest, "18.13.3-zen.1", { react: "19.2.7" });
		expect(result.name).toBe("@oh-my-pi-zen/pi-natives");
		expect(result.version).toBe("18.13.3-zen.1");
		expect(result.omp?.rename).toBeUndefined();
		expect(result.repository).toEqual({
			type: "git",
			url: "git+https://github.com/cagedbird-org/oh-my-pi-zen.git",
			directory: "packages/natives",
		});
		expect(result.dependencies).toEqual({ "@oh-my-pi-zen/pi-utils": "18.13.3-zen.1", react: "19.2.7" });
		expect(result.devDependencies).toEqual({ "@oh-my-pi-zen/pi-ai": "18.13.3-zen.1" });
		expect(result.peerDependencies).toEqual({ "@oh-my-pi-zen/pi-wire": "18.13.3-zen.1" });
		expect(result.optionalDependencies).toEqual({
			"@oh-my-pi-zen/pi-natives-linux-x64": "18.13.3-zen.1",
			"@oh-my-pi-zen/pi-natives-darwin-arm64": "18.13.3-zen.1",
			"@oh-my-pi-zen/pi-natives-linux-arm64": "18.13.3-zen.1",
		});
		expect(() =>
			transformManifest(
				{ name: "@oh-my-pi/pi-ai", version: "18.13.3", dependencies: { "@oh-my-pi/new-package": "workspace:*" } },
				"18.13.3-zen.1",
				{},
			),
		).toThrow("Unapproved internal dependency");
	});
});

test("selects first, incremented and explicit zen release numbers", () => {
	expect(zenVersion("18.13.3", "")).toBe("18.13.3-zen.1");
	expect(zenVersion("18.13.3", "", "18.13.3-zen.4")).toBe("18.13.3-zen.5");
	expect(zenVersion("18.13.3", "", "18.12.0-zen.8")).toBe("18.13.3-zen.1");
	expect(zenVersion("18.13.3", "2", "18.13.3-zen.4")).toBe("18.13.3-zen.2");
	expect(() => zenVersion("18.13.3", "0")).toThrow("Invalid zen release number");
});

test("publishes native leaves before dependents and coding-agent last", () => {
	const leaf: Manifest = { name: "leaf", version: "1" };
	const core: Manifest = { name: "core", version: "1", optionalDependencies: { leaf: "1" } };
	const cli: Manifest = { name: "@oh-my-pi-zen/pi-coding-agent", version: "1", dependencies: { core: "1" } };
	const independent: Manifest = { name: "independent", version: "1" };
	const manifests = new Map([cli, core, leaf, independent].map(manifest => [manifest.name, manifest]));
	const ordered = publishOrder(
		[...manifests.values()].map(manifest => ({ name: manifest.name, version: "1", dir: manifest.name })),
		manifests,
	);
	expect(ordered.map(pkg => pkg.name)).toEqual(["leaf", "core", "independent", "@oh-my-pi-zen/pi-coding-agent"]);
});

test("reads npm 11 and npm 12 pack output", () => {
	expect(packedFilename('[{"filename":"zen.tgz"}]')).toBe("zen.tgz");
	expect(packedFilename('{"@oh-my-pi-zen/pi-ai":{"filename":"zen.tgz"}}')).toBe("zen.tgz");
	expect(() => packedFilename("{}")).toThrow("Expected one npm pack result");
});
