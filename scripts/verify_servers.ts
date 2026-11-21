import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { NativeHost, prepareArtifacts } from "./host/native.ts";
import { external, prepare, selectedServers, withServer } from "./servers/independent.ts";
import { verifyServer } from "./servers/verify.ts";
import { main, readJSON, requireMacOS, sha256, sourceFile, writeJSON } from "./system.ts";

type ServerResult = Awaited<ReturnType<typeof verifyServer>>;

main(import.meta, async () => {
  const { values } = parseArgs({
    options: {
      prepare: { type: "boolean" },
      server: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help)
    return console.log(
      "Usage: pnpm exec tsx scripts/verify_servers.ts [--prepare] [--server fastapi|tiding]",
    );
  requireMacOS();
  const names = selectedServers(values.server);
  prepareArtifacts(external);
  if (values.prepare) await prepare(names);
  const native = new NativeHost();
  native.requireExecutable();
  const report = join(external, "verification.json");
  const previous = existsSync(report) ? readJSON<Record<string, ServerResult>>(report) : {};
  const artifactHash = sha256(readFileSync(sourceFile));
  const hostHash = sha256(readFileSync(native.executable));
  const results = Object.fromEntries(
    Object.entries(previous).filter(
      ([, result]) => result.bar_sha256 === artifactHash && result.host_sha256 === hostHash,
    ),
  );
  for (const name of names) {
    results[name] = await withServer(name, (base) =>
      verifyServer(name, base, new NativeHost(native.artifacts, `trmnl-independent-${name}`)),
    );
    writeJSON(report, results);
    console.log(`${name}: PASS`);
  }
});
