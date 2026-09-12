// Device driver for the Ryu Simulator sidecar.
//
// Wraps Apple's `simctl` (iOS Simulator) and Android's `adb`/`emulator` (Android
// Emulator) behind one `DeviceDriver` interface so the control server (`control.ts`)
// is testable with a fake — no real toolchains, no subprocesses.
//
// PLATFORM SUPPORT (the "show whichever is supported" contract)
// -------------------------------------------------------------
// * iOS runs ONLY on macOS (Apple ships `simctl` nowhere else) and needs Xcode + an
//   iOS runtime installed. `probe()` reports it unavailable — with a reason — off
//   mac or without Xcode, and the desktop/agent surfaces gate on that.
// * Android runs on any OS that has the Android SDK platform-tools (`adb`) on PATH.
//
// CONTROL PARITY (the honest limit, per the design decision)
// ----------------------------------------------------------
// * Android: full control — `adb shell input` gives tap/swipe/text/key for free.
// * iOS: `simctl` gives boot/install/launch/openurl/screenshot cleanly, but has NO
//   public coordinate tap/swipe. Those return `unsupported` for an iOS device;
//   adding facebook/idb later is the upgrade path. This is NOT a bug — it is Apple's
//   surface.

import { spawn } from "node:child_process";

export type Platform = "ios" | "android";

export interface Device {
	/** Stable id: iOS udid or Android serial. */
	id: string;
	kind: "simulator" | "emulator";
	name: string;
	/** OS / runtime label, e.g. "iOS 17.5" or "Android 14 (API 34)". */
	os: string;
	platform: Platform;
	state: "booted" | "shutdown" | "unknown";
}

export interface PlatformCapability {
	available: boolean;
	/** True when this platform can drive coordinate taps/swipes/text. */
	interactive: boolean;
	/** Human reason when unavailable (missing Xcode, wrong OS, no SDK). */
	reason?: string;
}

export interface Capabilities {
	android: PlatformCapability;
	ios: PlatformCapability;
}

/** The seam the control server depends on. Fakeable for tests. */
export interface DeviceDriver {
	boot(id: string): Promise<void>;
	install(id: string, appPath: string): Promise<void>;
	key(id: string, name: string): Promise<void>;
	/** Launch an installed app. `appId` = iOS bundle id or Android package name. */
	launch(id: string, appId: string): Promise<void>;
	list(): Promise<Device[]>;
	openUrl(id: string, url: string): Promise<void>;
	probe(): Promise<Capabilities>;
	/** PNG bytes of the current screen. */
	screenshot(id: string): Promise<Buffer>;
	shutdown(id: string): Promise<void>;
	swipe(
		id: string,
		x1: number,
		y1: number,
		x2: number,
		y2: number,
		durationMs: number
	): Promise<void>;
	tap(id: string, x: number, y: number): Promise<void>;
	text(id: string, value: string): Promise<void>;
}

/** Raised for an action a platform cannot perform (e.g. iOS tap). Maps to HTTP 400. */
export class UnsupportedActionError extends Error {}
/** Raised for an unknown device id. Maps to HTTP 404. */
export class UnknownDeviceError extends Error {}

interface RunResult {
	code: number;
	stderr: string;
	stdout: Buffer;
}

/** Run a command, capturing stdout as raw bytes (needed for screenshot PNGs). */
function run(
	cmd: string,
	args: string[],
	opts: { detached?: boolean } = {}
): Promise<RunResult> {
	return new Promise((resolve, reject) => {
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(cmd, args, {
				detached: opts.detached ?? false,
				stdio: opts.detached ? "ignore" : ["ignore", "pipe", "pipe"],
			});
		} catch (e) {
			reject(e instanceof Error ? e : new Error(String(e)));
			return;
		}
		if (opts.detached) {
			// Fire-and-forget (booting an emulator blocks until shutdown otherwise).
			child.unref();
			resolve({ code: 0, stdout: Buffer.alloc(0), stderr: "" });
			return;
		}
		const out: Buffer[] = [];
		const err: string[] = [];
		child.stdout?.on("data", (c: Buffer) => out.push(c));
		child.stderr?.on("data", (c: Buffer) => err.push(c.toString("utf8")));
		child.on("error", (e) => reject(e));
		child.on("close", (code) =>
			resolve({
				code: code ?? 0,
				stdout: Buffer.concat(out),
				stderr: err.join(""),
			})
		);
	});
}

