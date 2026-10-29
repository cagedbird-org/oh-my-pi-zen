import * as path from "node:path";
import { isEnoent, logger, VERSION } from "@oh-my-pi/pi-utils";
import bundledZenChangelogPath from "../../ZEN_CHANGELOG.md" with { type: "file" };
import { getPackageDir } from "../config";
import {
	type ChangelogEntry,
	type ChangelogView,
	type StartupChangelogSelection,
	parseChangelog,
	parseChangelogContent,
	readLastChangelogVersion,
	RECENT_CHANGELOG_ENTRY_LIMIT,
	renderChangelogEntries,
	resolveBundledChangelogPath,
	resolveStartupChangelogForDisplay,
	selectChangelogEntries,
	selectStartupChangelogEntries,
	writeLastChangelogVersion,
	selectStartupChangelog,
} from "./changelog";

export interface ZenChangelogVersion {
	major: number;
	minor: number;
	patch: number;
	zen: number;
}
export interface ZenChangelogEntry extends ChangelogEntry, ZenChangelogVersion {}

/** Plain upstream markers sort before the first zen release of that upstream version. */
export function parseZenChangelogVersion(version: string | undefined): ZenChangelogVersion | undefined {
	const match = version?.match(/^(\d+)\.(\d+)\.(\d+)(?:-zen\.([1-9]\d*))?$/);
	if (!match) return undefined;
	const parts = match.slice(1, 4).map(Number);
	const zen = Number(match[4] ?? 0);
	if (![...parts, zen].every(Number.isSafeInteger)) return undefined;
	return { major: parts[0], minor: parts[1], patch: parts[2], zen };
}

export function compareZenChangelogVersions(a: ZenChangelogVersion, b: ZenChangelogVersion): number {
	return a.major - b.major || a.minor - b.minor || a.patch - b.patch || a.zen - b.zen;
}

function upstreamVersion(version: ZenChangelogVersion): string {
	return `${version.major}.${version.minor}.${version.patch}`;
}

