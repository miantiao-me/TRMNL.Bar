import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { NativeHost } from "./native.ts";
import { sha256, writeJSON } from "../system.ts";
import { verifiedState } from "./stages.ts";

let directory: string;
let native: NativeHost;
let source: string;
let installed: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "trmnl-artifact-"));
  native = new NativeHost(directory, "instance-test", directory);
  source = join(directory, "TRMNL.bar");
  installed = join(native.data, "Dashboards/instance-test.bar");
  mkdirSync(dirname(native.executable), { recursive: true });
  mkdirSync(dirname(installed), { recursive: true });
  writeFileSync(source, "baseline bar");
  writeFileSync(native.executable, "baseline host");
  writeFileSync(installed, "installed bar");
  writeJSON(native.state, {
    id: "instance-test",
    bar_sha256: sha256("baseline bar"),
    host_sha256: sha256("baseline host"),
    installed_source_sha256: sha256("installed bar"),
  });
});

afterEach(() => rmSync(directory, { recursive: true, force: true }));

test("Resumes verification with the same build and installed source", () => {
  expect(verifiedState(native, source).bar_sha256).toBe(sha256("baseline bar"));
});

test("Requires a new baseline when the .bar build changes", () => {
  writeFileSync(source, "rebuilt bar");
  expect(() => verifiedState(native, source)).toThrow(/bar_sha256/);
});

test("Requires a new baseline when the host build changes", () => {
  writeFileSync(native.executable, "rebuilt host");
  expect(() => verifiedState(native, source)).toThrow(/host_sha256/);
});

test("Requires a new baseline when the installed source changes", () => {
  writeFileSync(installed, "replaced installation");
  expect(() => verifiedState(native, source)).toThrow(/installed_source_sha256/);
});
