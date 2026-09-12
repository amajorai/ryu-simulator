// The Simulator sidecar's OpenAPI 3.0 document, served at `GET /openapi.json`.
//
// WHY THIS FILE EXISTS
// --------------------
// Core derives LLM tools from each app sidecar's own OpenAPI document: on the
// sidecar's first Healthy edge it fetches `http://127.0.0.1:<port>/openapi.json`
// (`apps/core/src/sidecar/manifest_sidecar.rs`, `import_openapi_once`), lowers every
// operation into a proxy-addressed tool, and intersects the result against this
// app's manifest `sidecars[].http.routes[]`. The 11 Rust backends get this document
// for free from utoipa. This sidecar is hand-rolled Node/Bun HTTP with no framework,
// so the document is hand-written — and that is the ONLY difference. Without it the
// fetch 404s, Core records "no derived tools" DEFINITIVELY (a 404 is not retried),
// and `@ryu/simulator` — which ships **zero** `manifest.runnables` — contributes no
// agent tools at all. This file is that app's entire agent surface.
//
// THE THREE RULES THIS DOCUMENT MUST OBEY
// ---------------------------------------
// 1. **Every path here must also be declared in `manifest.json`'s
//    `sidecars[].http.routes[]`.** `ext_api::lower` drops any operation whose
//    sub-path no declared pattern matches, because the ext-proxy would 404 it —
//    a documented-but-undeclared operation becomes a tool that always fails.
//    Path parameters are written `{id}` here and `:id` there; the proxy's own
//    matcher treats `{id}` as an ordinary segment, so `/devices/:id/tap` matches.
// 2. **Paths are written as the sidecar actually serves them** (`/devices`, not
//    `/api/simulator/devices`). `lower` strips the sidecar's `http.mount` from each
//    documented path before the intersection, and this sidecar's router is rooted at
//    `/` — which is why the manifest carries `public_mount` but no `mount`. If a
//    `mount` is ever re-added here, every path below has to gain that prefix or the
//    whole document lowers to nothing with only a debug-level warning.
// 3. **Write routes must carry a real `requestBody` schema with named properties.**
//    `openapi_import::build_tool` merges those properties into the tool's
//    `input_schema`; an untyped/absent body yields a tool the model can see and call
//    but has no arguments to fill in. Every property description below is written for
//    a model deciding whether and how to call the route — that text is what it reads.
//
// The schemas are derived from `control.ts`'s `dispatchAction` (the keys it reads off
// the parsed body, and which ones it 400s on) and from `devices.ts`'s `DeviceDriver`.
// They describe what the handlers TRULY accept — a schema that promises more than the
// handler honours is worse than none, because the model trusts it.
//
// Responses are deliberately left thin: Core's importer reads `requestBody` and
// `parameters` only, and never looks at `responses`.

/** Shared `{id}` path parameter — every `/devices/:id/*` route takes the same one. */
const DEVICE_ID_PARAM = {
	name: "id",
	in: "path",
	required: true,
	description:
		"Tagged device id from list_devices, e.g. `ios:0F2A…` (a simctl UDID) or `android:emulator-5554` (an adb serial). The `ios:`/`android:` prefix is part of the id and selects the toolchain — an untagged udid or serial is rejected as unknown.",
	schema: { type: "string" },
} as const;

/** `POST /devices/{id}/<action>` operations that take no body at all. */
function bodylessDeviceAction(
	operationId: string,
	summary: string,
	description: string
) {
	return {
		post: {
			operationId,
			summary,
			description,
			parameters: [DEVICE_ID_PARAM],
			responses: { "200": { description: "The action was dispatched." } },
		},
	};
}

/** `POST /devices/{id}/<action>` operations that take a JSON body. */
function bodiedDeviceAction(
	operationId: string,
	summary: string,
	description: string,
	schemaRef: string
) {
	return {
		post: {
			operationId,
			summary,
			description,
			parameters: [DEVICE_ID_PARAM],
			requestBody: {
				required: true,
				content: {
					"application/json": {
						schema: { $ref: `#/components/schemas/${schemaRef}` },
					},
				},
			},
			responses: { "200": { description: "The action was dispatched." } },
		},
	};
}

