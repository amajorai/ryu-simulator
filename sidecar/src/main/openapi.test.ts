import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { manifestRoutingSchema } from "./contracts.ts";
import { handleRequest } from "./control.ts";
import type { DeviceDriver } from "./devices.ts";
import { OPENAPI_DOCUMENT } from "./openapi.ts";

interface DocumentWriteOperation {
	operationId: string;
	requestBody?: (typeof OPENAPI_DOCUMENT.paths)["/devices/{id}/tap"]["post"]["requestBody"];
}

const TOKEN = "tok";
const AUTH = `Bearer ${TOKEN}`;

/** A driver that throws on everything — no route under test ever reaches it. */
function unreachable(): never {
	throw new Error("driver must not be touched by document routes");
}
const inertDriver: DeviceDriver = {
	boot: unreachable,
	install: unreachable,
	key: unreachable,
	launch: unreachable,
	list: unreachable,
	openUrl: unreachable,
	probe: unreachable,
	screenshot: unreachable,
	shutdown: unreachable,
	swipe: unreachable,
	tap: unreachable,
	text: unreachable,
};

function deps() {
	return { driver: inertDriver, token: TOKEN };
}

function manifest() {
	return manifestRoutingSchema.parse(
		JSON.parse(
			readFileSync(new URL("../../../manifest.json", import.meta.url), "utf8")
		)
	);
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
		if (!(resp.json && "openapi" in resp.json)) {
			throw new Error("Simulator did not return its native OpenAPI document");
		}
		expect(resp.json.openapi).toBe("3.0.3");
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
		const paths = OPENAPI_DOCUMENT.paths;
		// Routes whose handler reads NO body keys (`dispatchAction`'s boot/shutdown
		// arms take only the path id), so having no requestBody is correct.
		const bodyless = new Set(["/devices/{id}/boot", "/devices/{id}/shutdown"]);
		let checked = 0;
		for (const [route, item] of Object.entries(paths)) {
			const post: DocumentWriteOperation | undefined =
				"post" in item ? item.post : undefined;
			if (!post || bodyless.has(route)) {
				continue;
			}
			const schema = post.requestBody?.content["application/json"].schema;
			expect(schema, `${route} POST has no JSON request body`).toBeDefined();
			expect(
				schema !== undefined && ("$ref" in schema || "properties" in schema),
				`a derived write tool would have no arguments: ${JSON.stringify(schema)}`
			).toBe(true);
			checked += 1;
		}
		expect(checked).toBeGreaterThan(0);
	});

	it("resolves every request-body $ref against components.schemas", () => {
		const schemas = OPENAPI_DOCUMENT.components.schemas;
		const refs = [
			...JSON.stringify(OPENAPI_DOCUMENT).matchAll(
				/"\$ref":"#\/components\/schemas\/([A-Za-z0-9_]+)"/g
			),
		].map((m) => m[1]);
		expect(refs.length).toBeGreaterThan(0);
		for (const name of refs) {
			const target = Object.entries(schemas).find(([key]) => key === name)?.[1];
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
