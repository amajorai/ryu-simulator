// Loopback control server for the Ryu Simulator sidecar.
//
// Core spawns this as a `local` manifest sidecar (`apps-store/simulator/manifest.json`,
// `SidecarProcess::Local`). It exposes a small HTTP control surface bound to loopback
// so Core — and, through Core's ext-proxy, the desktop Simulator panel and the agent's
// `simulator.*` MCP tools — can list devices, boot, install, launch, screenshot, and
// (Android) tap/swipe/type. Mirrors the browser sidecar's posture
// (`apps-store/browser/sidecar/src/main/control.ts`).
//
// SECURITY
// --------
// * Bound to 127.0.0.1 only.
// * Every route except `GET /health` requires `Authorization: Bearer <token>` — the
//   per-plugin secret Core injects at spawn (`RYU_EXT_TOKEN`); `RYU_SIMULATOR_TOKEN`
//   overrides for standalone/dev. Neither set ⇒ FAIL-CLOSED (all protected routes 401).
//
// The router (`handleRequest`) is a pure async function over an injected `DeviceDriver`,
// so it is unit-tested with a fake — no simctl, no adb, no sockets.

import { timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import {
	type DeviceDriver,
	UnknownDeviceError,
	UnsupportedActionError,
} from "./devices.ts";
import { OPENAPI_DOCUMENT } from "./openapi.ts";

/** Default loopback port. Distinct from Core (:7980), browser (:7993), mail (:7996). */
const SIMULATOR_CONTROL_BASE_PORT = 7994;
const DEV_PORT_OFFSET = 1000;
const PACKAGE_VERSION = "1.0.0";

export function resolveControlPort(
	env: NodeJS.ProcessEnv = process.env
): number {
	const explicit = Number.parseInt(env.RYU_SIMULATOR_PORT ?? "", 10);
	if (Number.isInteger(explicit) && explicit > 0) {
		return explicit;
	}
	const isDev = (env.RYU_PROFILE ?? "").trim().toLowerCase() === "dev";
	return isDev
		? SIMULATOR_CONTROL_BASE_PORT + DEV_PORT_OFFSET
		: SIMULATOR_CONTROL_BASE_PORT;
}

export function resolveControlToken(
	env: NodeJS.ProcessEnv = process.env
): string | null {
	const raw = env.RYU_EXT_TOKEN ?? env.RYU_SIMULATOR_TOKEN ?? "";
	const trimmed = raw.trim();
	return trimmed.length > 0 ? trimmed : null;
}

/** Constant-time bearer check. `null`/empty `expected` ⇒ fail-closed (reject all). */
export function bearerOk(
	authHeader: string | undefined,
	expected: string | null
): boolean {
	if (!expected) {
		return false;
	}
	const presented = authHeader?.startsWith("Bearer ")
		? authHeader.slice("Bearer ".length)
		: null;
	if (!presented) {
		return false;
	}
	const a = Buffer.from(presented, "utf8");
	const b = Buffer.from(expected, "utf8");
	if (a.length !== b.length) {
		return false;
	}
	return timingSafeEqual(a, b);
}

export interface ControlResponse {
	json?: unknown;
	raw?: { body: string; contentType: string };
	status: number;
}

function notFound(): ControlResponse {
	return { status: 404, json: { ok: false, error: "not found" } };
}

function badRequest(error: string): ControlResponse {
	return { status: 400, json: { ok: false, error } };
}

function parseJsonBody(raw: string): Record<string, unknown> | null {
	if (!raw) {
		return {};
	}
	try {
		const parsed = JSON.parse(raw);
		return typeof parsed === "object" && parsed !== null
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

function num(v: unknown): number | null {
	return typeof v === "number" && Number.isFinite(v) ? v : null;
}

interface RequestDeps {
	driver: DeviceDriver;
	token: string | null;
}

/** Map a driver throw to the right HTTP status (400 unsupported, 404 unknown, 500 else). */
function errorResponse(e: unknown): ControlResponse {
	if (e instanceof UnsupportedActionError) {
		return { status: 400, json: { ok: false, error: e.message } };
	}
	if (e instanceof UnknownDeviceError) {
		return { status: 404, json: { ok: false, error: e.message } };
	}
	return {
		status: 500,
		json: { ok: false, error: e instanceof Error ? e.message : "error" },
	};
}

/**
 * Pure request router. `path` has no query string; `body` is the raw request body.
 * Every route except `GET /health` is bearer-gated.
 */
export async function handleRequest(
	method: string,
	path: string,
	authHeader: string | undefined,
	body: string,
	{ driver, token }: RequestDeps
): Promise<ControlResponse> {
	if (method === "GET" && path === "/health") {
		return {
			status: 200,
			json: { ok: true, name: "ryu-simulator", version: PACKAGE_VERSION },
		};
	}

	if (!bearerOk(authHeader, token)) {
		return { status: 401, json: { ok: false, error: "unauthorized" } };
	}

	// Capability root (the `simulator.control` capability's `route: "/"`).
	if (method === "GET" && path === "/") {
		return {
			status: 200,
			json: {
				ok: true,
				name: "ryu-simulator",
				version: PACKAGE_VERSION,
				capability: "simulator.control",
			},
		};
	}

	// The app's own OpenAPI document. Core fetches this on the sidecar's first
	// Healthy edge and derives the agent's `simulator.*` tools from it — see
	// `openapi.ts` for the rules the document has to obey. Deliberately BEHIND the
	// bearer, like every route but `/health`: the document enumerates this node's
	// device-control surface, and an unauthenticated reader has no business with it.
	// Core's importer authenticates (`import_openapi` sends the same minted
	// `ext_token`), so gating it costs nothing.
	if (method === "GET" && path === "/openapi.json") {
		return { status: 200, json: OPENAPI_DOCUMENT };
	}

	if (method === "GET" && path === "/capabilities") {
		try {
			return { status: 200, json: await driver.probe() };
		} catch (e) {
			return errorResponse(e);
		}
	}

	if (method === "GET" && path === "/devices") {
		try {
			return { status: 200, json: { devices: await driver.list() } };
		} catch (e) {
			return errorResponse(e);
		}
	}

	// /devices/:id/<action>
	const m = path.match(/^\/devices\/([^/]+)\/([^/]+)$/);
	if (m) {
		const id = decodeURIComponent(m[1]);
		const action = m[2];
		const parsed = parseJsonBody(body);
		if (method !== "GET" && !parsed) {
			return badRequest("invalid json body");
		}
		const p = parsed ?? {};
		try {
			return await dispatchAction(driver, id, action, method, p);
		} catch (e) {
			return errorResponse(e);
		}
	}

	return notFound();
}

async function dispatchAction(
	driver: DeviceDriver,
	id: string,
	action: string,
	method: string,
	p: Record<string, unknown>
): Promise<ControlResponse> {
	const ok = { status: 200, json: { ok: true } } as const;

	if (action === "screenshot" && method === "GET") {
		const png = await driver.screenshot(id);
		return {
			status: 200,
			json: {
				image: png.toString("base64"),
				encoding: "base64",
				mime: "image/png",
			},
		};
	}
	if (method !== "POST") {
		return notFound();
	}
	switch (action) {
		case "boot":
			await driver.boot(id);
			return ok;
		case "shutdown":
			await driver.shutdown(id);
			return ok;
		case "install": {
			const appPath = typeof p.appPath === "string" ? p.appPath : "";
			if (!appPath) {
				return badRequest("missing appPath");
			}
			await driver.install(id, appPath);
			return ok;
		}
		case "launch": {
			const appId = typeof p.appId === "string" ? p.appId : "";
			if (!appId) {
				return badRequest("missing appId (bundle id or package name)");
			}
			await driver.launch(id, appId);
			return ok;
		}
		case "openurl": {
			const url = typeof p.url === "string" ? p.url : "";
			if (!url) {
				return badRequest("missing url");
			}
			await driver.openUrl(id, url);
			return ok;
		}
		case "tap": {
			const x = num(p.x);
			const y = num(p.y);
			if (x === null || y === null) {
				return badRequest("missing x/y");
			}
			await driver.tap(id, x, y);
			return ok;
		}
		case "swipe": {
			const x1 = num(p.x1);
			const y1 = num(p.y1);
			const x2 = num(p.x2);
			const y2 = num(p.y2);
			if (x1 === null || y1 === null || x2 === null || y2 === null) {
				return badRequest("missing x1/y1/x2/y2");
			}
			await driver.swipe(id, x1, y1, x2, y2, num(p.durationMs) ?? 300);
			return ok;
		}
		case "text": {
			const value = typeof p.text === "string" ? p.text : "";
			if (!value) {
				return badRequest("missing text");
			}
			await driver.text(id, value);
			return ok;
		}
		case "key": {
			const name = typeof p.key === "string" ? p.key : "";
			if (!name) {
				return badRequest("missing key");
			}
			await driver.key(id, name);
			return ok;
		}
		default:
			return notFound();
	}
}

/** Start the loopback control server. A bind failure logs and leaves the process up. */
export function startControlServer(deps: RequestDeps, port: number): Server {
	const server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c) => chunks.push(c as Buffer));
		req.on("end", () => {
			const body = Buffer.concat(chunks).toString("utf8");
			const path = (req.url ?? "/").split("?")[0];
			handleRequest(
				req.method ?? "GET",
				path,
				req.headers.authorization,
				body,
				deps
			)
				.then((resp) => {
					if (resp.raw) {
						res.writeHead(resp.status, {
							"Content-Type": resp.raw.contentType,
						});
						res.end(resp.raw.body);
						return;
					}
					res.writeHead(resp.status, { "Content-Type": "application/json" });
					res.end(JSON.stringify(resp.json ?? {}));
				})
				.catch((e) => {
					res.writeHead(500, { "Content-Type": "application/json" });
					res.end(
						JSON.stringify({
							ok: false,
							error: e instanceof Error ? e.message : "error",
						})
					);
				});
		});
	});
	server.on("error", (err) => {
		// biome-ignore lint/suspicious/noConsole: main-process diagnostic, no renderer.
		console.warn(`[ryu-simulator] control server unavailable: ${err.message}`);
	});
	server.listen(port, "127.0.0.1");
	return server;
}
