import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { NativeHost, snapshotMode } from "./host/native.ts";
import { baselineFixture, stages, verifiedState, type State } from "./host/stages.ts";
import { fixtures, serving } from "./servers/fixture.ts";
import { main, readJSON, requireMacOS, root, writeJSON } from "./system.ts";

main(import.meta, async () => {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { stage: { type: "string" }, help: { type: "boolean", short: "h" } },
  });
  const usage =
    "Usage: pnpm exec tsx scripts/verify_host.ts [Metrix.Bar source path] --stage baseline|restart|recover";
  if (values.help) return console.log(usage);
  const stage = values.stage as keyof typeof stages;
  assert(stage && Object.hasOwn(stages, stage) && positionals.length <= 1, usage);
  requireMacOS();
  const native = new NativeHost();
  if (stage === "baseline")
    await native.prepare(resolve(positionals[0] ?? join(dirname(root), "Metrix.Bar")));
  const fixture = stage === "baseline" ? baselineFixture() : verifiedState(native).fixture;
  const images = await fixtures(join(native.artifacts, "fixture-images"));
  await serving(fixture, images, () => stages[stage](native, fixture));
  writeJSON(native.state, { ...readJSON<State>(native.state), snapshot_mode: snapshotMode() });
  console.log(`${stage}: PASS. Artifacts are in ${native.artifacts}`);
});
