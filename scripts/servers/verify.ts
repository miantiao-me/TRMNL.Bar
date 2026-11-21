import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { configuration } from "../../src/config.ts";
import { Protocol } from "../../src/protocol/client.ts";
import { requireImage, snapshotMode, type NativeHost } from "../host/native.ts";
import { captureDevice, pngSize } from "../host/preview.ts";
import { prepareRotation, projects, type Server } from "./independent.ts";

export async function verifyServer(name: Server, base: string, native: NativeHost) {
  const { source, ...fingerprints } = native.testSource(base);
  return native.application(`independent-${name}`, async (app) => {
    const { api } = app;
    native.identifier = await api.install(source);
    try {
      const window = await native.show(app);
      const first = requireImage(await native.picture(app, { timeout: 45_000 }));
      const encoded = readFileSync(native.imageFile(first));
      const dimensions = pngSize(encoded);
      assert.deepEqual(dimensions, { width: 800, height: 480 });
      const firstError = await captureDevice(native, app, window, `independent-${name}`, first);
      await prepareRotation(name);
      let previous = first;
      for (let attempt = 0; attempt < 8; attempt++) {
        await native.refresh(api);
        const next = await native.picture(app, { previous });
        previous = requireImage(next);
        if (readFileSync(native.imageFile(previous)).equals(encoded)) {
          await sleep(1000);
          continue;
        }
        const nextError = await captureDevice(
          native,
          app,
          window,
          `independent-${name}-next`,
          previous,
        );
        const protocol = new Protocol(
          configuration({ server: base }, "02:54:52:4D:4E:4C"),
          fetch,
          Date.now,
          AbortSignal.timeout(15_000),
        );
        const setup = await protocol.setup();
        await protocol.log(setup.apiKey, "image");
        return {
          ...projects[name],
          ...fingerprints,
          native_image: true,
          snapshot_mode: snapshotMode(),
          preview_pixels_verified: true,
          preview_pixel_error: [firstError, nextError],
          ...dimensions,
          standard_log: true,
          playlist_rotation: true,
          frames_examined: attempt + 2,
          status: next.status,
          src: previous,
        };
      }
      throw new Error(`The ${name} playlist did not show a different screen`);
    } finally {
      await api.call("DELETE", `/dashboards/${native.identifier}`);
    }
  });
}
