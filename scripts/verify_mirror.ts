import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { fixtures, key, requestCount, serving, type Fixture } from "./servers/fixture.ts";
import { configureDrawing, ForegroundHost, gpuFrames, unlockedDesktop } from "./host/foreground.ts";
import {
  NativeHost,
  imageSource,
  prepareArtifacts,
  requireImage,
  type Application,
} from "./host/native.ts";
import { captureDevice } from "./host/preview.ts";
import { pressTray } from "./host/tray.ts";
import { main, requireMacOS, root, waitFor, writeJSON } from "./system.ts";

const artifacts = join(root, "dist/mirror-verification");
const current = "/prefix/api/display/current";

async function waitForText({ api, process }: Application, id: string, text: string): Promise<void> {
  await waitFor(
    async () =>
      (await api.snapshot(id)).view?.tray?.menu?.some(
        (item) => item.label === text && item.disabled,
      ),
    text,
    process,
  );
}

async function verifyMirror(
  native: NativeHost,
  fixture: Fixture,
  foreground: boolean,
): Promise<void> {
  const { source, ...fingerprints } = native.testSource(
    `http://127.0.0.1:${fixture.server_port}/prefix`,
    true,
  );
  const errors: number[] = [];
  let endpoint = "";
  let calls = 0;
  await native.application("mirror", async (app) => {
    const { api, client, process } = app;
    native.identifier = await api.install(source, join(artifacts, "check.json"));
    endpoint = `/dashboards/${native.identifier}`;
    const window = await native.show(app);
    await waitForText(app, native.identifier, "Enter a device token");
    assert.equal(fixture.requests.length, 0);
    await api.call("PUT", `${endpoint}/secrets/access_token`, { value: key });
    const first = requireImage(await native.picture(app));
    errors.push(await captureDevice(native, app, window, "mirror-ready", first));
    const reads = requestCount(fixture, current);
    const downloads = requestCount(fixture, "/prefix/screens/frame.png");
    await native.refresh(api);
    await waitFor(() => requestCount(fixture, current) > reads, "the mirror to refresh", process);
    assert.equal(imageSource(await native.picture(app)), first);
    assert.equal(requestCount(fixture, "/prefix/screens/frame.png"), downloads);
    fixture.no_screen = true;
    await native.refresh(api);
    await waitForText(app, native.identifier, "No screen yet");
    assert.equal(imageSource(await api.snapshot(native.identifier)), first);
    errors.push(await captureDevice(native, app, window, "mirror-empty-retained", first));
    await pressTray(app, "Disconnect");
    await waitForText(app, native.identifier, "Disconnected");
    assert.equal(imageSource(await api.snapshot(native.identifier)), undefined);
    const { inputs } = await api.call<{ inputs: { name: string; is_set: boolean }[] }>(
      "GET",
      `${endpoint}/inputs`,
    );
    assert.equal(inputs.find((input) => input.name === "access_token")?.is_set, false);
    if (foreground) {
      await waitFor(
        async () =>
          (await client.call("windows")).windows.some((item) => item.id === window && item.focused),
        "the window to regain focus after closing the menu",
        process,
      );
    }
    await native.capture(app, window, "mirror-disconnected");
    calls = fixture.requests.length;
  });
  await native.application("mirror-restart", async (app) => {
    const { api } = app;
    const window = await native.show(app);
    await waitForText(app, native.identifier, "Disconnected");
    assert.equal(imageSource(await api.snapshot(native.identifier)), undefined);
    assert.equal(fixture.requests.length, calls);
    await pressTray(app, "Connect");
    await waitForText(app, native.identifier, "Enter a device token");
    fixture.no_screen = false;
    await api.call("PUT", `${endpoint}/secrets/access_token`, { value: key });
    const recovered = await native.picture(app);
    errors.push(
      await captureDevice(native, app, window, "mirror-reconnected", requireImage(recovered)),
    );
    assert(fixture.requests.every((request) => !request.id && !request.model));
    assert(
      !requestCount(fixture, "/prefix/api/setup") && !requestCount(fixture, "/prefix/api/display"),
    );
    assert.equal(fixture.logs.length, 0);
    assert(!JSON.stringify(recovered).includes(key));
    await api.call("DELETE", endpoint);
  });
  const frames: Record<string, number> = {};
  if (foreground) {
    for (const stage of ["mirror", "mirror-restart"]) frames[stage] = gpuFrames(artifacts, stage);
  }
  const report = {
    ...fingerprints,
    snapshot_mode: foreground ? "gpu-foreground" : "software",
    preview_pixel_error: errors,
    missing_token_guidance: true,
    current_only: true,
    filename_reused: true,
    empty_retains_image: true,
    disconnect_clears_secret: true,
    restart_stays_disconnected: true,
    reconnect: true,
    physical_window_capture: foreground,
    window_focused: foreground,
    gpu_frames: frames,
  };
  writeJSON(join(artifacts, "verification.json"), report);
  console.log(
    `mirror: PASS (${report.snapshot_mode}, pixel error ${errors.join(", ")}). See ${artifacts}`,
  );
}

main(import.meta, async () => {
  const { values } = parseArgs({
    options: { software: { type: "boolean" }, help: { type: "boolean", short: "h" } },
  });
  if (values.help) return console.log("Usage: pnpm exec tsx scripts/verify_mirror.ts [--software]");
  requireMacOS();
  const foreground = !values.software;
  await unlockedDesktop();
  const identifier = `trmnl-mirror-verification-${randomUUID().slice(0, 8)}`;
  const native = foreground
    ? new ForegroundHost(artifacts, identifier)
    : new NativeHost(artifacts, identifier);
  native.requireExecutable();
  configureDrawing(values.software);
  prepareArtifacts(artifacts);
  const images = await fixtures(join(artifacts, "fixture-images"));
  const fixture: Fixture = {
    requests: [],
    logs: [],
    format: "png",
    filename: "current",
    fail_images: false,
  };
  await serving(fixture, images, () => verifyMirror(native, fixture, foreground));
});
