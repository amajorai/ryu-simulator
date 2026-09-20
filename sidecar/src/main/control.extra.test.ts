// Additional control-router coverage: the capability root, the 404/400/500 edges,
// the JSON-body guard, and every mutating action's happy path + missing-param
// rejection. Exercised over an injected fake driver — no simctl, no adb, no sockets.

import { describe, expect, it } from "bun:test";
import { handleRequest } from "./control.ts";
import type { Capabilities, Device, DeviceDriver } from "./devices.ts";

// A recording fake. `failWith` lets a test force a generic (non-typed) driver throw
// so the 500 branch of errorResponse is exercised.
class RecordingDriver implements DeviceDriver {
	public calls: Array<{ method: string; args: unknown[] }> = [];
	public failWith: Error | null = null;

	private rec(method: string, ...args: unknown[]): void {
		if (this.failWith) {
			throw this.failWith;
		}
		this.calls.push({ method, args });
	}

	// biome-ignore lint/suspicious/useAwait: async by interface; fake is synchronous.
	async probe(): Promise<Capabilities> {
		return {
			ios: { available: false, interactive: false },
			android: { available: true, interactive: true },
		};
	}
	// biome-ignore lint/suspicious/useAwait: async by interface; fake is synchronous.
	async list(): Promise<Device[]> {
		return [];
	}
	// biome-ignore lint/suspicious/useAwait: async by interface; fake is synchronous.
	async boot(id: string): Promise<void> {
		this.rec("boot", id);
	}
	// biome-ignore lint/suspicious/useAwait: async by interface; fake is synchronous.
	async shutdown(id: string): Promise<void> {
		this.rec("shutdown", id);
	}
	// biome-ignore lint/suspicious/useAwait: async by interface; fake is synchronous.
	async install(id: string, appPath: string): Promise<void> {
		this.rec("install", id, appPath);
	}
	// biome-ignore lint/suspicious/useAwait: async by interface; fake is synchronous.
	async launch(id: string, appId: string): Promise<void> {
		this.rec("launch", id, appId);
	}
	// biome-ignore lint/suspicious/useAwait: async by interface; fake is synchronous.
	async openUrl(id: string, url: string): Promise<void> {
		this.rec("openUrl", id, url);
	}
	// biome-ignore lint/suspicious/useAwait: async by interface; fake is synchronous.
	async screenshot(_id: string): Promise<Buffer> {
		return Buffer.from("PNG");
	}
	// biome-ignore lint/suspicious/useAwait: async by interface; fake is synchronous.
	async tap(id: string, x: number, y: number): Promise<void> {
		this.rec("tap", id, x, y);
	}
	// biome-ignore lint/suspicious/useAwait: async by interface; fake is synchronous.
	async swipe(
		id: string,
		x1: number,
		y1: number,
		x2: number,
		y2: number,
		durationMs: number
	): Promise<void> {
		this.rec("swipe", id, x1, y1, x2, y2, durationMs);
	}
	// biome-ignore lint/suspicious/useAwait: async by interface; fake is synchronous.
	async text(id: string, value: string): Promise<void> {
		this.rec("text", id, value);
	}
	// biome-ignore lint/suspicious/useAwait: async by interface; fake is synchronous.
	async key(id: string, name: string): Promise<void> {
		this.rec("key", id, name);
	}
}

const TOKEN = "tok";
const AUTH = `Bearer ${TOKEN}`;
function deps(driver: RecordingDriver = new RecordingDriver()) {
	return { driver, token: TOKEN };
}

const DEV = "/devices/android:x";

describe("capability root + unknown routes", () => {
	it("GET / returns the capability descriptor (bearer-gated)", async () => {
		const r = await handleRequest("GET", "/", AUTH, "", deps());
		expect(r.status).toBe(200);
		expect((r.json as { capability: string }).capability).toBe(
			"simulator.control"
		);
	});

	it("GET / without a bearer is 401", async () => {
		const r = await handleRequest("GET", "/", undefined, "", deps());
		expect(r.status).toBe(401);
	});

	it("an unknown authenticated route is 404", async () => {
		const r = await handleRequest("GET", "/nope", AUTH, "", deps());
		expect(r.status).toBe(404);
	});

	it("an unknown action on a known device is 404", async () => {
		const r = await handleRequest("POST", `${DEV}/fly`, AUTH, "{}", deps());
		expect(r.status).toBe(404);
	});

	it("a non-POST, non-screenshot action falls through to 404", async () => {
		// PUT is neither the GET screenshot special-case nor a POST action.
		const r = await handleRequest("PUT", `${DEV}/boot`, AUTH, "", deps());
		expect(r.status).toBe(404);
	});
});

describe("request body handling", () => {
	it("400s when a POST action carries a malformed JSON body", async () => {
		const r = await handleRequest("POST", `${DEV}/boot`, AUTH, "{bad", deps());
		expect(r.status).toBe(400);
		expect((r.json as { error: string }).error).toBe("invalid json body");
	});

	it("treats an empty body as an empty object (boot needs no params)", async () => {
		const d = new RecordingDriver();
		const r = await handleRequest("POST", `${DEV}/boot`, AUTH, "", deps(d));
		expect(r.status).toBe(200);
		expect(d.calls).toEqual([{ method: "boot", args: ["android:x"] }]);
	});

	it("decodes a percent-encoded device id", async () => {
		const d = new RecordingDriver();
		const r = await handleRequest(
			"POST",
			"/devices/android%3Aemulator-5554/boot",
			AUTH,
			"",
			deps(d)
		);
		expect(r.status).toBe(200);
		expect(d.calls[0]?.args[0]).toBe("android:emulator-5554");
	});
});