/**
 * The document. A plain literal rather than a builder: it is read by humans as the
 * app's API reference and by Core as the tool source, and both are better served by
 * something greppable than by something computed.
 */
export const OPENAPI_DOCUMENT = {
	openapi: "3.0.3",
	info: {
		title: "Ryu Simulator",
		version: "1.0.0",
		description:
			"Control the iOS Simulators (via Apple's `simctl`) and Android Emulators (via `adb`) installed on this node. iOS supports boot/shutdown, install, launch, deep links and screenshots; coordinate tap/swipe/text/key are Android-only, because `simctl` publishes no coordinate input surface. Call `GET /capabilities` first to learn which platforms this node can actually drive.",
	},
	// No `servers` block on purpose: Core supplies the base URL
	// (`http://127.0.0.1:<port>`) at import time. Hardcoding one here would bake a
	// particular node's loopback port into the published satellite repo.
	paths: {
		"/": {
			get: {
				operationId: "service_info",
				summary: "Simulator sidecar service info",
				description:
					"Identity and version of the running simulator control sidecar, plus the capability it backs (`simulator.control`). Use it to confirm the sidecar is the one you expect; use `GET /capabilities` to learn what it can do.",
				responses: { "200": { description: "Service identity." } },
			},
		},
		"/health": {
			get: {
				operationId: "health",
				summary: "Liveness probe",
				description:
					"Report whether the simulator control sidecar is up. The only unauthenticated route; it reveals nothing but the name and version.",
				responses: { "200": { description: "The sidecar is up." } },
			},
		},
		"/capabilities": {
			get: {
				operationId: "probe_capabilities",
				summary: "Which mobile platforms this node can drive",
				description:
					"Probe the node's toolchain and report, per platform, whether it is `available` (iOS needs macOS with Xcode's simctl; Android needs the SDK platform-tools' adb on PATH) and whether it is `interactive` (can accept coordinate taps, swipes and typing — true for Android, false for iOS). Unavailable platforms carry a human `reason`. Call this before anything else: it is a live probe of the node, never an OS guess.",
				responses: { "200": { description: "Per-platform capabilities." } },
			},
		},
		"/devices": {
			get: {
				operationId: "list_devices",
				summary: "List the simulators and emulators on this node",
				description:
					"List every iOS Simulator and Android Emulator known to this node as `{devices:[{id,kind,name,os,platform,state}]}`. `id` is the tagged handle (`ios:<udid>` / `android:<serial>`) every other route takes, and `state` is `booted`, `shutdown` or `unknown` — a device must be `booted` before install, launch, screenshot or input will work.",
				responses: { "200": { description: "The device list." } },
			},
		},
		"/devices/{id}/screenshot": {
			get: {
				operationId: "screenshot_device",
				summary: "Capture the device screen",
				description:
					'Capture the current screen of a BOOTED device and return `{image,encoding:"base64",mime:"image/png"}`. This is the way to see what an app looks like right now; a shutdown device has no screen and fails.',
				parameters: [DEVICE_ID_PARAM],
				responses: { "200": { description: "A base64 PNG of the screen." } },
			},
		},
		"/devices/{id}/boot": bodylessDeviceAction(
			"boot_device",
			"Boot a simulator or emulator",
			"Start a shutdown device so it can accept installs, launches, screenshots and input. Booting is asynchronous on both platforms — poll `GET /devices` until the device reports `booted` rather than assuming it is ready when this returns."
		),
		"/devices/{id}/shutdown": bodylessDeviceAction(
			"shutdown_device",
			"Shut a simulator or emulator down",
			"Power off a booted device. Anything running on it is lost; the device itself is not deleted and can be booted again."
		),
		"/devices/{id}/install": bodiedDeviceAction(
			"install_app",
			"Install an app build onto a device",
			"Install a locally built app onto a BOOTED device. Installing does not launch it — follow with `launch_app`. The path is read on the node the sidecar runs on, not on the caller's machine.",
			"InstallBody"
		),
		"/devices/{id}/launch": bodiedDeviceAction(
			"launch_app",
			"Launch an installed app",
			"Launch an app that is already installed on a BOOTED device, by bundle id (iOS) or package name (Android). Use `install_app` first for a build that is not on the device yet.",
			"LaunchBody"
		),
		"/devices/{id}/openurl": bodiedDeviceAction(
			"open_url",
			"Open a URL or deep link on the device",
			"Hand a URL to the device's URL handler: an `https://` link opens in the device browser, and a custom scheme (`myapp://path`) opens the app registered for it. This is how you exercise a deep link without driving the UI.",
			"OpenUrlBody"
		),
		"/devices/{id}/tap": bodiedDeviceAction(
			"tap_device",
			"Tap a screen coordinate (Android only)",
			"Send a single tap at a screen coordinate. ANDROID ONLY — an iOS device returns 400, because simctl publishes no coordinate input surface; check `GET /capabilities` first. Coordinates are device screen pixels with the origin at the top-left, so take a screenshot to find them.",
			"TapBody"
		),
		"/devices/{id}/swipe": bodiedDeviceAction(
			"swipe_device",
			"Swipe between two coordinates (Android only)",
			"Drag from one screen coordinate to another — scrolling, dismissing, pull-to-refresh. ANDROID ONLY, same limit as tap. A longer `durationMs` produces a slower drag, which is what fling-versus-scroll comes down to.",
			"SwipeBody"
		),
		"/devices/{id}/text": bodiedDeviceAction(
			"type_text",
			"Type text into the focused field (Android only)",
			"Type text into whatever field currently has focus. ANDROID ONLY. It does not focus anything itself — tap the field first — and it appends at the caret rather than replacing the field's contents.",
			"TextBody"
		),
		"/devices/{id}/key": bodiedDeviceAction(
			"press_key",
			"Press a hardware key (Android only)",
			"Press one hardware/system key — home, back, enter, app-switch and friends. ANDROID ONLY. Unknown names are rejected rather than guessed at.",
			"KeyBody"
		),
	},
	components: {
		schemas: {
			InstallBody: {
				type: "object",
				required: ["appPath"],
				properties: {
					appPath: {
						type: "string",
						description:
							"Absolute path ON THE NODE to the build to install: a `.app` bundle directory for an iOS Simulator, an `.apk` file for an Android Emulator.",
					},
				},
			},
			LaunchBody: {
				type: "object",
				required: ["appId"],
				properties: {
					appId: {
						type: "string",
						description:
							"iOS bundle identifier or Android package name of an app already installed on the device, e.g. `com.example.MyApp`.",
					},
				},
			},
			OpenUrlBody: {
				type: "object",
				required: ["url"],
				properties: {
					url: {
						type: "string",
						description:
							"URL to hand to the device's URL handler — an `https://` web link, or a custom scheme deep link such as `myapp://orders/42`.",
					},
				},
			},
			TapBody: {
				type: "object",
				required: ["x", "y"],
				properties: {
					x: {
						type: "number",
						description:
							"Horizontal screen coordinate in device pixels, measured from the left edge.",
					},
					y: {
						type: "number",
						description:
							"Vertical screen coordinate in device pixels, measured from the top edge.",
					},
				},
			},
			SwipeBody: {
				type: "object",
				required: ["x1", "y1", "x2", "y2"],
				properties: {
					x1: {
						type: "number",
						description: "Horizontal coordinate the swipe starts at.",
					},
					y1: {
						type: "number",
						description: "Vertical coordinate the swipe starts at.",
					},
					x2: {
						type: "number",
						description: "Horizontal coordinate the swipe ends at.",
					},
					y2: {
						type: "number",
						description: "Vertical coordinate the swipe ends at.",
					},
					durationMs: {
						type: "integer",
						description:
							"How long the drag takes, in milliseconds. Defaults to 300. Raise it for a deliberate scroll, lower it for a fling.",
					},
				},
			},
			TextBody: {
				type: "object",
				required: ["text"],
				properties: {
					text: {
						type: "string",
						description:
							"Text to type into the focused field. Spaces are handled for you; the field is not cleared first.",
					},
				},
			},
			KeyBody: {
				type: "object",
				required: ["key"],
				properties: {
					key: {
						type: "string",
						description:
							"Key to press: a friendly name (`home`, `back`, `enter`, `menu`, `power`, `volumeup`, `volumedown`, `appswitch`, `delete`, `tab`), a raw Android `KEYCODE_*` name, or a numeric keycode. Anything else is rejected.",
					},
				},
			},
		},
	},
} as const;
