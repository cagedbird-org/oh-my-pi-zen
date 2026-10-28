import { describe, expect, it } from "bun:test";
import { baseTag, nextTag, plainTags } from "./follow";

describe("zen follow tag selection", () => {
	it("keeps only plain vX.Y.Z tags in semver order", () => {
		expect(
			plainTags([
				"v18.10.0",
				"v18.9.2",
				"v18.13.3-rc.1",
				"zen/v17.3.0-zen.1",
				"v18.13.3-zen.1",
				"canary",
				"v18.9.10",
			]),
		).toEqual(["v18.9.2", "v18.9.10", "v18.10.0"]);
	});

	it("takes the base from the newest plain ancestor tag", () => {
		expect(baseTag(["v18.9.2", "v18.13.1", "v18.13.0", "zen/v17.3.0-zen.1"])).toBe("v18.13.1");
		expect(() => baseTag(["zen/v17.3.0-zen.1"])).toThrow();
	});

	it("follows one tag at a time, never skipping and never offering prereleases", () => {
		const upstream = ["v18.13.3", "v18.14.0", "v18.13.4-canary.1", "v18.13.4", "v18.13.2"];
		expect(nextTag(upstream, "v18.13.2")).toBe("v18.13.3");
		expect(nextTag(upstream, "v18.13.3")).toBe("v18.13.4");
		expect(nextTag(upstream, "v18.13.4")).toBe("v18.14.0");
		expect(nextTag(upstream, "v18.14.0")).toBeUndefined();
	});
});
