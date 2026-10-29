import { describe, expect, it } from "bun:test";
import { z } from "zod";
import {
	capabilitiesSchema,
	devicesResponseSchema,
	screenshotResponseSchema,
} from "./contracts.ts";
import {
	bearerOk,
	handleRequest,
	isJsonContentType,
	isTrustedLocalRequest,
	MAX_CONTROL_BODY_BYTES,
	resolveControlPort,
	resolveControlToken,
	startControlServer,
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
function fixtureResult<T>(read: () => T): Promise<T> {
	return new Promise((resolve) => {
		resolve(read());
	});
}

class FakeDriver implements DeviceDriver {
	public calls: Array<{ method: string; args: (string | number)[] }> = [];
	public tapUnsupported = false;

	private record(method: string, ...args: (string | number)[]): void {
		this.calls.push({ method, args });
	}

	probe(): Promise<Capabilities> {
		return fixtureResult(() => {
			return {
				ios: { available: false, interactive: false, reason: "not a mac" },
				android: { available: true, interactive: true },
			};
		});
	}
	list(): Promise<Device[]> {
		return fixtureResult(() => {
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
		});
	}
	boot(id: string): Promise<void> {
		return fixtureResult(() => {
			if (id === "android:missing") {
				throw new UnknownDeviceError("unknown");
			}
			this.record("boot", id);
		});
	}
	shutdown(id: string): Promise<void> {
		return fixtureResult(() => {
			this.record("shutdown", id);
		});
	}
	install(id: string, appPath: string): Promise<void> {
		return fixtureResult(() => {
			this.record("install", id, appPath);
		});
	}
	launch(id: string, appId: string): Promise<void> {
		return fixtureResult(() => {
			this.record("launch", id, appId);
		});
	}
	openUrl(id: string, url: string): Promise<void> {
		return fixtureResult(() => {
			this.record("openUrl", id, url);
		});
	}
	screenshot(_id: string): Promise<Buffer> {
		return fixtureResult(() => {
			return Buffer.from("PNGDATA");
		});
	}
	tap(id: string, x: number, y: number): Promise<void> {
		return fixtureResult(() => {
			if (this.tapUnsupported) {
				throw new UnsupportedActionError("no ios tap");
			}
			this.record("tap", id, x, y);
		});
	}
	swipe(
		id: string,
		x1: number,
		y1: number,
		x2: number,
		y2: number
	): Promise<void> {
		return fixtureResult(() => {
			this.record("swipe", id, x1, y1, x2, y2);
		});
	}
	text(id: string, value: string): Promise<void> {
		return fixtureResult(() => {
			this.record("text", id, value);
		});
	}
	key(id: string, name: string): Promise<void> {
		return fixtureResult(() => {
			this.record("key", id, name);
		});
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
	it("isolates every known profile instead of treating all non-release builds as dev", () => {
		expect(resolveControlPort({ RYU_PROFILE: "dev" })).toBe(8994);
		expect(resolveControlPort({ RYU_PROFILE: "canary" })).toBe(9994);
		expect(resolveControlPort({ RYU_PROFILE: "nightly" })).toBe(10_994);
		expect(resolveControlPort({ RYU_PROFILE: "beta" })).toBe(11_994);
		expect(resolveControlPort({})).toBe(7994);
		expect(() => resolveControlPort({ RYU_PROFILE: "staging" })).toThrow(
			"unknown RYU_PROFILE"
		);
	});
	it("reads only RYU_EXT_TOKEN", () => {
		expect(resolveControlToken({ RYU_EXT_TOKEN: " a " })).toBe("a");
		expect(resolveControlToken({ RYU_SIMULATOR_TOKEN: "b" })).toBeNull();
		expect(resolveControlToken({})).toBeNull();
	});
});

describe("loopback ingress guards", () => {
	it("rejects browser origins and DNS-rebound hosts", () => {
		expect(
			isTrustedLocalRequest(
				{ headers: { host: "127.0.0.1:8994", origin: "https://evil.test" } },
				8994
			)
		).toBe(false);
		expect(
			isTrustedLocalRequest({ headers: { host: "evil.test:8994" } }, 8994)
		).toBe(false);
		expect(
			isTrustedLocalRequest({ headers: { host: "localhost:8994" } }, 8994)
		).toBe(true);
	});

	it("accepts only JSON content types for body-parsing routes", () => {
		expect(isJsonContentType("application/json")).toBe(true);
		expect(isJsonContentType("application/json; charset=utf-8")).toBe(true);
		expect(isJsonContentType("text/plain")).toBe(false);
		expect(isJsonContentType(undefined)).toBe(false);
	});

	it("authenticates before buffering and caps authenticated bodies", async () => {
		const server = startControlServer(deps(), 0);
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const address = server.address();
		if (!address || z.string().safeParse(address).success) {
			throw new Error("simulator test server did not expose a TCP port");
		}
		const port = z.object({ port: z.number() }).parse(address).port;
		const url = `http://127.0.0.1:${port}/devices/android:x/boot`;
		const oversizedBody = "x".repeat(MAX_CONTROL_BODY_BYTES + 1);

		try {
			const unauthorized = await fetch(url, {
				body: oversizedBody,
				headers: { "Content-Type": "application/json" },
				method: "POST",
			});
			expect(unauthorized.status).toBe(401);

			const oversized = await fetch(url, {
				body: oversizedBody,
				headers: {
					Authorization: AUTH,
					"Content-Type": "application/json",
				},
				method: "POST",
			});
			expect(oversized.status).toBe(413);

			const plainText = await fetch(url, {
				body: "{}",
				headers: { Authorization: AUTH, "Content-Type": "text/plain" },
				method: "POST",
			});
			expect(plainText.status).toBe(415);
		} finally {
			await new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			});
		}
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
		expect(devicesResponseSchema.parse(r.json).devices).toHaveLength(1);
	});
	it("reports capabilities", async () => {
		const r = await handleRequest("GET", "/capabilities", AUTH, "", deps());
		expect(capabilitiesSchema.parse(r.json).android.available).toBe(true);
		expect(capabilitiesSchema.parse(r.json).ios.available).toBe(false);
	});
	it("boots a device", async () => {
		const d = new FakeDriver();
		const r = await handleRequest(
			"POST",
			"/devices/android:emulator-5554/boot",
			AUTH,
			"",
			deps(d),
			"application/json"
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
			deps(d),
			"application/json"
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
			deps(),
			"application/json"
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
			deps(d),
			"application/json"
		);
		expect(r.status).toBe(400);
	});
	it("maps an unknown device to 404", async () => {
		const r = await handleRequest(
			"POST",
			"/devices/android:missing/boot",
			AUTH,
			"",
			deps(),
			"application/json"
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
		expect(screenshotResponseSchema.parse(r.json).image).toBe(
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
			deps(d),
			"application/json"
		);
		expect(r.status).toBe(200);
		expect(d.calls).toEqual([
			{ method: "launch", args: ["ios:udid", "com.acme.app"] },
		]);
	});
});
