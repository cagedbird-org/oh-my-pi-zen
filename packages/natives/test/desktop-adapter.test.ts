import { afterEach, describe, expect, it, vi } from "bun:test";
import { adaptDesktopSession } from "../native/desktop-adapter.js";
import { desktopEscapeStops, forgetDesktopEscapeStops, startSessionBusBridge } from "../native/desktop.js";
import * as loaderState from "../native/loader-state.js";

describe("desktop native ABI requirements", () => {
	it.each([
		["missing desktop export", undefined],
		[
			"legacy execute ABI",
			class {
				execute() {}
			},
		],
		[
			"pre-zoom ABI",
			class {
				click() {}
				cancel() {}
			},
		],
		[
			"uncancellable ABI",
			class {
				click() {}
				captureRegion() {}
			},
		],
	])("defers rejection of %s until desktop use without constructing the addon", (_label, NativeSession) => {
		// Importing the shared native module must remain safe for non-desktop tools.
		const DesktopSession = adaptDesktopSession(NativeSession);
		expect(() => new DesktopSession({ display: "active" })).toThrow(/^Unsupported:/);
	});

	it("rejects an addon built before the turn-scoped display hold", () => {
		const Stale = adaptDesktopSession(class {});
		expect(() => new Stale({ display: "active" })).toThrow(/holdDisplayUntilReleased, releaseDisplayAwake/);
	});

	it("rejects an addon built before the Escape stop count", () => {
		// Every method present, so only the getter can decide; without it the worker reads each run as stopped.
		const prototype = (escapeStops: boolean) =>
			new Proxy(
				{},
				{
					get: () => () => {},
					has: (_target, key) => escapeStops || key !== "escapeStops",
				},
			);
		const Current = { prototype: prototype(true) };
		expect<unknown>(adaptDesktopSession(Current)).toBe(Current);
		const Stale = adaptDesktopSession({ prototype: prototype(false) });
		expect(() => new Stale({ display: "active" })).toThrow(/^Unsupported: .*\(missing escapeStops\)/);
	});

	it("guards KWin options without breaking official addons' host sessions", () => {
		class Official {
			constructor(readonly options?: unknown) {}
		}
		for (const method of [
			"click",
			"capture",
			"captureRegion",
			"cancel",
			"retire",
			"setRunDeadline",
			"observe",
			"listApplications",
			"openApplication",
			"menuItems",
			"menuSelect",
			"holdKeys",
			"holdMouse",
			"acquireControl",
			"releaseControl",
			"controlState",
			"bringToCurrentSpace",
			"axSelectText",
			"holdDisplayUntilReleased",
			"releaseDisplayAwake",
		]) {
			Object.defineProperty(Official.prototype, method, { value: () => {} });
		}
		Object.defineProperty(Official.prototype, "escapeStops", { get: () => 0 });
		const Session = adaptDesktopSession(Official);
		expect(new Session({ display: "active" })).toBeInstanceOf(Official);
		expect(() => new Session({ kwinBusAddress: "unix:path=/tmp/agent-bus" })).toThrow(/KWin session options/);
		expect(() => new Session({ waylandDisplay: "agent-wayland" })).toThrow(/KWin session options/);
		Object.defineProperty(Official, "kwinSessionOptionsVersion", { value: () => 0, configurable: true });
		expect(() => new Session({ kwinBusAddress: "unix:path=/tmp/agent-bus" })).toThrow(/KWin session options/);
		expect(() => new Session({ waylandDisplay: "agent-wayland" })).toThrow(/KWin session options/);
		expect(new Session({ display: "active" })).toBeInstanceOf(Official);
		Object.defineProperty(Official, "kwinSessionOptionsVersion", { value: () => 1 });
		expect(new Session({ kwinBusAddress: "unix:path=/tmp/agent-bus" })).toBeInstanceOf(Official);
	});
});

describe("lazy desktop exports", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("report a stale addon's missing Escape exports with the stale-addon stub", () => {
		// A workspace addon built before the Escape exports, which the loader tolerates as stale.
		const missingNativeExport = loaderState.missingNativeExport;
		const stale = {
			path: "/w/packages/natives/native/pi_natives.darwin-arm64.node",
			version: "18.8.7",
			packageVersion: "18.12.1",
			stale: true,
		};
		vi.spyOn(loaderState, "loadNative").mockReturnValue({});
		vi.spyOn(loaderState, "missingNativeExport").mockImplementation(name => missingNativeExport(name, stale));
		for (const [name, call] of [
			["desktopEscapeStops", () => desktopEscapeStops("k")],
			["forgetDesktopEscapeStops", () => forgetDesktopEscapeStops("k")],
		] as const) {
			expect(call).toThrow(`\`${name}\` is missing`);
			expect(call).toThrow("bun run build:native");
		}
	});
	it("skips the session bridge on official addons and surfaces native startup failures", () => {
		vi.spyOn(loaderState, "loadNative").mockReturnValue({});
		expect(startSessionBusBridge("unix:path=/missing", ["org.freedesktop.secrets"])).toBeUndefined();
		vi.spyOn(loaderState, "loadNative").mockReturnValue({
			startSessionBusBridge() {
				throw new Error("host bus unavailable");
			},
		});
		expect(() => startSessionBusBridge("unix:path=/missing", ["org.freedesktop.secrets"])).toThrow(
			"host bus unavailable",
		);
	});
});
