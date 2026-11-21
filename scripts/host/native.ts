import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Automation } from "./automation.ts";
import { testTrayTitle } from "./tray.ts";
import {
  availablePort,
  privateDirectory,
  readJSON,
  root,
  runLogged,
  sha256,
  sourceFile,
  WaitTimeout,
  waitFor,
  withProcess,
  writeJSON,
} from "../system.ts";

const workspace = join(root, "dist/host-verification");
const hostVersion = "0.3.2";

interface Node {
  type: string;
  props?: { src?: string };
  children?: Node[];
}

interface Snapshot {
  status: string;
  error?: string;
  view?: {
    panel?: Node;
    tray?: { menu?: { label?: string; disabled?: boolean }[] };
  };
}

export function imageSource(snapshot: Snapshot): string | undefined {
  function walk(node: Node): string | undefined {
    if (node.type === "Image") return node.props?.src;
    for (const child of node.children ?? []) {
      const source = walk(child);
      if (source) return source;
    }
  }
  const panel = snapshot.view?.panel;
  return panel && walk(panel);
}

export function requireImage(snapshot: Snapshot): string {
  const source = imageSource(snapshot);
  assert(source, "The dashboard has no displayed image");
  return source;
}

export class API {
  private config;

  constructor(data: string) {
    this.config = readJSON<{ api: { port: number; token: string } }>(
      join(data, "instances.json"),
    ).api;
  }

  async call<T = unknown>(method: string, path: string, data?: unknown): Promise<T> {
    const response = await fetch(`http://127.0.0.1:${this.config.port}/v0${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.config.token}`, "Content-Type": "application/json" },
      body: data === undefined ? undefined : JSON.stringify(data),
      signal: AbortSignal.timeout(18_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`${method} ${path}: HTTP ${response.status}`);
    }
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  snapshot(id: string): Promise<Snapshot> {
    return this.call("GET", `/dashboards/${id}`);
  }

  async install(source: string, checkFile?: string): Promise<string> {
    assert((await this.call<{ valid: boolean }>("POST", "/validate", { source })).valid);
    if (checkFile) {
      const checked = await this.call<{ valid: boolean; diagnostics: unknown }>("POST", "/check", {
        source,
        scheduled: true,
        tree: true,
      });
      writeJSON(checkFile, checked);
      assert(checked.valid, JSON.stringify(checked.diagnostics));
    }
    return (await this.call<{ id: string }>("POST", "/dashboards", { source })).id;
  }
}

export interface Application {
  api: API;
  client: Automation;
  process: ChildProcess;
}

export class NativeHost {
  readonly data;
  readonly executable;
  readonly state;

  constructor(
    readonly artifacts = workspace,
    public identifier = "trmnl-device-verification",
    readonly workspacePath = workspace,
  ) {
    this.data = join(workspacePath, "data");
    this.executable = join(workspacePath, "TRMNL Device Verification.app/Contents/MacOS/metrixbar");
    this.state = join(artifacts, "state.json");
  }

  requireExecutable(): void {
    assert(
      existsSync(this.executable),
      "Run pnpm exec tsx scripts/verify_host.ts --stage baseline first",
    );
  }

