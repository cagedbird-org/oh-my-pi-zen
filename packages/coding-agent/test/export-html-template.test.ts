import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseHTML } from "@oh-my-pi/pi-utils/dom";
import type { BunPlugin } from "bun";
import { getTemplate } from "../src/export/html/index";
import viewerAsset from "../src/export/html/viewer.generated.json" with { type: "json" };

const bundleDistUrl = new URL("../scripts/bundle-dist.ts", import.meta.url).href;
const probePath = path.resolve(import.meta.dir, "fixtures", "html-export-template-probe.ts");
const packageDir = path.resolve(import.meta.dir, "..");
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-html-template-"));
const unrelatedCwd = path.join(tempRoot, "unrelated-cwd");
const bundleDir = path.join(tempRoot, "bundle");
const compiledPath = path.join(tempRoot, "compiled-template-probe");
let bundlePath: string;
const dependencyStubs: Record<string, string> = {
	"@oh-my-pi/omp-stats/trace":
		'export const buildSessionTraceFromSnapshots = () => { throw new Error("Trace assembly is outside the template probe"); };',
	"@oh-my-pi/pi-utils":
		'export const APP_NAME = "omp"; export const isEnoent = err => err?.code === "ENOENT"; export const CONFIG_DIR_NAME = ".omp"; export const getConfigAgentDirName = () => ".omp/agent"; export const getProjectDir = () => process.cwd();',
	"./capability": "export const isUserSourceEnabled = () => false;",
	"./config/claude-paths": "export const resolveClaudePaths = () => ({});",
	"./config/config-file": "",
	"./tools/path-utils": "export const expandTilde = value => value.replace(/^~(?=$|\\/)/, process.env.HOME);",
	"@oh-my-pi/pi-tui/theme":
		"export const getResolvedThemeColors = async () => ({}); export const getThemeExportColors = async () => ({});",
	"../../session/sub-sessions": "export const collectSubSessions = async () => ({});",
	"../../session/session-manager":
		"export class SessionManager { static async open() { return new SessionManager(); } }",
};
const focusedBundlePlugin: BunPlugin = {
	name: "html-template-focused-bundle",
	setup(build) {
		build.onResolve({ filter: /.*/ }, args =>
			dependencyStubs[args.path] === undefined ? undefined : { path: args.path, namespace: "template-probe-stub" },
		);
		build.onLoad({ filter: /.*/, namespace: "template-probe-stub" }, args => ({
			contents: dependencyStubs[args.path]!,
			loader: "js",
		}));
	},
};

