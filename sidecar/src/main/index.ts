// Ryu Simulator sidecar — entrypoint.
//
// A dependency-free Node/Bun process Core spawns as a `local` manifest sidecar. It
// wraps Apple's `simctl` and Android's `adb`/`emulator` behind one loopback HTTP
// control server (`control.ts`) driven by `RealDeviceDriver` (`devices.ts`). No
// window, no Electron — the device UI is Apple's/Google's own simulator, and the
// desktop panel streams screenshots over the control surface.

import {
	resolveControlPort,
	resolveControlToken,
	startControlServer,
} from "./control.ts";
import { RealDeviceDriver } from "./devices.ts";

function main(): void {
	const port = resolveControlPort();
	const token = resolveControlToken();
	if (!token) {
		// Fail-closed is enforced per-request; warn once so a misconfigured spawn is
		// diagnosable rather than silently rejecting everything.
		// biome-ignore lint/suspicious/noConsole: main-process diagnostic, no renderer.
		console.warn(
			"[ryu-simulator] no RYU_EXT_TOKEN/RYU_SIMULATOR_TOKEN set — all control routes will 401"
		);
	}
	startControlServer({ driver: new RealDeviceDriver(), token }, port);
	// biome-ignore lint/suspicious/noConsole: main-process diagnostic, no renderer.
	console.log(`[ryu-simulator] control server on 127.0.0.1:${port}`);
}

main();