describe("mutating actions: happy path + missing-param rejection", () => {
	it("shutdown", async () => {
		const d = new RecordingDriver();
		const r = await handleRequest("POST", `${DEV}/shutdown`, AUTH, "", deps(d));
		expect(r.status).toBe(200);
		expect(d.calls[0]?.method).toBe("shutdown");
	});

	it("install requires appPath", async () => {
		const missing = await handleRequest(
			"POST",
			`${DEV}/install`,
			AUTH,
			"{}",
			deps()
		);
		expect(missing.status).toBe(400);
		expect((missing.json as { error: string }).error).toBe("missing appPath");
		const d = new RecordingDriver();
		const ok = await handleRequest(
			"POST",
			`${DEV}/install`,
			AUTH,
			JSON.stringify({ appPath: "/tmp/a.apk" }),
			deps(d)
		);
		expect(ok.status).toBe(200);
		expect(d.calls[0]).toEqual({
			method: "install",
			args: ["android:x", "/tmp/a.apk"],
		});
	});

	it("launch requires appId", async () => {
		const missing = await handleRequest(
			"POST",
			`${DEV}/launch`,
			AUTH,
			"{}",
			deps()
		);
		expect(missing.status).toBe(400);
		expect((missing.json as { error: string }).error).toContain("appId");
		const d = new RecordingDriver();
		const ok = await handleRequest(
			"POST",
			`${DEV}/launch`,
			AUTH,
			JSON.stringify({ appId: "com.acme" }),
			deps(d)
		);
		expect(ok.status).toBe(200);
	});

	it("openurl requires url", async () => {
		const missing = await handleRequest(
			"POST",
			`${DEV}/openurl`,
			AUTH,
			"{}",
			deps()
		);
		expect(missing.status).toBe(400);
		const d = new RecordingDriver();
		const ok = await handleRequest(
			"POST",
			`${DEV}/openurl`,
			AUTH,
			JSON.stringify({ url: "https://ryuhq.com" }),
			deps(d)
		);
		expect(ok.status).toBe(200);
		expect(d.calls[0]).toEqual({
			method: "openUrl",
			args: ["android:x", "https://ryuhq.com"],
		});
	});

	it("swipe requires all four coordinates and defaults duration to 300", async () => {
		const missing = await handleRequest(
			"POST",
			`${DEV}/swipe`,
			AUTH,
			JSON.stringify({ x1: 1, y1: 2 }),
			deps()
		);
		expect(missing.status).toBe(400);
		const d = new RecordingDriver();
		const ok = await handleRequest(
			"POST",
			`${DEV}/swipe`,
			AUTH,
			JSON.stringify({ x1: 1, y1: 2, x2: 3, y2: 4 }),
			deps(d)
		);
		expect(ok.status).toBe(200);
		expect(d.calls[0]).toEqual({
			method: "swipe",
			args: ["android:x", 1, 2, 3, 4, 300],
		});
	});

	it("swipe honors an explicit duration", async () => {
		const d = new RecordingDriver();
		await handleRequest(
			"POST",
			`${DEV}/swipe`,
			AUTH,
			JSON.stringify({ x1: 1, y1: 2, x2: 3, y2: 4, durationMs: 900 }),
			deps(d)
		);
		expect(d.calls[0]?.args.at(-1)).toBe(900);
	});

	it("text requires a non-empty string", async () => {
		const missing = await handleRequest(
			"POST",
			`${DEV}/text`,
			AUTH,
			"{}",
			deps()
		);
		expect(missing.status).toBe(400);
		const d = new RecordingDriver();
		const ok = await handleRequest(
			"POST",
			`${DEV}/text`,
			AUTH,
			JSON.stringify({ text: "hello world" }),
			deps(d)
		);
		expect(ok.status).toBe(200);
		expect(d.calls[0]?.args[1]).toBe("hello world");
	});

	it("key requires a name", async () => {
		const missing = await handleRequest(
			"POST",
			`${DEV}/key`,
			AUTH,
			"{}",
			deps()
		);
		expect(missing.status).toBe(400);
		const d = new RecordingDriver();
		const ok = await handleRequest(
			"POST",
			`${DEV}/key`,
			AUTH,
			JSON.stringify({ key: "home" }),
			deps(d)
		);
		expect(ok.status).toBe(200);
		expect(d.calls[0]).toEqual({ method: "key", args: ["android:x", "home"] });
	});
});

describe("non-number coordinates are rejected", () => {
	it("tap rejects a stringified number (num() requires a real number)", async () => {
		const r = await handleRequest(
			"POST",
			`${DEV}/tap`,
			AUTH,
			JSON.stringify({ x: "10", y: 20 }),
			deps()
		);
		expect(r.status).toBe(400);
	});

	it("tap rejects a non-finite coordinate", async () => {
		const r = await handleRequest(
			"POST",
			`${DEV}/tap`,
			AUTH,
			JSON.stringify({ x: 10, y: null }),
			deps()
		);
		expect(r.status).toBe(400);
	});
});

describe("driver failures map to the right status", () => {
	it("a generic driver throw becomes a 500 with the message", async () => {
		const d = new RecordingDriver();
		d.failWith = new Error("device exploded");
		const r = await handleRequest("POST", `${DEV}/boot`, AUTH, "", deps(d));
		expect(r.status).toBe(500);
		expect((r.json as { error: string }).error).toBe("device exploded");
	});

	it("a non-Error throw still yields a 500", async () => {
		const d = new RecordingDriver();
		// biome-ignore lint/suspicious/noExplicitAny: forcing a non-Error throw.
		d.failWith = "boom" as any;
		const r = await handleRequest("POST", `${DEV}/boot`, AUTH, "", deps(d));
		expect(r.status).toBe(500);
		expect((r.json as { error: string }).error).toBe("error");
	});
});