async function commandExists(
	cmd: string,
	probeArgs: string[]
): Promise<boolean> {
	try {
		const r = await run(cmd, probeArgs);
		return r.code === 0;
	} catch {
		return false;
	}
}

// `adb shell <cmd>` re-parses its arguments through the emulator's /system/bin/sh,
// so a request-supplied string containing shell metacharacters (`;`, backticks,
// `$()`, `&`, …) would be interpreted rather than passed literally. The host spawn
// is already safe (no `shell: true`) and the route is bearer-gated, so the blast
// radius is the ephemeral emulator only — but we single-quote remote-sh arguments
// as defense-in-depth. Single quotes disable every metacharacter; the only thing
// that can end a single-quoted string is a single quote, which we escape as '\''.
function shQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

// Android keyevents are a constrained set: a numeric keycode or a `KEYCODE_*` name.
// Anything else is rejected rather than handed to the remote sh.
const KEYCODE_PATTERN = /^(?:\d+|KEYCODE_[A-Z0-9_]+)$/;

const IOS_PREFIX = "ios:";
const ANDROID_PREFIX = "android:";

function tagId(platform: Platform, raw: string): string {
	return `${platform === "ios" ? IOS_PREFIX : ANDROID_PREFIX}${raw}`;
}

/** Split a tagged id back into `{platform, raw}`. Throws UnknownDeviceError if malformed. */
function untag(id: string): { platform: Platform; raw: string } {
	if (id.startsWith(IOS_PREFIX)) {
		return { platform: "ios", raw: id.slice(IOS_PREFIX.length) };
	}
	if (id.startsWith(ANDROID_PREFIX)) {
		return { platform: "android", raw: id.slice(ANDROID_PREFIX.length) };
	}
	throw new UnknownDeviceError(`unknown device id: ${id}`);
}

/**
 * The production driver. iOS ids are namespaced `ios:<udid>`, Android `android:<serial>`,
 * so one flat id space addresses both toolchains and the platform is recoverable from
 * the id alone (the control server never needs a separate platform param).
 */
export class RealDeviceDriver implements DeviceDriver {
	async probe(): Promise<Capabilities> {
		const isMac = process.platform === "darwin";
		const [hasSimctl, hasAdb] = await Promise.all([
			isMac
				? commandExists("xcrun", ["simctl", "help"])
				: Promise.resolve(false),
			commandExists("adb", ["version"]),
		]);
		return {
			ios: {
				available: isMac && hasSimctl,
				interactive: false,
				reason: isMac
					? hasSimctl
						? undefined
						: "Xcode command line tools not found. Install Xcode, then run `xcodebuild -downloadPlatform iOS`."
					: "The iOS Simulator runs only on macOS; this node is not a Mac.",
			},
			android: {
				available: hasAdb,
				interactive: hasAdb,
				reason: hasAdb
					? undefined
					: "Android platform-tools (`adb`) not found on PATH. Install the Android SDK.",
			},
		};
	}

	async list(): Promise<Device[]> {
		const [ios, android] = await Promise.all([
			this.listIos().catch(() => [] as Device[]),
			this.listAndroid().catch(() => [] as Device[]),
		]);
		return [...ios, ...android];
	}

