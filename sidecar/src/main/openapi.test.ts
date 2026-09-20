import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { handleRequest } from "./control.ts";
import type { DeviceDriver } from "./devices.ts";
import { OPENAPI_DOCUMENT } from "./openapi.ts";

const TOKEN = "tok";
const AUTH = `Bearer ${TOKEN}`;

/** A driver that throws on everything — no route under test ever reaches it. */
const inertDriver = new Proxy({} as DeviceDriver, {
	get() {
		return () => {
			throw new Error("driver must not be touched by document routes");
		};
	},
});

function deps() {
	return { driver: inertDriver, token: TOKEN };
}

interface ManifestRoute {
	path: string;
}
interface Manifest {
	sidecars: {
		http?: { mount?: string; routes?: ManifestRoute[] };
	}[];
}

function manifest(): Manifest {
	return JSON.parse(
		readFileSync(new URL("../../../manifest.json", import.meta.url), "utf8")
	) as Manifest;
}

/**
 * The ext-proxy's own matcher, ported: `:param` matches one non-empty segment and a
 * trailing `*rest` matches the remainder. Core runs the real one
 * (`ext_proxy::route_matches`) over the same two inputs, so a document path this
 * rejects is a derived tool Core would silently drop.
 */
function routeMatches(pattern: string, actual: string): boolean {
	const pat = pattern.replace(/^\//, "").split("/");
	const act = actual.replace(/^\//, "").split("/");
	for (const [i, p] of pat.entries()) {
		if (p.startsWith("*")) {
			return true;
		}
		const a = act[i];
		if (a === undefined) {
			return false;
		}
		if (p.startsWith(":")) {
			if (a === "") {
				return false;
			}
		} else if (p !== a) {
			return false;
		}
	}
	return pat.length === act.length;
}

describe("openapi document routing", () => {
	it("serves the document to an authenticated caller", async () => {
		const resp = await handleRequest("GET", "/openapi.json", AUTH, "", deps());
		expect(resp.status).toBe(200);
		expect((resp.json as { openapi: string }).openapi).toBe("3.0.3");
	});

	// The document enumerates this node's whole device-control surface, so it sits
	// behind the same bearer as the routes it describes. Core's importer presents
	// that bearer; a drive-by local process does not.
	it("401s an unauthenticated document fetch", async () => {
		const resp = await handleRequest("GET", "/openapi.json", undefined, "", {
			driver: inertDriver,
			token: TOKEN,
		});
		expect(resp.status).toBe(401);
	});
});

describe("openapi document contract", () => {
	// The retrofit's whole point: a derived write tool whose requestBody schema is
	// empty reaches the model with NO arguments it can see — discoverable and
	// uncallable. Core RESOLVES `$ref` against `components.schemas` when importing,
	// so a ref here is correct and expected.
	it("documents a request body for every write route", () => {
		const paths = OPENAPI_DOCUMENT.paths as Record<
			string,
			Record<string, { requestBody?: unknown }>
		>;
		// Routes whose handler reads NO body keys (`dispatchAction`'s boot/shutdown
		// arms take only the path id), so having no requestBody is correct.
		const bodyless = new Set(["/devices/{id}/boot", "/devices/{id}/shutdown"]);
		let checked = 0;
		for (const [route, item] of Object.entries(paths)) {
			const post = item.post;
			if (!post || bodyless.has(route)) {
				continue;
			}
			const schema = (
				post.requestBody as {
					content?: Record<string, { schema?: Record<string, unknown> }>;
				}
			)?.content?.["application/json"]?.schema;
			expect(schema, `${route} POST has no JSON request body`).toBeDefined();
			expect(
				schema?.$ref !== undefined || schema?.properties !== undefined,
				`a derived write tool would have no arguments: ${JSON.stringify(schema)}`
			).toBe(true);
			checked += 1;
		}
		expect(checked).toBeGreaterThan(0);
	});

	it("resolves every request-body $ref against components.schemas", () => {
		const schemas = OPENAPI_DOCUMENT.components.schemas as Record<
			string,
			{ properties?: Record<string, unknown> }
		>;
		const refs = [
			...JSON.stringify(OPENAPI_DOCUMENT).matchAll(
				/"\$ref":"#\/components\/schemas\/([A-Za-z0-9_]+)"/g
			),
		].map((m) => m[1]);
		expect(refs.length).toBeGreaterThan(0);
		for (const name of refs) {
			const target = schemas[name];
			expect(target, `dangling $ref to ${name}`).toBeDefined();
			// A component with no `properties` lowers to the same empty argument set a
			// missing body would — the exact failure this retrofit exists to remove.
			expect(
				Object.keys(target?.properties ?? {}).length,
				`${name} has no properties`
			).toBeGreaterThan(0);
		}
	});

	// Core intersects derived operations against the manifest's declared routes and
	// DROPS whatever does not match, logging only at debug. A path documented here
	// but undeclared there therefore yields nothing, silently.
	it("only documents paths the manifest declares", () => {
		const sidecar = manifest().sidecars[0];
		const declared = (sidecar.http?.routes ?? []).map((r) => r.path);
		expect(declared.length).toBeGreaterThan(0);
		for (const route of Object.keys(OPENAPI_DOCUMENT.paths)) {
			expect(
				declared.some((pattern) => routeMatches(pattern, route)),
				`${route} is documented but not declared in manifest http.routes`
			).toBe(true);
		}
	});

	// `ext_api::lower` strips `http.mount` from each documented path before that
	// intersection. This sidecar's router is rooted at `/`, so the manifest must
	// carry no `mount` — re-adding one without prefixing every path below turns the
	// whole document into zero derived tools.
	it("keeps the sidecar unmounted, matching the paths it documents", () => {
		expect(manifest().sidecars[0].http?.mount).toBeUndefined();
	});
});
