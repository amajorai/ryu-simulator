# ryu-simulator

Simulators for Ryu — drive iOS Simulators (simctl, macOS + Xcode) and Android Emulators (adb) from a workspace tab: list/boot devices, install & launch apps, open deep links, screenshot, and (Android) tap/swipe/type, exposed as the grant-gated simulator.control capability.

> **The public home of `ryu-simulator`.** Source, builds, and releases live here —
> binaries for every platform are attached to each release.
>
> This tree is generated from the Ryu monorepo, so commits pushed here
> directly are replaced on the next sync. **Pull requests are welcome** —
> open them here and they are ported into the monorepo, then flow back out.
> Ryu as a whole: https://github.com/amajorai/ryu

## Source & build

The **source of record** for this app: a dependency-free Bun/TypeScript
`sidecar/` Ryu runs locally as a grant-gated control capability, plus the
manifest `ui/`. The sidecar builds standalone — `cd sidecar && bun install &&
bun run build` compiles a single `ryu-simulator` executable; each release attaches
the per-platform binaries.

## License

Apache-2.0 — see [LICENSE](./LICENSE).

---

# @ryu/simulator — Simulators

Drive **iOS Simulators** (`simctl`, macOS + Xcode) and **Android Emulators**
(`adb`/`emulator`) from a workspace tab. Ryu runs the device-control toolchain as a
**local sidecar** and exposes it to agents as the grant-gated `simulator.control`
capability: list/boot devices, install & launch apps, open deep links, screenshot,
and (Android) tap/swipe/type. Core spawns the sidecar lazily and idle-stops it; the
desktop Simulator panel drives it through the ext-proxy.

Availability is a **runtime probe**, not an OS sniff: iOS shows only on a Mac node
with Xcode; Android shows wherever the Android SDK is installed on the connected node.

## Parts

- **`sidecar/` — `ryu-simulator` (out-of-process, Node/Bun).** A dependency-free
  control server (`@ryu/simulator-sidecar`) wrapping `simctl` + `adb` behind a
  loopback HTTP surface. No dependency on `apps/core`; compiled by
  `bun build --compile` into a `ryu-simulator` binary resolved via `RYU_SIMULATOR_BIN`
  else `ryu-simulator` on `PATH` (`~/.ryu/bin`). See `sidecar/README.md` for the full
  control API.
- **`ui/` — the manifest (`manifest.json`).** No companion UI of its own; the desktop
  Simulator panel (a dedicated `simulator` workspace TabKind) is the consumer.
  `runnables: []`.

## Manifest (`manifest.json`)

- **Sidecar:** `simulator` on `:7994`, `command: "ryu-simulator"`,
  `command_env: RYU_SIMULATOR_BIN`, `port_env: RYU_SIMULATOR_PORT`, `health_path:
  /health`, **`lazy: true`** with `idle_stop_secs: 300`. Declared HTTP routes:
  `/`, `/health`, `/capabilities`, `/devices`, and per-device
  `boot`/`shutdown`/`install`/`launch`/`openurl`/`screenshot`/`tap`/`swipe`/`text`/`key`.
- **Provides:** capability `simulator.control` (v1.0.0) → sidecar `simulator`, route
  `/`, grant `simulator:control`.
- **Grant:** `simulator:control`.

## Control parity (the honest limit)

- **Android:** full control — `adb shell input` gives tap/swipe/text/key for free.
- **iOS:** `simctl` gives boot/install/launch/openurl/screenshot cleanly, but has **no
  public coordinate tap/swipe**. Those return an `unsupported` result for an iOS
  device; adding [facebook/idb](https://github.com/facebook/idb) is the upgrade path.

## Auth / security

The sidecar binds **loopback only** and fail-closes: every route except `GET /health`
requires a bearer resolved as `RYU_EXT_TOKEN` (Core's per-plugin secret, re-stamped on
each proxied hop) else `RYU_SIMULATOR_TOKEN`. If neither is set, protected routes
reject with 401.

## Swap seam

Any control server that honors the same `/devices*` loopback contract and bearer auth
can replace the sidecar without touching Core — the `command_env` override points Core
at an alternative binary. The capability, not the process, is what the desktop panel
and agents bind to.
