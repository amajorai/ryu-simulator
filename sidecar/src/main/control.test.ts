import { describe, expect, it } from "bun:test";
import {
	bearerOk,
	handleRequest,
	resolveControlPort,
	resolveControlToken,
} from "./control.ts";
import {
	type Capabilities,
	type Device,
	type DeviceDriver,
	UnknownDeviceError,
	UnsupportedActionError,
} from "./devices.ts";

// A pure in-memory DeviceDriver so control routing/auth is exercised with no simctl,
// no adb, no sockets. Records the last mutating call for assertion.
class FakeDriver implements DeviceDriver {
	public calls: Array<{ method: string; args: unknown[] }> = [];
	public tapUnsupported = false;

	private record(method: string, ...args: unknown[]): void {
		this.calls.push({ method, args });
	}

	// biome-ignore lint/suspicious/useAwait: async by interface; fake is synchronous.
	async probe(): Promise<Capabilities> {
		return {
			ios: { available: false, interactive: false, reason: "not a mac" },
			android: { available: true, interactive: true },
		};
	}
	// biome-ignore lint/suspicious/useAwait: async by interface; fake is synchronous.
	async list(): Promise<Device[]> {
		return [
			{
				id: "android:emulator-5554",
				platform: "android",
				name: "Pixel 7",
				os: "Android",
				state: "booted",
				kind: "emulator",
			},
		];
	}
	// biome-ignore lint/suspicious/useAwait: async by interface; fake is synchronous.
	async boot(id: string): Promise<void> {
		if (id === "android:missing") {
			throw new UnknownDeviceError("unknown");
		}
		this.record("boot", id);
	}
	// biome-ignore lint/suspicious/useAwait: async by interface; fake is synchronous.
	async shutdown(id: string): Promise<void> {
		this.record("shutdown", id);
	}
	// biome-ignore lint/suspicious/useAwait: async by interface; fake is synchronous.
	async install(id: string, appPath: string): Promise<void> {
		this.record("install", id, appPath);
	}
	// biome-ignore lint/suspicious/useAwait: async by interface; fake is synchronous.
	async launch(id: string, appId: string): Promise<void> {
		this.record("launch", id, appId);
	}
	// biome-ignore lint/suspicious/useAwait: async by interface; fake is synchronous.
	async openUrl(id: string, url: string): Promise<void> {
		this.record("openUrl", id, url);
	}
	// biome-ignore lint/suspicious/useAwait: async by interface; fake is synchronous.
	async screenshot(_id: string): Promise<Buffer> {
		return Buffer.from("PNGDATA");
	}
	// biome-ignore lint/suspicious/useAwait: async by interface; fake is synchronous.
	async tap(id: string, x: number, y: number): Promise<void> {
		if (this.tapUnsupported) {
			throw new UnsupportedActionError("no ios tap");
		}
		this.record("tap", id, x, y);
	}
	// biome-ignore lint/suspicious/useAwait: async by interface; fake is synchronous.
	async swipe(
		id: string,
		x1: number,
		y1: number,
		x2: number,
		y2: number
	): Promise<void> {
		this.record("swipe", id, x1, y1, x2, y2);
	}
	// biome-ignore lint/suspicious/useAwait: async by interface; fake is synchronous.
	async text(id: string, value: string): Promise<void> {
		this.record("text", id, value);
	}
	// biome-ignore lint/suspicious/useAwait: async by interface; fake is synchronous.
	async key(id: string, name: string): Promise<void> {
		this.record("key", id, name);
	}
}

const TOKEN = "secret-token";
const AUTH = `Bearer ${TOKEN}`;

function deps(
	driver: FakeDriver = new FakeDriver(),
	token: string | null = TOKEN
) {
	return { driver, token };
}

describe("bearerOk", () => {
	it("rejects when no expected token is configured (fail-closed)", () => {
		expect(bearerOk(AUTH, null)).toBe(false);
		expect(bearerOk(AUTH, "")).toBe(false);
	});
	it("rejects a missing or malformed header", () => {
		expect(bearerOk(undefined, TOKEN)).toBe(false);
		expect(bearerOk("Basic xyz", TOKEN)).toBe(false);
	});
	it("accepts the matching bearer", () => {
		expect(bearerOk(AUTH, TOKEN)).toBe(true);
	});
});

