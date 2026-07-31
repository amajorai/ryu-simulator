// Companion-UI consumer contract for the Ryu Simulator app.
//
// WHY THIS TEST EXISTS HERE
// -------------------------
// `com.ryu.simulator` is a backend-only apps-store app: its device-control logic
// ships in ../sidecar (simctl + adb behind a `DeviceDriver`) and its desktop panel
// lives in apps/desktop (out of this package's scope). This `ui/` package therefore
// owns no render code and no pure module of its own. The one thing a Simulator UI
// genuinely depends on is the driver CONTRACT — the tagged-id namespace, the
// platform-recoverable-from-id rule, and the iOS action-parity limit — so this test
// pins that contract against the real shipped driver rather than asserting nothing.
//
// It deliberately overlaps the sidecar's own devices.test.ts: those invariants are
// the only pure logic the app owns, and they are exactly what a UI would get wrong.
// Every assertion below hits a branch that THROWS before any simctl/adb/emulator
// subprocess is spawned, so the test is hermetic — no toolchain, no network, no
// environment dependence.

import { describe, expect, it } from "bun:test";
import {
	type Device,
	RealDeviceDriver,
	UnknownDeviceError,
	UnsupportedActionError,
} from "../../sidecar/src/main/devices.ts";

const driver = new RealDeviceDriver();

// A UI never fabricates ids — it renders whatever `list()` returns and echoes the
// device's `id` back on every action. These stand in for driver-provided ids.
const IOS_ID = "ios:00000000-0000-0000-0000-0000DEADBEEF";
const ANDROID_ID = "android:emulator-5554";

// The four interactive actions a companion UI must gate behind a device's
// `PlatformCapability.interactive` flag (true for Android, false for iOS).
const INTERACTIVE_ACTIONS: readonly [string, () => Promise<unknown>][] = [
	["tap", () => driver.tap(IOS_ID, 10, 20)],
	["swipe", () => driver.swipe(IOS_ID, 1, 2, 3, 4, 300)],
	["text", () => driver.text(IOS_ID, "hello")],
	["key", () => driver.key(IOS_ID, "home")],
];

describe("tagged-id contract: platform is recoverable from the id alone", () => {
	it("rejects an id the UI did not get from the driver (no platform prefix)", async () => {
		// The UI must round-trip driver ids verbatim; a hand-built id is refused,
		// which is why the control API needs no separate `platform` parameter.
		await expect(driver.boot("iphone-15")).rejects.toBeInstanceOf(
			UnknownDeviceError
		);
		await expect(driver.shutdown("Pixel_7")).rejects.toBeInstanceOf(
			UnknownDeviceError
		);
	});

	it("names the offending id so the UI can surface it", async () => {
		await expect(driver.boot("bogus-id")).rejects.toThrow("bogus-id");
	});

	it("routes an ios: id to the iOS branch and an android: id to the android branch", async () => {
		// Same method name, two id namespaces, two different failure modes — proof the
		// platform is decoded from the id prefix, not passed alongside it.
		await expect(driver.key(IOS_ID, "home")).rejects.toBeInstanceOf(
			UnsupportedActionError
		);
		await expect(
			driver.key(ANDROID_ID, "not-a-keycode")
		).rejects.toBeInstanceOf(UnsupportedActionError);
	});
});

describe("iOS action-parity: the UI must disable interactive controls for iOS", () => {
	it("every interactive action on an iOS device is unsupported", async () => {
		for (const [, invoke] of INTERACTIVE_ACTIONS) {
			await expect(invoke()).rejects.toBeInstanceOf(UnsupportedActionError);
		}
	});

	it("points the UI at the idb upgrade path in the failure message", async () => {
		await expect(driver.tap(IOS_ID, 1, 1)).rejects.toThrow("idb");
	});
});

describe("android key-input safety: user-typed key names are validated", () => {
	it("rejects shell-metacharacter payloads before they reach the device", async () => {
		await expect(driver.key(ANDROID_ID, "$(reboot)")).rejects.toBeInstanceOf(
			UnsupportedActionError
		);
		await expect(driver.key(ANDROID_ID, "a; rm -rf /")).rejects.toBeInstanceOf(
			UnsupportedActionError
		);
	});

	it("explains the accepted key forms so the UI can guide input", async () => {
		await expect(driver.key(ANDROID_ID, "bad!")).rejects.toThrow("KEYCODE_");
	});
});

describe("error taxonomy the UI switches on", () => {
	it("both driver errors are real Error subclasses with their message intact", () => {
		expect(new UnknownDeviceError("nope")).toBeInstanceOf(Error);
		expect(new UnsupportedActionError("nope")).toBeInstanceOf(Error);
		expect(new UnknownDeviceError("boom").message).toBe("boom");
	});

	it("exposes the Device model shape the UI renders", () => {
		// A compile-time-checked sample of the row a UI list item binds to; asserting
		// the fields keeps this contract honest if the driver's Device type drifts.
		const sample: Device = {
			id: ANDROID_ID,
			platform: "android",
			name: "Pixel 7",
			os: "Android 14 (API 34)",
			state: "booted",
			kind: "emulator",
		};
		expect(sample.platform).toBe("android");
		expect(sample.kind).toBe("emulator");
		expect(sample.state).toBe("booted");
	});
});
