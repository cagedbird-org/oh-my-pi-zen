import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import { releaseNotes } from "../../../scripts/zen/release-notes";
import {
	formatStartupChangelogSummary,
	parseChangelogContent,
	readLastChangelogVersion,
	resolveStartupChangelogForDisplay,
	STARTUP_CHANGELOG_MAX_BYTES,
	writeLastChangelogVersion,
} from "../src/utils/changelog";
import {
	compareZenChangelogVersions,
	parseZenChangelogContent,
	parseZenChangelogVersion,
	renderZenChangelogView,
	resolveZenStartupChangelogForDisplay,
	selectZenStartupChangelog,
} from "../src/utils/zen-changelog";

function release(version: string, body = "### Added\n\n- 中文功能。\n  English feature."): string {
	return `## [${version}] - 2026-10-29\n\n${body}\n`;
}
const zenHistory = ["18.14.0-zen.1", "18.13.3-zen.7", "18.13.3-zen.6", "18.13.3-zen.5", "18.13.3-zen.4"]
	.map(version => release(version))
	.join("\n");
const upstreamHistory = ["18.14.0", "18.13.4", "18.13.3", "18.13.2", "18.13.1"]
	.map(version => release(version))
	.join("\n");

async function withAssets<T>(run: (dir: string, upstream: string, zen: string) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-zen-changelog-"));
	try {
		const upstream = path.join(dir, "CHANGELOG.md");
		const zen = path.join(dir, "ZEN_CHANGELOG.md");
		await Bun.write(upstream, upstreamHistory);
		await Bun.write(zen, zenHistory);
		return await run(dir, upstream, zen);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

describe("zen changelog version boundaries", () => {
	test("orders upstream before its zen releases, numeric zen revisions, and newer upstream versions first", () => {
		const ordered = ["18.14.0-zen.1", "18.13.3-zen.10", "18.13.3-zen.9", "18.13.3", "18.13.2-zen.99"];
		const parsed = ordered.map(version => parseZenChangelogVersion(version)!);
		for (let i = 1; i < parsed.length; i++)
			expect(compareZenChangelogVersions(parsed[i - 1], parsed[i])).toBeGreaterThan(0);
		expect(parseZenChangelogVersion("18.13.3")).toEqual({ major: 18, minor: 13, patch: 3, zen: 0 });
		for (const invalid of [
			undefined,
			"18.13",
			"18.13.3-beta.1",
			"18.13.3-zen.0",
			"18.13.3-zen.01",
			"18.13.3-zen.9007199254740992",
		]) {
			expect(parseZenChangelogVersion(invalid)).toBeUndefined();
		}
	});

	test("ignores unreleased and upstream-only headings and sorts zen release bodies numerically", () => {
		const entries = parseZenChangelogContent(
			`## [Unreleased]\n\n- pending\n\n${release("18.13.3-zen.2")}${release("18.13.3")}${release("18.13.3-zen.10")}`,
		);
		expect(entries.map(entry => entry.zen)).toEqual([10, 2]);
		expect(entries[0].content).toContain("English feature.");
	});
});

describe("grouped startup updates", () => {
	const zen = parseZenChangelogContent(zenHistory);
	const upstream = parseChangelogContent(upstreamHistory);

	test("zen.6 to zen.7 shows only the zen group and counts each bilingual bullet once", () => {
		const selection = selectZenStartupChangelog(zen, upstream, "18.13.3-zen.6", "18.13.3-zen.7");
		expect(selection.markdown).toContain("# oh-my-pi-zen\n");
		expect(selection.markdown).toContain("[18.13.3-zen.7]");
		expect(selection.markdown).not.toContain("oh-my-pi (upstream)");
		expect(selection.markdown).not.toContain("[18.14.0-zen.1]");
		expect(selection.changeCount).toBe(1);
		expect(selection.categoryCounts).toEqual({ Added: 1 });
		expect(formatStartupChangelogSummary(selection)).toContain("v18.13.3-zen.7 · 1 change in 1 release");
	});

	test("an upstream upgrade shows zen before upstream and excludes previously read upstream releases", () => {
		const selection = selectZenStartupChangelog(zen, upstream, "18.13.3-zen.7", "18.14.0-zen.1");
		const markdown = selection.markdown!;
		expect(markdown.indexOf("# oh-my-pi-zen")).toBeLessThan(markdown.indexOf("# oh-my-pi (upstream)"));
		expect(markdown).toContain("[18.14.0-zen.1]");
		expect(markdown).toContain("[18.14.0]");
		expect(markdown).toContain("[18.13.4]");
		expect(markdown).not.toContain("[18.13.3]");
		expect(selection.selectedEntries).toBe(3);
		expect(selection.changeCount).toBe(3);
		expect(formatStartupChangelogSummary(selection)).toContain("3 changes across 3 releases");
	});

	test("an upstream marker upgrades to zen without replaying the same upstream release", () => {
		const selection = selectZenStartupChangelog(zen, upstream, "18.13.3", "18.13.3-zen.7");
		expect(selection.selectedEntries).toBe(3);
		expect(selection.totalUnseenEntries).toBe(4);
		expect(selection.markdown).not.toContain("oh-my-pi (upstream)");
		expect(selection.markdown).not.toContain("[18.13.3-zen.4]");
	});

	test("startup independently caps each group at three releases while counting all unseen releases", () => {
		const selection = selectZenStartupChangelog(zen, upstream, "18.13.0", "18.14.0-zen.1");
		expect(selection.selectedEntries).toBe(6);
		expect(selection.totalUnseenEntries).toBe(10);
		const groups = selection.markdown!.split(/^# /m).slice(1);
		for (const group of groups) expect(group.match(/^## /gm)).toHaveLength(3);
	});

	test("each startup group retains its own release count and byte cap", () => {
		const huge = "### Added\n\n- " + "字".repeat(STARTUP_CHANGELOG_MAX_BYTES);
		const selection = selectZenStartupChangelog(
			parseZenChangelogContent(release("18.14.0-zen.1", huge)),
			parseChangelogContent(release("18.14.0", huge)),
			"18.13.3-zen.7",
			"18.14.0-zen.1",
		);
		const groups = selection.markdown!.split(/^# /m).slice(1);
		expect(groups).toHaveLength(2);
		for (const group of groups) {
			const body = group.slice(group.indexOf("\n\n") + 2).trim();
			expect(Buffer.byteLength(body)).toBeLessThanOrEqual(STARTUP_CHANGELOG_MAX_BYTES);
			expect(body).toContain("/changelog full");
		}
		expect(selection.truncated).toBe(true);
	});

	test("isolated startup persists full zen markers, skips steady state and preserves newer downgrade markers", async () => {
		await withAssets(async (agentDir, changelogPath, zenChangelogPath) => {
			await writeLastChangelogVersion("18.13.3-zen.6", agentDir);
			const options = {
				mode: "expanded",
				currentVersion: "18.13.3-zen.7",
				changelogPath,
				zenChangelogPath,
				agentDir,
			} as const;
			expect((await resolveZenStartupChangelogForDisplay(options))?.markdown).toContain("[18.13.3-zen.7]");
			expect(await readLastChangelogVersion(agentDir)).toBe("18.13.3-zen.7");
			expect(await resolveZenStartupChangelogForDisplay(options)).toBeUndefined();
			expect(
				await resolveZenStartupChangelogForDisplay({ ...options, mode: "hidden", currentVersion: "18.13.3-zen.6" }),
			).toBeUndefined();
			expect(await readLastChangelogVersion(agentDir)).toBe("18.13.3-zen.7");
		});
	});

	test("hidden upgrades and first runs persist without displaying history", async () => {
		await withAssets(async (agentDir, changelogPath, zenChangelogPath) => {
			const options = {
				mode: "expanded",
				currentVersion: "18.13.3-zen.6",
				changelogPath,
				zenChangelogPath,
				agentDir,
			} as const;
			expect(await resolveZenStartupChangelogForDisplay(options)).toBeUndefined();
			expect(await readLastChangelogVersion(agentDir)).toBe("18.13.3-zen.6");
			expect(
				await resolveZenStartupChangelogForDisplay({ ...options, mode: "hidden", currentVersion: "18.13.3-zen.7" }),
			).toBeUndefined();
			expect(await readLastChangelogVersion(agentDir)).toBe("18.13.3-zen.7");
		});
	});

	test("pure upstream runtime uses the unchanged upstream startup contract", async () => {
		await withAssets(async (agentDir, changelogPath, zenChangelogPath) => {
			const options = {
				mode: "expanded",
				currentVersion: "18.14.0",
				changelogPath,
				zenChangelogPath,
				agentDir,
			} as const;
			await writeLastChangelogVersion("18.13.3", agentDir);
			const expected = await resolveStartupChangelogForDisplay(options);
			await writeLastChangelogVersion("18.13.3", agentDir);
			expect(await resolveZenStartupChangelogForDisplay(options)).toEqual(expected);
		});
	});

	test("missing and empty zen assets retain upstream startup selection without group headings", async () => {
		await withAssets(async (agentDir, changelogPath, zenChangelogPath) => {
			for (const asset of [zenChangelogPath, path.join(agentDir, "missing.md")]) {
				await Bun.write(zenChangelogPath, "");
				await writeLastChangelogVersion("18.13.3-zen.7", agentDir);
				const selection = await resolveZenStartupChangelogForDisplay({
					mode: "expanded",
					currentVersion: "18.14.0-zen.1",
					agentDir,
					changelogPath,
					zenChangelogPath: asset,
				});
				expect(selection?.markdown).toContain("[18.14.0]");
				expect(selection?.markdown).not.toContain("# oh-my-pi");
				expect(selection?.selectedEntries).toBe(2);
				expect(await readLastChangelogVersion(agentDir)).toBe("18.14.0-zen.1");
			}
		});
	});
});

describe("changelog command views", () => {
	test("recent, last N and full take the requested number independently from both groups", async () => {
		await withAssets(async (_dir, changelogPath, zenChangelogPath) => {
			const options = { currentVersion: "18.14.0-zen.1", changelogPath, zenChangelogPath };
			for (const [view, count] of [
				[{ kind: "recent", count: 3 }, 6],
				[{ kind: "last", count: 2 }, 4],
				[{ kind: "full" }, 10],
			] as const) {
				const rendered = await renderZenChangelogView(view, options);
				expect(rendered.shown).toBe(count);
				expect(rendered.markdown.indexOf("# oh-my-pi-zen")).toBeLessThan(
					rendered.markdown.indexOf("# oh-my-pi (upstream)"),
				);
				expect(rendered.markdown.match(/^## /gm)).toHaveLength(count);
			}
		});
	});

	test("missing or empty zen assets and pure upstream versions render the upstream-only view", async () => {
		await withAssets(async (dir, changelogPath, zenChangelogPath) => {
			const view = { kind: "recent", count: 3 } as const;
			const upstream = await renderZenChangelogView(view, {
				currentVersion: "18.14.0",
				changelogPath,
				zenChangelogPath,
			});
			for (const asset of [zenChangelogPath, path.join(dir, "missing.md")]) {
				await Bun.write(zenChangelogPath, "");
				expect(
					await renderZenChangelogView(view, {
						currentVersion: "18.14.0-zen.1",
						changelogPath,
						zenChangelogPath: asset,
					}),
				).toEqual(upstream);
			}
			expect(upstream.markdown).not.toContain("# oh-my-pi");
		});
	});
});

describe("bilingual release notes", () => {
	test("extracts only the requested body and appends both upstream link labels", () => {
		const body = "### Fixed\n\n- 中文修复。\n  English fix.";
		const notes = releaseNotes(
			"18.13.3-zen.7",
			`## [Unreleased]\n\n- pending\n\n${release("18.13.3-zen.7", body)}\n${release("18.13.3-zen.6")}`,
		);
		expect(notes).toBe(
			`${body}\n\n基于上游 [oh-my-pi 18.13.3](https://github.com/can1357/oh-my-pi/releases/tag/v18.13.3) / Based on upstream [oh-my-pi 18.13.3](https://github.com/can1357/oh-my-pi/releases/tag/v18.13.3)\n`,
		);
	});

	test("a heading-only release has an empty body rather than leaking the version heading", () => {
		const notes = releaseNotes("18.13.3-zen.7", "## [18.13.3-zen.7]");
		expect(notes).not.toContain("[18.13.3-zen.7]");
		expect(notes).toStartWith("\n\n基于上游 ");
	});

	test("missing first zen release emits the bilingual upstream-following fallback", () => {
		expect(releaseNotes("18.14.0-zen.1", "## [Unreleased]\n")).toContain(
			"无 zen 功能变化，跟进上游 18.14.0。 / No zen changes; follows upstream 18.14.0.",
		);
	});

	test("missing later releases fail the actual CLI before producing publishable notes", async () => {
		const result =
			await $`${process.execPath} ${path.resolve(import.meta.dir, "../../../scripts/zen/release-notes.ts")} 999.0.0-zen.2`
				.quiet()
				.nothrow();
		expect(result.exitCode).not.toBe(0);
		expect(result.stdout.toString()).toBe("");
		expect(result.stderr.toString()).toContain("Missing zen/CHANGELOG.md section for 999.0.0-zen.2");
	});
});