describe("resolve helpers", () => {
	it("shifts the port by +1000 under RYU_PROFILE=dev", () => {
		expect(
			resolveControlPort({ RYU_PROFILE: "dev" } as NodeJS.ProcessEnv)
		).toBe(8994);
		expect(resolveControlPort({} as NodeJS.ProcessEnv)).toBe(7994);
	});
	it("prefers RYU_EXT_TOKEN over RYU_SIMULATOR_TOKEN", () => {
		expect(
			resolveControlToken({
				RYU_EXT_TOKEN: "a",
				RYU_SIMULATOR_TOKEN: "b",
			} as NodeJS.ProcessEnv)
		).toBe("a");
		expect(resolveControlToken({} as NodeJS.ProcessEnv)).toBeNull();
	});
});

describe("handleRequest", () => {
	it("serves /health unauthenticated", async () => {
		const r = await handleRequest("GET", "/health", undefined, "", deps());
		expect(r.status).toBe(200);
	});
	it("401s protected routes without a bearer", async () => {
		const r = await handleRequest("GET", "/devices", undefined, "", deps());
		expect(r.status).toBe(401);
	});
	it("lists devices", async () => {
		const r = await handleRequest("GET", "/devices", AUTH, "", deps());
		expect(r.status).toBe(200);
		expect((r.json as { devices: Device[] }).devices).toHaveLength(1);
	});
	it("reports capabilities", async () => {
		const r = await handleRequest("GET", "/capabilities", AUTH, "", deps());
		expect((r.json as Capabilities).android.available).toBe(true);
		expect((r.json as Capabilities).ios.available).toBe(false);
	});
	it("boots a device", async () => {
		const d = new FakeDriver();
		const r = await handleRequest(
			"POST",
			"/devices/android:emulator-5554/boot",
			AUTH,
			"",
			deps(d)
		);
		expect(r.status).toBe(200);
		expect(d.calls).toEqual([
			{ method: "boot", args: ["android:emulator-5554"] },
		]);
	});
	it("taps with coordinates", async () => {
		const d = new FakeDriver();
		const r = await handleRequest(
			"POST",
			"/devices/android:x/tap",
			AUTH,
			JSON.stringify({ x: 100, y: 200 }),
			deps(d)
		);
		expect(r.status).toBe(200);
		expect(d.calls).toEqual([{ method: "tap", args: ["android:x", 100, 200] }]);
	});
	it("400s a tap missing coordinates", async () => {
		const r = await handleRequest(
			"POST",
			"/devices/android:x/tap",
			AUTH,
			"{}",
			deps()
		);
		expect(r.status).toBe(400);
	});
	it("maps an unsupported action to 400", async () => {
		const d = new FakeDriver();
		d.tapUnsupported = true;
		const r = await handleRequest(
			"POST",
			"/devices/ios:udid/tap",
			AUTH,
			JSON.stringify({ x: 1, y: 2 }),
			deps(d)
		);
		expect(r.status).toBe(400);
	});
	it("maps an unknown device to 404", async () => {
		const r = await handleRequest(
			"POST",
			"/devices/android:missing/boot",
			AUTH,
			"",
			deps()
		);
		expect(r.status).toBe(404);
	});
	it("returns a base64 screenshot", async () => {
		const r = await handleRequest(
			"GET",
			"/devices/android:x/screenshot",
			AUTH,
			"",
			deps()
		);
		expect(r.status).toBe(200);
		expect((r.json as { image: string }).image).toBe(
			Buffer.from("PNGDATA").toString("base64")
		);
	});
	it("launches an app by id", async () => {
		const d = new FakeDriver();
		const r = await handleRequest(
			"POST",
			"/devices/ios:udid/launch",
			AUTH,
			JSON.stringify({ appId: "com.acme.app" }),
			deps(d)
		);
		expect(r.status).toBe(200);
		expect(d.calls).toEqual([
			{ method: "launch", args: ["ios:udid", "com.acme.app"] },
		]);
	});
});