	private async listIos(): Promise<Device[]> {
		if (process.platform !== "darwin") {
			return [];
		}
		const r = await run("xcrun", ["simctl", "list", "devices", "--json"]);
		if (r.code !== 0) {
			return [];
		}
		const parsed = JSON.parse(r.stdout.toString("utf8")) as {
			devices: Record<
				string,
				Array<{
					udid: string;
					name: string;
					state: string;
					isAvailable?: boolean;
				}>
			>;
		};
		const out: Device[] = [];
		for (const [runtime, devs] of Object.entries(parsed.devices)) {
			// Runtime key looks like "com.apple.CoreSimulator.SimRuntime.iOS-17-5".
			const os =
				runtime.split(".SimRuntime.").pop()?.replace(/-/g, " ") ?? runtime;
			for (const d of devs) {
				if (d.isAvailable === false) {
					continue;
				}
				out.push({
					id: tagId("ios", d.udid),
					platform: "ios",
					name: d.name,
					os,
					state: d.state === "Booted" ? "booted" : "shutdown",
					kind: "simulator",
				});
			}
		}
		return out;
	}

	private async listAndroid(): Promise<Device[]> {
		const booted = new Map<string, string>();
		const r = await run("adb", ["devices", "-l"]);
		if (r.code === 0) {
			for (const line of r.stdout.toString("utf8").split("\n").slice(1)) {
				const m = line.match(/^(\S+)\s+device\b(.*)$/);
				if (m) {
					const model = m[2].match(/model:(\S+)/)?.[1]?.replace(/_/g, " ");
					booted.set(m[1], model ?? m[1]);
				}
			}
		}
		const out: Device[] = [];
		for (const [serial, name] of booted) {
			out.push({
				id: tagId("android", serial),
				platform: "android",
				name,
				os: "Android",
				state: "booted",
				kind: "emulator",
			});
		}
		// Offline AVDs the user can boot.
		const avds = await run("emulator", ["-list-avds"]).catch(() => null);
		if (avds && avds.code === 0) {
			for (const avd of avds.stdout
				.toString("utf8")
				.split("\n")
				.map((s) => s.trim())) {
				if (avd && !out.some((d) => d.name === avd)) {
					out.push({
						id: tagId("android", `@${avd}`),
						platform: "android",
						name: avd,
						os: "Android",
						state: "shutdown",
						kind: "emulator",
					});
				}
			}
		}
		return out;
	}

	private async simctl(args: string[]): Promise<RunResult> {
		const r = await run("xcrun", ["simctl", ...args]);
		if (r.code !== 0) {
			throw new Error(r.stderr.trim() || `simctl ${args[0]} failed`);
		}
		return r;
	}

	private async adb(serial: string, args: string[]): Promise<RunResult> {
		const r = await run("adb", ["-s", serial, ...args]);
		if (r.code !== 0) {
			throw new Error(r.stderr.trim() || `adb ${args[0]} failed`);
		}
		return r;
	}

	async boot(id: string): Promise<void> {
		const { platform, raw } = untag(id);
		if (platform === "ios") {
			await this.simctl(["boot", raw]);
			return;
		}
		if (raw.startsWith("@")) {
			// An AVD name — launch a fresh emulator (detached, it blocks otherwise).
			await run("emulator", ["-avd", raw.slice(1)], { detached: true });
			return;
		}
		// A serial that is already a running device — nothing to boot.
	}

	async shutdown(id: string): Promise<void> {
		const { platform, raw } = untag(id);
		if (platform === "ios") {
			await this.simctl(["shutdown", raw]);
			return;
		}
		await this.adb(raw, ["emu", "kill"]);
	}

	async install(id: string, appPath: string): Promise<void> {
		const { platform, raw } = untag(id);
		if (platform === "ios") {
			await this.simctl(["install", raw, appPath]);
			return;
		}
		await this.adb(raw, ["install", "-r", appPath]);
	}

