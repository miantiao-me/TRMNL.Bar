import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { fixtures, serving } from "./servers/fixture.ts";
import {
  configureDrawing,
  ForegroundHost,
  foregroundArtifacts,
  gpuFrames,
  unlockedDesktop,
} from "./host/foreground.ts";
import { prepareArtifacts, requireImage, type Application } from "./host/native.ts";
import { captureDevice } from "./host/preview.ts";
import { main, requireMacOS, sha256, sourceFile, writeJSON } from "./system.ts";
import { baselineFixture, stages } from "./host/stages.ts";
import { selectedServers, withServer } from "./servers/independent.ts";
import { verifyServer } from "./servers/verify.ts";

class ProtocolHost extends ForegroundHost {
  readonly matches: Record<string, number> = {};

  override async capture(app: Application, window: number, name: string): Promise<void> {
    const source = requireImage(await app.api.snapshot(this.identifier));
    this.matches[name] = await captureDevice(
      this,
      app,
      window,
      name,
      source,
      super.capture.bind(this),
    );
  }
}

async function verifyProtocol(native: ProtocolHost) {
  const fixture = baselineFixture();
  const images = await fixtures(join(native.artifacts, "fixture-images"));
  const frames: Record<string, number> = {};
  await serving(fixture, images, async () => {
    // Each stage starts and exits the app to exercise a real process restart.
    for (const [stage, verify] of Object.entries(stages)) {
      await verify(native, fixture);
      frames[stage] = gpuFrames(native.artifacts, stage);
      console.log(`${stage}: PASS (${frames[stage]} foreground GPU frames)`);
    }
  });
  const state = JSON.parse(readFileSync(native.state, "utf8")) as Record<string, unknown>;
  writeJSON(native.state, { ...state, snapshot_mode: "gpu-foreground" });
  return {
    baseline: state.baseline,
    restart: state.restart,
    invalid_cache_recovered: state.invalid_cache_recovered,
    deleted: state.deleted,
    physical_window_capture: true,
    window_focused: true,
    gpu_frames: frames,
    preview_pixels_verified: true,
    preview_pixel_error: native.matches,
  };
}

main(import.meta, async () => {
  const { values } = parseArgs({
    options: { server: { type: "string" }, help: { type: "boolean", short: "h" } },
  });
  if (values.help)
    return console.log(
      "Usage: pnpm exec tsx scripts/verify_foreground.ts [--server fastapi|tiding]",
    );
  requireMacOS();
  const names = selectedServers(values.server);
  const desktop = await unlockedDesktop();
  const native = new ProtocolHost();
  native.requireExecutable();
  configureDrawing();
  prepareArtifacts(foregroundArtifacts);
  const reportPath = join(foregroundArtifacts, "verification.json");
  const servers: Record<string, object> = {};
  const report = {
    environment: desktop,
    snapshot_mode: "gpu-foreground",
    servers,
    bar_sha256: sha256(readFileSync(sourceFile)),
    host_sha256: sha256(readFileSync(native.executable)),
  };
  writeJSON(reportPath, report);
  for (const name of names) {
    const result = await withServer(name, (base) =>
      verifyServer(
        name,
        base,
        new ForegroundHost(foregroundArtifacts, `trmnl-independent-${name}`),
      ),
    );
    const frames = gpuFrames(foregroundArtifacts, `independent-${name}`);
    servers[name] = {
      ...result,
      snapshot_mode: "gpu-foreground",
      physical_window_capture: true,
      window_focused: true,
      gpu_frames: frames,
    };
    writeJSON(reportPath, report);
    console.log(
      `${name}: PASS (${frames} foreground GPU frames, window pixel error ${result.preview_pixel_error.join(", ")})`,
    );
  }
  if (!values.server)
    writeJSON(reportPath, { ...report, protocol_fixture: await verifyProtocol(native) });
});
