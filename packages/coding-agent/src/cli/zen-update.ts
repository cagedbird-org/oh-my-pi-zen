/**
 * zen fork update policy: `omp update` and the startup update banner follow the
 * npm `latest` dist-tag of `@oh-my-pi-zen/pi-coding-agent` and always install
 * through `bun install -g`. Names are literal `@oh-my-pi-zen/...` strings; the
 * publish-time rename only rewrites `@oh-my-pi/` and leaves these alone.
 */

export const ZEN_PACKAGE = "@oh-my-pi-zen/pi-coding-agent";
export const ZEN_NATIVES_PACKAGE = "@oh-my-pi-zen/pi-natives";

/** Platforms the zen release publishes `@oh-my-pi-zen/pi-natives-<tag>` leaves for. */
export const ZEN_NATIVE_TAGS: ReadonlySet<string> = new Set([
	"linux-x64",
	"darwin-arm64",
	"linux-arm64",
	"android-arm64",
]);

/** zen releases are always npm-installable; never switch to the upstream binary channel. */
export const ZEN_RELEASE_DIST = "npm";

/**
 * Route every install through bun. Brew, mise, Nix, npm and binary targets are
 * upstream distribution paths zen does not publish; `path` is dropped so a
 * failed install cannot fall back to the upstream build service.
 */
export function zenUpdateTarget<T extends { method: string }>(_detected: T | undefined): T | { method: "bun" } {
	return { method: "bun" };
}
