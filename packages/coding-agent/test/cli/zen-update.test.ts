import { describe, expect, it } from "bun:test";
import { compareVersions } from "@oh-my-pi/pi-utils";
import { buildBunInstallArgs } from "../../src/cli/update-cli";
import { ZEN_NATIVE_TAGS, ZEN_NATIVES_PACKAGE, ZEN_PACKAGE } from "../../src/cli/zen-update";

describe("zen update version ordering", () => {
	it("orders X.Y.Z-zen.N numerically across zen counter, patch and minor", () => {
		const newer = (a: string, b: string) => Bun.semver.order(a, b) > 0;
		expect(newer("18.13.3-zen.10", "18.13.3-zen.9")).toBe(true);
		expect(newer("18.13.3-zen.2", "18.13.3-zen.1")).toBe(true);
		expect(newer("18.14.0-zen.1", "18.13.3-zen.5")).toBe(true);
		expect(newer("18.13.4-zen.1", "18.13.3-zen.9")).toBe(true);
		expect(Bun.semver.order("18.13.3-zen.2", "18.13.3-zen.2")).toBe(0);
		expect(newer("18.13.3-zen.1", "18.14.0-zen.1")).toBe(false);
		// `omp update` compares with compareVersions, the startup banner with Bun.semver; they must agree.
		expect(compareVersions("18.13.3-zen.10", "18.13.3-zen.9")).toBeGreaterThan(0);
		expect(compareVersions("18.14.0-zen.1", "18.13.3-zen.5")).toBeGreaterThan(0);
	});
});

describe("zen bun install command", () => {
	it("installs the agent, natives core and the platform leaf at the pinned zen version", () => {
		for (const tag of ZEN_NATIVE_TAGS) {
			const args = buildBunInstallArgs("18.14.0-zen.1", tag);
			expect(args.slice(0, 2)).toEqual(["install", "-g"]);
			expect(args.slice(-3)).toEqual([
				"@oh-my-pi-zen/pi-coding-agent@18.14.0-zen.1",
				"@oh-my-pi-zen/pi-natives@18.14.0-zen.1",
				`@oh-my-pi-zen/pi-natives-${tag}@18.14.0-zen.1`,
			]);
		}
		expect([...ZEN_NATIVE_TAGS].sort()).toEqual(["android-arm64", "darwin-arm64", "linux-arm64", "linux-x64"]);
		expect(ZEN_PACKAGE).toBe("@oh-my-pi-zen/pi-coding-agent");
		expect(ZEN_NATIVES_PACKAGE).toBe("@oh-my-pi-zen/pi-natives");
	});

	it("requests no leaf package on platforms zen does not publish", () => {
		for (const tag of ["win32-x64", "darwin-x64", "linux-arm"]) {
			expect(buildBunInstallArgs("18.14.0-zen.1", tag).slice(-2)).toEqual([
				"@oh-my-pi-zen/pi-coding-agent@18.14.0-zen.1",
				"@oh-my-pi-zen/pi-natives@18.14.0-zen.1",
			]);
		}
	});
});
