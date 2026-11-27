# TRMNL.Bar

## Project Language

Use English for the default README, release notes, project metadata, source comments, test names, and developer-facing output. Keep `README.zh-CN.md` and the Simplified Chinese dashboard translations available. Use English as the dashboard fallback.

## Project Goals and Status

See [DESIGN.md](DESIGN.md) for dashboard behavior and the device and mirror modes.

- Connect Metrix.Bar to a standard TRMNL server or mirror an existing device. The server handles Recipes, data, playlists, and rendering. The `.bar` handles identity, device and mirror protocols, authentication, refresh, caching, and native display. The host provides general-purpose capabilities and keeps TRMNL-specific behavior in the `.bar`. [Metrix.Bar](https://metrix.bar/)
- The TypeScript client is at version `0.2.1` and builds a single `dist/TRMNL.bar`. It requires Metrix.Bar `0.3.2` or later. The `.bar` declares Apache-2.0 in its root `license` attribute and imports Valibot `1.5.0` and `@noble/ciphers` `2.4.0` from esm.sh. Metrix.Bar loads and caches the modules. Keep the device entry point focused on running the virtual device and mirror through Metrix.Bar's native APIs.
- The project has 97 TypeScript tests, including 7 verification script tests, and 41 ablation cases. On 2026-11-21, an isolated Metrix.Bar `0.3.2` instance on macOS `27.0.1` arm64 passed the three standard-protocol stages, playlist rotation with FastAPI and Tiding, and mirror disconnect and reconnect. Foreground GPU verification checked window focus, system screenshot pixels, and GPU frame logs. The server revisions are pinned in `scripts/servers/independent.ts`. Build fingerprints are recorded in the native verification reports.
- The first image once reached the 30-second test wait limit. The verification timeout is now 45 seconds for the initial installation only. The root cause of earlier refresh timeouts remains unknown. Official account access, the WidgetKit desktop container, macOS 13, and other platforms still need separate verification.

## Repository Layout

| Path | Responsibility |
| --- | --- |
| `src/index.ts`, `src/config.ts`, `src/errors.ts` | Worker entry point, device configuration, and shared errors |
| `src/device/` | Device lifecycle, enrollment, diagnostics, and frame updates |
| `src/protocol/` | TRMNL API client, reply parsing, and HTTP transport |
| `src/storage/` | Persisted state, secure credentials, and encrypted checkpoints |
| `src/runtime/` | Metrix.Bar Worker contracts and cancellable operations |
| `src/ui/` | Native panel, tray, and widget rendering |
| `src/testing/` | Shared Worker test fixtures |
| `build/` | Vite+ packaging plugin and the editable `.bar` manifest |
| `scripts/` | Verification commands and their host and server modules |
| `docs/` | Assets shared by both READMEs |

Keep behavior tests beside the code they exercise. The Worker entry point wires the device controller and native view to Metrix.Bar. Keep Node.js tooling in `build/` and `scripts/`.

## Toolchain and Commands

- Use Node.js `24.22.2`, pnpm `12.21.0`, and the local `vite-plus` `1.6.0`. Node.js is for development and packaging. Installed dashboards run in Metrix.Bar alone.
- `pnpm-workspace.yaml` maps Vite to the Vite+ engine. Run `pnpm check`, `pnpm test`, and `pnpm build` from this directory. Track `dist/TRMNL.bar` alongside its source and distribute the tracked file from the repository. Keep local credentials, dependencies, lockfiles, coverage, verification data, and Python caches out of Git.

### Build from Source

With the toolchain above, run these commands from the project root.

```sh
pnpm install
pnpm exec vp build
```

The build writes `dist/TRMNL.bar`. Rebuild and commit it with Worker or manifest changes.

| Task | Command |
| --- | --- |
| Watch and rebuild | `pnpm exec vp build --watch` |
| Check formatting, lint, and types | `pnpm exec vp check` |
| Check formatting only | `pnpm exec vp fmt --check` |
| Run lint only | `pnpm exec vp lint` |
| Check types only | `pnpm exec vp check --no-fmt --no-lint` |
| Run the full test suite once | `pnpm exec vp test` |
| Run one test file | `pnpm exec vp test src/protocol/client.test.ts` |
| Filter by test name | `pnpm exec vp test -t 'test name'` |

- Keep `typeAware: true` and `typeCheck: true` under `lint.options` in `vite.config.ts`. Import test APIs from `vite-plus/test` and configure tests in the `test` block. Use `vp test` to run the Vite+ test runner directly. `vp run test` runs a package script.

## Device Protocol

- Device mode pairs with `GET /api/setup` and gets the next screen with `GET /api/display`. Send `POST /api/log` only on explicit user action. `/api/display` advances the playlist, so retry a failed image download first. Mirror mode reads the current screen from `/api/display/current`. Fall back to LaraPaper's `/api/current_screen` only when the server returns Laravel's missing-route response for the standard endpoint. Mirror mode reads the current screen without pairing, advancing the playlist, or uploading device logs. It omits virtual device identity headers and ignores physical firmware reset and upgrade flags. [BYOS protocol](https://docs.trmnl.com/go/diy/byos) · [Display API](https://docs.trmnl.com/go/private-api/screens)
- Server URLs may include a path prefix. Image URLs may be relative or absolute. Declare the actual origins for both API and image requests. The generic `network from-url` permission extracts and authorizes only the origin. Strip device tokens from cross-origin redirects.
- Use a stable, locally administered virtual device ID. Keep real network interface identities and fabricated hardware telemetry out of requests. Base declared models, dimensions, color depths, and compatibility versions on source code or observed protocol behavior. Keep firmware claims limited to virtual device compatibility.
- Check HTTP and JSON status codes. Setup succeeds with `200`, display succeeds with `0`, and `202` means enrollment is pending. Refresh intervals are in seconds. Handle `skip_update`, `reset_firmware`, and rate limits. Show a status message for OTA updates and leave physical firmware downloads and execution to physical devices.
- Store tokens through the declared secret, secure writes, and the instance credential store. Bind tokens to the server and device ID. Keep tokens out of `localStorage`, component trees, logs, examples, and builds. Use AES-GCM checkpoints for unfinished screens, store the key only in a secret, and keep signed URLs encrypted in ordinary storage. Preserve credential isolation and the last successful screen when changing servers or pairing again. Test fixtures must follow the host contract that reading an unset `$metrix.secret` throws.
- Persist the mode in both state and frame records. Treat legacy state as device mode. Preserve credentials for the same binding when switching modes and isolate unfinished screens by mode. Mirror refresh defaults to 300 seconds and accepts 10–86400 seconds. HTTP or JSON `404` and `202` mean the current screen is pending. Persist `needsToken` on `401` or `403` to pause automatic requests. The host's `schedule(null)` restores the default interval, so use `needsToken` to keep requests paused.
- Persist the disconnect intent and cancel refresh and diagnostics before deleting credentials and checkpoints in sequence. Complete cleanup even with an invalid configuration. Stay disconnected across restarts and changes to the server or device ID until the user explicitly connects.
- Follow the server's requirements for official accounts, device permissions, and BYOD licenses. Apply those requirements only to servers that impose them.

## Lifecycle Transitions

| State | Transition and owner |
| --- | --- |
| Connection | The controller persists the disconnect intent, cancels active work, and clears credentials and the frame checkpoint. Cleanup resumes after restart. Explicit Connect resumes polling. |
| Refresh | The controller serializes the active refresh by cancellation. An explicit action can bypass the next poll or retry time. An unfinished frame takes priority over the next display request. |
| Enrollment | The enrollment module retains an in-flight setup reply across refresh replacement for the same configuration. A new pairing request, configuration change, or disconnect cancels it. |
| Authentication | Mirror mode waits for a token. An authentication failure pauses periodic requests across restart. Input changes or an explicit refresh can retry. |
| Credential store | Credential writes and deletion wait for the previous write to settle. Binding and encryption isolate recovery data. |
| Frame recovery | The frame module checkpoints a candidate before download. A successful image replaces the displayed frame. A failed download keeps the candidate and the previous image. Mode, binding, and revision govern restart recovery. |
| Diagnostics | Only a user action starts a diagnostic. Refresh and disconnect can cancel it. The result updates the menu only while it still belongs to the same error. |
| HTTP redirects | The transport limits redirects to approved origins. Once an image request leaves the server origin, subsequent hops omit device identity and credentials. |
| Presentation | The Worker reads the host language at startup. The menu renders the current device phase and any recovery actions. The panel and Widgets derive their output from the available image. |

## Host and Output

- Keep English and Simplified Chinese dashboard text in `src/ui/messages.ts`. The Worker reads `app.locale` at lifecycle start. Restart Metrix.Bar to refresh the host language snapshot. Keep the manifest’s default input text in English and add Simplified Chinese with `locale lang="zh-Hans"`.
- The `.bar` worker's `render` returns `{ tray, panel, widget? }`, with nodes shaped as `{ type, props, children }`. Keep TRMNL state machines and UI copy in the `.bar`. Target a worker environment with neither the DOM nor the full Node.js runtime.
- Use the generic `image.load` API to convert PNG, JPEG, and BMP bytes to persistent image references. Reuse the host's native Image, screenshot, and Widget resource pipeline to display server-rendered screens.
- Keep the panel and desktop widget limited to the server-rendered screen. Put connection status, pairing details, and actions in `tray.menu`. Use the host’s dashboard settings for configuration.
- Validate panel and Widget components against their respective schemas. Use Widget Image properties defined by the Widget schema. Panel properties such as `fillWidth`, `fillHeight`, and `fit` belong to panel components. Set explicit dimensions on the root panel to prevent native preview clipping.
- Use the published host documentation for runtime types and permissions. Pass an explicit path to a Metrix.Bar checkout as the first argument to `scripts/verify_host.ts` when running the baseline on a local host build. [.bar format](https://metrix.bar/docs/bar-format.md) · [Component reference](https://metrix.bar/docs/components.md)

## Verification

- For source changes, run at least `pnpm exec vp check`, `pnpm exec vp test`, and `pnpm exec vp build`. Report any checks that were skipped or failed. Test observable behavior. Run `pnpm exec tsx scripts/verify_ablation.ts` to check key safeguards in isolated copies. Require a passing control group, the expected test failure for each mutation, and matching production source SHA-256 fingerprints before and after the run.
- For device changes, cover setup, display, and log requests, headers, HTTP and JSON status codes, refresh intervals in seconds, filename deduplication, path prefixes, independent image origins, PNG, JPEG, and BMP handling, cancellation, credential changes, retention of the last successful image on failure, and restart recovery. Record each independently tested server and its pinned revision. For native previews, wait for the asynchronous image to render and compare screenshot pixels with the server image.
- For native macOS verification, run `pnpm exec tsx scripts/verify_host.ts /path/to/Metrix.Bar --stage baseline`. Then run `pnpm exec tsx scripts/verify_host.ts --stage restart` and `pnpm exec tsx scripts/verify_host.ts --stage recover` in that order. Then run `pnpm exec tsx scripts/verify_servers.ts --prepare` to prepare and verify two independent servers. Omit `--prepare` to reuse existing test dependencies. FastAPI requires Python 3.13 managed by uv. Tiding requires Bun. Unlock the desktop and run `pnpm exec tsx scripts/verify_foreground.ts` to check GPU frame logs in the default configuration, window focus, and system window screenshots. Test data is stored in the ignored `dist/host-verification/`, `dist/independent-servers/`, and `dist/foreground-verification/` directories. The `.bar` package and runtime exclude the test servers.
- Run `pnpm exec tsx scripts/verify_mirror.ts` to check mirror mode and disconnection using the existing isolated host build. Unlock the desktop for native right-click actions. The default run verifies foreground GPU rendering. Use `--software` to test software rendering and record the capture method in the report. Test data is stored in the ignored `dist/mirror-verification/` directory.
- Before delivering a `.bar`, validate it and preview it natively in Metrix.Bar. Confirm service connectivity in the host. For physical window screenshots, unlock the desktop and make sure the window is visible and unobstructed. The automation `capture` API renders in memory. For locked-screen verification, set `MYGO_GPU=0` on the test instance only and record whether evidence comes from software rendering or foreground GPU capture. Report any gaps in coverage for the real WidgetKit container, the minimum macOS version, and other platforms.