  async prepare(host: string): Promise<void> {
    rmSync(this.workspacePath, { recursive: true, force: true });
    privateDirectory(join(this.data, "Dashboards"));
    writeJSON(join(this.data, "instances.json"), {
      version: 0,
      instances: {},
      dashboards: {},
      seeded: true,
      api: { enabled: true, port: await availablePort(), token: randomBytes(32).toString("hex") },
      telemetry: { enabled: false },
      app: { language: "en", updateFrequency: "manual", network: { mode: "direct" } },
    });
    privateDirectory(dirname(this.executable));
    writeFileSync(
      join(dirname(this.executable), "../Info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>TRMNL Verify</string>
<key>CFBundleExecutable</key><string>metrixbar</string>
<key>CFBundleIdentifier</key><string>bar.metrix.trmnl-device-verification</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${hostVersion}</string>
<key>CFBundleVersion</key><string>0</string>
<key>LSUIElement</key><true/>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>
`,
    );
    await runLogged(
      [
        "go",
        "build",
        "-tags",
        "metrix_dev,e2e",
        "-ldflags",
        `-X "main.developmentDataDir=${this.data}" -X main.displayVersion=${hostVersion} -X main.updateVersion=${hostVersion}`,
        "-o",
        this.executable,
        "./cmd/metrixbar",
      ],
      host,
      join(this.artifacts, "build.log"),
      { ...process.env, CGO_ENABLED: "0" },
    );
  }

  async application<T>(
    stage: string,
    action: (app: Application) => Promise<T>,
    locale = "en",
  ): Promise<T> {
    const path = join(this.workspacePath, "ui.sock");
    rmSync(path, { force: true });
    return withProcess(
      [this.executable],
      {
        log: join(this.artifacts, `${stage}.log`),
        env: { ...process.env, MYGO_AUTOMATION: path, MYGO_LOCALE: locale },
      },
      async (child) => {
        await waitFor(() => existsSync(path), "the automation socket", child);
        const client = await Automation.connect(path);
        try {
          const api = new API(this.data);
          await waitFor(
            async () => {
              try {
                await api.call("GET", "/health");
                return true;
              } catch (error) {
                if (error instanceof TypeError && error.message === "fetch failed") return false;
                throw error;
              }
            },
            "the local API",
            child,
          );
          return await action({ api, client, process: child });
        } finally {
          client.close();
        }
      },
    );
  }

  async show({ client, process }: Application): Promise<number> {
    const { id } = await waitFor(
      async () =>
        (await client.call("windows")).windows.find(
          (window) => window.visible && window.kind === "content",
        ),
      "the main window",
      process,
    );
    const key = `nav:dashboard:${this.identifier}`;
    await waitFor(
      async () => (await client.tree(id)).nodes.some((node) => node.key === key),
      "dashboard navigation",
      process,
    );
    await client.press(id, key);
    return id;
  }

  async picture(
    app: Application,
    {
      previous,
      status,
      timeout,
    }: {
      previous?: string;
      status?: string;
      timeout?: number;
    } = {},
  ): Promise<Snapshot> {
    const target = join(this.artifacts, "failed-worker.json");
    try {
      return await waitFor(
        async () => {
          const snapshot = await app.api.snapshot(this.identifier);
          if (snapshot.status === "error") {
            writeJSON(target, snapshot);
            throw new Error(
              `The worker could not publish the screen (${snapshot.error}). See ${target}`,
            );
          }
          const source = imageSource(snapshot);
          if (
            source &&
            source !== previous &&
            (status === undefined ||
              snapshot.view?.tray?.menu?.some((item) => item.disabled && item.label === status))
          )
            return snapshot;
        },
        "the device screen to appear",
        app.process,
        timeout,
      );
    } catch (error) {
      if (!(error instanceof WaitTimeout)) throw error;
      writeJSON(target, await app.api.snapshot(this.identifier));
      throw new Error(`Timed out waiting for the device screen. See ${target}`, { cause: error });
    }
  }

  async capture({ client }: Application, window: number, name: string): Promise<void> {
    await client.tree(window);
    await client.call("idle", { window, timeout: 5000 });
    const png = Buffer.from((await client.call("capture", { window })).png, "base64");
    assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    writeFileSync(join(this.artifacts, `${name}.png`), png);
    writeJSON(join(this.artifacts, `${name}-tree.json`), await client.tree(window));
  }

  async refresh(api: API): Promise<void> {
    await api.call("POST", `/dashboards/${this.identifier}/refresh`);
  }

  imageFile(source: string): string {
    return join(this.data, "RenderImages", `${source.replace(/^metrix-image:\/\//, "")}.png`);
  }

  testSource(server: string, mirror = false) {
    const bytes = readFileSync(sourceFile);
    let source = bytes
      .toString()
      .replace('id="trmnl-bar"', `id="${this.identifier}"`)
      .replace('default="https://trmnl.com"', `default="${server}"`)
      .replace('placeholder="lucide:monitor"', `default="${testTrayTitle}"`);
    if (mirror) source = source.replace('default="device"', 'default="mirror"');
    return {
      source,
      bar_sha256: sha256(bytes),
      host_sha256: sha256(readFileSync(this.executable)),
      installed_source_sha256: sha256(source),
    };
  }
}

export function snapshotMode() {
  return process.env.MYGO_GPU === "0" ? "software" : "default";
}

export function prepareArtifacts(path: string): void {
  privateDirectory(path);
  chmodSync(path, 0o700);
}
