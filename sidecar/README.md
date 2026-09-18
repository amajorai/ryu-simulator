# @ryu/simulator-sidecar — `ryu-simulator`

A dependency-free Node/Bun control server that wraps Apple's `simctl` (iOS Simulator)
and Android's `adb`/`emulator` (Android Emulator) behind one loopback HTTP surface.
No Electron, no window: the device UI is Apple's/Google's own simulator; this process
only drives it and streams screenshots. Core runs it as a `local` manifest sidecar
(`../manifest.json`).

## Build

```sh
bun install
bun run build     # → dist/ryu-simulator (bun build --compile)
bun test          # control-server routing/auth unit tests (fake driver)
```

The compiled `ryu-simulator` binary is placed on `PATH` (`~/.ryu/bin`) or pointed at
via `RYU_SIMULATOR_BIN`. It must build **natively per OS** — iOS control is macOS-only.

## Control API (loopback, bearer-gated)

Bound to `127.0.0.1:7994` (`RYU_SIMULATOR_PORT` overrides; `+1000` under
`RYU_PROFILE=dev`). Every route except `GET /health` requires
`Authorization: Bearer <RYU_EXT_TOKEN | RYU_SIMULATOR_TOKEN>` (fail-closed).

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness (unauthenticated). |
| GET | `/` | Capability root (`simulator.control`). |
| GET | `/capabilities` | Per-platform availability probe `{ ios, android }`. |
| GET | `/devices` | List iOS + Android devices `{ id, platform, name, os, state }`. |
| POST | `/devices/:id/boot` | Boot a simulator/emulator. |
| POST | `/devices/:id/shutdown` | Shut it down. |
| POST | `/devices/:id/install` | `{ appPath }` — install a `.app`/`.apk`. |
| POST | `/devices/:id/launch` | `{ appId }` — launch by bundle id / package. |
| POST | `/devices/:id/openurl` | `{ url }` — open a URL / deep link. |
| GET | `/devices/:id/screenshot` | `{ image (base64 PNG) }`. |
| POST | `/devices/:id/tap` | `{ x, y }` — **Android only** (iOS → 400 unsupported). |
| POST | `/devices/:id/swipe` | `{ x1, y1, x2, y2, durationMs? }` — Android only. |
| POST | `/devices/:id/text` | `{ text }` — Android only. |
| POST | `/devices/:id/key` | `{ key }` — named key (home/back/…), Android only. |

Device ids are namespaced `ios:<udid>` / `android:<serial>` (`android:@<avd>` = an
offline AVD to boot), so one flat id space addresses both toolchains.

## Files

- `src/main/devices.ts` — the `DeviceDriver` seam over `simctl` + `adb` (fakeable).
- `src/main/control.ts` — pure request router + fail-closed bearer + server.
- `src/main/index.ts` — entrypoint (resolve port/token, start server).
- `src/main/control.test.ts` — routing/auth tests against a fake driver.
