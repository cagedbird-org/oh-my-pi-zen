import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import { stageCollabWeb } from "./collab-web";
import { npmPublishEnvironment } from "./publish-auth";
import {
	collabWebName,
	packedFilename,
	publishOrder,
	rewriteZenText,
	syncPublishedPackages,
	transformManifest,
	zenVersion,
	type Manifest,
} from "./release";

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

test("stages a version-pinned static collab-web npm package without analytics or runtime dependencies", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "zen-web-stage-test-"));
	try {
		const source = path.join(root, "packages/collab-web");
		const original =
			'<html><head><!-- Analytics --><script src="https://um.can.ac/script.js"></script><script src="/umami.js"></script></head><body><script type="module" src="./main.ts"></script></body></html>';
		await Bun.write(path.join(root, "LICENSE"), "MIT fixture license");
		await Bun.write(
			path.join(source, "package.json"),
			JSON.stringify({
				name: "@oh-my-pi/collab-web",
				version: "16.3.6",
				private: true,
				dependencies: { "@oh-my-pi/pi-wire": "catalog:" },
			}),
		);
		await Bun.write(path.join(source, "index.html"), original);
		await Bun.write(path.join(source, "main.ts"), 'document.body.dataset.ready = "loaded";');
		await Bun.write(path.join(source, "public/robots.txt"), "User-agent: *\nAllow: /\n");
		const dir = await stageCollabWeb(root, "18.13.3-zen.2");
		const manifest = (await Bun.file(path.join(dir, "package.json")).json()) as Manifest;
		expect(manifest.name).toBe(collabWebName);
		expect(manifest.version).toBe("18.13.3-zen.2");
		expect(manifest.private).toBeUndefined();
		expect(manifest.dependencies).toBeUndefined();
		expect(manifest.scripts).toBeUndefined();
		const html = await Bun.file(path.join(dir, "dist/index.html")).text();
		expect(html).not.toMatch(/umami|um\.can\.ac|analytics/i);
		expect(html).toContain('type="module"');
		expect(await Bun.file(path.join(dir, "dist/robots.txt")).text()).toBe("User-agent: *\nAllow: /\n");
		expect(await Bun.file(path.join(source, "index.html")).text()).toBe(original);
		const packed = JSON.parse((await $`npm pack --ignore-scripts --dry-run --json`.cwd(dir).quiet()).text()) as
			| { files: { path: string }[] }[]
			| Record<string, { files: { path: string }[] }>;
		const files = (Array.isArray(packed) ? packed[0]! : Object.values(packed)[0]!).files.map(file => file.path);
		expect(files.filter(file => !/^dist\/[^/]+\.js$/.test(file)).sort()).toEqual([
			"LICENSE",
			"dist/index.html",
			"dist/robots.txt",
			"package.json",
		]);
		expect(files.filter(file => /^dist\/[^/]+\.js$/.test(file))).toHaveLength(1);
		const transformed = transformManifest(
			{
				name: "@oh-my-pi/collab-web",
				version: "16.3.6",
				private: true,
				dependencies: { "@oh-my-pi/pi-wire": "catalog:" },
			},
			"18.13.3-zen.2",
			{},
		);
		expect(transformed.version).toBe("18.13.3-zen.2");
		expect(transformed.dependencies).toEqual({ "@oh-my-pi-zen/pi-wire": "18.13.3-zen.2" });
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("every npm child strips ambient token auth and config overrides while retaining OIDC", async () => {
	const source = {
		PATH: process.env.PATH,
		NODE_AUTH_TOKEN: "ambient",
		NPM_TOKEN: "ambient",
		OTHER_NPM_TOKEN: "ambient",
		npm_config_token: "ambient",
		npm_config__authToken: "ambient",
		NPM_CONFIG_USERCONFIG: "/ambient/npmrc",
		npm_config_userconfig: "/ambient/lowercase-npmrc",
		NPM_CONFIG_GLOBALCONFIG: "/ambient/global-npmrc",
		ACTIONS_ID_TOKEN_REQUEST_URL: "oidc-url",
		ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-request-token",
	};
	const env = npmPublishEnvironment(source, "/isolated");
	const script = "console.log(JSON.stringify(process.env))";
	const child = await $`${process.execPath} -e ${script}`.env(env).quiet();
	const actual = JSON.parse(child.text());
	for (const key of [
		"NODE_AUTH_TOKEN",
		"NPM_TOKEN",
		"OTHER_NPM_TOKEN",
		"npm_config_token",
		"npm_config__authToken",
		"npm_config_userconfig",
	]) {
		expect(actual[key]).toBeUndefined();
	}
	expect(actual.ACTIONS_ID_TOKEN_REQUEST_URL).toBe("oidc-url");
	expect(actual.ACTIONS_ID_TOKEN_REQUEST_TOKEN).toBe("oidc-request-token");
	expect(actual.NPM_CONFIG_USERCONFIG).toBe("/isolated/oidc.npmrc");
	expect(actual.NPM_CONFIG_GLOBALCONFIG).toBe("/isolated/global.npmrc");
	expect(source.NODE_AUTH_TOKEN).toBe("ambient");
});

test("requests mirror sync with PUT for every published package and does not fail on mirror errors", async () => {
	const requests: { url: string; method?: string }[] = [];
	const warn = spyOn(console, "warn").mockImplementation(() => {});
	const log = spyOn(console, "log").mockImplementation(() => {});
	const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
		Object.assign(
			async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
				requests.push({ url: String(input), method: init?.method });
				if (requests.length === 1) throw new Error("mirror offline");
				return requests.length === 2 ? new Response("unavailable", { status: 503 }) : Response.json({ ok: true });
			},
			{ preconnect: fetch.preconnect },
		),
	);
	try {
		const names = ["@oh-my-pi-zen/pi-utils", "@oh-my-pi-zen/pi-wire", collabWebName];
		await syncPublishedPackages(names);
		expect(requests).toEqual(
			names.map(name => ({ url: `https://registry.npmmirror.com/-/package/${name}/syncs`, method: "PUT" })),
		);
		expect(warn).toHaveBeenCalledTimes(2);
	} finally {
		fetchSpy.mockRestore();
		warn.mockRestore();
		log.mockRestore();
	}
});
