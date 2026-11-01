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
		console.warn(
			"[ryu-simulator] no RYU_EXT_TOKEN set — all control routes will 401"
		);
	}
	startControlServer({ driver: new RealDeviceDriver(), token }, port);
	console.log(`[ryu-simulator] control server on 127.0.0.1:${port}`);
}

main();
