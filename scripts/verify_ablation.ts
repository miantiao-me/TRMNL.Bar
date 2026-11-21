import assert from "node:assert/strict";
import { cpSync, globSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parseArgs } from "node:util";
import { cases } from "./ablation_cases.ts";
import { main, privateDirectory, root, run, sha256, sourceFile, writeJSON } from "./system.ts";

const artifacts = join(root, "dist/review/ablation");

function sourceHashes() {
  return Object.fromEntries(
    globSync("src/**/*.ts", { cwd: root })
      .sort()
      .map((path) => [path, sha256(readFileSync(join(root, path)))]),
  );
}

function prepare(name: string): string {
  const directory = join(artifacts, name);
  rmSync(directory, { recursive: true, force: true });
  cpSync(join(root, "src"), join(directory, "src"), { recursive: true });
  writeFileSync(
    join(directory, "vite.config.ts"),
    `import { defineConfig } from 'vite-plus';
export default defineConfig({root: ${JSON.stringify(directory)}, test: {include: ['src/**/*.test.ts'], exclude: [], testTimeout: 5000}});
`,
  );
  return directory;
}

async function verify(name: string, directory: string, pattern?: string) {
  const command = [
    "exec",
    "vp",
    "test",
    "--config",
    join(directory, "vite.config.ts"),
    "--reporter=verbose",
  ];
  if (pattern) command.push("-t", pattern);
  const started = performance.now();
  const log = join(artifacts, `${name}.log`);
  let output: string;
  let exitCode = 0;
  try {
    const result = await run("pnpm", command, {
      cwd: root,
      env: { ...process.env, NO_COLOR: "1" },
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    output = result.stdout + result.stderr;
  } catch (error) {
    const result = error as { stdout?: string; stderr?: string; code?: number | string };
    output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    writeFileSync(log, output);
    if (typeof result.code !== "number") throw error;
    exitCode = result.code;
  }
  writeFileSync(log, output);
  const expected = pattern ? 1 : 0;
  if (pattern) {
    assert(
      exitCode !== 0 && output.includes("AssertionError:") && /Tests\s+1 failed/.test(output),
      `Expected one assertion failure from the mutation. See ${log}`,
    );
  } else {
    assert.equal(exitCode, 0, `The control group failed. See ${log}`);
  }
  console.log(`${name}: ${pattern ? "regression detected" : "PASS"}`);
  return {
    exit_code: exitCode,
    expected_failures: expected,
    verified: true,
    seconds: Number(((performance.now() - started) / 1000).toFixed(3)),
    log: relative(root, log),
  };
}

function replaceUnique(
  source: string,
  original: string,
  replacement: string,
  path: string,
): string {
  const start = source.indexOf(original);
  assert(
    start >= 0 && start === source.lastIndexOf(original),
    `Expected exactly one mutation target in ${path}: ${original}`,
  );
  return source.slice(0, start) + replacement + source.slice(start + original.length);
}

main(import.meta, async () => {
  const { values } = parseArgs({ options: { help: { type: "boolean", short: "h" } } });
  if (values.help) return console.log("Usage: pnpm exec tsx scripts/verify_ablation.ts");
  privateDirectory(artifacts);
  const before = sourceHashes();
  const results: Record<string, Awaited<ReturnType<typeof verify>>> = {};
  results.control = await verify("control", prepare("control"));
  for (const [name, filename, original, replacement, pattern] of cases) {
    const directory = prepare(name);
    const path = join(directory, "src", filename);
    let source = replaceUnique(readFileSync(path, "utf8"), original, replacement, path);
    if (name === "credential-queue") {
      // Reads wait for queued writes to preserve credential operation order.
      source = replaceUnique(source, "await operation.wait(this.writing);", "", path);
    }
    if (name === "operation-guard") {
      // Cancellation and a final check keep superseded operations from publishing results.
      source = replaceUnique(
        source,
        "return await Promise.race([task, this.aborted]);",
        "this.aborted.catch(() => {});\n      return await task;",
        path,
      );
    }
    writeFileSync(path, source);
    results[name] = await verify(name, directory, pattern);
  }
  assert.deepEqual(sourceHashes(), before, "Ablation verification modified the production source");
  const report = join(artifacts, "verification.json");
  writeJSON(report, {
    source_unchanged: true,
    source_sha256: before,
    bar_sha256: sha256(readFileSync(sourceFile)),
    cases: results,
  });
  console.log(`Ablation verification complete. See ${report}`);
});
