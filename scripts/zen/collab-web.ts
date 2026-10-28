import * as fs from "node:fs/promises";
import * as path from "node:path";
import { collabWebName, type Manifest } from "./release";

/** Build a dependency-free static npm package without changing upstream inputs. */
export async function stageCollabWeb(
	root: string,
	version: string,
	destination = path.join(root, "packages/collab-web/npm"),
): Promise<string> {
	const source = path.join(root, "packages/collab-web");
	const input = path.join(source, `.zen-index-${crypto.randomUUID()}.html`);
	const manifest = (await Bun.file(path.join(source, "package.json")).json()) as Manifest;
	const html = new HTMLRewriter()
		.on("script[src]", {
			element(element) {
				if (/um\.can\.ac|umami/i.test(element.getAttribute("src") ?? "")) element.remove();
			},
		})
		.transform(await Bun.file(path.join(source, "index.html")).text());
	await fs.mkdir(destination);
	await Bun.write(input, html.replace(/<!--\s*Analytics[\s\S]*?-->/gi, ""));
	try {
		const result = await Bun.build({
			entrypoints: [input],
			outdir: path.join(destination, "dist"),
			target: "browser",
			minify: true,
			define: { "process.env.NODE_ENV": '"production"' },
			naming: { entry: "[hash].[ext]", chunk: "[hash].[ext]", asset: "[hash].[ext]" },
		});
		if (!result.success) throw new AggregateError(result.logs, "collab-web production build failed");
		const entry = result.outputs.find(output => output.path.endsWith(".html"));
		if (!entry) throw new Error("collab-web build did not emit HTML");
		await fs.rename(entry.path, path.join(destination, "dist/index.html"));
		await fs.cp(path.join(source, "public"), path.join(destination, "dist"), { recursive: true });
		await fs.copyFile(path.join(root, "LICENSE"), path.join(destination, "LICENSE"));
		await Bun.write(
			path.join(destination, "package.json"),
			`${JSON.stringify(
				{
					name: collabWebName,
					version,
					description: manifest.description,
					license: manifest.license ?? "MIT",
					repository: {
						type: "git",
						url: "git+https://github.com/cagedbird-org/oh-my-pi-zen.git",
						directory: "packages/collab-web",
					},
					files: ["dist", "LICENSE"],
				},
				null,
				"\t",
			)}\n`,
		);
		return destination;
	} finally {
		await fs.rm(input, { force: true });
	}
}
