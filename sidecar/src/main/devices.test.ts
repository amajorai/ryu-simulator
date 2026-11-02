// RealDeviceDriver unit tests — only the branches that THROW before any
// subprocess spawn, so no simctl/adb/emulator is ever invoked:
//   * malformed device id  → UnknownDeviceError (the `untag` guard)
//   * iOS coordinate/key actions → UnsupportedActionError (Apple's surface limit)
//   * android key with a non-keycode → UnsupportedActionError (the injection guard)
//
// The android happy paths and iOS boot/install/launch/openUrl/screenshot all reach
// a real toolchain and are deliberately NOT exercised here. Asserting the exact
// error class is the safety net: if a case ever fell through to a spawn, it would
// throw a different (spawn) error and fail loudly instead of silently shelling out.

import { describe, expect, it } from "bun:test";
import {
	RealDeviceDriver,
	UnknownDeviceError,
	UnsupportedActionError,
} from "./devices.ts";

const driver = new RealDeviceDriver();
const BAD_ID = "no-platform-prefix";

describe("untag guard — every action rejects a malformed id", () => {
	it("boot / shutdown / install / launch reject an untagged id", async () => {
		await expect(driver.boot(BAD_ID)).rejects.toBeInstanceOf(
			UnknownDeviceError
		);
		await expect(driver.shutdown(BAD_ID)).rejects.toBeInstanceOf(
			UnknownDeviceError
		);
		await expect(driver.install(BAD_ID, "/tmp/app.apk")).rejects.toBeInstanceOf(
			UnknownDeviceError
		);
		await expect(driver.launch(BAD_ID, "com.acme")).rejects.toBeInstanceOf(
			UnknownDeviceError
		);
	});

	it("openUrl / screenshot / tap / swipe / text / key reject an untagged id", async () => {
		await expect(driver.openUrl(BAD_ID, "https://x")).rejects.toBeInstanceOf(
			UnknownDeviceError
		);
		await expect(driver.screenshot(BAD_ID)).rejects.toBeInstanceOf(
			UnknownDeviceError
		);
		await expect(driver.tap(BAD_ID, 1, 2)).rejects.toBeInstanceOf(
			UnknownDeviceError
		);
		await expect(driver.swipe(BAD_ID, 1, 2, 3, 4, 100)).rejects.toBeInstanceOf(
			UnknownDeviceError
		);
		await expect(driver.text(BAD_ID, "hi")).rejects.toBeInstanceOf(
			UnknownDeviceError
		);
		await expect(driver.key(BAD_ID, "home")).rejects.toBeInstanceOf(
			UnknownDeviceError
		);
	});

	it("the error names the offending id", async () => {
		await expect(driver.boot(BAD_ID)).rejects.toThrow(BAD_ID);
	});
});

describe("iOS has no public coordinate/key surface (simctl)", () => {
	it("tap / swipe / text / key on an iOS device are unsupported", async () => {
		await expect(driver.tap("ios:UDID", 10, 20)).rejects.toBeInstanceOf(
			UnsupportedActionError
		);
		await expect(
			driver.swipe("ios:UDID", 1, 2, 3, 4, 300)
		).rejects.toBeInstanceOf(UnsupportedActionError);
		await expect(driver.text("ios:UDID", "hello")).rejects.toBeInstanceOf(
			UnsupportedActionError
		);
		await expect(driver.key("ios:UDID", "home")).rejects.toBeInstanceOf(
			UnsupportedActionError
		);
	});

	it("the tap error points at the idb upgrade path", async () => {
		await expect(driver.tap("ios:UDID", 1, 1)).rejects.toThrow("idb");
	});
});

describe("android key validation (keycode injection guard)", () => {
	it("rejects a key that is neither a friendly name, a number, nor KEYCODE_*", async () => {
		await expect(
			driver.key("android:serial", "rm -rf /")
		).rejects.toBeInstanceOf(UnsupportedActionError);
		await expect(
			driver.key("android:serial", "$(reboot)")
		).rejects.toBeInstanceOf(UnsupportedActionError);
		// A lowercase raw name that is not in the friendly map and not KEYCODE_* form.
		await expect(driver.key("android:serial", "wat")).rejects.toBeInstanceOf(
			UnsupportedActionError
		);
	});

	it("the rejection message lists the accepted forms", async () => {
		await expect(driver.key("android:serial", "bad!")).rejects.toThrow(
			"KEYCODE_"
		);
	});
});

describe("error classes are real Errors", () => {
	it("both derive from Error with their message intact", () => {
		expect(new UnknownDeviceError("x")).toBeInstanceOf(Error);
		expect(new UnsupportedActionError("y")).toBeInstanceOf(Error);
		expect(new UnknownDeviceError("boom").message).toBe("boom");
	});
});
