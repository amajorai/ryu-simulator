import { describe, expect, it } from "bun:test";
import { controlActionSchema, simctlDevicesSchema } from "./contracts.ts";

interface FutureMetadata {
	next?: FutureMetadata;
}

describe("native Simulator boundary contracts", () => {
	it("keeps finite coordinates and optional duration without coercing input text", () => {
		expect(
			controlActionSchema.parse({ x: -1.5, y: 0, durationMs: 0, text: " a b " })
		).toMatchObject({ x: -1.5, y: 0, durationMs: 0, text: " a b " });
		const malformed = controlActionSchema.parse({
			x: "10",
			y: Number.POSITIVE_INFINITY,
			durationMs: null,
			text: 42,
		});
		expect(malformed.x).toBeUndefined();
		expect(malformed.y).toBeUndefined();
		expect(malformed.durationMs).toBeUndefined();
		expect(malformed.text).toBeUndefined();
	});

	it("reads only the existing action fields rather than recursing through future metadata", () => {
		let future: FutureMetadata = {};
		for (let index = 0; index < 20_000; index += 1) {
			future = { next: future };
		}
		expect(controlActionSchema.parse({ appId: "org.test", future }).appId).toBe(
			"org.test"
		);
	});

	it("parses simctl's runtime groups and optional availability exactly", () => {
		const devices = {
			"com.apple.CoreSimulator.SimRuntime.iOS-17-5": [
				{
					udid: "A",
					name: "iPhone",
					state: "Booted",
					isAvailable: true,
					deviceTypeIdentifier: "native extra",
				},
				{
					udid: "B",
					name: "Old iPhone",
					state: "Shutdown",
					isAvailable: false,
				},
				{ udid: "C", name: "Legacy iPhone", state: "Shutdown" },
			],
		};
		expect(
			simctlDevicesSchema.parse({ devices }).devices[
				"com.apple.CoreSimulator.SimRuntime.iOS-17-5"
			]
		).toEqual([
			{ udid: "A", name: "iPhone", state: "Booted", isAvailable: true },
			{ udid: "B", name: "Old iPhone", state: "Shutdown", isAvailable: false },
			{ udid: "C", name: "Legacy iPhone", state: "Shutdown" },
		]);
	});

	it("refuses malformed simctl rows before a fabricated device id can reach a control action", () => {
		expect(
			simctlDevicesSchema.safeParse({
				devices: { runtime: [{ name: "No id", state: "Booted" }] },
			}).success
		).toBe(false);
		expect(
			simctlDevicesSchema.safeParse({
				devices: { runtime: [{ udid: "A", name: "No state" }] },
			}).success
		).toBe(false);
		expect(
			simctlDevicesSchema.safeParse({
				devices: {
					runtime: [
						{
							udid: "A",
							name: "Wrong availability",
							state: "Booted",
							isAvailable: "yes",
						},
					],
				},
			}).success
		).toBe(false);
	});
});
