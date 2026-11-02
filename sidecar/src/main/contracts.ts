import { z } from "zod";

const optionalText = z.string().optional().catch(undefined);
const optionalNumber = z.number().optional().catch(undefined);

/** Exact action fields consumed by the router; invalid fields retain its 400 labels. */
export const controlActionSchema = z.object({
	appPath: optionalText,
	appId: optionalText,
	url: optionalText,
	text: optionalText,
	key: optionalText,
	x: optionalNumber,
	y: optionalNumber,
	x1: optionalNumber,
	y1: optionalNumber,
	x2: optionalNumber,
	y2: optionalNumber,
	durationMs: optionalNumber,
});
export type ControlAction = z.infer<typeof controlActionSchema>;

export const controlStatusSchema = z.object({
	ok: z.boolean(),
	error: z.string().optional(),
	name: z.string().optional(),
	version: z.string().optional(),
	capability: z.string().optional(),
});
export const simctlDevicesSchema = z.object({
	devices: z.record(
		z.string(),
		z.array(
			z.object({
				udid: z.string(),
				name: z.string(),
				state: z.string(),
				isAvailable: z.boolean().optional(),
			})
		)
	),
});

export const deviceSchema = z.object({
	id: z.string(),
	kind: z.enum(["simulator", "emulator"]),
	name: z.string(),
	os: z.string(),
	platform: z.enum(["ios", "android"]),
	state: z.enum(["booted", "shutdown", "unknown"]),
});
export const devicesResponseSchema = z.object({
	devices: z.array(deviceSchema),
});
const platformCapabilitySchema = z.object({
	available: z.boolean(),
	interactive: z.boolean(),
	reason: z.string().optional(),
});
export const capabilitiesSchema = z.object({
	android: platformCapabilitySchema,
	ios: platformCapabilitySchema,
});
export const screenshotResponseSchema = z.object({
	image: z.string(),
	encoding: z.literal("base64"),
	mime: z.literal("image/png"),
});

export const manifestRoutingSchema = z.object({
	sidecars: z.array(
		z.object({
			http: z
				.object({
					mount: z.string().optional(),
					routes: z.array(z.object({ path: z.string() })).optional(),
				})
				.optional(),
		})
	),
});