export function parseZenChangelogContent(content: string): ZenChangelogEntry[] {
	return parseChangelogContent(content)
		.flatMap(entry => {
			const heading = entry.content.split("\n", 1)[0];
			const version = parseZenChangelogVersion(heading.match(/^## \[([^\]]+)\]/)?.[1]);
			return version?.zen ? [{ ...entry, ...version }] : [];
		})
		.sort((a, b) => compareZenChangelogVersions(b, a));
}

/** The package-local source symlink and publish-time regular file share the upstream asset mechanism. */
export async function parseZenChangelog(changelogPath?: string): Promise<ZenChangelogEntry[]> {
	const packageDir = getPackageDir();
	const assetPath = changelogPath ?? (packageDir ? path.join(packageDir, "ZEN_CHANGELOG.md") : undefined);
	if (assetPath) {
		try {
			return parseZenChangelogContent(await Bun.file(assetPath).text());
		} catch (error) {
			if (!isEnoent(error)) logger.warn("Could not parse zen changelog", { error: String(error) });
			// An explicitly selected missing asset is an absent zen changelog, not another package's history.
			if (changelogPath) return [];
		}
	}
	try {
		return parseZenChangelogContent(
			await Bun.file(resolveBundledChangelogPath(bundledZenChangelogPath, import.meta.url)).text(),
		);
	} catch (error) {
		if (!isEnoent(error)) logger.warn("Could not parse bundled zen changelog", { error: String(error) });
		return [];
	}
}

function groupedMarkdown(zen: string | undefined, upstream: string | undefined): string | undefined {
	const groups: string[] = [];
	if (zen) groups.push(`# oh-my-pi-zen\n\n${zen}`);
	if (upstream) groups.push(`# oh-my-pi (upstream)\n\n${upstream}`);
	return groups.length ? groups.join("\n\n") : undefined;
}

/** Both groups retain the upstream per-group entry and byte caps and Markdown bullet counting. */
export function selectZenStartupChangelog(
	zenEntries: ZenChangelogEntry[],
	upstreamEntries: ChangelogEntry[],
	lastVersion: string | undefined,
	currentVersion: string,
): StartupChangelogSelection {
	const current = parseZenChangelogVersion(currentVersion);
	const last = parseZenChangelogVersion(lastVersion);
	const empty = selectStartupChangelogEntries([], 0);
	if (!current || !last) return { ...empty, persistCurrentVersion: true };
	if (compareZenChangelogVersions(current, last) <= 0) return empty;
	const unseenZen = zenEntries.filter(
		entry => compareZenChangelogVersions(entry, last) > 0 && compareZenChangelogVersions(entry, current) <= 0,
	);
	const unseenUpstream = upstreamEntries.filter(entry => {
		const version = { ...entry, zen: 0 };
		return (
			compareZenChangelogVersions(version, { ...last, zen: 0 }) > 0 &&
			compareZenChangelogVersions(version, { ...current, zen: 0 }) <= 0
		);
	});
	const zen = selectStartupChangelogEntries(unseenZen.slice(0, RECENT_CHANGELOG_ENTRY_LIMIT), unseenZen.length);
	const upstream = selectStartupChangelogEntries(
		unseenUpstream.slice(0, RECENT_CHANGELOG_ENTRY_LIMIT),
		unseenUpstream.length,
	);
	const categoryCounts = { ...zen.categoryCounts };
	for (const [category, count] of Object.entries(upstream.categoryCounts)) {
		categoryCounts[category] = (categoryCounts[category] ?? 0) + count;
	}
	return {
		markdown: groupedMarkdown(zen.markdown, upstream.markdown),
		persistCurrentVersion: true,
		truncated: zen.truncated || upstream.truncated,
		selectedEntries: zen.selectedEntries + upstream.selectedEntries,
		totalUnseenEntries: zen.totalUnseenEntries + upstream.totalUnseenEntries,
		latestVersion: currentVersion,
		changeCount: zen.changeCount + upstream.changeCount,
		categoryCounts,
	};
}

export async function resolveZenStartupChangelogForDisplay(options: {
	mode: "hidden" | "summary" | "expanded";
	currentVersion: string;
	changelogPath?: string;
	zenChangelogPath?: string;
	agentDir?: string;
}): Promise<StartupChangelogSelection | undefined> {
	const current = parseZenChangelogVersion(options.currentVersion);
	if (!current?.zen) return resolveStartupChangelogForDisplay(options);
	const lastVersion = await readLastChangelogVersion(options.agentDir);
	const last = parseZenChangelogVersion(lastVersion);
	if (!last) {
		await writeLastChangelogVersion(options.currentVersion, options.agentDir);
		return undefined;
	}
	if (compareZenChangelogVersions(current, last) <= 0) return undefined;
	if (options.mode === "hidden") {
		await writeLastChangelogVersion(options.currentVersion, options.agentDir);
		return undefined;
	}
	const zenEntries = await parseZenChangelog(options.zenChangelogPath);
	if (zenEntries.length === 0) {
		const upstream = selectStartupChangelog(
			await parseChangelog(options.changelogPath),
			upstreamVersion(last),
			upstreamVersion(current),
		);
		if (upstream.persistCurrentVersion) await writeLastChangelogVersion(options.currentVersion, options.agentDir);
		return upstream.markdown ? upstream : undefined;
	}
	const selection = selectZenStartupChangelog(
		zenEntries,
		await parseChangelog(options.changelogPath),
		lastVersion,
		options.currentVersion,
	);
	if (selection.persistCurrentVersion) await writeLastChangelogVersion(options.currentVersion, options.agentDir);
	return selection.markdown ? selection : undefined;
}

/** Shared by the TUI and headless slash command so both expose the same groups. */
export async function renderZenChangelogView(
	view: ChangelogView,
	options: { currentVersion?: string; changelogPath?: string; zenChangelogPath?: string } = {},
): Promise<{ markdown: string; shown: number }> {
	const upstreamEntries = selectChangelogEntries(await parseChangelog(options.changelogPath), view);
	const zenEntries = parseZenChangelogVersion(options.currentVersion ?? VERSION)?.zen
		? selectChangelogEntries(await parseZenChangelog(options.zenChangelogPath), view)
		: [];
	const upstream = renderChangelogEntries(upstreamEntries).markdown;
	const zen = renderChangelogEntries(zenEntries).markdown;
	return {
		markdown: (zenEntries.length ? groupedMarkdown(zen, upstream) : upstream) || "No changelog entries found.",
		shown: zenEntries.length + upstreamEntries.length,
	};
}