	async launch(id: string, appId: string): Promise<void> {
		const { platform, raw } = untag(id);
		if (platform === "ios") {
			await this.simctl(["launch", raw, appId]);
			return;
		}
		await this.adb(raw, [
			"shell",
			"monkey",
			"-p",
			shQuote(appId),
			"-c",
			"android.intent.category.LAUNCHER",
			"1",
		]);
	}

	async openUrl(id: string, url: string): Promise<void> {
		const { platform, raw } = untag(id);
		if (platform === "ios") {
			await this.simctl(["openurl", raw, url]);
			return;
		}
		await this.adb(raw, [
			"shell",
			"am",
			"start",
			"-a",
			"android.intent.action.VIEW",
			"-d",
			shQuote(url),
		]);
	}

	async screenshot(id: string): Promise<Buffer> {
		const { platform, raw } = untag(id);
		if (platform === "ios") {
			// `-` writes the PNG to stdout.
			const r = await this.simctl(["io", raw, "screenshot", "--type=png", "-"]);
			return r.stdout;
		}
		const r = await this.adb(raw, ["exec-out", "screencap", "-p"]);
		return r.stdout;
	}

	async tap(id: string, x: number, y: number): Promise<void> {
		const { platform, raw } = untag(id);
		if (platform === "ios") {
			throw new UnsupportedActionError(
				"iOS Simulator has no public coordinate tap (simctl). Install facebook/idb to enable it."
			);
		}
		await this.adb(raw, ["shell", "input", "tap", String(x), String(y)]);
	}

	async swipe(
		id: string,
		x1: number,
		y1: number,
		x2: number,
		y2: number,
		durationMs: number
	): Promise<void> {
		const { platform, raw } = untag(id);
		if (platform === "ios") {
			throw new UnsupportedActionError(
				"iOS Simulator has no public coordinate swipe (simctl). Install facebook/idb to enable it."
			);
		}
		await this.adb(raw, [
			"shell",
			"input",
			"swipe",
			String(x1),
			String(y1),
			String(x2),
			String(y2),
			String(durationMs),
		]);
	}

	async text(id: string, value: string): Promise<void> {
		const { platform, raw } = untag(id);
		if (platform === "ios") {
			throw new UnsupportedActionError(
				"iOS Simulator text entry needs facebook/idb; not available via simctl."
			);
		}
		// `input text` treats spaces specially; encode them as %s. Single-quote the
		// result so shell metacharacters in `value` reach `input text` literally
		// instead of being interpreted by the emulator's sh.
		await this.adb(raw, [
			"shell",
			"input",
			"text",
			shQuote(value.replace(/ /g, "%s")),
		]);
	}

	async key(id: string, name: string): Promise<void> {
		const { platform, raw } = untag(id);
		if (platform === "ios") {
			throw new UnsupportedActionError(
				"iOS Simulator hardware keys need facebook/idb; not available via simctl."
			);
		}
		const keycode = ANDROID_KEYCODES[name.toLowerCase()] ?? name;
		if (!KEYCODE_PATTERN.test(keycode)) {
			throw new UnsupportedActionError(
				`unsupported key: ${name}. Use a friendly name (home, back, enter, …), a numeric keycode, or a KEYCODE_* name.`
			);
		}
		await this.adb(raw, ["shell", "input", "keyevent", keycode]);
	}
}

/** Friendly key name → Android keyevent. Unknown names pass through verbatim. */
const ANDROID_KEYCODES: Record<string, string> = {
	home: "KEYCODE_HOME",
	back: "KEYCODE_BACK",
	enter: "KEYCODE_ENTER",
	menu: "KEYCODE_MENU",
	power: "KEYCODE_POWER",
	volumeup: "KEYCODE_VOLUME_UP",
	volumedown: "KEYCODE_VOLUME_DOWN",
	appswitch: "KEYCODE_APP_SWITCH",
	delete: "KEYCODE_DEL",
	tab: "KEYCODE_TAB",
};