async function runProbe(command: string[]): Promise<string> {
	const proc = Bun.spawn(command, {
		cwd: unrelatedCwd,
		env: { ...process.env, PI_PACKAGE_DIR: "" },
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	expect(exitCode, stderr).toBe(0);
	return stdout;
}

beforeAll(async () => {
	await fs.mkdir(unrelatedCwd);
	await Bun.write(path.join(bundleDir, "package.json"), "{}");
	await Bun.write(
		path.join(bundleDir, "export-assets", viewerAsset.file),
		Bun.file(path.join(packageDir, "export-assets", viewerAsset.file)),
	);
	const bundle = await Bun.build({
		entrypoints: [probePath],
		outdir: bundleDir,
		target: "bun",
		plugins: [focusedBundlePlugin],
		define: { "process.env.PI_BUNDLED": '"true"' },
	});
	if (!bundle.success) throw new AggregateError(bundle.logs, "Template probe bundle failed");
	const entrypoint = bundle.outputs.find(output => output.kind === "entry-point");
	if (!entrypoint) throw new Error("Template probe emitted no entry point");
	bundlePath = entrypoint.path;
	const compiled = await Bun.build({
		entrypoints: [probePath],
		target: "bun",
		plugins: [focusedBundlePlugin],
		define: { "process.env.PI_BUNDLED": '"true"' },
		compile: { outfile: compiledPath },
	});
	if (!compiled.success) throw new AggregateError(compiled.logs, "Compiled template probe failed");
}, 120_000);

afterAll(async () => {
	await fs.rm(tempRoot, { recursive: true, force: true });
});

describe("HTML export template", () => {
	test("source exports inline the viewer and all dependencies", async () => {
		const html = getTemplate();
		const { document } = parseHTML(html);
		const scripts = document.querySelectorAll("script[src]");
		expect(scripts).toHaveLength(0);
		expect(document.querySelectorAll('link[rel="stylesheet"], link[rel="preload"]')).toHaveLength(0);
		expect(html).toBe(await runProbe([process.execPath, probePath]));
	});

	test("exports explain how to generate a missing viewer", async () => {
		const checkoutDir = path.join(tempRoot, "checkout", "packages", "coding-agent");
		await Bun.write(path.join(checkoutDir, "package.json"), "{}");
		const bundle = await Bun.build({
			entrypoints: [probePath],
			outdir: checkoutDir,
			target: "bun",
			plugins: [focusedBundlePlugin],
		});
		if (!bundle.success) throw new AggregateError(bundle.logs, "Development probe bundle failed");
		const entrypoint = bundle.outputs.find(output => output.kind === "entry-point");
		if (!entrypoint) throw new Error("Development probe emitted no entry point");
		const proc = Bun.spawn([process.execPath, entrypoint.path], {
			cwd: unrelatedCwd,
			env: { ...process.env, PI_PACKAGE_DIR: "" },
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
		expect(exitCode).not.toBe(0);
		expect(stderr).toContain("Run bun gen:export-viewer");
	});

	test("packaged exports inline the viewer and both dependencies without external scripts", async () => {
		const html = await runProbe([process.execPath, bundlePath]);
		const { document } = parseHTML(html);
		const scripts = document.querySelectorAll("script[src]");
		const viewer = await Bun.file(path.join(packageDir, "export-assets", viewerAsset.file)).text();
		expect(html).toContain(viewer.replace(/<\/script/gi, match => `<\\/${match.slice(2)}`));
		expect(html).toContain('window.addEventListener("DOMContentLoaded",function(){');
		expect(html).not.toContain("build.stencil.so");
		expect(scripts).toHaveLength(0);
		expect(html).not.toContain("{{MARKED_");
		expect(html).not.toContain("{{HIGHLIGHT_");
	});

	test("compiled binaries explain that the package directory cannot be located", async () => {
		const proc = Bun.spawn([compiledPath], {
			cwd: unrelatedCwd,
			env: { ...process.env, PI_PACKAGE_DIR: "" },
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
		expect(exitCode).not.toBe(0);
		expect(stderr).toContain("Cannot locate the package directory for the HTML export viewer");
	});

	test("npm packages include the inline viewer and metadata but omit viewer source assets", async () => {
		const productionDir = path.join(tempRoot, "production-bundle");
		const staleAsset = path.join(productionDir, "template-stale.css");
		await Bun.write(staleAsset, "obsolete viewer sidecar");
		const runner = path.join(tempRoot, "bundle-dist-runner.ts");
		await Bun.write(
			runner,
			`import { bundleDist } from ${JSON.stringify(bundleDistUrl)};\nawait bundleDist(${JSON.stringify(productionDir)});\n`,
		);
		const proc = Bun.spawn([process.execPath, runner], {
			cwd: packageDir,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
		expect(await Bun.file(staleAsset).exists()).toBe(false);

		const repoRoot = path.resolve(packageDir, "../..");
		const packWorkspace = path.join(tempRoot, "pack-workspace");
		const packageRel = path.relative(repoRoot, packageDir).split(path.sep).join("/");
		const rootManifest = await Bun.file(path.join(repoRoot, "package.json")).json();
		rootManifest.workspaces = { packages: [packageRel], catalog: rootManifest.workspaces.catalog };
		await Bun.write(path.join(packWorkspace, "package.json"), JSON.stringify(rootManifest));
		await Bun.write(path.join(packWorkspace, "bun.lock"), Bun.file(path.join(repoRoot, "bun.lock")));
		const packDir = path.join(packWorkspace, packageRel);
		await Bun.write(path.join(packDir, "package.json"), Bun.file(path.join(packageDir, "package.json")));
		await fs.cp(productionDir, path.join(packDir, "dist"), { recursive: true });
		await fs.cp(path.join(packageDir, "src/export/html"), path.join(packDir, "src/export/html"), { recursive: true });
		await fs.cp(path.join(packageDir, "export-assets"), path.join(packDir, "export-assets"), { recursive: true });
		const pack = Bun.spawn([process.execPath, "pm", "pack", "--dry-run", "--ignore-scripts"], {
			cwd: packDir,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const [packOut, packErr, packExit] = await Promise.all([
			new Response(pack.stdout).text(),
			new Response(pack.stderr).text(),
			pack.exited,
		]);
		expect(packExit, packErr).toBe(0);
		const packed = Array.from(packOut.matchAll(/^packed \S+ (.+)$/gm), match => match[1]);
		expect(packed).toContain("src/export/html/template.html.txt");
		expect(packed).toContain("src/export/html/viewer.generated.json");
		expect(packed.filter(file => file?.startsWith("export-assets/"))).toEqual([`export-assets/${viewerAsset.file}`]);
		for (const name of ["shell.html", "template.css", "template.js", "share-loader.js"]) {
			expect(packed).not.toContain(`src/export/html/${name}`);
		}
		expect(packed.filter(file => /^dist\/(template-|tool-views\.|marked\.|highlight\.)/.test(file))).toEqual([]);
	}, 60_000);
});
