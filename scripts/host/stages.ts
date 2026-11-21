import assert from "node:assert/strict";
import { copyFileSync, existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { key, requestCount, type Fixture } from "../servers/fixture.ts";
import { readJSON, sha256, sourceFile, waitFor, writeJSON } from "../system.ts";
import { requireImage, type NativeHost } from "./native.ts";
import { pressTray } from "./tray.ts";
import { pngSize } from "./preview.ts";

export interface State {
  id: string;
  device_id: string;
  retained: string;
  baseline: boolean;
  fixture: Fixture;
  bar_sha256: string;
  host_sha256: string;
  installed_source_sha256: string;
  restart?: boolean;
  recovered?: string;
  invalid_cache_recovered?: boolean;
  deleted?: boolean;
  snapshot_mode?: string;
}

export function verifiedState(native: NativeHost, source = sourceFile): State {
  const state = readJSON<State>(native.state);
  const files = {
    bar_sha256: source,
    host_sha256: native.executable,
    installed_source_sha256: join(native.data, "Dashboards", `${state.id}.bar`),
  } as const;
  for (const field of Object.keys(files) as (keyof typeof files)[]) {
    const path = files[field];
    assert(
      existsSync(path) && state[field] === sha256(readFileSync(path)),
      `${field} differs from the baseline. Run the baseline stage again`,
    );
  }
  native.identifier = state.id;
  return state;
}

const setup = "/prefix/api/setup";
const display = "/prefix/api/display";

async function baseline(native: NativeHost, fixture: Fixture): Promise<void> {
  const { source, ...fingerprints } = native.testSource(
    `http://127.0.0.1:${fixture.server_port}/prefix`,
  );
  await native.application("baseline", async (app) => {
    const { api, process } = app;
    native.identifier = await api.install(source, join(native.artifacts, "check.json"));
    const window = await native.show(app);
    // Allow one 30-second retry for the first screen, as in the independent BYOS checks.
    const first = requireImage(await native.picture(app, { timeout: 45_000 }));
    copyFileSync(native.imageFile(first), join(native.artifacts, "installed-render.png"));
    await native.capture(app, window, "installed-bmp");
    const setupIds = new Set(fixture.requests.filter((r) => r.path === setup).map((r) => r.id));
    assert.equal(setupIds.size, 1);
    const displayCount = () => requestCount(fixture, display);
    let calls = displayCount();
    fixture.refresh_rate = 3600;
    await waitFor(() => displayCount() > calls, "the refresh interval in seconds", process);
    Object.assign(fixture, { format: "png", filename: "png-cdn", use_cdn: true });
    await api.call("POST", `/dashboards/${native.identifier}/inputs`, {
      inputs: { image_origin: `http://127.0.0.1:${fixture.cdn_port}` },
    });
    const png = requireImage(await native.picture(app, { previous: first }));
    const downloads = requestCount(fixture, "/images/frame.png");
    calls = displayCount();
    await native.refresh(api);
    await waitFor(() => displayCount() > calls, "a response with the same filename", process);
    await native.picture(app);
    assert.equal(
      requestCount(fixture, "/images/frame.png"),
      downloads,
      "Downloaded the same filename twice",
    );
    Object.assign(fixture, { format: "jpeg", filename: "jpeg-cdn" });
    await native.refresh(api);
    const jpeg = requireImage(await native.picture(app, { previous: png }));
    await native.capture(app, window, "jpeg-cdn");
    Object.assign(fixture, { format: "png", filename: "failed-frame", fail_images: true });
    await native.refresh(api);
    assert.equal(
      requireImage(await native.picture(app, { status: "Unable to load screen" })),
      jpeg,
    );
    calls = displayCount();
    await pressTray(app, "Send diagnostics");
    await waitFor(() => fixture.logs.length, "a device log request", process);
    fixture.fail_images = false;
    await native.refresh(api);
    const retried = requireImage(await native.picture(app, { previous: jpeg }));
    assert.equal(displayCount(), calls, "Retrying the image advanced the playlist");
    assert.deepEqual(pngSize(readFileSync(native.imageFile(retried))), { width: 800, height: 480 });
    assert.deepEqual(
      new Set(fixture.requests.filter((r) => r.path === display).map((r) => r.model)),
      new Set(["og"]),
    );
    Object.assign(fixture, { filename: "restart-failure", fail_images: true });
    await native.refresh(api);
    const retained = await native.picture(app, { status: "Unable to load screen" });
    assert.equal(requireImage(retained), retried);
    await native.capture(app, window, "failed-update-retained");
    assert(!fixture.credential_leak, "The CDN received device credentials");
    assert(!JSON.stringify(retained).includes(key));
    writeJSON(native.state, {
      id: native.identifier,
      device_id: [...setupIds][0],
      retained: retried,
      baseline: true,
      fixture,
      ...fingerprints,
    } satisfies State);
  });
}

async function restart(native: NativeHost, fixture: Fixture): Promise<void> {
  const state = verifiedState(native);
  await native.application("restart", async (app) => {
    const window = await native.show(app);
    assert.equal(requireImage(await native.picture(app)), state.retained);
    await native.capture(app, window, "restart-retained");
    Object.assign(fixture, { fail_images: false, filename: "restart-recovered" });
    await native.refresh(app.api);
    const recovered = requireImage(await native.picture(app, { previous: state.retained }));
    await native.capture(app, window, "restart-recovered");
    writeJSON(native.state, { ...state, restart: true, recovered, fixture });
  });
}

async function recover(native: NativeHost, fixture: Fixture): Promise<void> {
  const state = verifiedState(native);
  assert(state.restart && state.recovered, "Complete the restart stage first");
  const cache = join(native.data, "RenderImages");
  const cached = () =>
    existsSync(cache) && readdirSync(cache).some((file) => file.endsWith(".png"));
  assert(cached(), "The persistent image cache is missing");
  rmSync(cache, { recursive: true });
  const calls = requestCount(fixture, setup);
  await native.application("recover", async (app) => {
    const window = await native.show(app);
    await native.picture(app, { previous: state.recovered });
    assert.equal(
      requestCount(fixture, setup),
      calls,
      "The stored device token was lost on restart",
    );
    assert(
      fixture.requests.every(
        (request) => request.path !== display || request.id === state.device_id,
      ),
    );
    await native.capture(app, window, "invalid-cache-recovered");
    await app.api.call("DELETE", `/dashboards/${native.identifier}`);
    assert(!cached(), "Removing the dashboard should release managed images");
    writeJSON(native.state, { ...state, invalid_cache_recovered: true, deleted: true, fixture });
  });
}

export const stages = { baseline, restart, recover };

export function baselineFixture(): Fixture {
  return {
    requests: [],
    logs: [],
    format: "bmp",
    filename: "first",
    use_cdn: false,
    fail_images: false,
    refresh_rate: 2,
  };
}
